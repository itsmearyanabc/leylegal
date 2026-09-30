import { Injectable, Module, NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AdmissionGate, AdmissionStats } from '../common/admission-gate';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';

/** One warning per window while refusing, never one per refused question. */
const LOG_WINDOW_MS = 10_000;

/** Seconds a refused client is told to wait before sending again. */
export const BUSY_RETRY_AFTER_SECONDS = 5;

/** The refusal body, shared by both places that refuse. */
export const BUSY_BODY = {
  success: false,
  error: {
    code: 'BUSY',
    message:
      'Ley Legal is answering a lot of questions right now. Nothing was charged - please send it again in a few seconds.',
  },
} as const;

/**
 * The admission gate for web answers, shared by the middleware (which takes
 * and holds the slots) and the admin panel (which reports on them).
 *
 * Limits come from the environment - CHAT_MAX_CONCURRENT, CHAT_MAX_WAITING,
 * CHAT_WAIT_TIMEOUT_MS - with defaults derived from the database pool, because
 * the pool is what a slot actually spends.
 */
@Injectable()
export class ChatAdmission {
  private readonly logger = getLogger().child({ module: 'chat:admission' });
  private readonly gate: AdmissionGate;
  private refusedSinceLog = 0;
  private lastLogAt = 0;

  constructor(@InjectEnv() env: AppEnv) {
    this.gate = new AdmissionGate(env.chatMaxConcurrent, env.chatMaxWaiting, env.CHAT_WAIT_TIMEOUT_MS);
  }

  /**
   * A release function, or null when the server is too busy to take this
   * question. `abandoned` reports whether the client has already gone.
   */
  async enter(abandoned?: () => boolean): Promise<(() => void) | null> {
    const release = await this.gate.acquire(abandoned);
    if (!release && !abandoned?.()) this.noteRefusal();
    return release;
  }

  stats(): AdmissionStats {
    return this.gate.stats();
  }

  private noteRefusal(): void {
    this.refusedSinceLog++;
    const now = Date.now();
    if (now - this.lastLogAt < LOG_WINDOW_MS) return;

    this.logger.warn(
      { refusedInWindow: this.refusedSinceLog, ...this.gate.stats() },
      'Busy: refusing web questions beyond the admission limit',
    );
    this.refusedSinceLog = 0;
    this.lastLogAt = now;
  }
}

/**
 * Admission for POST /api/chat/ask, decided at the door.
 *
 * The slot is taken here - before the session lookup, before any database work
 * at all - and held until the response finishes or the client disconnects.
 * Middleware runs before guards, which is the whole point.
 *
 * ## Why at the door, and not in the handler
 *
 * Measured, twice. With the gate inside the handler, every question paid for
 * UserAuthGuard's session lookup before it could be refused, and at 250
 * simultaneous askers those lookups alone used up the database pool: answers
 * fell from 144 to 44 a minute. A pre-check here that refused only when the
 * line was full did not help (42 a minute), because requests that had passed
 * the check but were still inside the lookup were invisible to it - at ~50
 * arrivals a second dozens were always in that gap.
 *
 * Holding the slot from the door closes the gap: a refused or waiting request
 * does no database work, and the session lookup runs only for the requests
 * actually being answered.
 */
@Injectable()
export class ChatAdmissionMiddleware implements NestMiddleware {
  constructor(private readonly admission: ChatAdmission) {}

  async use(_req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    let open = true;
    res.on('close', () => {
      open = false;
    });

    const release = await this.admission.enter(() => !open);
    if (!release) {
      if (!open) return;
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('retry-after', String(BUSY_RETRY_AFTER_SECONDS));
      res.end(JSON.stringify(BUSY_BODY));
      return;
    }

    // However the request ends - answered, 401, an error, or the client
    // leaving - the response closes, and the slot goes back exactly once.
    res.once('close', release);
    if (!open) {
      release();
      return;
    }
    next();
  }
}

/** Its own module so the web app and the admin panel share one gate. */
@Module({ providers: [ChatAdmission, ChatAdmissionMiddleware], exports: [ChatAdmission, ChatAdmissionMiddleware] })
export class ChatAdmissionModule {}
