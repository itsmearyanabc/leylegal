import { todayInIndia, withCaseRows } from './case-status.rows';
import { CaseMatch, caseMatchRows, caseTitle } from './party-search';

/**
 * A stored message's structured data as the browser gets it.
 *
 * The rows of anything that shows a court case are worked out here, whenever
 * the message is shown - a case card's (case-status.rows.ts) and the cases a
 * party search found (party-search.ts) - so the browser only lays out rows and
 * a message stored before a rule changed reads by the new one.
 */
export function forBrowser<T extends Record<string, unknown> | null | undefined>(structured: T, today: string = todayInIndia()): T {
  if (!structured) return structured;
  if (structured.kind === 'caseStatus') return withCaseRows(structured, today);

  const cases = structured.kind === 'precedents' ? (structured.cases as { items?: CaseMatch[] } | null | undefined) : null;
  if (cases && Array.isArray(cases.items)) {
    return {
      ...structured,
      cases: { ...cases, items: cases.items.map((m) => ({ ...m, title: caseTitle(m), rows: caseMatchRows(m, today) })) },
    };
  }
  return structured;
}
