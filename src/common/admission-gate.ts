/**
 * Admission control: at most `limit` pieces of work at once, a short bounded
 * line behind them, and an immediate "no" beyond that.
 *
 * ## Why this exists
 *
 * Without it, every question asked on the web started work at once and queued
 * for the database pool. Measured on the production configuration: past about
 * 250 simultaneous askers the queue grew faster than it drained, answers took
 * longer than anyone waits, people gave up - and their abandoned questions kept
 * running, holding the pool for the next ones. At 1,000 askers nothing was
 * answered, and after the load stopped the server needed an estimated 45
 * minutes to work through the backlog.
 *
 * A server that refuses the excess stays fast for the ones it admits. The
 * refusal is cheap (no database, no model, no charge) and honest (the client is
 * told to try again in a few seconds), which is strictly better than accepting
 * a question it cannot answer in time.
 *
 * ## Shape
 *
 * `acquire()` resolves to a release function, or `null` when refused - either
 * immediately because the line is full, or after `waitTimeoutMs` in line. A
 * released slot passes straight to the next live waiter, so the count of work
 * in progress never dips and re-rises between them.
 *
 * Deliberately no Nest and no timers beyond the wait timeout, so the behaviour
 * is pinned down by plain unit tests.
 */
export interface AdmissionStats {
  limit: number;
  maxWaiting: number;
  waitTimeoutMs: number;
  inFlight: number;
  waiting: number;
  admitted: number;
  refused: number;
  timedOut: number;
}

interface Waiter {
  grant: (release: (() => void) | null) => void;
  abandoned?: () => boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class AdmissionGate {
  private inFlight = 0;
  private readonly line: Waiter[] = [];
  private admitted = 0;
  private refused = 0;
  private timedOut = 0;

  constructor(
    readonly limit: number,
    readonly maxWaiting: number,
    readonly waitTimeoutMs: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('AdmissionGate limit must be a positive integer');
    if (!Number.isInteger(maxWaiting) || maxWaiting < 0) throw new Error('AdmissionGate maxWaiting must be >= 0');
  }

  /**
   * Take a slot. `abandoned` lets a waiter who has gone away (the client
   * disconnected while in line) give up its place instead of being handed a
   * slot nobody will use.
   */
  acquire(abandoned?: () => boolean): Promise<(() => void) | null> {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      this.admitted++;
      return Promise.resolve(this.releaser());
    }

    if (this.line.length >= this.maxWaiting) {
      this.refused++;
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        grant: resolve,
        abandoned,
        timer: setTimeout(() => {
          const index = this.line.indexOf(waiter);
          if (index === -1) return;
          this.line.splice(index, 1);
          this.timedOut++;
          this.refused++;
          resolve(null);
        }, this.waitTimeoutMs),
      };
      waiter.timer.unref?.();
      this.line.push(waiter);
    });
  }

  stats(): AdmissionStats {
    return {
      limit: this.limit,
      maxWaiting: this.maxWaiting,
      waitTimeoutMs: this.waitTimeoutMs,
      inFlight: this.inFlight,
      waiting: this.line.length,
      admitted: this.admitted,
      refused: this.refused,
      timedOut: this.timedOut,
    };
  }

  /** A release function that works once, however many times it is called. */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      // Hand the slot to the next waiter who is still there. One who left is
      // told no and skipped, so the slot is not spent on an empty connection.
      while (this.line.length > 0) {
        const next = this.line.shift()!;
        clearTimeout(next.timer);
        if (next.abandoned?.()) {
          next.grant(null);
          continue;
        }
        this.admitted++;
        next.grant(this.releaser());
        return;
      }

      this.inFlight--;
    };
  }
}
