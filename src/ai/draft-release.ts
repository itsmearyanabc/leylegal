import { referenceSpans } from './legal-patterns';

/**
 * Showing an answer while the model is still writing it - without showing
 * anything the citation check has not passed.
 *
 * ## Why
 *
 * Measured on leylegal.in on 4 October, the model writing a section answer
 * took p50 1.8 s of a 3.2 s answer, and the advocate saw nothing until the
 * last word was written and checked. Showing the text as it is written cuts
 * that wait to the first line.
 *
 * ## What may be shown, and when
 *
 * The citation check (GuardrailsService) is the product's load-bearing safety
 * control, and it runs on finished text. So text is shown a whole line at a
 * time, and only:
 *
 *   - once enough has been written after the line (DRAFT_LOOKAHEAD) to see
 *     whether a citation or section reference runs on across its end - none
 *     may, or the line waits for the rest of that reference;
 *   - after every reference in it has been looked up exactly as the check on
 *     the finished answer looks it up, and every one that fails has been
 *     struck the same way (GuardrailsService.verifiedDraft).
 *
 * The finished answer is then checked whole, as before, and that text is the
 * one shown and kept. A draft is never more than an earlier view of it.
 */

/** Characters that must follow a line before it is shown - longer than any reference's run onto the next line. */
export const DRAFT_LOOKAHEAD = 24;

/**
 * How much of the text written so far may be checked and shown: up to the end
 * of the last line with DRAFT_LOOKAHEAD characters after it, and back to the
 * start of the line of any reference that runs across that end.
 */
export function releasableEnd(written: string): number {
  if (written.length <= DRAFT_LOOKAHEAD) return 0;
  let end = written.lastIndexOf('\n', written.length - DRAFT_LOOKAHEAD - 1) + 1;
  if (end <= 0) return 0;

  const spans = referenceSpans(written);
  for (;;) {
    const across = spans.find((span) => span.start < end && span.end >= end);
    if (!across) return end;
    end = written.lastIndexOf('\n', across.start - 1) + 1;
    if (end <= 0) return 0;
  }
}

/**
 * Shows an answer's checked lines as the model writes them.
 *
 * `offer` is called with all the text written so far, after every piece of it
 * arrives; an empty string means the writing started over (the stream failed
 * and the answer is being written again in one piece), and withdraws what was
 * shown. `close` stops it before the finished answer is sent, so no draft can
 * arrive after the answer it is a draft of.
 */
export class DraftReleaser {
  private written = '';
  private shownUpTo = 0;
  private round = 0;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly known = new Map<string, boolean>();

  constructor(
    private readonly check: (prefix: string, known: Map<string, boolean>) => Promise<string>,
    private readonly show: (draft: string) => void,
  ) {}

  offer(written: string): void {
    if (this.stopped) return;

    if (written === '') {
      this.round += 1;
      this.written = '';
      if (this.shownUpTo > 0) {
        this.shownUpTo = 0;
        this.show('');
      }
      return;
    }

    this.written = written;
    if (!this.running) this.running = this.pump().finally(() => (this.running = null));
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const round = this.round;
      const end = releasableEnd(this.written);
      if (end <= this.shownUpTo) return;

      let draft: string;
      try {
        draft = await this.check(this.written.slice(0, end), this.known);
      } catch {
        // A line that could not be checked is never shown, and nor is anything
        // after it: the finished answer, checked whole, still arrives.
        this.stopped = true;
        return;
      }

      if (this.stopped) return;
      if (round !== this.round) continue;
      this.shownUpTo = end;
      this.show(draft);
    }
  }
}
