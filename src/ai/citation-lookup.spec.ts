import { PrecedentRow } from '../database/types';
import { ABSOLUTE_RULE_NOTE, assumesAbsoluteRule, canonicalCitation, kanoonCitationForms, sameCitation } from './citation-match';
import { extractCitations } from './legal-patterns';
import { asksWhichCase, kanoonQueries, PrecedentsService, wrongCitationNote } from './precedents.service';

/**
 * Finding a judgment by its citation (Fix 1b).
 *
 * Live tests of 4 and 7 October 2026: every citation-only question Kanoon
 * should have answered came back "No judgment found" - (2014) 2 SCC 1, (1997)
 * 1 SCC 416, (2017) 10 SCC 1, (2021) 2 SCC 324, AIR 1962 SC 605 - and a name
 * with a wrong citation beside it was never searched by name (J-FK-11, 12).
 * The citation lists below are Indian Kanoon's own, read from the judgments'
 * pages on 7 October (docs 10239019, 1596139, 1033637).
 */

const LALITA_KUMARI = [
  'AIR 2014 SUPREME COURT 187', '2013 AIR SCW 6386', 'AIR 2014 SC (CRIMINAL) 66', '2014 (1) SCC (CRI) 524', '2013 (13) SCALE 559', '2014 (2) SCC 1',
];
const NANAVATI = ['1962 AIR 605', '1962 SCR SUPL. (1) 567', 'AIR 1962 SUPREME COURT 605', '1962 2 SCJ 347 1964 BOM LR 488'];
const BHAJAN_LAL = ['1992 AIR 604', '1990 SCR SUPL. (3) 259', 'AIR 1992 SUPREME COURT 604', '1992 SCC (SUPP) 1 335', '1992 SCC (CRI) 426'];

function row(over: Partial<PrecedentRow>): PrecedentRow {
  return {
    judgment_id: 'kanoon:1',
    case_title: 'Someone vs Someone Else',
    neutral_citation: null,
    reporter_citations: [],
    court_name: 'Supreme Court of India',
    court_type: 'SUPREME_COURT',
    judgment_date: new Date('2013-11-12'),
    bench: [],
    bench_strength: null,
    act_sections: [],
    headnote: null,
    ratio_decidendi: null,
    disposition: null,
    source_url: null,
    best_excerpt: '',
    para_number: null,
    score: 0.5,
    relevance_rank: 1,
    total_matches: 1,
    ...over,
  } as PrecedentRow;
}

/** A search result carries only the first citation Kanoon lists; the header has them all. */
const lalita = row({ judgment_id: 'kanoon:10239019', case_title: 'Lalita Kumari vs Govt.Of U.P.& Ors', reporter_citations: [LALITA_KUMARI[0]] });
const nanavati = row({ judgment_id: 'kanoon:1596139', case_title: 'K. M. Nanavati vs State Of Maharashtra', reporter_citations: [NANAVATI[0]] });
const bhajanLal = row({ judgment_id: 'kanoon:1033637', case_title: 'State Of Haryana And Ors vs Ch. Bhajan Lal And Ors', reporter_citations: [BHAJAN_LAL[0]] });
const arnesh = row({ judgment_id: 'kanoon:2982624', case_title: 'Arnesh Kumar vs State Of Bihar & Anr', reporter_citations: ['AIR 2014 SUPREME COURT 2756'] });
/** A High Court judgment that quotes Lalita Kumari - what `cite: (2014) 2 SCC 1` returned. */
const citing = row({ judgment_id: 'kanoon:77', case_title: 'Mobeen vs State Of U.P Thru. Prin. Secy. Home', court_name: 'Allahabad High Court' });
const other2019 = row({ judgment_id: 'kanoon:555', case_title: 'Someone Real vs Union Of India', reporter_citations: ['2019 (3) SCC 112'] });

const HEADERS: Record<number, string[]> = {
  10239019: LALITA_KUMARI,
  1596139: NANAVATI,
  1033637: BHAJAN_LAL,
  2982624: ['AIR 2014 SUPREME COURT 2756', '2014 (8) SCC 273', '2014 (3) SCC (CRI) 449'],
  77: ['2024 AHC 1234'],
  555: ['2019 (3) SCC 112'],
};

function build(search: (query: string) => PrecedentRow[]) {
  const kanoon = {
    isConfigured: true,
    isDegraded: false,
    search: jest.fn(async (query: string) => search(query)),
    documentHeader: jest.fn(async (tid: number) => ({
      caseNumber: null,
      neutralCitation: null,
      equivalentCitations: HEADERS[tid] ?? [],
      bench: [],
      extract: '',
    })),
  };
  const service = new PrecedentsService(
    {} as never,
    {} as never,
    kanoon as never,
    { get: () => 'kanoon', getNumber: (_k: string, d: number) => d } as never,
    { isRouterMocked: true } as never,
    { KANOON_ENRICH_MAX: 5, PRECEDENT_MAX_RESULTS: 15, PRECEDENT_PAGE_SIZE: 5 } as never,
  );
  return { service, kanoon };
}

function asked(text: string) {
  return { intent: 'PRECEDENT_SEARCH' as const, language: 'en', cnrNumber: null, sectionNumber: null, actCode: null, searchQuery: text, rawText: text, confidence: 0.9 };
}

describe('one report, many spellings (citation-match.ts)', () => {
  it.each([
    ['(2014) 2 SCC 1', '2014 (2) SCC 1'],
    ['(2014) 2 SCC 1', '2014 2 SCC 1'],
    ['AIR 1962 SC 605', 'AIR 1962 SUPREME COURT 605'],
    ['1992 Supp (1) SCC 335', '1992 SCC (SUPP) 1 335'],
    ['(1992) Supp 1 SCC 335', '1992 SCC (SUPP) 1 335'],
    ['2026 INSC 668', '2026 INSC 668'],
  ])('%s is %s', (a, b) => {
    expect(sameCitation(a, b)).toBe(true);
  });

  it.each([
    ['(2014) 2 SCC 1', '2014 (1) SCC (CRI) 524'], // SCC (Cri) is a different report
    ['(2014) 2 SCC 1', '(2014) 2 SCC 10'],
    ['AIR 1962 SC 605', 'AIR 1962 BOM 605'],
    ['1992 Supp (1) SCC 335', '1992 (1) SCC 335'], // the supplement is not the main volume
    ['(2020) 1 SCC 50', '2014 (2) SCC 1'],
  ])('%s is not %s', (a, b) => {
    expect(sameCitation(a, b)).toBe(false);
  });

  it("asks Kanoon in its own spelling first, then as typed", () => {
    expect(kanoonCitationForms('(2014) 2 SCC 1')).toEqual(['2014 (2) SCC 1', '(2014) 2 SCC 1']);
    expect(kanoonCitationForms('AIR 1962 SC 605')).toEqual(['AIR 1962 SUPREME COURT 605', '1962 AIR 605', 'AIR 1962 SC 605']);
    expect(kanoonCitationForms('1992 Supp (1) SCC 335')).toEqual(['1992 SCC (SUPP) 1 335', '1992 Supp (1) SCC 335']);
    expect(kanoonCitationForms('2014 (2) SCC 1')).toEqual(['2014 (2) SCC 1']);
  });

  it('keys an unknown reporter on its letters and digits, as before', () => {
    expect(canonicalCitation('(2013) 4 KER LJ 686')).toBe('20134kerlj686');
  });
});

describe('a Supreme Court Cases supplement is a citation (J-CL-10)', () => {
  it('is read out of the question', () => {
    // It was not, and "1992 Supp (1) SCC 335 - which judgment?" became a topic
    // search: "10 authorities on 1992 Supp (1) SCC 335", Indra Sawhney first.
    expect(extractCitations('1992 Supp (1) SCC 335 — which judgment?')).toEqual(['1992 Supp (1) SCC 335']);
    expect(extractCitations('see 1992 SCC (Supp) 1 335')).toEqual(['1992 SCC (Supp) 1 335']);
  });

  it('is searched as a citation, not as a topic', () => {
    expect(kanoonQueries(asked('1992 Supp (1) SCC 335 — which judgment?') as never)).toEqual([
      'cite: 1992 SCC (SUPP) 1 335',
      'cite: 1992 Supp (1) SCC 335',
    ]);
  });
});

describe('a judgment asked for by citation alone', () => {
  it('is found when the citation is on the judgment, though not the one on the search result (J-CL-02)', async () => {
    const { service, kanoon } = build((q) => (q === 'cite: 2014 (2) SCC 1' ? [lalita, citing] : [citing]));

    const result = await service.search(asked('Which case is reported at (2014) 2 SCC 1?') as never);

    expect(kanoon.search.mock.calls[0][0]).toBe('cite: 2014 (2) SCC 1');
    expect(result.namedCase).toEqual({ name: '(2014) 2 SCC 1', found: true });
    expect(result.precedents.map((p) => p.case_title)).toEqual(['Lalita Kumari vs Govt.Of U.P.& Ors']);
    expect(result.precedents[0].reporter_citations).toContain('2014 (2) SCC 1');
  });

  it('is not found in the judgments that merely cite it', async () => {
    // `cite: (2014) 2 SCC 1` returned 20,230 judgments quoting Lalita Kumari.
    const { service } = build(() => [citing]);

    const result = await service.search(asked('Which case is reported at (2014) 2 SCC 1?') as never);

    expect(result.namedCase).toEqual({ name: '(2014) 2 SCC 1', found: false });
    expect(result.precedents).toEqual([]);
  });

  it('matches AIR ... SC against Kanoon\'s AIR ... SUPREME COURT (J-CL-07)', async () => {
    const { service } = build((q) => (q === 'cite: AIR 1962 SUPREME COURT 605' ? [nanavati] : []));

    const result = await service.search(asked('AIR 1962 SC 605 — which case and what was held?') as never);

    expect(result.namedCase?.found).toBe(true);
    expect(result.precedents[0].case_title).toBe('K. M. Nanavati vs State Of Maharashtra');
  });

  it('finds a supplement citation (J-CL-10)', async () => {
    const { service } = build((q) => (q === 'cite: 1992 SCC (SUPP) 1 335' ? [bhajanLal] : []));

    const result = await service.search(asked('1992 Supp (1) SCC 335 — which judgment?') as never);

    expect(result.namedCase?.found).toBe(true);
    expect(result.precedents[0].case_title).toBe('State Of Haryana And Ors vs Ch. Bhajan Lal And Ors');
  });

  it('stops at the first spelling that finds it', async () => {
    const { service, kanoon } = build(() => [lalita]);

    await service.search(asked('(2014) 2 SCC 1') as never);

    expect(kanoon.search).toHaveBeenCalledTimes(1);
  });

  it('reads at most three headers per spelling', async () => {
    const { service, kanoon } = build(() => Array.from({ length: 10 }, (_, i) => row({ judgment_id: `kanoon:${900 + i}` })));

    await service.search(asked('(2014) 2 SCC 1') as never);

    // Two spellings, three headers each.
    expect(kanoon.documentHeader).toHaveBeenCalledTimes(6);
  });

  it('surfaces the error only when every spelling failed', async () => {
    const { service, kanoon } = build(() => []);
    kanoon.search.mockRejectedValue(new Error('indian kanoon is down'));

    await expect(service.search(asked('(2014) 2 SCC 1') as never)).rejects.toThrow('indian kanoon is down');
  });
});

describe('a case name with a citation that is not its own (J-FK-11, J-FK-12)', () => {
  it('finds the case by name and says whose citation it is', async () => {
    const { service, kanoon } = build((q) =>
      q.startsWith('cite:') ? [other2019] : q.startsWith('title:') ? [arnesh] : [],
    );

    const result = await service.search(asked('Summarise Arnesh Kumar v. State of Bihar, (2019) 3 SCC 112') as never);

    expect(kanoon.search.mock.calls.map((c) => c[0])).toEqual(['cite: 2019 (3) SCC 112', 'title: Arnesh Kumar State of Bihar']);
    expect(result.namedCase?.found).toBe(true);
    expect(result.precedents.map((p) => p.case_title)).toEqual(['Arnesh Kumar vs State Of Bihar & Anr']);
    expect(result.notes).toEqual([
      '(2019) 3 SCC 112 is the citation of Someone Real vs Union Of India, not of the judgment you named. The judgment you named is below.',
    ]);
  });

  it("says Kanoon does not list it for the case, and lists the case's own citations, SCC first", async () => {
    // Lalita Kumari is (2014) 2 SCC 1; "(2020) 1 SCC 50" is on no judgment here.
    const { service } = build((q) => (q.startsWith('title:') ? [lalita] : []));

    const result = await service.search(asked('What did Lalita Kumari v. Govt. of U.P., (2020) 1 SCC 50 hold?') as never);

    expect(result.namedCase?.found).toBe(true);
    expect(result.notes).toEqual([
      'Indian Kanoon does not list (2020) 1 SCC 50 for this judgment. It lists: 2014 (2) SCC 1; AIR 2014 SUPREME COURT 187; AIR 2014 SC (CRIMINAL) 66.',
    ]);
  });

  it('adds nothing when the citation is the named case\'s own', async () => {
    const { service, kanoon } = build((q) => (q === 'cite: 2014 (8) SCC 273' ? [arnesh] : []));

    const result = await service.search(asked('Summarise Arnesh Kumar v. State of Bihar, (2014) 8 SCC 273') as never);

    expect(kanoon.search).toHaveBeenCalledTimes(1);
    expect(result.namedCase?.found).toBe(true);
    expect(result.notes).toBeUndefined();
  });

  it('says the case was not found when the name search finds nothing either', async () => {
    const { service } = build(() => []);

    const result = await service.search(asked('Summarise Arnesh Kumar v. State of Bihar, (2019) 3 SCC 112') as never);

    expect(result.namedCase).toEqual({ name: 'Arnesh Kumar vs State of Bihar', found: false });
    expect(result.notes).toBeUndefined();
  });

  it('builds the note from Kanoon\'s records only', () => {
    expect(wrongCitationNote('(2020) 1 SCC 50', row({ reporter_citations: [] }), null)).toBe(
      'Indian Kanoon does not list (2020) 1 SCC 50 for this judgment.',
    );
  });
});

describe('a question that assumes a rule holds always (J-FK-15)', () => {
  it('is recognised', () => {
    expect(assumesAbsoluteRule('judgments holding that bail must always be granted in Section 420 cases')).toBe(true);
    expect(assumesAbsoluteRule('क्या जमानत हमेशा मिलती है')).toBe(true);
    expect(assumesAbsoluteRule('judgments on bail in Section 420 cases')).toBe(false);
  });

  it('is said above a topic list', async () => {
    const { service } = build(() => [row({ judgment_id: 'kanoon:42', case_title: 'Vijay Kumar Kela vs State' })]);

    const result = await service.search(
      asked('Give me five Supreme Court judgments with full SCC citations holding that bail must always be granted in Section 420 cases.') as never,
    );

    expect(result.notes).toEqual([ABSOLUTE_RULE_NOTE]);
  });

  it('is not said over a named case', async () => {
    const { service } = build(() => [arnesh]);

    const result = await service.search(asked('Did Arnesh Kumar v. State of Bihar say arrest must never be automatic?') as never);

    expect(result.notes).toBeUndefined();
  });
});

describe('"which case held ..." (S-SL-02, J-PL-14)', () => {
  it('is recognised in English and Hindi', () => {
    expect(asksWhichCase('Which case held that the procedure under Article 21 must be just, fair and reasonable?')).toBe(true);
    expect(asksWhichCase('Compensation for custodial death under Article 32 — leading case')).toBe(true);
    expect(asksWhichCase('धारा 482 CrPC के तहत FIR रद्द करने के मानदंड क्या हैं? सुप्रीम कोर्ट का फैसला')).toBe(true);
    expect(asksWhichCase('What does Article 21 say?')).toBe(false);
  });

  it('searches the words of the holding before the bare provision', () => {
    const intent = {
      ...asked('Which case held that the procedure under Article 21 must be just, fair and reasonable?'),
      searchQuery: 'procedure established by law Article 21 just fair and reasonable',
      sectionNumber: 'Article 21',
      actCode: 'COI',
    };
    expect(kanoonQueries(intent as never)).toEqual([
      'procedure established by law Article 21 just fair and reasonable',
      '"Article 21" "Constitution of India"',
    ]);
  });

  it('leaves an ordinary provision search as it was', () => {
    const intent = { ...asked('judgments on Article 21 and prisoners'), searchQuery: 'Article 21 prisoners', sectionNumber: 'Article 21', actCode: 'COI' };
    expect(kanoonQueries(intent as never)[0]).toBe('"Article 21" "Constitution of India"');
  });
});
