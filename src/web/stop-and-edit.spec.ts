import { ChatMessageRow, UserRow } from '../database/types';
import { ChatController } from './chat.controller';
import { ChatEvent, ChatService } from './chat.service';

/**
 * Stop, and editing the question you just asked.
 *
 * Asked for together, for one reason: a wrong question should not cost
 * credits. So Stop refunds and removes the question, and hands it back to be
 * edited - but only until the answer has been sent. After that the answer has
 * been delivered, and stopping or editing it must not become a way to read
 * answers for free.
 */

const USER = { id: 'user-1', role: 'ADVOCATE' } as unknown as UserRow;
const OTHER = { id: 'user-2', role: 'ADVOCATE' } as unknown as UserRow;

function message(id: string, role: 'user' | 'assistant') {
  return {
    id, role, content: role, intent: null, citations: [], structured: null,
    creditsCharged: 0, guardrailFlagged: false, error: null, createdAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// The controller: what reaches the browser, and what gets undone
// ---------------------------------------------------------------------------

function fakeReply() {
  const written: ChatEvent[] = [];
  const raw = {
    writeHead: jest.fn(),
    on: jest.fn(),
    write: jest.fn((chunk: string) => { written.push(JSON.parse(chunk.replace(/^data: /, ''))); }),
    end: jest.fn(),
  };
  return { reply: { raw, status: jest.fn().mockReturnThis(), send: jest.fn() }, written };
}

/** A pipeline that stops after the question and waits to be let go. */
function pausedAnswer() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reachedGate!: () => void;
  const atGate = new Promise<void>((resolve) => { reachedGate = resolve; });

  async function* ask(): AsyncGenerator<ChatEvent> {
    yield { type: 'thread', threadId: 'thread-1', title: 'q' };
    yield { type: 'message', message: message('11111111-1111-1111-1111-111111111111', 'user') };
    reachedGate();
    await gate;
    yield {
      type: 'answer',
      message: message('22222222-2222-2222-2222-222222222222', 'assistant'),
      credits: {} as never,
      charged: 2,
    };
  }

  const chat = { ask: jest.fn(ask), discardTurn: jest.fn().mockResolvedValue(undefined) };
  const credits = { peek: jest.fn().mockResolvedValue({ total: 10 }) };
  const controller = new ChatController(chat as unknown as ChatService, {} as never, credits as never);
  return { controller, chat, release: () => release(), atGate };
}

function asking(controller: ChatController, user: UserRow, reply: unknown, requestId = 'req-12345678') {
  return controller.ask(
    { question: 'what is 302 ipc', requestId },
    { principal: { user } } as never,
    reply as never,
  );
}

describe('Stop, before the answer arrives', () => {
  it('sends nothing more, refunds, and removes the question', async () => {
    const { controller, chat, release, atGate } = pausedAnswer();
    const { reply, written } = fakeReply();

    const run = asking(controller, USER, reply);
    await atGate;

    const result = await controller.stop({ requestId: 'req-12345678' }, { principal: { user: USER } } as never);
    release();
    await run;

    expect(result).toMatchObject({ stopped: true });
    expect(written.map((e) => e.type)).not.toContain('answer');

    // Once at Stop, so a resend finds the thread clean; once at the end, for
    // what the abandoned answer wrote after it.
    expect(chat.discardTurn).toHaveBeenCalledTimes(2);
    expect(chat.discardTurn.mock.calls[0][0]).toMatchObject({
      userMessageId: '11111111-1111-1111-1111-111111111111',
      threadId: 'thread-1',
    });
    expect(chat.discardTurn.mock.calls[1][0].messageIds).toContain('22222222-2222-2222-2222-222222222222');
  });
});

describe('Stop, too late', () => {
  it('is refused once the answer has been sent', async () => {
    const { controller, chat, release, atGate } = pausedAnswer();
    const { reply, written } = fakeReply();

    const run = asking(controller, USER, reply);
    await atGate;
    release();
    await run;

    const result = await controller.stop({ requestId: 'req-12345678' }, { principal: { user: USER } } as never);

    expect(result).toEqual({ stopped: false });
    expect(written.map((e) => e.type)).toContain('answer');
    expect(chat.discardTurn).not.toHaveBeenCalled();
  });

  it("will not stop somebody else's answer", async () => {
    const { controller, chat, release, atGate } = pausedAnswer();
    const { reply } = fakeReply();

    const run = asking(controller, USER, reply);
    await atGate;
    const result = await controller.stop({ requestId: 'req-12345678' }, { principal: { user: OTHER } } as never);
    release();
    await run;

    expect(result).toEqual({ stopped: false });
    expect(chat.discardTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The service: what is charged, and what is replaced
// ---------------------------------------------------------------------------

function service() {
  let n = 0;
  const chats = {
    findThread: jest.fn().mockResolvedValue({ id: 'thread-1', title: 'New chat' }),
    createThread: jest.fn(),
    autoTitle: jest.fn().mockResolvedValue(undefined),
    deleteFromMessage: jest.fn().mockResolvedValue(2),
    deleteMessages: jest.fn().mockResolvedValue(2),
    recentTurns: jest.fn().mockResolvedValue([]),
    appendMessage: jest.fn(async (input: { role: string; content: string }) => ({
      id: `msg-${++n}`, role: input.role, content: input.content, intent: null, citations: [],
      structured: null, credits_charged: 0, guardrail_flagged: false, error_detail: null, created_at: new Date(),
    }) as unknown as ChatMessageRow),
  };
  const intents = {
    classify: jest.fn().mockResolvedValue({
      intent: 'SECTION_LOOKUP', language: 'en', cnrNumber: null, sectionNumber: null,
      actCode: null, searchQuery: 'q', confidence: 0.9,
    }),
  };
  const credits = {
    spend: jest.fn().mockResolvedValue({ allowed: true, charged: 2, replay: false, balance: { total: 8 } }),
    peek: jest.fn().mockResolvedValue({ total: 8 }),
    refund: jest.fn().mockResolvedValue(undefined),
  };
  const rag = {
    answer: jest.fn().mockResolvedValue({
      text: 'An answer.', citations: [], passages: [], statutes: [], model: 'm', inputTokens: 0,
      outputTokens: 0, latencyMs: 1, guardrailTriggered: false, guardrailReason: null, mocked: false,
    }),
  };

  const chat = new ChatService(
    chats as never, intents as never, rag as never, {} as never, {} as never,
    credits as never, { recordSearch: jest.fn() } as never, {} as never, { isFullyMocked: false } as never,
    { find: jest.fn().mockResolvedValue(null) } as never,
  );
  return { chat, chats, credits };
}

async function drain(events: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('the charge, when Stop comes first', () => {
  it('is never taken when Stop lands while the question is being read', async () => {
    const { chat, credits } = service();

    const events = await drain(chat.ask({ user: USER, threadId: 'thread-1', question: 'q', stopped: () => true }));

    expect(credits.spend).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).not.toContain('answer');
  });

  it('is refunded, by the question it was charged for', async () => {
    const { chat, chats, credits } = service();

    await chat.discardTurn({ user: USER, threadId: 'thread-1', userMessageId: 'msg-1', messageIds: ['msg-1', 'msg-2'] });

    expect(credits.refund).toHaveBeenCalledWith(USER.id, USER.role, 'spend:web:msg-1', expect.any(String));
    expect(chats.deleteMessages).toHaveBeenCalledWith(USER.id, 'thread-1', ['msg-1', 'msg-2']);
  });
});

describe('an edited question', () => {
  it('replaces the turn it was edited from, before it is asked', async () => {
    const { chat, chats } = service();

    await drain(chat.ask({
      user: USER, threadId: 'thread-1', question: 'the corrected question',
      replaceMessageId: '33333333-3333-3333-3333-333333333333',
    }));

    expect(chats.deleteFromMessage).toHaveBeenCalledWith(USER.id, 'thread-1', '33333333-3333-3333-3333-333333333333');
    expect(chats.deleteFromMessage.mock.invocationCallOrder[0])
      .toBeLessThan(chats.appendMessage.mock.invocationCallOrder[0]);
  });

  it('is charged like any other question', async () => {
    // The answer it replaces was delivered. Refunding it would make "edit" a
    // way to read answers for nothing.
    const { chat, credits } = service();

    await drain(chat.ask({
      user: USER, threadId: 'thread-1', question: 'q2',
      replaceMessageId: '33333333-3333-3333-3333-333333333333',
    }));

    expect(credits.spend).toHaveBeenCalledTimes(1);
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a message id rather than failing the question', async () => {
    const { reply } = fakeReply();
    const chat = { ask: jest.fn(async function* (_input: unknown) { /* nothing */ }), discardTurn: jest.fn() };
    const controller = new ChatController(chat as never, {} as never, {} as never);

    await controller.ask(
      { question: 'q', replaceMessageId: "x'; drop table chat_messages; --" },
      { principal: { user: USER } } as never,
      reply as never,
    );

    expect(chat.ask.mock.calls[0][0]).toMatchObject({ replaceMessageId: null });
  });
});
