import { nonexistentProvision } from './provision-range';

/**
 * "BNS Section 520 kya hai?" was answered "I am not sure what Section 520
 * covers". The BNS ends at Section 358, so the honest answer is that there is
 * no such section - and where that number does exist.
 */
describe('a provision past the end of its Act', () => {
  it('says BNS 520 does not exist, and that the BNSS has a Section 520', () => {
    const answer = nonexistentProvision('BNS', '520')!;
    expect(answer).toContain('does not exist');
    expect(answer).toContain('358');
    expect(answer).toContain('BNSS');
    expect(answer).not.toContain('IPC,'); // the IPC ends at 511
  });

  it('lists every code that does have the number', () => {
    const answer = nonexistentProvision('BNS', '400')!;
    expect(answer).toContain('BNSS, IPC, CrPC');
  });

  it('refuses a number past the end of each code, and accepts its last one', () => {
    const cases: [Parameters<typeof nonexistentProvision>[0], number][] = [
      ['IPC', 511], ['BNS', 358], ['CRPC', 484], ['BNSS', 531], ['IEA', 167], ['BSA', 170], ['CPC', 158],
    ];
    for (const [act, last] of cases) {
      expect(nonexistentProvision(act, String(last))).toBeNull();
      expect(nonexistentProvision(act, String(last + 1))).toContain('does not exist');
    }
  });

  it('judges an inserted section by its number, so 498A and 65B are in range', () => {
    expect(nonexistentProvision('IPC', '498A')).toBeNull();
    expect(nonexistentProvision('IEA', '65B')).toBeNull();
    expect(nonexistentProvision('CRPC', '41A')).toBeNull();
    expect(nonexistentProvision('BNS', '103(1)')).toBeNull();
    expect(nonexistentProvision('IPC', '512A')).toContain('does not exist');
  });

  it('knows the CPC has 51 Orders and the Constitution 395 Articles', () => {
    expect(nonexistentProvision('CPC', 'Order 51')).toBeNull();
    expect(nonexistentProvision('CPC', 'Order 37 Rule 3')).toBeNull();
    expect(nonexistentProvision('CPC', 'Order 52')).toContain('Order LI');
    expect(nonexistentProvision('COI', 'Article 21A')).toBeNull();
    expect(nonexistentProvision('COI', 'Article 395')).toBeNull();
    expect(nonexistentProvision('COI', 'Article 396')).toContain('395 articles');
  });

  it('leaves alone anything it cannot judge', () => {
    expect(nonexistentProvision(null, '520')).toBeNull();
    expect(nonexistentProvision('BNS', null)).toBeNull();
    expect(nonexistentProvision('BNS', 'Order 3')).toBeNull();
    expect(nonexistentProvision('BNS', 'the one about theft')).toBeNull();
  });
});
