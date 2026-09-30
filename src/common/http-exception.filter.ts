import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ApiFailure } from './api-response';
import { getLogger } from './logger';

/**
 * Turns any thrown error into the standard failure envelope.
 *
 * Two rules worth keeping:
 *  - 5xx never leaks an internal message to the client. The detail goes to the
 *    logs with a request id; the caller gets that id and nothing else.
 *  - 4xx does pass the message through, because those are the caller's to fix.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = getLogger();

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest & { requestId?: string }>();
    const requestId = request?.requestId ?? randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        message = String(record.message ?? exception.message);
        code = String(record.code ?? httpStatusToCode(status));
        details = record.details;
      }
      if (code === 'INTERNAL_ERROR') code = httpStatusToCode(status);
    } else if (carriesHttpStatus(exception)) {
      /*
       * Errors raised by Fastify and its plugins before any Nest handler runs.
       *
       * The rate limiter's 429, a 413 for a body over the limit, a 400 from
       * the JSON parser: each is a plain Error with a `statusCode`, not an
       * HttpException, so this filter used to report all of them as 500. The
       * one that mattered was the rate limiter - ten clients on one laptop
       * pass 300 requests a minute in under a second, and from then on every
       * answer was "500 Internal Server Error". A server politely refusing an
       * over-eager address read, to anyone load-testing it, as a server that
       * had fallen over.
       */
      status = exception.statusCode;
      code = httpStatusToCode(status);
      if (status < 500) message = exception.message;
    }

    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      // Not a warning per request: a client that ignores its 429s produces
      // thousands a second, and logging each one turns a refused flood into a
      // full disk. The limiter's own headers tell the client when to retry.
      this.logger.debug({ requestId, url: request?.url }, 'Rate limited');
    } else if (status >= 500) {
      this.logger.error(
        {
          requestId,
          method: request?.method,
          url: request?.url,
          err: exception instanceof Error ? { message: exception.message, stack: exception.stack } : exception,
        },
        'Unhandled exception',
      );
      // Deliberately generic - the detail is in the logs, keyed by requestId.
      message = 'An unexpected error occurred. Quote the request id when reporting this.';
      details = undefined;
    } else {
      this.logger.warn(
        { requestId, method: request?.method, url: request?.url, status, code },
        'Request failed',
      );
    }

    const payload: ApiFailure = {
      success: false,
      error: { code, message, ...(details !== undefined ? { details } : {}) },
      meta: { response_time_ms: 0, request_id: requestId },
    };

    void reply.status(status).send(payload);
  }
}

/** A plain error that already knows its HTTP status - Fastify's convention. */
function carriesHttpStatus(exception: unknown): exception is Error & { statusCode: number } {
  const statusCode = (exception as { statusCode?: unknown } | null)?.statusCode;
  return exception instanceof Error && typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599;
}

function httpStatusToCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR';
  }
}
