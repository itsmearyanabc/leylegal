import { caseStatusRows, informativeDisposal, isStaleNextHearing, todayInIndia, withCaseRows } from './case-status.rows';
import { CaseStatus } from './ecourts.service';

/**
 * The case card's rows, shared by WhatsApp and the website.
 *
 * The record is the one a client looked up and reported: disposed on
 * 2024-03-12, with that same day still in "next hearing", "DISPOSED" as the
 * nature of disposal, and the provider's placeholder for a case type its table
 * did not know.
 */
function reported(over: Partial<CaseStatus> = {}): CaseStatus {
  return {
    cnr: 'DLCT010012342024',
    caseNumber: 'Unrecognized case type 79/2024',
    filingNumber: '831/2024',
    cnrCaseNumber: '0012342024',
    statusLabel: 'Disposed',
    decisionDate: '2024-03-12',
    disposalNature: 'DISPOSED',
    fir: null,
    recordUpdated: '2026-07-06',
    caseType: 'Unrecognized case type',
    filingDate: '2024-01-27',
    registrationDate: '2024-01-29',
    firstHearingDate: '2024-01-29',
    court: 'District & Sessions Judge, Central, Tis Hazari Court, Delhi',
    judge: 'DISTRICT JUDGE (COMMERCIAL COURT) - 08, CENTRAL, THC',
    petitioner: 'Idfc First Bank',
    respondent: 'Aditya Bhatia 6897',
    petitionerAdvocate: 'MAYANK MAHAJAN',
    respondentAdvocate: null,
    stage: 'Misc./ Appearance',
    nextHearingDate: '2024-03-12',
    lastHearingDate: '2024-03-12',
    status: 'DISPOSED',
    mocked: false,
    ...over,
  };
}

const TODAY = '2026-10-02';
const valueOf = (rows: { label: string; value: string }[], label: string) => rows.find((r) => r.label === label)?.value;

describe('the case card a client reported', () => {
  const rows = caseStatusRows(reported(), TODAY);

  it('does not show a disposed case\'s past "next hearing" as a date', () => {
    expect(valueOf(rows, 'Next Hearing Date')).toBe('Not available');
    // The last hearing really was that day, and stays.
    expect(valueOf(rows, 'Last Hearing Date')).toBe('2024-03-12');
    expect(valueOf(rows, 'Disposal Date')).toBe('2024-03-12');
  });

  it('drops a nature of disposal that only says "disposed" again', () => {
    expect(rows.map((r) => r.label)).not.toContain('Nature of Disposal');
  });

  it('never prints the provider placeholder as a case type', () => {
    expect(valueOf(rows, 'Case Type')).toBe('Not available');
    expect(valueOf(rows, 'Registration Number')).toBe('79/2024');
    expect(JSON.stringify(rows)).not.toMatch(/unrecogni/i);
  });

  it('lists the agreed fields in the agreed order', () => {
    expect(rows.map((r) => r.label)).toEqual([
      'Case Type', 'Filing Number', 'Filing Date', 'Registration Number', 'Registration Date',
      'CNR Number', 'CNR Case Number', 'First Hearing Date', 'Last Hearing Date', 'Next Hearing Date',
      'Case Status', 'Disposal Date', 'Stage of Case', 'Court', 'Judge',
      'Petitioner and Advocate', 'Respondent and Advocate',
    ]);
    expect(valueOf(rows, 'Petitioner and Advocate')).toBe('Idfc First Bank (MAYANK MAHAJAN)');
    expect(valueOf(rows, 'Respondent and Advocate')).toBe('Aditya Bhatia 6897');
  });
});

describe('the disposed-case rule', () => {
  it('keeps a future date - restoration and review matters are relisted', () => {
    expect(isStaleNextHearing({ status: 'DISPOSED', nextHearingDate: '2026-10-20' }, TODAY)).toBe(false);
  });

  it('keeps a listing for today, and blanks yesterday\'s', () => {
    expect(isStaleNextHearing({ status: 'DISPOSED', nextHearingDate: '2026-10-02' }, TODAY)).toBe(false);
    expect(isStaleNextHearing({ status: 'DISPOSED', nextHearingDate: '2026-10-01' }, TODAY)).toBe(true);
  });

  it('never touches a pending case', () => {
    expect(isStaleNextHearing({ status: 'PENDING', nextHearingDate: '2024-03-12' }, TODAY)).toBe(false);
    expect(valueOf(caseStatusRows(reported({ status: 'PENDING', statusLabel: 'Pending' }), TODAY), 'Next Hearing Date')).toBe('2024-03-12');
  });

  it('counts days in India, not on the server clock', () => {
    // 20:00 UTC on the 1st is already the 2nd in India.
    expect(todayInIndia(new Date('2026-10-01T20:00:00Z'))).toBe('2026-10-02');
    expect(todayInIndia(new Date('2026-10-01T18:00:00Z'))).toBe('2026-10-01');
  });
});

describe('the nature of disposal', () => {
  it.each([
    ['DISPOSED', 'Disposed', null],
    ['Disposed of', 'Disposed', null],
    ['Dismissed', 'Dismissed', null],
    ['DISMISSED AS WITHDRAWN', 'Disposed', 'DISMISSED AS WITHDRAWN'],
    ['Contested--DECREED', 'Disposed', 'Contested--DECREED'],
    [null, 'Disposed', null],
  ])('%s beside a status of %s -> %s', (nature, label, expected) => {
    expect(informativeDisposal(nature, label)).toBe(expected);
  });

  it('is shown on a decided case when it says something', () => {
    const rows = caseStatusRows(reported({ disposalNature: 'DISMISSED AS WITHDRAWN' }), TODAY);
    expect(valueOf(rows, 'Nature of Disposal')).toBe('DISMISSED AS WITHDRAWN');
  });
});

describe('cards on their way to the browser', () => {
  it('get their rows added', () => {
    const out = withCaseRows({ kind: 'caseStatus', ...reported() } as Record<string, unknown>, TODAY) as Record<string, unknown>;
    expect(valueOf(out.rows as never, 'Next Hearing Date')).toBe('Not available');
  });

  it('read right when stored before newer fields existed', () => {
    const old = { kind: 'caseStatus', cnr: 'DLCT010012342024', status: 'DISPOSED', nextHearingDate: '2024-03-12' };
    const rows = (withCaseRows(old as Record<string, unknown>, TODAY) as { rows: { label: string; value: string }[] }).rows;
    expect(valueOf(rows, 'Next Hearing Date')).toBe('Not available');
    expect(valueOf(rows, 'CNR Case Number')).toBe('Not available');
    expect(valueOf(rows, 'Case Status')).toBe('DISPOSED');
  });

  it('leave every other message alone', () => {
    const answer = { kind: 'answer', sources: [] };
    expect(withCaseRows(answer, TODAY)).toBe(answer);
    expect(withCaseRows(null, TODAY)).toBeNull();
  });
});
