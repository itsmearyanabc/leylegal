import searchResponse from './__fixtures__/ecourtsindia-search-idfc.json';
import { caseMatchRows, caseTitle, mapSearchResponse, partiesIn, partyName } from './party-search';
import { formatCaseMatches } from '../whatsapp/replies';

/**
 * Finding a case by its parties.
 *
 * "idfc First bank vs aditya bhatia 6897" was answered "No judgments matched":
 * Indian Kanoon holds no document with those parties - the matter is a
 * district-court arbitration petition with no reported judgment - and nothing
 * looked for the case itself. The fixture is eCourtsIndia's real answer to that
 * search (GET /api/partner/search, captured on the production server).
 */
const found = mapSearchResponse(searchResponse);
const reported = found.cases[0];

describe("eCourtsIndia's search response", () => {
  it('reads the real response as the case it is', () => {
    expect(found.totalHits).toBe(1);
    expect(reported).toEqual({
      cnr: 'DLCT010012342024',
      petitioners: ['Idfc First Bank'],
      respondents: ['Aditya Bhatia 6897'],
      petitionerAdvocates: ['MAYANK MAHAJAN'],
      court: 'District & Sessions Judge, Central, Tis Hazari Court, Delhi',
      // The provider does not know this type: code "UNKNOWN", labelled
      // "Unrecognized case type" - neither is a case type.
      caseType: null,
      category: 'Arbitration & Conciliation Act, 1996 - 9',
      filingNumber: '831/2024',
      registrationNumber: '79/2024',
      statusLabel: 'Disposed',
      status: 'DISPOSED',
      filingDate: '2024-01-27',
      registrationDate: '2024-01-29',
      decisionDate: '2024-03-12',
      nextHearingDate: '2024-03-12',
    });
  });

  it('skips a result with no CNR, and finds nothing in an empty answer', () => {
    const withoutCnr = { data: { ...searchResponse.data, results: [{ ...searchResponse.data.results[0], cnr: '' }], totalHits: 1 } };
    expect(mapSearchResponse(withoutCnr).cases).toEqual([]);
    expect(mapSearchResponse({ data: { ...searchResponse.data, results: [], totalHits: 0 } })).toEqual({ totalHits: 0, cases: [] });
  });
});

describe('the parties in a question', () => {
  it('reads the question the client asked', () => {
    expect(partiesIn('idfc First bank vs aditya bhatia 6897')).toEqual({
      petitioner: 'idfc First bank',
      respondent: 'aditya bhatia 6897',
      query: 'idfc First bank vs aditya bhatia 6897',
    });
  });

  it.each([
    // Request words run into the name: every word of a name must match on eCourts.
    ['Idfc First Bank v. Aditya Bhatia ka status', 'Idfc First Bank', 'Aditya Bhatia'],
    ['status of idfc first bank vs aditya bhatia', 'idfc first bank', 'aditya bhatia'],
    ['summary of case Idfc First Bank vs Aditya Bhatia', 'Idfc First Bank', 'Aditya Bhatia'],
    // A company form the court record may not carry.
    ['IDFC First Bank Ltd versus Aditya Bhatia', 'IDFC First Bank', 'Aditya Bhatia'],
    // "of" inside a name stays.
    ['Arnesh Kumar vs State of Bihar', 'Arnesh Kumar', 'State of Bihar'],
  ])('%s -> %s | %s', (question, petitioner, respondent) => {
    expect(partiesIn(question)).toMatchObject({ petitioner, respondent });
  });

  it('keeps a number that is part of the name as filed', () => {
    expect(partyName('aditya bhatia 6897')).toBe('aditya bhatia 6897');
  });

  it('finds no parties in a question that names no case', () => {
    expect(partiesIn('judgments on default bail under section 187 BNSS')).toBeNull();
    expect(partyName('ka status')).toBeNull();
  });
});

describe('a case found', () => {
  it('is titled as the case card titles it', () => {
    expect(caseTitle(reported)).toBe('Idfc First Bank vs Aditya Bhatia 6897');
  });

  it('shows enough to tell it is the one, and not a past date as the next hearing', () => {
    expect(caseMatchRows(reported, '2026-10-02')).toEqual([
      { label: 'Court', value: 'District & Sessions Judge, Central, Tis Hazari Court, Delhi' },
      { label: 'Case Number', value: '79/2024' },
      { label: 'Filing Number', value: '831/2024' },
      { label: 'Act and Section', value: 'Arbitration & Conciliation Act, 1996 - 9' },
      { label: 'Case Status', value: 'Disposed on 2024-03-12' },
      { label: 'Filing Date', value: '2024-01-27' },
      { label: 'Petitioner Advocate', value: 'MAYANK MAHAJAN' },
    ]);
  });

  it('shows a coming hearing on a pending case', () => {
    const pending = { ...reported, status: 'PENDING' as const, statusLabel: 'Pending', decisionDate: null, nextHearingDate: '2026-10-20' };
    expect(caseMatchRows(pending, '2026-10-02')).toContainEqual({ label: 'Next Hearing Date', value: '2026-10-20' });
  });
});

describe('on WhatsApp', () => {
  const forQuestion = { query: 'idfc First bank vs aditya bhatia 6897', result: found };

  it('says there is no reported judgment, gives the case and the CNR to send', () => {
    const text = formatCaseMatches(forQuestion, 1, true, '2026-10-02');
    expect(text).toContain('*No reported judgment found for "idfc First bank vs aditya bhatia 6897".*');
    expect(text).toContain('One case on eCourts with these parties:');
    expect(text).toContain('1. *DLCT010012342024* - Idfc First Bank vs Aditya Bhatia 6897');
    expect(text).toContain('   • Case Status: Disposed on 2024-03-12');
    expect(text).toContain("Send a CNR to see that case's full status (1 credit).");
    expect(text).toMatch(/research aid/);
    expect(text).not.toMatch(/\n\n\n/);
  });

  it('heads the cases plainly when judgments follow', () => {
    const text = formatCaseMatches(forQuestion, 1, false, '2026-10-02');
    expect(text.startsWith('*Cases on eCourts for "idfc First bank vs aditya bhatia 6897"*')).toBe(true);
    expect(text).not.toMatch(/research aid/);
  });
});
