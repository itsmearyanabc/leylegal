import { EventEmitter } from 'node:events';
import { UserRow } from '../database/types';
import { ChatAdmissionMiddleware } from './chat-admission.service';
import { ChatController } from './chat.controller';
import { ChatEvent } from './chat.service';

/**
 * Load shedding on POST /api/chat/ask.
 *
 * Measured before this existed: 1,000 simultaneous askers produced no answers
 * at all, because every question started work, queued for the database, and
 * kept running after its asker gave up. These pin down what prevents that -
 * the slot is taken at the door, before the session lookup, and held until the
 * response ends; the excess is refused with no work done; and nothing is
 * started for someone who has already left.
 */

/** A raw response: an emitter with the three things the middleware touches. */
function rawRes() {
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    body: '',
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    end: jest.fn((b?: string) => {
      res.body = b ?? '';
      res.emit('close');
    }),
  });
  return { res, headers };
}

function middlewareWith(enter: jest.Mock) {
  return new ChatAdmissionMiddleware({ enter } as never);
}

describe('admission at the door', () => {
  it('refuses with 503, Retry-After and BUSY, and never reaches auth or the handler', async () => {
    const { res, headers } = rawRes();
    const next = jest.fn();

    await middlewareWith(jest.fn().mockResolvedValue(null)).use({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(headers['retry-after']).toBe('5');
    expect(JSON.parse(res.body).error.code).toBe('BUSY');
  });

  it('lets an admitted request through and holds the slot until the response closes', async () => {
    const release = jest.fn();
    const { res } = rawRes();
    const next = jest.fn();

    await middlewareWith(jest.fn().mockResolvedValue(release)).use({} as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled(); // still answering

    res.emit('close');
    res.emit('close');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('tells the gate when the client has gone, so its place in line is not wasted', async () => {
    const enter = jest.fn().mockResolvedValue(() => undefined);
    const { res } = rawRes();

    await middlewareWith(enter).use({} as never, res as never, jest.fn());
    const abandoned = enter.mock.calls[0][0] as () => boolean;

    expect(abandoned()).toBe(false);
    res.emit('close');
    expect(abandoned()).toBe(true);
  });

  it('sends nothing to a client that left while waiting and was then refused', async () => {
    let decide!: (v: null) => void;
    const enter = jest.fn(() => new Promise<null>((r) => (decide = r)));
    const { res } = rawRes();
    const next = jest.fn();

    const pending = middlewareWith(enter).use({} as never, res as never, next);
    res.emit('close');
    decide(null);
    await pending;

    expect(res.end).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('gives the slot straight back when the client left just as it was granted', async () => {
    let grant!: (v: () => void) => void;
    const enter = jest.fn(() => new Promise<() => void>((r) => (grant = r)));
    const release = jest.fn();
    const { res } = rawRes();
    const next = jest.fn();

    const pending = middlewareWith(enter).use({} as never, res as never, next);
    res.emit('close');
    grant(release);
    await pending;

    expect(next).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('a question whose client left before any work began', () => {
  const USER = { id: 'user-1', role: 'GUEST_LAWYER' } as unknown as UserRow;

  function fakeReply() {
    const listeners: Record<string, () => void> = {};
    const written: ChatEvent[] = [];
    const raw = {
      writeHead: jest.fn(),
      on: jest.fn((event: string, fn: () => void) => {
        listeners[event] = fn;
      }),
      write: jest.fn((chunk: string) => {
        written.push(JSON.parse(chunk.replace(/^data: /, '')));
      }),
      end: jest.fn(),
    };
    const reply = { raw, status: jest.fn().mockReturnThis(), header: jest.fn().mockReturnThis(), send: jest.fn() };
    return { reply, written, disconnect: () => listeners.close?.() };
  }

  function build() {
    const chat = {
      ask: jest.fn(async function* (input: { stopped: () => boolean }): AsyncGenerator<ChatEvent> {
        yield { type: 'thread', threadId: 't1', title: 'q' };
        yield { type: 'message', message: { id: 'q1', role: 'user' } as never };
        if (input.stopped()) return;
        yield { type: 'answer', message: { id: 'a1', role: 'assistant' } as never, credits: {} as never, charged: 2 };
      }),
      discardTurn: jest.fn().mockResolvedValue(undefined),
    };
    return { controller: new ChatController(chat as never, {} as never, {} as never), chat };
  }

  const ask = (controller: ChatController, reply: unknown) =>
    controller.ask(
      { question: 'what is 302 ipc', requestId: 'req-12345678' },
      { principal: { user: USER } } as never,
      reply as never,
    );

  it('stops the pipeline and removes the lone question', async () => {
    const { controller, chat } = build();
    const gone = fakeReply();
    chat.ask.mockImplementationOnce(async function* (input: { stopped: () => boolean }) {
      yield { type: 'thread', threadId: 't1', title: 'q' };
      yield { type: 'message', message: { id: 'q1', role: 'user' } as never };
      gone.disconnect();
      if (input.stopped()) return;
      throw new Error('work began for a client that had left');
    } as never);

    await ask(controller, gone.reply);

    expect(chat.discardTurn).toHaveBeenCalledWith(expect.objectContaining({ userMessageId: 'q1' }));
    expect(gone.reply.raw.end).not.toHaveBeenCalled();
  });

  it('keeps an answer that was delivered', async () => {
    const { controller, chat } = build();
    const here = fakeReply();

    await ask(controller, here.reply);

    expect(here.written.map((e) => e.type)).toContain('answer');
    expect(chat.discardTurn).not.toHaveBeenCalled();
  });
});
