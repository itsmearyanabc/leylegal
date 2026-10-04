import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';

/**
 * Unverified information from the web, when every verified source is empty.
 *
 * ## Why
 *
 * Ley Legal answers from what it can check: its own database of Acts, Indian
 * Kanoon and eCourts. When all three have nothing the reply was "not
 * available" - true, and of no use to an advocate who then found the answer in
 * a Delhi courts e-filing list through a general chatbot. The founder's call:
 * show what the web has, kept apart from the answer and marked unverified, and
 * charge one credit for it.
 *
 * ## What keeps it honest
 *
 * - **The web, not the model's memory.** OpenAI's web_search tool, forced on,
 *   and only what the pages it cites say. Memory is how "Section 520 BNSS" was
 *   once answered with a different section altogether.
 * - **A source for every point, or nothing.** An answer with no url_citation is
 *   discarded, as is "NO_RESULT" - the reply stays "not available".
 * - **Apart and labelled.** Shown after the verified answer, never inside it,
 *   with the note below, and never run through the guardrail that would strip
 *   exactly what was found: it is marked as unchecked instead.
 * - **Only after the verified sources** - a section with no official text, a
 *   judgment neither Kanoon nor eCourts has, a CNR eCourts does not know.
 */

export type WebFallbackKind = 'provision' | 'judgment' | 'cnr';

export interface WebSource {
  title: string;
  url: string;
}

export interface UnverifiedInfo {
  /** What the cited pages say, with inline citations as [title](url). */
  text: string;
  sources: WebSource[];
  /** {@link UNVERIFIED_NOTE}, carried with it so both channels say exactly that. */
  note: string;
}

/** Said with every unverified answer, on both channels. */
export const UNVERIFIED_NOTE =
  "This information is not verified against Ley Legal's database. It was found on the internet and is a likely " +
  'possibility, not a confirmed record - open the sources and check it before relying on it.';

/**
 * What a question with no verified answer cost, said after it: nothing, or the
 * credit for the unverified information below.
 */
export function costLine(charged: number, unverified: boolean): string {
  if (unverified && charged > 0) return `${charged} credit${charged === 1 ? ' was' : 's were'} charged for the unverified information below.`;
  return 'No credits were charged for this question.';
}

const INSTRUCTIONS = `You help Indian advocates. Ley Legal's verified sources - its database of Acts, Indian Kanoon and eCourts - had nothing for this question, so you search the web.

- Answer in at most 120 words, in English, from the pages you cite and nothing else.
- Cite a source for every fact.
- Prefer official sources: court websites (sci.gov.in, ecourts.gov.in, High Court and district court sites), indiacode.nic.in, egazette.gov.in.
- Never state a section number, case name, citation, date, party or outcome that is not in a page you cite. Do not fill gaps.
- Answer about the case or provision asked for, and nothing else. Never offer a different case, a "similar" case or a corrected citation in its place.
- Indian law only: leave out anything about other countries.
- If the pages you find do not answer the question - including when the case or citation asked for cannot be found - reply with exactly: NO_RESULT`;

function task(kind: WebFallbackKind, question: string, detail: string | null): string {
  const asked = `The advocate asked: ${question}`;
  switch (kind) {
    case 'provision':
      return `Find the text of this provision of Indian law, or a reliable summary of what it says${detail ? ` (${detail})` : ''}.\n\n${asked}`;
    case 'judgment':
      return `Find this judgment or case of an Indian court${detail ? ` (${detail})` : ''}: the court, the date, the case number or citation, and what was decided.\n\n${asked}`;
    case 'cnr':
      return `Find the court case with CNR number ${detail ?? ''} on Indian court websites: the parties, the court, the case number, its status and its next or last hearing date.\n\n${asked}`;
  }
}

/** The Responses API request - exported so the capture used in tests is this exact body. */
export function webSearchRequest(model: string, kind: WebFallbackKind, question: string, detail: string | null = null) {
  return {
    model,
    instructions: INSTRUCTIONS,
    input: task(kind, question, detail),
    tools: [
      {
        type: 'web_search',
        search_context_size: 'low',
        user_location: { type: 'approximate', country: 'IN', timezone: 'Asia/Kolkata' },
      },
    ],
    // Forced: with "auto" the model may answer from memory without searching.
    tool_choice: 'required',
    max_output_tokens: 600,
  };
}

/**
 * The Responses API output to text and sources - or null when it found nothing
 * it can cite. Output items: a web_search_call, then a message whose
 * output_text parts carry the text and url_citation annotations.
 */
export function parseWebAnswer(payload: unknown): UnverifiedInfo | null {
  const output = (payload as { output?: unknown })?.output;
  if (!Array.isArray(output)) return null;

  const parts = output
    .filter((item): item is { type: string; content?: unknown } => !!item && (item as { type?: unknown }).type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part): part is { type: string; text?: unknown; annotations?: unknown } => !!part && part.type === 'output_text');

  const text = parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
  if (!text || /\bNO_RESULT\b/.test(text)) return null;

  const seen = new Set<string>();
  const sources: WebSource[] = [];
  for (const part of parts) {
    for (const a of Array.isArray(part.annotations) ? part.annotations : []) {
      const url = typeof a?.url === 'string' ? a.url.trim() : '';
      if (a?.type !== 'url_citation' || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      sources.push({ title: typeof a.title === 'string' && a.title.trim() ? a.title.trim() : url, url });
    }
  }
  // No source, no answer: an uncited paragraph is the model's memory.
  if (sources.length === 0) return null;
  return { text, sources: sources.slice(0, 6), note: UNVERIFIED_NOTE };
}

@Injectable()
export class WebFallbackService {
  private readonly logger = getLogger().child({ module: 'web-fallback' });

  constructor(@InjectEnv() private readonly env: AppEnv) {}

  get isEnabled(): boolean {
    return this.env.WEB_FALLBACK === 'on' && this.env.OPENAI_API_KEY !== '';
  }

  /**
   * What the web says, with sources - or null: switched off, nothing citable
   * found, or the search failed. A null leaves the reply exactly as it was.
   */
  async find(kind: WebFallbackKind, question: string, detail: string | null = null): Promise<UnverifiedInfo | null> {
    if (!this.isEnabled) return null;
    const started = Date.now();
    const base = (this.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

    try {
      const response = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
        body: JSON.stringify(webSearchRequest(this.env.WEB_SEARCH_MODEL, kind, question, detail)),
        signal: AbortSignal.timeout(this.env.WEB_FALLBACK_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.warn({ kind, status: response.status, body: body.slice(0, 300) }, 'Web search failed');
        return null;
      }
      const found = parseWebAnswer(await response.json());
      this.logger.info({ kind, found: found !== null, sources: found?.sources.length ?? 0, ms: Date.now() - started }, 'Web search for unverified information');
      return found;
    } catch (err) {
      this.logger.warn({ kind, err: err instanceof Error ? err.message : String(err), ms: Date.now() - started }, 'Web search failed');
      return null;
    }
  }
}
