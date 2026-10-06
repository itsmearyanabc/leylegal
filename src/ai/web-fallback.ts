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
- Do not name the judges or describe the bench.
- If the pages you find do not answer the question - including when the case or citation asked for cannot be found - reply with exactly: NO_RESULT`;

/**
 * The most volumes of Supreme Court Cases (SCC) any year could have.
 *
 * EBC's own catalogue (August 2026) lists 13-20 bound volumes a year for
 * 2009-2024 - 20 in each year from 2019 to 2024 - and 10 for 2025 and for 2026.
 * 25 leaves a margin, so a real citation is never refused; "(2022) 40 SCC 404"
 * and "(2023) 99 SCC 1" still are.
 */
export const SCC_MAX_VOLUMES = 25;

/** Law reports whose citations carry a year. */
const REPORTER = '(?:SCC|SCR|SCALE|SCJ|JT|INSC|Cri\\.?\\s*L\\.?\\s*J|DLT|Supp)';

/** The year in India, where every citation is dated. */
function indianYear(now: Date): number {
  return Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(now));
}

/**
 * Why a citation in the question cannot exist - or null when every citation in
 * it could.
 *
 * ## Why
 *
 * Live test of 4 October 2026: asked about "(2022) 40 SCC 404", the web search
 * answered that the citation "corresponds to" another case, and for
 * "(2028) 1 SCC 1" it offered a different, real case instead. The rule against
 * that in INSTRUCTIONS was already there; the model ignored it. A prompt is a
 * request, not a check. A citation that cannot exist is now refused here,
 * before any search, so there is nothing for the model to fill in.
 *
 * Only two rules, both certain: a year still in the future, and an SCC volume
 * no year has. Anything less certain (AIR page numbers, INSC numbers) is left
 * to the search - refusing a real citation would be its own wrong answer.
 */
export function impossibleCitation(text: string, now: Date = new Date()): string | null {
  const thisYear = indianYear(now);

  // (2022) 40 SCC 404  /  2022 (40) SCC 404
  const scc = /\(\s*(\d{4})\s*\)\s*(\d{1,3})\s*SCC\b|\b(\d{4})\s*\(\s*(\d{1,3})\s*\)\s*SCC\b/gi;
  for (const match of text.matchAll(scc)) {
    const volume = Number(match[2] ?? match[4]);
    if (volume > SCC_MAX_VOLUMES) {
      return `no year of the Supreme Court Cases (SCC) reports has a volume ${volume}`;
    }
  }

  // A year inside a citation: (2028) 1 SCC 1, AIR 2031 SC 5, 2027 INSC 12,
  // 2029 SCC OnLine SC 3. Only next to a reporter's name, so a year in an
  // ordinary sentence ("pending since (2027) ...") is not read as a citation.
  // AIR is followed by its court and page (AIR 1962 SC 605, AIR 1962 SUPREME
  // COURT 605): "air" before a year is a word too, as in "clean air 2030".
  const dated = new RegExp(
    `\\(\\s*(\\d{4})\\s*\\)\\s*(?:Supp\\s*)?(?:\\(\\s*\\d+\\s*\\)\\s*)?\\d*\\s*${REPORTER}\\b` +
      `|\\bAIR\\s+(\\d{4})\\s+(?:[A-Za-z][A-Za-z.&]{0,12}\\s*){1,2}\\d{1,5}\\b` +
      `|\\b(\\d{4})\\s+(?:INSC|SCC\\s+OnLine|Supp)\\b` +
      `|\\b(\\d{4})\\s*\\(\\s*\\d{1,3}\\s*\\)\\s*${REPORTER}\\b`,
    'gi',
  );
  for (const match of text.matchAll(dated)) {
    const year = Number(match[1] ?? match[2] ?? match[3] ?? match[4]);
    if (year > thisYear) return `${year} is still in the future`;
  }
  return null;
}

/**
 * The model saying it could not find what was asked - and then, often, going
 * on to describe something else.
 *
 * Live test of 4 October 2026: "I couldn't locate a case titled 'Laxmi Narayan
 * v. State' with the citation '(2028) 1 SCC 1.' The most recent Supreme Court
 * case involving Laxmi Narayan is ..." and "I couldn't find a Supreme Court
 * judgment titled 'Rajendra Kumar v Union of India' ... The citation '40 SCC
 * 404' corresponds to ... 'Raj Kumar v Union of India'". The instructions say
 * to answer NO_RESULT in exactly that case. An answer that admits the search
 * failed is treated as NO_RESULT, whatever follows the admission.
 *
 * Narrow on purpose: first person ("I couldn't find") or about the case or
 * citation itself, so a holding such as "the court could not find any evidence
 * of cruelty" is not mistaken for one.
 */
const NOT_FOUND: RegExp[] = [
  /\bI\s+(?:could\s*not|couldn['’]t|was\s+(?:not\s+able|unable)\s+to|am\s+(?:not\s+able|unable)\s+to|cannot|can['’]t|did\s+not|didn['’]t)\s+(?:find|locate|identify|trace|confirm|verify)\b/i,
  /\b(?:case|judgment|judgement|citation|decision)\b[^.]{0,80}?\b(?:could\s*not|couldn['’]t|cannot|can['’]t)\s+be\s+(?:found|located|traced|identified|verified|confirmed)\b/i,
  /\b(?:case|judgment|judgement|citation|decision)\b[^.]{0,60}?\bdoes\s+not\s+(?:appear\s+to\s+)?exist\b/i,
  /\bno\s+(?:such\s+)?(?:record|trace)\s+of\s+(?:a|an|the|any)?\s*(?:\w+\s+){0,3}?(?:case|judgment|judgement|citation|decision)\b/i,
  /\b(?:there\s+is\s+)?no\s+such\s+(?:case|judgment|judgement|citation|decision)\b/i,
];

export function admitsNotFound(text: string): boolean {
  return NOT_FOUND.some((pattern) => pattern.test(text));
}

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

type OutputText = { type: string; text?: unknown; annotations?: unknown };

/** The output_text parts of the messages in a Responses API output. */
function outputTexts(payload: unknown): OutputText[] {
  const output = (payload as { output?: unknown })?.output;
  if (!Array.isArray(output)) return [];
  return output
    .filter((item): item is { type: string; content?: unknown } => !!item && (item as { type?: unknown }).type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part): part is OutputText => !!part && part.type === 'output_text');
}

function textOf(parts: OutputText[]): string {
  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
}

/**
 * The Responses API output to text and sources - or null when it found nothing
 * it can cite. Output items: a web_search_call, then a message whose
 * output_text parts carry the text and url_citation annotations.
 */
export function parseWebAnswer(payload: unknown): UnverifiedInfo | null {
  const parts = outputTexts(payload);
  const text = textOf(parts);
  // "I couldn't find X. ... Y" is NO_RESULT followed by a substitute: see admitsNotFound.
  if (!text || /\bNO_RESULT\b/.test(text) || admitsNotFound(text)) return null;

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
    // A citation that cannot exist is not searched for: whatever the web
    // "finds" for it is another case (see impossibleCitation).
    const impossible = kind === 'judgment' ? impossibleCitation(question) : null;
    if (impossible) {
      this.logger.info({ kind, impossible }, 'Web search skipped: the citation cannot exist');
      return null;
    }
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
      const payload: unknown = await response.json();
      const found = parseWebAnswer(payload);
      // An answer dropped only for admitting the case was not found is logged
      // with its opening words, so a real answer lost to admitsNotFound shows.
      const text = found ? '' : textOf(outputTexts(payload));
      const droppedAsNotFound = text && !/\bNO_RESULT\b/.test(text) && admitsNotFound(text) ? text.slice(0, 300) : undefined;
      this.logger.info(
        { kind, found: found !== null, sources: found?.sources.length ?? 0, ms: Date.now() - started, ...(droppedAsNotFound ? { droppedAsNotFound } : {}) },
        'Web search for unverified information',
      );
      return found;
    } catch (err) {
      this.logger.warn({ kind, err: err instanceof Error ? err.message : String(err), ms: Date.now() - started }, 'Web search failed');
      return null;
    }
  }
}
