import { PrecedentRow } from '../database/types';
import { courtFilter, isOrder } from '../kanoon/kanoon.mapper';
import { CASE_NAME_MATCH, caseNameScore, extractCaseName, samePetitioner } from './case-name';
import { parseJsonLoose } from './providers/llm-provider.interface';

/**
 * The leading judgments on a point of law: named by the model, found on Indian
 * Kanoon by title and year, or not shown at all.
 *
 * ## Why
 *
 * A research list is a keyword search, and the judgment every advocate cites
 * first is often not among its ten results. Live test of 6 October: Arnesh
 * Kumar missing from "Supreme Court guidelines on arrest for offences
 * punishable up to 7 years" (P1) and from the Hindi 498A question (P10), Gian
 * Singh and B.S. Joshi from quashing a 498A FIR on compromise (NP1), Laxman v.
 * State of Maharashtra from dying declarations (NP5), T.T. Antony from a second
 * FIR (X29). None was in the list the search returned; asked for by title on
 * Indian Kanoon, each one was found - and the year told the right Laxman from
 * another of 1973:
 *
 *   doctypes:supremecourt fromdate: 1-1-2001 todate: 31-12-2003 title: Laxman Maharashtra
 *     -> Laxman vs State Of Maharashtra, 2002 (the Constitution Bench)
 *
 * which is what an advocate does: recall the leading case, then look it up.
 *
 * ## What keeps it honest
 *
 * The model only names judgments to look for. What is shown is what Kanoon
 * holds - its title, date, court and text, summarised like every other card.
 * A name Kanoon does not have, or has only in another year, is dropped: the
 * same title search without the year found "Laxman And Others vs State Of
 * Maharashtra" of 1973, a different case. Nothing the model writes reaches the
 * page as a fact.
 */

/** At most this many: the leading authorities, not a second list. */
export const MAX_LEADING = 3;

export interface LeadingJudgment {
  /** As reported, petitioner first: "Arnesh Kumar v. State of Bihar". */
  name: string;
  /** The year it was delivered. */
  year: number;
  /** The court the model named, when it named one: "Supreme Court". */
  court: string | null;
}

export function buildLeadingJudgmentsPrompt(courtNamed: boolean): string {
  return `You help Indian advocates find case law. Name the leading judgments on the exact point of law in the question: the ones an experienced Indian advocate would cite first.

- At most ${MAX_LEADING}. Fewer, or none, is better than a guess: name a judgment only if you are certain it exists and decides this point.
- The case name as it is reported, petitioner first, e.g. "Arnesh Kumar v. State of Bihar".
- The year the judgment was delivered.
- ${courtNamed ? 'The advocate asked for one court: name only judgments of that court.' : 'Prefer the Supreme Court of India.'}
- Never invent a case, a party or a year.

Reply with JSON only: {"cases": [{"name": "...", "year": 2014, "court": "Supreme Court"}]}`;
}

/** The model's answer, with anything that is not a dated cause title dropped. */
export function parseLeadingJudgments(text: string, thisYear: number): LeadingJudgment[] {
  const parsed = parseJsonLoose<{ cases?: unknown }>(text);
  const list = Array.isArray(parsed?.cases) ? parsed.cases : [];
  const seen = new Set<string>();
  const out: LeadingJudgment[] = [];

  for (const item of list) {
    const entry = (item ?? {}) as { name?: unknown; year?: unknown; court?: unknown };
    const name = typeof entry.name === 'string' ? entry.name.replace(/\s+/g, ' ').trim() : '';
    const year = Number(entry.year);
    const court = typeof entry.court === 'string' && entry.court.trim() ? entry.court.trim() : null;

    if (!name || !extractCaseName(name)) continue;
    if (!Number.isInteger(year) || year < 1950 || year > thisYear) continue;
    if (seen.has(name.toLowerCase())) continue;

    seen.add(name.toLowerCase());
    out.push({ name, year, court });
    if (out.length === MAX_LEADING) break;
  }
  return out;
}

/** The court to look in: the one the advocate asked for, else the one the model named. */
function courtOf(judgment: LeadingJudgment, askedCourt: string | null): string | null {
  return askedCourt ?? (judgment.court ? courtFilter(judgment.court) : null);
}

/** A petitioner that is the State identifies nothing on its own. */
const GENERIC_PARTY = /^(?:the\s+)?(?:state|union|govt\.?|government|commissioner|central\s+bureau|cbi)\b/i;

/**
 * The Kanoon searches for one named judgment, most specific first: both
 * parties, then the petitioner alone - for a respondent Kanoon spells its own
 * way ("Govt.Of U.P." for "Government of Uttar Pradesh").
 *
 * The court and the year window go before `title:`, whose operand runs to the
 * next operator (see kanoonQueries).
 */
export function leadingJudgmentQueries(judgment: LeadingJudgment, askedCourt: string | null): string[] {
  const name = extractCaseName(judgment.name);
  if (!name) return [];

  const slug = courtOf(judgment, askedCourt);
  const scope = [
    slug ? `doctypes:${slug}` : '',
    `fromdate: 1-1-${judgment.year - 1} todate: 31-12-${judgment.year + 1}`,
  ]
    .filter(Boolean)
    .join(' ');

  const queries = [`${scope} title: ${name.petitioner} ${name.respondent}`];
  if (!GENERIC_PARTY.test(name.petitioner)) queries.push(`${scope} title: ${name.petitioner}`);
  return queries;
}

/**
 * The judgment that was named, out of a search's results - or null.
 *
 * The title must match (the petitioner alone, when that was all that was
 * searched), it must be a judgment and not an order, and it must be from the
 * year named or one either side: reported citations often carry the next year.
 * Of two that match - Lalita Kumari has a 2012 reference order and the 2013
 * Constitution Bench judgment under one title - the one the courts cite most,
 * then the one nearest the year named.
 *
 * A Supreme Court judgment must come from the Supreme Court, whatever the
 * search returned: a Patna High Court "Lalita Kumari vs The Chief Secretary"
 * of 2025 shares the petitioner's name.
 */
export function pickLeadingJudgment(
  judgment: LeadingJudgment,
  rows: PrecedentRow[],
  { askedCourt = null, petitionerOnly = false }: { askedCourt?: string | null; petitionerOnly?: boolean } = {},
): PrecedentRow | null {
  const name = extractCaseName(judgment.name);
  if (!name) return null;
  const supremeOnly = courtOf(judgment, askedCourt) === 'supremecourt';

  const year = (row: PrecedentRow): number | null => {
    if (!row.judgment_date) return null;
    const at = new Date(row.judgment_date);
    return Number.isNaN(at.getTime()) ? null : at.getUTCFullYear();
  };

  const candidates = rows.filter((row) => {
    const delivered = year(row);
    return (
      !isOrder(row) &&
      (!supremeOnly || /\bsupreme court\b/i.test(row.court_name ?? '')) &&
      delivered !== null &&
      Math.abs(delivered - judgment.year) <= 1 &&
      caseNameScore(name, row.case_title) >= CASE_NAME_MATCH &&
      (!petitionerOnly || samePetitioner(name, row.case_title))
    );
  });

  const distance = (row: PrecedentRow): number => Math.abs((year(row) ?? 0) - judgment.year);
  return (
    candidates.sort(
      (a, b) =>
        (b.cited_by ?? -1) - (a.cited_by ?? -1) || distance(a) - distance(b) || a.relevance_rank - b.relevance_rank,
    )[0] ?? null
  );
}

/** The leading judgments first, then the rest without them, to `max`. */
export function leadingFirst(leading: PrecedentRow[], rest: PrecedentRow[], max: number): PrecedentRow[] {
  const ids = new Set(leading.map((row) => row.judgment_id));
  return [...leading, ...rest.filter((row) => !ids.has(row.judgment_id))].slice(0, max);
}
