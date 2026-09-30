import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { UserAuthGuard, WebRequest } from '../auth/user-auth.guard';
import { getLogger } from '../common/logger';
import { CreditsService } from '../credits/credits.service';
import { ChatRepository } from '../database/repositories/chat.repository';
import { ChatMessageRow } from '../database/types';
import { ChatEvent, ChatService } from './chat.service';

/** Longest question accepted. Generous for legal prose, bounded for the model bill. */
const MAX_QUESTION_LENGTH = 4000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * An answer in progress, as far as Stop needs to know about it.
 *
 * In memory, in this process. The web service runs as one process (see
 * ecosystem.config.js), so the request and the Stop for it always meet here;
 * a second replica would need this in the database.
 */
interface RunningAsk {
  userId: string;
  threadId: string | null;
  userMessageId: string | null;
  /** Every message this turn wrote - the question and anything after it. */
  messageIds: string[];
  /** Stop was pressed before the answer was sent. */
  stopped: boolean;
  /** The answer, or the reason there is none, has been sent. Stop is too late. */
  settled: boolean;
}

function track(run: RunningAsk, event: ChatEvent): void {
  if (event.type === 'thread') run.threadId = event.threadId;
  if (event.type === 'message' || event.type === 'answer') {
    run.messageIds.push(event.message.id);
    if (event.type === 'message' && event.message.role === 'user') run.userMessageId = event.message.id;
  }
}

/**
 * The signed-in advocate's chat.
 *
 * Every route is guarded and every query is scoped to the caller in SQL - see
 * ChatRepository. There is no route here that takes a user id: the only account
 * this controller can reach is the one holding the session cookie.
 */
@Controller('api/chat')
@UseGuards(UserAuthGuard)
export class ChatController {
  private readonly logger = getLogger().child({ module: 'web:chat:http' });
  private readonly running = new Map<string, RunningAsk>();

  constructor(
    private readonly chat: ChatService,
    private readonly chats: ChatRepository,
    private readonly credits: CreditsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Threads
  // ---------------------------------------------------------------------------

  @Get('threads')
  async listThreads(@Req() req: WebRequest, @Query('limit') limit?: string) {
    const rows = await this.chats.listThreads(req.principal!.user.id, clamp(limit, 100, 200));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
      createdAt: row.created_at,
    }));
  }

  @Post('threads')
  @HttpCode(HttpStatus.OK)
  async createThread(@Req() req: WebRequest) {
    const thread = await this.chats.createThread(req.principal!.user.id);
    return { id: thread.id, title: thread.title, messageCount: 0, lastMessageAt: thread.last_message_at };
  }

  @Get('threads/:id')
  async readThread(@Param('id') id: string, @Req() req: WebRequest) {
    const userId = req.principal!.user.id;

    const thread = await this.chats.findThread(userId, id);
    if (!thread) throw new NotFoundException({ code: 'NO_THREAD', message: 'Conversation not found.' });

    const messages = await this.chats.listMessages(userId, id);

    return {
      id: thread.id,
      title: thread.title,
      createdAt: thread.created_at,
      messages: messages.map(toPublicMessage),
    };
  }

  @Patch('threads/:id')
  async renameThread(@Param('id') id: string, @Body() body: { title?: string }, @Req() req: WebRequest) {
    const title = (body?.title ?? '').trim();
    if (!title) throw new BadRequestException({ code: 'EMPTY_TITLE', message: 'Give the chat a name.' });

    const thread = await this.chats.renameThread(req.principal!.user.id, id, title);
    if (!thread) throw new NotFoundException({ code: 'NO_THREAD', message: 'Conversation not found.' });

    return { id: thread.id, title: thread.title };
  }

  /**
   * Remove a conversation.
   *
   * Archives by default and erases only when explicitly asked. The two are
   * different requests - "get this out of my sidebar" and "destroy this" - and
   * a single endpoint that always does the second makes a misclick permanent.
   */
  @Delete('threads/:id')
  async removeThread(
    @Param('id') id: string,
    @Query('permanent') permanent: string | undefined,
    @Req() req: WebRequest,
  ) {
    const userId = req.principal!.user.id;

    const done =
      permanent === 'true'
        ? await this.chats.purgeThread(userId, id)
        : await this.chats.archiveThread(userId, id);

    if (!done) throw new NotFoundException({ code: 'NO_THREAD', message: 'Conversation not found.' });
    return { removed: true, permanent: permanent === 'true' };
  }

  // ---------------------------------------------------------------------------
  // Asking
  // ---------------------------------------------------------------------------

  /**
   * Ask a question and stream the answer's progress.
   *
   * ## Why POST-with-SSE rather than EventSource
   *
   * `EventSource` only issues GETs, which would put the advocate's question in
   * a URL - and therefore in server logs, browser history and any proxy in
   * between. Legal questions are exactly the content that must not end up
   * there. So the body is a POST and the client reads the streamed response
   * with fetch, which is a few more lines in the browser and keeps the question
   * out of every log on the path.
   *
   * ## What is streamed, and what is not
   *
   * Progress stages and the finished message. Not tokens - see the class
   * comment in chat.service.ts for why an unverified citation must never reach
   * the screen, even for a moment.
   */
  @Post('ask')
  async ask(
    @Body() body: { threadId?: string; question?: string; requestId?: string; replaceMessageId?: string },
    @Req() req: WebRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const user = req.principal!.user;
    const question = (body?.question ?? '').trim();

    // Only a real message id reaches the database, where it is cast to uuid -
    // anything else would fail the cast and lose the question with it.
    const replaceMessageId =
      typeof body?.replaceMessageId === 'string' && UUID.test(body.replaceMessageId)
        ? body.replaceMessageId
        : null;

    if (!question) {
      reply.status(HttpStatus.BAD_REQUEST).send({
        success: false,
        error: { code: 'EMPTY', message: 'Type a question first.' },
      });
      return;
    }

    if (question.length > MAX_QUESTION_LENGTH) {
      reply.status(HttpStatus.BAD_REQUEST).send({
        success: false,
        error: {
          code: 'TOO_LONG',
          message: `Questions are limited to ${MAX_QUESTION_LENGTH} characters.`,
        },
      });
      return;
    }

    reply.raw.writeHead(HttpStatus.OK, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Render and most reverse proxies buffer responses by default, which
      // holds every event until the stream closes and turns live progress into
      // one delivery at the end. This is the header nginx honours to stop that.
      'x-accel-buffering': 'no',
    });

    // Whether the browser is still there. A closed connection is normal - the
    // advocate navigated away or hit stop - and is not an error. Once the answer
    // is under way it is still finished and saved, so it is in the thread when
    // they come back. (Admission was decided before this handler ran - see
    // ChatAdmissionMiddleware, which holds this request's slot until it ends.)
    let open = true;
    reply.raw.on('close', () => {
      open = false;
    });

    const write = (event: ChatEvent): void => {
      if (!open) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Registered before the first await, so a Stop pressed at once still finds it.
    const requestId = typeof body?.requestId === 'string' && REQUEST_ID.test(body.requestId) ? body.requestId : null;
    const run: RunningAsk = {
      userId: user.id, threadId: null, userMessageId: null, messageIds: [], stopped: false, settled: false,
    };
    if (requestId) this.running.set(requestId, run);

    try {
      for await (const event of this.chat.ask({
        user,
        threadId: body?.threadId ?? null,
        question,
        replaceMessageId,
        // Stop pressed, or nobody left to answer. Consulted only before the
        // work starts (classification, then the charge); an answer already
        // under way runs on and is saved.
        stopped: () => run.stopped || !open,
      })) {
        track(run, event);

        // The advocate stopped this answer. The pipeline runs on to its end so
        // that whatever it charged and wrote can be undone below, but nothing
        // more of it is sent.
        if (run.stopped) continue;

        write(event);

        // Once the answer - or the reason there is none - has been sent, Stop
        // is too late: it was delivered, and undoing it would be a free answer.
        if (event.type === 'answer' || event.type === 'error') run.settled = true;
      }
    } catch (err) {
      // ChatService handles its own failures and refunds; reaching here means
      // something outside that, so the connection gets a final honest event
      // rather than simply dying.
      this.logger.error({ err, userId: user.id }, 'Chat stream failed');
      write({
        type: 'error',
        code: 'STREAM_FAILED',
        message: 'The connection dropped while answering. Your credits have not been charged.',
      });
    } finally {
      if (open) reply.raw.end();
      if (requestId) this.running.delete(requestId);
    }

    // The second pass - see ChatService.discardTurn. Whatever the abandoned
    // answer charged or wrote after Stop is refunded and removed. The same for
    // a question whose client left before any work began: it ended without an
    // answer, so the lone question is removed rather than left in the thread.
    if (run.stopped || (!open && !run.settled)) {
      await this.chat
        .discardTurn({ user, threadId: run.threadId, userMessageId: run.userMessageId, messageIds: run.messageIds })
        .catch((err) => this.logger.error({ err, userId: user.id }, 'Could not undo a stopped answer'));
    }
  }

  /**
   * Stop an answer that has not arrived yet.
   *
   * The question is removed and its credits refunded at once, so the advocate
   * can edit it and send it again straight away into a clean thread. Refused
   * once the answer has been sent: stopping then would be a free answer.
   */
  @Post('stop')
  @HttpCode(HttpStatus.OK)
  async stop(@Body() body: { requestId?: string }, @Req() req: WebRequest) {
    const user = req.principal!.user;
    const run = typeof body?.requestId === 'string' ? this.running.get(body.requestId) : undefined;

    // Somebody else's request looks exactly like one that does not exist.
    if (!run || run.userId !== user.id || run.settled) return { stopped: false };

    run.stopped = true;
    await this.chat.discardTurn({
      user,
      threadId: run.threadId,
      userMessageId: run.userMessageId,
      messageIds: [...run.messageIds],
    });

    return { stopped: true, credits: await this.credits.peek(user.id, user.role) };
  }

  // ---------------------------------------------------------------------------
  // Credits
  // ---------------------------------------------------------------------------

  @Get('credits')
  async balance(@Req() req: WebRequest) {
    const user = req.principal!.user;
    const [balance, history] = await Promise.all([
      this.credits.balance(user.id, user.role),
      this.credits.history(user.id, 50),
    ]);

    return {
      balance,
      history: history.map((row) => ({
        id: row.id,
        kind: row.kind,
        bucket: row.bucket,
        delta: row.delta,
        balanceAfter: row.balance_after,
        reason: row.reason,
        action: row.action,
        createdAt: row.created_at,
      })),
    };
  }
}

function toPublicMessage(row: ChatMessageRow) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    intent: row.intent,
    citations: row.citations ?? [],
    structured: row.structured,
    creditsCharged: row.credits_charged,
    guardrailFlagged: row.guardrail_flagged,
    error: row.error_detail,
    createdAt: row.created_at,
  };
}

function clamp(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}
