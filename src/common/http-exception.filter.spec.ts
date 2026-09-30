import { BadRequestException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';

/**
 * What status a failure is reported with.
 *
 * The case that earned this file: the rate limiter refuses an over-eager
 * address with a plain Error carrying statusCode 429, and this filter reported
 * it as 500. Ten clients on one laptop were answered with thousands of
 * "Internal Server Error"s a second, which reads as a crashed server to anyone
 * load-testing it.
 */
describe('AllExceptionsFilter', () => {
  function run(exception: unknown) {
    const reply = { statusCode: 0, body: undefined as unknown, status: jest.fn(), send: jest.fn() };
    reply.status.mockImplementation((code: number) => {
      reply.statusCode = code;
      return reply;
    });
    reply.send.mockImplementation((body: unknown) => {
      reply.body = body;
      return reply;
    });
    const host = {
      switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ method: 'GET', url: '/' }) }),
    };
    new AllExceptionsFilter().catch(exception, host as never);
    return { status: reply.statusCode, body: reply.body as { error: { code: string; message: string } } };
  }

  const withStatus = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

  it('reports the rate limiter as 429, not 500', () => {
    const { status, body } = run(withStatus('Rate limit exceeded, retry in 1 minute', 429));
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toBe('Rate limit exceeded, retry in 1 minute');
  });

  it('keeps the status of other framework errors (body too large, bad JSON)', () => {
    expect(run(withStatus('Request body is too large', 413)).status).toBe(413);
    expect(run(withStatus('Unexpected token } in JSON', 400)).status).toBe(400);
  });

  it('still hides the detail of a real 500', () => {
    const { status, body } = run(new Error('connection terminated unexpectedly'));
    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.error.message).not.toContain('connection terminated');
  });

  it('does not trust a statusCode outside the error range', () => {
    expect(run(withStatus('odd', 200)).status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(run({ statusCode: 429 }).status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('leaves Nest HttpExceptions as they were', () => {
    const { status, body } = run(new BadRequestException({ code: 'EMPTY', message: 'Type a question first.' }));
    expect(status).toBe(HttpStatus.BAD_REQUEST);
    expect(body.error.code).toBe('EMPTY');
  });
});
