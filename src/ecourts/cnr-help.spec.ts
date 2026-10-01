import { caseNumberIn, cnrNeededReply, EarlierCase, matchEarlierCase } from './cnr-help';

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
