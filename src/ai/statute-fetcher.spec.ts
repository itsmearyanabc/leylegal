import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KanoonNotConfiguredError } from '../kanoon/kanoon.service';
import { lawQuery, otherActCode, parseLawTitle, provisionTarget, sameAct, StatuteFetcher } from './statute-fetcher';

/**
 * The official text of a provision outside the loaded codes, from Indian
 * Kanoon: exactly the provision asked, or nothing.
 */
const NI_138 = readFileSync(join(__dirname, '..', 'kanoon', '__fixtures__', 'law-ni-act-138.html'), 'utf8');

describe('matching a Kanoon result to the question', () => {
  it('reads Kanoon legislation titles', () => {
    expect(parseLawTitle('Section 138 in The Negotiable Instruments Act, 1881')).toEqual({
      word: 'Section', number: '138', act: 'The Negotiable Instruments Act, 1881',
    });
    expect(parseLawTitle('Article 21 in Constitution of India')).toEqual({ word: 'Article', number: '21', act: 'Constitution of India' });
    expect(parseLawTitle('Section 498A in The Indian Penal Code, 1860')?.number).toBe('498A');
    expect(parseLawTitle('Maharashtra Court-fees Act.')).toBeNull();
  });

  it('reads the titles as the API sends them, with the searched words in bold', () => {
    // Exactly as production's log recorded them. With the tags left in no title
    // matched, and every provision was reported "not available".
    expect(parseLawTitle('<b>Section</b> <b>377</b> in The <b>Indian</b> <b>Penal</b> <b>Code</b>, 1860')).toEqual({
      word: 'Section', number: '377', act: 'The Indian Penal Code, 1860',
    });
    expect(parseLawTitle('<b>Section</b> 41 in The <b>Code</b> of <b>Criminal</b> <b>Procedure</b>, 1973')?.number).toBe('41');
    expect(parseLawTitle('<b>Section</b> <b>124A</b> in The <b>Indian</b> <b>Penal</b> <b>Code</b>, 1860')?.number).toBe('124A');
  });

  it('accepts only the same Act - same words, and the same year when both give one', () => {
    expect(sameAct('Negotiable Instruments Act, 1881', 'The Negotiable Instruments Act, 1881')).toBe(true);
    expect(sameAct('Negotiable Instruments Act', 'The Negotiable Instruments Act, 1881')).toBe(true);
    expect(sameAct('Code of Criminal Procedure, 1973', 'The Code of Criminal Procedure, 1973')).toBe(true);
    // Kanoon also carries a 1989 code under the same name.
    expect(sameAct('Code of Criminal Procedure, 1973', 'The Code of Criminal Procedure, 1989 (1933 A. D.)')).toBe(false);
    // An abbreviation the router did not expand is not the Act.
    expect(sameAct('NI Act', 'The Negotiable Instruments Act, 1881')).toBe(false);
    // A State Act that shares words is a different law.
    expect(sameAct('Rent Control Act', 'The Delhi Rent Control Act, 1958')).toBe(false);
  });

  it('gives another Act a stable, short act_code', () => {
    const code = otherActCode('The Negotiable Instruments Act, 1881');
    expect(code).toMatch(/^NIA1881-[0-9a-f]{4}$/);
    expect(otherActCode('The Negotiable Instruments Act, 1881')).toBe(code);
    expect(otherActCode('The Protection of Children from Sexual Offences Act, 2012').length).toBeLessThanOrEqual(20);
  });
});

describe('what can be fetched', () => {
  it.each([
    [{ actCode: 'IPC', sectionNumber: '415' }, { actCode: 'IPC', word: 'Section', number: '415' }],
    [{ actCode: 'CRPC', sectionNumber: '156(3)' }, { actCode: 'CRPC', word: 'Section', number: '156' }],
    [{ actCode: 'COI', sectionNumber: 'Article 21' }, { actCode: 'COI', word: 'Article', number: '21' }],
    [{ actCode: null, sectionNumber: '138', actName: 'Negotiable Instruments Act, 1881' }, { actCode: null, word: 'Section', number: '138' }],
    [{ actCode: null, sectionNumber: '21', actName: 'Constitution of India' }, { actCode: null, word: 'Article', number: '21' }],
  ])('%j -> %j', (intent, expected) => {
    expect(provisionTarget(intent as never)).toMatchObject(expected);
  });

  it.each([
    [{ actCode: 'BNS', sectionNumber: '103' }, 'loaded in full from the Gazette'],
    [{ actCode: 'CPC', sectionNumber: 'Order 39 Rule 1' }, 'Orders are not separate documents on Kanoon'],
    [{ actCode: null, sectionNumber: '138', actName: null }, 'no Act named'],
    [{ actCode: 'IPC', sectionNumber: null }, 'no provision named'],
  ])('nothing for %j (%s)', (intent, _why) => {
    expect(provisionTarget(intent as never)).toBeNull();
  });

  it('searches the way Kanoon ranks the provision first', () => {
    expect(lawQuery({ actCode: null, actName: 'Negotiable Instruments Act, 1881', word: 'Section', number: '138' })).toBe(
      'section 138 negotiable instruments act',
    );
  });
});

describe('fetching', () => {
  const target = { actCode: null, actName: 'Negotiable Instruments Act, 1881', word: 'Section' as const, number: '138' };

  function fetcher(
    over: { docs?: unknown[]; html?: string; configured?: boolean; searchError?: Error; entireAct?: number; actHtml?: string } = {},
  ) {
    const store = new Map<string, unknown>();
    const kanoon = {
      isConfigured: over.configured ?? true,
      searchLaws: over.searchError ? jest.fn().mockRejectedValue(over.searchError) : jest.fn().mockResolvedValue(over.docs ?? []),
      lawDocument: jest.fn(async (tid: number) => (tid === over.entireAct ? over.actHtml : over.html ?? NI_138)),
      entireActOf: jest.fn().mockResolvedValue(over.entireAct ?? null),
    };
    const corpus = {
      storeLaw: jest.fn(async (law: Record<string, string>) => ({ id: 'row-1', act_code: law.actCode, act_name: law.actName, section_number: law.sectionNumber, section_title: law.sectionTitle, section_text: law.sectionText, source_url: law.sourceUrl })),
      lawsWithSection: jest.fn().mockResolvedValue([]),
      replaceAbridged: jest.fn().mockResolvedValue(true),
    };
    const cache = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: unknown) => void store.set(k, v)),
    };
    return { fetcher: new StatuteFetcher(kanoon as never, corpus as never, cache as never), kanoon, corpus, cache };
  }

  it('picks the exact provision from among unrelated laws, then stores it', async () => {
    const { fetcher: f, kanoon, corpus } = fetcher({
      docs: [
        { tid: 18291589, title: 'Maharashtra Court-fees Act.' },
        { tid: 1823824, title: 'Section 138 in The Negotiable Instruments Act, 1881' },
      ],
    });

    const result = await f.fetch(target);

    expect(kanoon.lawDocument).toHaveBeenCalledWith(1823824, expect.any(Number));
    expect(result.outcome).toBe('stored');
    expect(corpus.storeLaw).toHaveBeenCalledWith(expect.objectContaining({
      actName: 'The Negotiable Instruments Act, 1881',
      sectionNumber: '138',
      sectionTitle: 'Dishonour of cheque for insufficiency, etc., of funds in the account',
      sourceUrl: 'https://indiankanoon.org/doc/1823824/',
    }));
    expect(corpus.storeLaw.mock.calls[0][0].actCode).toMatch(/^NIA1881-/);
  });

  it('matches the highlighted title the API returns, and stores the plain Act name', async () => {
    const { fetcher: f, kanoon, corpus } = fetcher({
      docs: [
        { tid: 18291589, title: 'West Bengal Municipal Corporation Act, 2006' },
        { tid: 1823824, title: '<b>Section</b> <b>138</b> in The <b>Negotiable</b> <b>Instruments</b> <b>Act</b>, 1881' },
      ],
    });

    const result = await f.fetch(target);

    expect(kanoon.lawDocument).toHaveBeenCalledWith(1823824, expect.any(Number));
    expect(result.outcome).toBe('stored');
    expect(corpus.storeLaw.mock.calls[0][0].actName).toBe('The Negotiable Instruments Act, 1881');
  });

  it('does not take section 41 for 41A', async () => {
    const { fetcher: f, kanoon } = fetcher({ docs: [{ tid: 1899251, title: 'Section 41 in The Code of Criminal Procedure, 1973' }] });

    const result = await f.fetch({ actCode: 'CRPC', actName: 'Code of Criminal Procedure, 1973', word: 'Section', number: '41A' });

    expect(result).toEqual({ row: null, outcome: 'not-found' });
    expect(kanoon.lawDocument).not.toHaveBeenCalled();
  });

  /*
   * No wording of the search finds CrPC 41A or Evidence Act 65B (run on the
   * server, 4 Oct 2026): the results below are the ones it returned. Kanoon
   * folds both into the section before them in its copy of the Act, and the
   * fixtures are those blocks exactly as indiankanoon.org serves them.
   */
  const fixture = (name: string) => readFileSync(join(__dirname, '..', 'kanoon', '__fixtures__', name), 'utf8');

  it('reads a section Kanoon has no page for out of the whole Act', async () => {
    const { fetcher: f, kanoon, corpus } = fetcher({
      docs: [
        { tid: 1899251, title: '<b>Section</b> 41 in The <b>Code</b> of <b>Criminal</b> <b>Procedure</b>, 1973' },
        { tid: 75059398, title: '<b>Section</b> 35 in Bharatiya Nagarik Suraksha Sanhita, 2023' },
        { tid: 91117739, title: 'Bharatiya Nagarik Suraksha Sanhita, 2023' },
      ],
      entireAct: 445276,
      actHtml: fixture('law-crpc-act-41.html'),
    });

    const result = await f.fetch({ actCode: 'CRPC', actName: 'Code of Criminal Procedure, 1973', word: 'Section', number: '41A' });

    expect(result.outcome).toBe('stored');
    expect(kanoon.entireActOf).toHaveBeenCalledWith(1899251, expect.any(Number));
    expect(kanoon.lawDocument).toHaveBeenCalledWith(445276, expect.any(Number));
    const law = corpus.storeLaw.mock.calls[0][0];
    expect(law).toMatchObject({
      actCode: 'CRPC',
      actName: 'Code of Criminal Procedure, 1973',
      sectionNumber: '41A',
      sectionTitle: 'Notice of appearance before police officer',
      sourceUrl: 'https://indiankanoon.org/doc/445276/',
    });
    expect(law.sectionText).toMatch(/^41A\. \(1\) \[The police officer shall\], in all cases where the arrest of a person is not required/);
    expect(law.sectionText.split('\n')).toHaveLength(4);
  });

  it('reads 65B out of section 65 of the Evidence Act, where Kanoon put it', async () => {
    const { fetcher: f, corpus } = fetcher({
      docs: [
        { tid: 23526241, title: 'The Bombay Land Revenue Code, 1879' },
        { tid: 47360416, title: '<b>Section</b> 54 in The Telecommunications <b>Act</b>, 2023' },
        { tid: 487818, title: '<b>Section</b> 65 in The <b>Indian</b> <b>Evidence</b> <b>Act</b>, 1872' },
      ],
      entireAct: 1953529,
      actHtml: fixture('law-iea-act-65.html'),
    });

    const result = await f.fetch({ actCode: 'IEA', actName: 'Indian Evidence Act, 1872', word: 'Section', number: '65B' });

    expect(result.outcome).toBe('stored');
    const law = corpus.storeLaw.mock.calls[0][0];
    expect(law.sectionTitle).toBe('Admissibility of electronic records');
    expect(law.sectionText).toMatch(/^65B\. \(1\) Notwithstanding anything contained in this Act/);
    expect(law.sectionText).toMatch(/derived therefrom by calculation, comparison or any other process\.\]$/);
    // Section 65's own clauses are not part of it.
    expect(law.sectionText).not.toContain('Secondary evidence may be given');
  });

  it('is not found when the whole Act does not have it either', async () => {
    const { fetcher: f, corpus } = fetcher({
      docs: [{ tid: 1899251, title: 'Section 41 in The Code of Criminal Procedure, 1973' }],
      entireAct: 445276,
      actHtml: fixture('law-crpc-act-41.html'),
    });

    const result = await f.fetch({ actCode: 'CRPC', actName: 'Code of Criminal Procedure, 1973', word: 'Section', number: '41E' });

    expect(result).toEqual({ row: null, outcome: 'not-found' });
    expect(corpus.storeLaw).not.toHaveBeenCalled();
  });

  it('remembers a miss for a day, so it is not paid for again', async () => {
    const { fetcher: f, kanoon } = fetcher({ docs: [] });

    expect((await f.fetch(target)).outcome).toBe('not-found');
    expect((await f.fetch(target)).outcome).toBe('not-found');
    expect(kanoon.searchLaws).toHaveBeenCalledTimes(1);
  });

  it('does not remember an outage as a miss', async () => {
    const { fetcher: f, kanoon } = fetcher({ searchError: new Error('The operation was aborted due to timeout') });

    expect((await f.fetch(target)).outcome).toBe('unavailable');
    expect((await f.fetch(target)).outcome).toBe('unavailable');
    expect(kanoon.searchLaws).toHaveBeenCalledTimes(2);
  });

  it('reports a document it cannot read as such, and stores nothing', async () => {
    const { fetcher: f, corpus } = fetcher({
      docs: [{ tid: 1823824, title: 'Section 138 in The Negotiable Instruments Act, 1881' }],
      html: '<div class="judgments">not a provision</div>',
    });

    expect((await f.fetch(target)).outcome).toBe('unparsable');
    expect(corpus.storeLaw).not.toHaveBeenCalled();
  });

  it('is unavailable without a Kanoon key, without calling it', async () => {
    const { fetcher: f, kanoon } = fetcher({ configured: false });

    expect((await f.fetch(target)).outcome).toBe('unavailable');
    expect(kanoon.searchLaws).not.toHaveBeenCalled();
    expect(KanoonNotConfiguredError).toBeDefined();
  });

  describe("0006's abridged seed rows", () => {
    const IPC_415 = readFileSync(join(__dirname, '..', 'kanoon', '__fixtures__', 'law-ipc-415.html'), 'utf8');
    const ipc = { actCode: 'IPC' as const, actName: 'Indian Penal Code, 1860', word: 'Section' as const, number: '415' };
    const seed = { id: 'seed-415', act_code: 'IPC', section_number: '415', section_title: 'Cheating', section_text: 'abridged', source_url: null };
    const docs = [{ tid: 1306824, title: 'Section 415 in The Indian Penal Code, 1860' }];

    it('puts the official text in place of the summary', async () => {
      const { fetcher: f, corpus } = fetcher({ docs, html: IPC_415 });

      const row = await f.replaceAbridged(seed as never, ipc);

      expect(corpus.replaceAbridged).toHaveBeenCalledWith('seed-415', 'Cheating', expect.stringMatching(/^415\. Whoever, by deceiving/), 'https://indiankanoon.org/doc/1306824/');
      expect(row).toMatchObject({ id: 'seed-415', source_url: 'https://indiankanoon.org/doc/1306824/' });
      expect(row?.section_text).toMatch(/^415\. Whoever, by deceiving/);
    });

    it('leaves the summary as it was when Kanoon does not have the section', async () => {
      const { fetcher: f, corpus } = fetcher({ docs: [] });

      expect(await f.replaceAbridged(seed as never, ipc)).toBeNull();
      expect(corpus.replaceAbridged).not.toHaveBeenCalled();
    });

    it('does not claim a replacement another request already made', async () => {
      const { fetcher: f, corpus } = fetcher({ docs, html: IPC_415 });
      corpus.replaceAbridged.mockResolvedValue(false);

      expect(await f.replaceAbridged(seed as never, ipc)).toBeNull();
    });
  });

  it('finds a provision of another Act kept earlier, by its Act', async () => {
    const { fetcher: f, corpus } = fetcher();
    corpus.lawsWithSection.mockResolvedValue([
      { id: 'a', act_name: 'The Prevention of Corruption Act, 1988', section_number: '138' },
      { id: 'b', act_name: 'The Negotiable Instruments Act, 1881', section_number: '138' },
    ]);

    expect((await f.stored(target))?.id).toBe('b');
  });
});
