import { caseNumberIn, cnrNeededReply, EarlierCase, matchEarlierCase, otherQuestionNote, otherQuestionWithCnr } from './cnr-help';

/**
 * "Check the status of CNR 831/2024" - the filing number off the card above -
 * was answered "No case found for CNR 831/2024", as though the case did not
 * exist. It is answered with what a CNR is, and which case that number was.
 */
const reported: EarlierCase = {
  cnr: 'DLCT010012342024',
  filingNumber: '831/2024',
  caseNumber: '79/2024',
  petitioner: 'Idfc First Bank',
  respondent: 'Aditya Bhatia 6897',
};

describe('the number typed', () => {
  it.each([
    ['Check the status of CNR 831/2024', '831/2024'],
    ['status of 831 / 2024 please', '831/2024'],
    ['case no. 0831/2024', '831/2024'],
    ['Writ Petition (Civil) 138/2024', '138/2024'],
  ])('%s -> %s', (text, expected) => {
    expect(caseNumberIn(text)).toBe(expected);
  });

  it.each([
    'what is the next date in my case',
    'section 138/2 of the NI Act', // not a year
    '12/03/2024', // a date
  ])('nothing in "%s"', (text) => {
    expect(caseNumberIn(text)).toBeNull();
  });
});

describe('matching it to a case already looked up in the chat', () => {
  it('finds the case by its filing or registration number', () => {
    expect(matchEarlierCase('831/2024', [reported])).toEqual({ case: reported, which: 'filing' });
    // The real Delhi High Court record in __fixtures__, as the mapper prints its registration number.
    const writ: EarlierCase = { cnr: 'DLHC010001232024', filingNumber: '9623/2024', caseNumber: 'Writ Petition (Civil) 138/2024', petitioner: null, respondent: null };
    expect(matchEarlierCase('138/2024', [reported, writ])).toEqual({ case: writ, which: 'registration' });
  });

  it('names no case when two in the chat share the number', () => {
    // Constructed: the real DLND02 complaint case given the client's filing
    // number, because two real cases sharing one in a chat is what this rule is for.
    const other = { cnr: 'DLND020047882015', filingNumber: '831/2024', caseNumber: null, petitioner: 'MR.ARUN JAITLEY', respondent: 'MR. ARVIND KEJRIWAL' };
    expect(matchEarlierCase('831/2024', [reported, other])).toBeNull();
  });

  it('counts the same case shown twice as one', () => {
    expect(matchEarlierCase('831/2024', [reported, reported])?.case.cnr).toBe('DLCT010012342024');
  });

  it('names nothing for a number no card carries', () => {
    expect(matchEarlierCase('832/2024', [reported])).toBeNull();
  });
});

describe('the reply', () => {
  it('says which case the number belongs to and what to send, free', () => {
    const text = cnrNeededReply('831/2024', { case: reported, which: 'filing' });
    expect(text).toContain('*831/2024* is not a CNR - it is the filing number of *DLCT010012342024* (Idfc First Bank vs Aditya Bhatia 6897)');
    expect(text).toContain('send *DLCT010012342024*');
    expect(text).toContain('No credits were charged.');
    expect(text).not.toMatch(/no case found/i);
  });

  it('explains a CNR when the number matches nothing', () => {
    const text = cnrNeededReply('831/2024', null);
    expect(text).toContain('*831/2024* is not a CNR');
    expect(text).toContain('16-character');
    expect(text).toContain('No credits were charged.');
  });

  it('asks for the CNR when no number was given', () => {
    expect(cnrNeededReply(null, null)).toMatch(/^To check a case, I need its CNR\./);
  });
});

/** Live tests of 4 and 7 Oct: the second half of a CNR question dropped without a word (C-07, C-15). */
describe('another question in the same message as a CNR', () => {
  it('is found and quoted back (C-15)', () => {
    expect(
      otherQuestionWithCnr("CNR DLCT010012342024 — what's the status and which Arbitration Act section governs interim relief?", 'DLCT010012342024'),
    ).toBe('which Arbitration Act section governs interim relief?');
  });

  it.each([
    'dlct010012342024',
    'Status of CNR UPLK010999992023',
    'bhai dlct010012342024 wala case kis stage pe hai',
    'Who are the parties in DLCT010012342024?',
    'Mera case ka status batao, CNR DLCT010012342024, agli date kab hai?',
    "CNR DLCT010012342024 - case under section 138 NI Act, what's the status?",
  ])('is not found in %p, which asks only about the case', (question) => {
    const cnr = question.toUpperCase().match(/[A-Z]{4}\d{12}/)![0];
    expect(otherQuestionWithCnr(question, cnr)).toBeNull();
  });

  it('is said with the status, not answered as if it were', () => {
    expect(otherQuestionNote('which Arbitration Act section governs interim relief?')).toBe(
      'Your message also asked: "which Arbitration Act section governs interim relief?" This reply covers only the case status - ' +
        'send that question on its own and Ley Legal will answer it.',
    );
  });
});
