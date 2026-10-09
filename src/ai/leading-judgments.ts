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

/** The earliest year a judgment named is believed: the Privy Council and the old High Courts are on Kanoon. */
const EARLIEST_YEAR = 1860;

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
- Only judgments that are good law today. If the judgment that once decided the point was later overruled, name the judgment that overruled it instead - Bhatia International gave way to BALCO (2012), Gurdwara Sahib v. Gram Panchayat Village Sirthala to Ravinder Kaur Grewal v. Manjit Kaur (2019).
- When the question describes one particular judgment - "the judgment that recognised the right to die with dignity" - name that judgment first.
- The case name as it is reported, petitioner first, e.g. "Arnesh Kumar v. State of Bihar".
- The year the judgment was delivered.
- ${courtNamed ? 'The advocate asked for one court: name only judgments of that court.' : 'Prefer the Supreme Court of India - unless the question names another court, such as the Privy Council: then name only that court\'s judgments.'}
- Never invent a case, a party or a year.

Reply with JSON only: {"cases": [{"name": "...", "year": 2014, "court": "Supreme Court"}]}`;
}

/**
 * "Is X still good law?" - the later judgment that overruled X, if the model
 * is certain of one. What it names is then found on Kanoon and read
 * (precedents.service.ts, overruledBy); nothing it writes is shown as a fact.
 */
export function buildOverruledByPrompt(title: string, court: string | null, year: number | null): string {
  return `You help Indian advocates check whether a judgment is still good law.

The judgment: "${title}"${court ? `, ${court}` : ''}${year ? `, ${year}` : ''}.

Has it been overruled - wholly, or on the point in the question - by a later judgment of a larger bench or a higher court?
- Name only the later judgment that overruled it: the case name as reported, petitioner first, the year it was delivered, and its court.
- At most 2. If it has not been overruled, or you are not certain, reply with an empty list. A guess is worse than an empty list.
- Never invent a case, a party or a year.

Reply with JSON only: {"cases": [{"name": "...", "year": 2020, "court": "Supreme Court"}]}`;
}

/**
 * Overrulings an advocate is likely to meet, as candidates for the check
 * above - never as facts.
 *
 * The model asked "what overruled P.V. Narasimha Rao (1998)?" answered with
 * nothing, three times (live test, 9 Oct, J-GL-08): Sita Soren is of March
 * 2024. And point-of-law answers named overruled judgments as the law - Bhatia
 * International for Part I of the Arbitration Act, Gurudwara Sahib for adverse
 * possession (client's audit, 9 Oct, J-PL-50, J-PL-48).
 *
 * An entry is only a name to look for. It is said only when the later
 * judgment is found on Indian Kanoon by title and year and its own text says
 * the earlier one is overruled (textOverrules) - so a wrong entry here can
 * produce no claim, only a miss.
 */
export const KNOWN_OVERRULINGS: readonly { earlier: LeadingJudgment; later: LeadingJudgment; alias?: string }[] = [
  { earlier: { name: 'P.V. Narasimha Rao v. State (CBI/SPE)', year: 1998, court: 'Supreme Court' }, later: { name: 'Sita Soren v. Union of India', year: 2024, court: 'Supreme Court' } },
  { earlier: { name: 'Suresh Kumar Koushal v. Naz Foundation', year: 2013, court: 'Supreme Court' }, later: { name: 'Navtej Singh Johar v. Union of India', year: 2018, court: 'Supreme Court' } },
  { earlier: { name: 'Shafhi Mohammad v. State of Himachal Pradesh', year: 2018, court: 'Supreme Court' }, later: { name: 'Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal', year: 2020, court: 'Supreme Court' } },
  { earlier: { name: 'Bhatia International v. Bulk Trading S.A.', year: 2002, court: 'Supreme Court' }, later: { name: 'Bharat Aluminium Co. v. Kaiser Aluminium Technical Services Inc.', year: 2012, court: 'Supreme Court' } },
  { earlier: { name: 'Gurdwara Sahib v. Gram Panchayat Village Sirthala', year: 2013, court: 'Supreme Court' }, later: { name: 'Ravinder Kaur Grewal v. Manjit Kaur', year: 2019, court: 'Supreme Court' } },
  // Written "ADM Jabalpur" in the judgments that discuss it.
  { earlier: { name: 'Additional District Magistrate, Jabalpur v. Shivakant Shukla', year: 1976, court: 'Supreme Court' }, later: { name: 'K.S. Puttaswamy v. Union of India', year: 2017, court: 'Supreme Court' }, alias: 'ADM Jabalpur' },
  { earlier: { name: 'I.C. Golak Nath v. State of Punjab', year: 1967, court: 'Supreme Court' }, later: { name: 'Kesavananda Bharati v. State of Kerala', year: 1973, court: 'Supreme Court' } },
  { earlier: { name: 'E.V. Chinnaiah v. State of Andhra Pradesh', year: 2004, court: 'Supreme Court' }, later: { name: 'State of Punjab v. Davinder Singh', year: 2024, court: 'Supreme Court' } },
];

/** The known overrulings of a judgment, by its Kanoon title and year (KNOWN_OVERRULINGS), with the name its text may go by. */
export function knownOverrulingsOf(title: string, year: number | null): (LeadingJudgment & { alias?: string })[] {
  return KNOWN_OVERRULINGS.filter(({ earlier }) => {
    const known = extractCaseName(earlier.name);
    return known !== null && (year === null || Math.abs(year - earlier.year) <= 1) && caseNameScore(known, title) >= CASE_NAME_MATCH;
  }).map(({ later, alias }) => (alias ? { ...later, alias } : later));
}

/** "Is Suresh Kumar Koushal v. Naz Foundation still good law?" */
export function asksIfStillGoodLaw(text: string): boolean {
  return /\bgood\s+law\b|\boverruled\b|\bstill\s+(?:valid|binding|holds?|applies|applicable|the\s+law)\b|\bcan\s+(?:i|we|one)\s+(?:still\s+)?(?:rely|cite)\b|\bsafe\s+to\s+(?:rely|cite)\b/i.test(text);
}

/**
 * Whether a judgment's text says the earlier one was overruled: the earlier
 * petitioner's longest name word, and "overruled" or "not good law" (or the
 * like) within a few hundred characters of it, with most of the petitioner's
 * words there too.
 *
 * Arjun Panditrao Khotkar (2020): "Shafhi Mohammad (supra) ... do not lay down
 * the law correctly and are therefore overruled"; Navtej Singh Johar (2018):
 * "Suresh Kumar Koushal ... is hereby overruled"; Sita Soren (2024): "the
 * judgment of the majority in P V Narasimha Rao ... is overruled".
 */
export function textOverrules(html: string, earlierPetitionerWords: string[]): boolean {
  const words = earlierPetitionerWords.map((w) => w.toLowerCase().replace(/[^a-z]/g, '')).filter((w) => w.length >= 3);
  if (words.length === 0) return false;
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const anchor = [...words].sort((a, b) => b.length - a.length)[0];
  // Said, not denied: "is hereby overruled", "are therefore overruled" - never
  // "has not been overruled" or "is not overruled".
  const OVERRULED =
    /(?<!\bnot\s)(?<!\bnever\s)\b(?:is|are|was|were|stands?|be|been|hereby|therefore|accordingly|thus)\s+(?:hereby\s+|therefore\s+|accordingly\s+|expressly\s+)?overruled\b|\boverrul(?:e|es|ing)\s+(?:the\s+)?(?:said\s+)?(?:decisions?|judgments?|views?|ratio|law)\b|\bno\s+longer\s+good\s+law\b|\bis\s+not\s+(?:a\s+)?good\s+law\b|\bdo(?:es)?\s+not\s+lay\s+down\s+the\s+(?:correct\s+)?law\b|\bwrongly\s+decided\b/;
  for (let at = text.indexOf(anchor); at !== -1; at = text.indexOf(anchor, at + anchor.length)) {
    const window = text.slice(Math.max(0, at - 600), at + 600);
    if (OVERRULED.test(window) && words.filter((w) => window.includes(w)).length >= Math.ceil(words.length / 2)) return true;
  }
  return false;
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
    // From 1860, not 1950: "Which Privy Council case explains common
    // intention?" is Mahbub Shah v. Emperor, 1945, and was dropped here - the
    // list that followed had neither it nor Barendra Kumar Ghosh, 1925 (live
    // test, 8 Oct, S-SL-20). Kanoon holds them; the title search still decides.
    if (!Number.isInteger(year) || year < EARLIEST_YEAR || year > thisYear) continue;
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

  const petitioner = titleWords(name.petitioner);
  const queries = [`${scope} title: ${petitioner} ${titleWords(name.respondent)}`];
  if (!GENERIC_PARTY.test(petitioner)) queries.push(`${scope} title: ${petitioner}`);
  return queries;
}

/**
 * A party as Kanoon's title search can match it: every word sent must be in
 * the title. The model named "Sushila Aggarwal and Others v. State (NCT of
 * Delhi) and Another" (2020); Kanoon titles it "Sushila Aggarwal vs State (Nct
 * Of Delhi)", so "and Others" and "and Another" found nothing (live, 6 Oct, NP6).
 */
function titleWords(party: string): string {
  return party
    .replace(/[()[\],;]/g, ' ')
    .replace(/(?:\band|&)\s+(?:others|ors|another|anr)\b\.?|\b(?:ors|anr|etc)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
