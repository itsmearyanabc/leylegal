import { extractCaseName } from '../ai/case-name';
import { CaseRow, NOT_AVAILABLE, isStaleNextHearing, realCaseType, todayInIndia } from './case-status.rows';

/**
 * Finding a case by its parties, on eCourts.
 *
 * ## Why
 *
 * "idfc First bank vs aditya bhatia 6897" went to judgment search and came back
 * "No judgments matched". Correctly, as far as it went: Indian Kanoon holds no
 * document with those parties - the matter is a district-court arbitration
 * petition, OMP (I) (COMM) 79/2024, that never produced a reported judgment.
 * What the advocate wanted was the case, and eCourts has it.
 *
 * So a named case that Kanoon does not have is looked for on eCourts too, by
 * petitioner and respondent (eCourtsIndia's case search: Rs 0.60 a call, against
 * Rs 1.50 for a case's full record). Sources in order: Kanoon for judgments,
 * eCourts for cases. Nothing from the open web.
 *
 * ## Names as typed are not names as filed
 *
 * The provider matches every word of a name by default. Two things typed
 * around a name defeat that: request words run into it ("... Aditya Bhatia ka
 * status") and company suffixes the court record leaves out ("IDFC First Bank
 * Ltd" against "Idfc First Bank"). Both are dropped before searching. A number
 * stays: eCourts has this respondent as "Aditya Bhatia 6897".
 */

/** One case on eCourts, as the search returns it. */
export interface CaseMatch {
  cnr: string;
  petitioners: string[];
  respondents: string[];
  petitionerAdvocates: string[];
  court: string | null;
  caseType: string | null;
  /** "Arbitration & Conciliation Act, 1996 - 9" - the Act and section the court filed it under. */
  category: string | null;
  filingNumber: string | null;
  registrationNumber: string | null;
  statusLabel: string | null;
  status: 'PENDING' | 'DISPOSED' | 'UNKNOWN';
  filingDate: string | null;
  registrationDate: string | null;
  decisionDate: string | null;
  nextHearingDate: string | null;
}

export interface PartySearchResult {
  /** Cases matching, across all pages - only the first few are in `cases`. */
  totalHits: number;
  cases: CaseMatch[];
}

/** Words that end a request, not a name: "... ka status", "... kya hai", "... next date". */
const REQUEST_WORDS = new Set([
  'ka', 'ki', 'ke', 'ko', 'kya', 'hai', 'hain', 'batao', 'bataye', 'bhejo', 'status', 'case', 'cases',
  'details', 'detail', 'next', 'date', 'hearing', 'judgment', 'judgement', 'summary', 'order', 'orders',
  'please', 'pls', 'check', 'latest', 'current', 'stage', 'the', 'of', 'in',
]);

/** Company forms a court record often omits, and a name match must not require. */
const COMPANY_FORMS = new Set(['ltd', 'limited', 'pvt', 'private', 'llp', 'inc', 'co', 'corp', 'company']);

/**
 * A party name as eCourts should be asked for it, or null when nothing is left.
 *
 * Request words are taken off the ends only - "status of Idfc First Bank" loses
 * "status of", and "State of Bihar" keeps its "of".
 */
export function partyName(typed: string): string | null {
  const words = typed
    .replace(/[.,()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 0 && REQUEST_WORDS.has(words[0].toLowerCase())) words.shift();
  while (words.length > 0 && REQUEST_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  const kept = words.filter((w) => !COMPANY_FORMS.has(w.toLowerCase()));
  return kept.length > 0 ? kept.join(' ') : null;
}

/**
 * The parties of a named case in a question - "idfc First bank vs aditya bhatia
 * 6897" - as eCourts should be asked for them, or null when it names no case.
 */
export function partiesIn(question: string): { petitioner: string; respondent: string | null; query: string } | null {
  const name = extractCaseName(question);
  const petitioner = name ? partyName(name.petitioner) : null;
  if (!name || !petitioner) return null;
  const respondent = partyName(name.respondent);
  return { petitioner, respondent, query: respondent ? `${petitioner} vs ${respondent}` : petitioner };
}

/** What a party search found, with the names it searched for. */
export interface CasesForQuestion {
  query: string;
  result: PartySearchResult;
}

/**
 * The provider's search response to cases.
 *
 * Read against a real response (__fixtures__/ecourtsindia-search-idfc.json),
 * not only the documentation, which leaves out filingNumber, courtName and
 * caseCategory and shows no case type the provider does not know - for which
 * it sends the code "UNKNOWN". A result without a CNR is skipped: the CNR is
 * the only thing an advocate can do anything with.
 */
export function mapSearchResponse(payload: unknown): PartySearchResult {
  const envelope = ((payload as Record<string, unknown>)?.data ?? payload) as Record<string, unknown>;
  const results = Array.isArray(envelope?.results) ? (envelope.results as Record<string, unknown>[]) : [];
  const lookup = (((envelope?.enumDescriptions as Record<string, unknown> | undefined)?.enumLookup ?? {}) as Record<
    string,
    Record<string, string>
  >);

  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => s !== null) : []);
  const day = (v: unknown): string | null => {
    const s = str(v);
    return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
  };

  const cases: CaseMatch[] = [];
  for (const r of results) {
    const cnr = str(r.cnr)?.toUpperCase();
    if (!cnr) continue;
    const typeCode = str(r.caseType);
    const statusCode = str(r.caseStatus);
    const courtCode = str(r.courtCode);
    cases.push({
      cnr,
      petitioners: list(r.petitioners),
      respondents: list(r.respondents),
      petitionerAdvocates: list(r.petitionerAdvocates),
      court: (courtCode && lookup.courtCode?.[courtCode]) || str(r.courtName) || courtCode,
      caseType: realCaseType(typeCode ? lookup.caseType?.[typeCode] : null) ?? realCaseType(str(r.caseTypeRaw)) ?? realCaseType(typeCode),
      category: str(r.caseCategory) ?? (list(r.actsAndSections).join('; ') || null),
      filingNumber: str(r.filingNumber),
      registrationNumber: str(r.registrationNumber),
      statusLabel: (statusCode && lookup.caseStatus?.[statusCode]) || statusCode,
      status: /dispos|dismiss|withdraw|decided/i.test(statusCode ?? '') ? 'DISPOSED' : /pend/i.test(statusCode ?? '') ? 'PENDING' : 'UNKNOWN',
      filingDate: day(r.filingDate),
      registrationDate: day(r.registrationDate),
      decisionDate: day(r.decisionDate),
      nextHearingDate: day(r.nextHearingDate),
    });
  }

  const total = Number(envelope?.totalHits);
  return { totalHits: Number.isFinite(total) && total >= cases.length ? total : cases.length, cases };
}

/** "Idfc First Bank vs Aditya Bhatia 6897". */
export function caseTitle(match: Pick<CaseMatch, 'petitioners' | 'respondents'>): string {
  const p = match.petitioners.join(', ');
  const r = match.respondents.join(', ');
  return p && r ? `${p} vs ${r}` : p || r || 'Case record';
}

/**
 * A found case's rows - enough to tell it is the one, with the full status a
 * tap away. The disposed-case rule is the case card's: a past "next hearing" on
 * a decided matter is not shown as a date.
 */
export function caseMatchRows(match: CaseMatch, today: string = todayInIndia()): CaseRow[] {
  const number = [match.caseType, match.registrationNumber].filter(Boolean).join(' ');
  const status =
    match.status === 'DISPOSED' && match.decisionDate
      ? `${match.statusLabel ?? 'Disposed'} on ${match.decisionDate}`
      : match.statusLabel ?? NOT_AVAILABLE;
  const next = isStaleNextHearing(match, today) ? null : match.nextHearingDate;

  return [
    { label: 'Court', value: match.court ?? NOT_AVAILABLE },
    // Registration, with the type when the provider knows it.
    { label: 'Case Number', value: number || NOT_AVAILABLE },
    // The number an advocate is as likely to have to hand - 831/2024 was it.
    ...(match.filingNumber ? [{ label: 'Filing Number', value: match.filingNumber }] : []),
    ...(match.category ? [{ label: 'Act and Section', value: match.category }] : []),
    { label: 'Case Status', value: status },
    { label: 'Filing Date', value: match.filingDate ?? NOT_AVAILABLE },
    ...(next ? [{ label: 'Next Hearing Date', value: next }] : []),
    ...(match.petitionerAdvocates.length ? [{ label: 'Petitioner Advocate', value: match.petitionerAdvocates.join(', ') }] : []),
  ];
}
