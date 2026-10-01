import type { CaseStatus } from './ecourts.service';

/**
 * The case status card's rows - one definition for WhatsApp and the website.
 *
 * ## Why one definition
 *
 * The website drew its own card in the browser from the raw record, and it
 * drifted from the WhatsApp one: other labels, another order, empty rows
 * dropped - and none of the disposed-case rule. A client looking at a matter
 * disposed on 2024-03-12 saw "Next hearing 2024-03-12" on the website, which
 * WhatsApp had blanked since the rule was written. Both now print these rows.
 *
 * The rows are worked out when a card is shown, not when the case is looked
 * up, so a card already stored in a chat reads by the current rules too.
 *
 * ## The rules
 *
 * - Every field of the agreed list is always present, "Not available" where
 *   the record has nothing: a row that comes and goes reads as an omission.
 * - A disposed case whose next hearing date has passed shows "Not available"
 *   there. Left in, an advocate scanning quickly reads a date that already
 *   happened as an upcoming listing on a matter that is over. A future date is
 *   kept - restoration and review applications do get relisted.
 * - Disposal date and nature are for decided matters only, and the nature only
 *   when it says more than the status ("DISMISSED AS WITHDRAWN", not
 *   "DISPOSED" again).
 * - The provider's placeholder for a case-type code it does not know
 *   ("Unrecognized case type") is not a case type, and is never printed as one.
 */

export interface CaseRow {
  label: string;
  value: string;
}

export const NOT_AVAILABLE = 'Not available';

/** eCourtsIndia's enumLookup text for a case-type code missing from its table. */
const PROVIDER_PLACEHOLDER = /^unrecogni[sz]ed case type\b[\s:-]*/i;

/** The calendar day in India - court dates are Indian dates, the server runs on UTC. */
export function todayInIndia(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** A next hearing that is already over, on a matter that is decided. */
export function isStaleNextHearing(status: Pick<CaseStatus, 'status' | 'nextHearingDate'>, today: string): boolean {
  const date = status.nextHearingDate;
  return status.status === 'DISPOSED' && !!date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today;
}

/** How the case was disposed of, when that says more than the status line already does. */
export function informativeDisposal(nature: string | null | undefined, statusLabel: string | null | undefined): string | null {
  const text = nature?.trim();
  if (!text) return null;
  const bare = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const said = bare(text);
  if (said === 'disposed' || said === 'disposedof' || (statusLabel && said === bare(statusLabel))) return null;
  return text;
}

/** A case type, or null for the provider's placeholder. */
export function realCaseType(type: string | null | undefined): string | null {
  const text = type?.trim();
  if (!text || PROVIDER_PLACEHOLDER.test(text)) return null;
  return text;
}

export function caseStatusRows(status: CaseStatus, today: string = todayInIndia()): CaseRow[] {
  const value = (v: string | null | undefined): string => (v && v.trim() ? v.trim() : NOT_AVAILABLE);
  const decided = status.status === 'DISPOSED';
  const nature = decided ? informativeDisposal(status.disposalNature, status.statusLabel) : null;

  return [
    { label: 'Case Type', value: value(realCaseType(status.caseType)) },
    // Two different numbers - "9623/2024" and "138/2024" on the first real record.
    { label: 'Filing Number', value: value(status.filingNumber) },
    { label: 'Filing Date', value: value(status.filingDate) },
    // "Unrecognized case type 79/2024" is a registration number of 79/2024.
    { label: 'Registration Number', value: value(status.caseNumber?.replace(PROVIDER_PLACEHOLDER, '')) },
    { label: 'Registration Date', value: value(status.registrationDate) },
    { label: 'CNR Number', value: status.cnr },
    // The CNR's own case-number part - what the eCourts portal's case-number search takes.
    { label: 'CNR Case Number', value: value(status.cnrCaseNumber) },
    { label: 'First Hearing Date', value: value(status.firstHearingDate) },
    { label: 'Last Hearing Date', value: value(status.lastHearingDate) },
    { label: 'Next Hearing Date', value: isStaleNextHearing(status, today) ? NOT_AVAILABLE : value(status.nextHearingDate) },
    // The provider's own word - "Dismissed" - not the three-way flag.
    { label: 'Case Status', value: value(status.statusLabel ?? status.status) },
    ...(decided ? [{ label: 'Disposal Date', value: value(status.decisionDate) }] : []),
    ...(nature ? [{ label: 'Nature of Disposal', value: nature }] : []),
    { label: 'Stage of Case', value: value(status.stage) },
    { label: 'Court', value: value(status.court) },
    { label: 'Judge', value: value(status.judge) },
    { label: 'Petitioner and Advocate', value: pair(status.petitioner, status.petitionerAdvocate) },
    { label: 'Respondent and Advocate', value: pair(status.respondent, status.respondentAdvocate) },
    // Criminal matters only - on a civil card it would be noise.
    ...(status.fir ? [{ label: 'FIR', value: status.fir }] : []),
  ];
}

/**
 * A stored chat message's structured data, with a case card's rows added.
 *
 * Applied wherever a message goes to the browser - the live answer and the
 * thread history - so the website never draws a case card from raw fields.
 */
export function withCaseRows<T extends Record<string, unknown> | null | undefined>(structured: T, today?: string): T {
  if (!structured || structured.kind !== 'caseStatus') return structured;
  return { ...structured, rows: caseStatusRows(structured as unknown as CaseStatus, today) };
}

/** "Party (Advocate)", degrading to whichever half the record actually has. */
function pair(party: string | null | undefined, advocate: string | null | undefined): string {
  const p = party?.trim();
  const a = advocate?.trim();
  if (!p && !a) return NOT_AVAILABLE;
  if (!a) return p as string;
  if (!p) return `${NOT_AVAILABLE} (${a})`;
  return `${p} (${a})`;
}
