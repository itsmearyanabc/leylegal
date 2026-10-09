import research from './__fixtures__/research-6oct.json';
import { PrecedentRow } from '../database/types';
import {
  asksIfStillGoodLaw,
  knownOverrulingsOf,
  leadingFirst,
  LeadingJudgment,
  leadingJudgmentQueries,
  MAX_LEADING,
  parseLeadingJudgments,
  pickLeadingJudgment,
  textOverrules,
} from './leading-judgments';
import { kanoonQueries, orderingNote, PrecedentsService, priorityQueries, topicQuery } from './precedents.service';

/**
 * Research lists, from the live run of 6 October 2026: the leading judgment
 * was missing from P1, P10, NP1, NP5 and X29, and Kanoon finds each one when
 * asked for by its title and year. The rows are the real ones the answers
 * listed (__fixtures__/research-6oct.json).
 */
type Fixture = [string, string, string, string];

function row([id, title, date, court]: Fixture, rank = 1, citedBy?: number): PrecedentRow {
  return {
    judgment_id: id,
    case_title: title,
    neutral_citation: null,
    reporter_citations: [],
    court_name: court,
    court_type: null,
    judgment_date: new Date(date),
    bench: [],
    bench_strength: null,
    act_sections: [],
    headnote: null,
    ratio_decidendi: null,
    disposition: null,
    source_url: `https://indiankanoon.org/doc/${id.slice('kanoon:'.length)}/`,
    best_excerpt: '',
    para_number: null,
    score: 1 / (rank + 1),
    relevance_rank: rank,
    total_matches: 10,
    ...(citedBy === undefined ? {} : { cited_by: citedBy }),
  };
}

function intent(name: keyof typeof research) {
  const q = research[name] as { rawText: string; searchQuery: string };
  return { intent: 'PRECEDENT_SEARCH', sectionNumber: null, actCode: null, cnrNumber: null, confidence: 0.9, rawText: q.rawText, searchQuery: q.searchQuery } as never;
}

const ARNESH = research.V1.rows[0] as Fixture;
const [LALITA_2013, LALITA_2012, LALITA_PATNA] = research.X23.rows as Fixture[];
const [DK_BASU, NILABATI] = research.X28.rows as Fixture[];

describe('a topic, as Kanoon is asked it', () => {
  it.each([
    // The exact words that found T.T. Antony second, Paniben second and Arnesh
    // Kumar on Indian Kanoon on 6 October, where the rewrites did not.
    ['X29', 'Is a second FIR on the same incident permissible'],
    ['NP5', 'Can a conviction be based solely on a dying declaration without corroboration'],
    ['P10', 'what police should do before arrest in dowry harassment cases under Section 498A'],
    ['X28', 'compensation for custodial death'],
    ['NP1', 'Can a quash a 498A FIR based on a compromise between husband and wife'],
    ['P11', 'Is a mutation (dakhil kharij) entry considered proof of title to land'],
  ] as const)('%s', (name, query) => {
    expect(topicQuery((research[name] as { searchQuery: string }).searchQuery)).toBe(query);
  });

  it('keeps the court as the operator alone', () => {
    expect(kanoonQueries(intent('X29'))).toEqual(['Is a second FIR on the same incident permissible doctypes:supremecourt']);
  });

  it('reads the Supreme Court out of a question in Hindi, so the home court is not put above it (P10)', () => {
    expect(kanoonQueries(intent('P10'))).toEqual([
      'what police should do before arrest in dowry harassment cases under Section 498A doctypes:supremecourt',
    ]);
    expect(priorityQueries(intent('P10'), 'Delhi')).toBeNull();
  });

  it('leaves a question with no court and no research words as it was', () => {
    expect(topicQuery('anticipatory bail after chargesheet')).toBe('anticipatory bail after chargesheet');
  });
});

describe('the leading judgments the model names', () => {
  it('are kept with a cause title and a year', () => {
    const text = JSON.stringify({
      cases: [
        { name: 'Arnesh Kumar v. State of Bihar', year: 2014, court: 'Supreme Court' },
        { name: 'Lalita Kumari v. Government of Uttar Pradesh', year: 2013 },
      ],
    });
    expect(parseLeadingJudgments(text, 2026)).toEqual([
      { name: 'Arnesh Kumar v. State of Bihar', year: 2014, court: 'Supreme Court' },
      { name: 'Lalita Kumari v. Government of Uttar Pradesh', year: 2013, court: null },
    ]);
  });

  it('are dropped without a cause title, without a believable year, or twice', () => {
    const text = JSON.stringify({
      cases: [
        { name: 'The Arnesh Kumar guidelines', year: 2014 },
        { name: 'Arnesh Kumar v. State of Bihar', year: 2031 },
        { name: 'Arnesh Kumar v. State of Bihar', year: 'recent' },
        { name: 'Arnesh Kumar v. State of Bihar', year: 2014 },
        { name: 'arnesh kumar v. state of bihar', year: 2014 },
      ],
    });
    expect(parseLeadingJudgments(text, 2026)).toEqual([{ name: 'Arnesh Kumar v. State of Bihar', year: 2014, court: null }]);
  });

  it(`are at most ${MAX_LEADING}, and none when the answer is not JSON`, () => {
    const names = ['Arnesh Kumar v. State of Bihar', 'Lalita Kumari v. Govt of UP', 'D.K. Basu v. State of West Bengal', 'Gian Singh v. State of Punjab'];
    expect(parseLeadingJudgments(JSON.stringify({ cases: names.map((name) => ({ name, year: 2000 })) }), 2026)).toHaveLength(MAX_LEADING);
    expect(parseLeadingJudgments('I am not sure.', 2026)).toEqual([]);
  });
});

describe('looking a named judgment up on Kanoon', () => {
  const laxman: LeadingJudgment = { name: 'Laxman v. State of Maharashtra', year: 2002, court: 'Supreme Court' };

  it('searches its title within a year either side, court first (the query that found the 2002 Constitution Bench)', () => {
    expect(leadingJudgmentQueries(laxman, null)).toEqual([
      'doctypes:supremecourt fromdate: 1-1-2001 todate: 31-12-2003 title: Laxman State of Maharashtra',
      'doctypes:supremecourt fromdate: 1-1-2001 todate: 31-12-2003 title: Laxman',
    ]);
  });

  it('keeps to the court the advocate asked for', () => {
    expect(leadingJudgmentQueries(laxman, 'patna')[0]).toMatch(/^doctypes:patna /);
  });

  it('never searches a State petitioner on its own', () => {
    expect(leadingJudgmentQueries({ name: 'State of Haryana v. Bhajan Lal', year: 1990, court: 'Supreme Court' }, null)).toHaveLength(1);
  });
});

describe('the judgment taken from the results', () => {
  const arnesh: LeadingJudgment = { name: 'Arnesh Kumar v. State of Bihar', year: 2014, court: 'Supreme Court' };

  it('is the one named', () => {
    expect(pickLeadingJudgment(arnesh, [row(ARNESH)])?.judgment_id).toBe('kanoon:2982624');
  });

  it('is from the year named or one either side: D.K. Basu was delivered in December 1996 and reported in 1997', () => {
    const basu = (year: number): LeadingJudgment => ({ name: 'D.K. Basu v. State of West Bengal', year, court: 'Supreme Court' });
    expect(pickLeadingJudgment(basu(1997), [row(DK_BASU)])?.judgment_id).toBe('kanoon:501198');
    expect(pickLeadingJudgment(basu(1999), [row(DK_BASU)])).toBeNull();
  });

  it('is not somebody else', () => {
    expect(pickLeadingJudgment(arnesh, [row(NILABATI), row(LALITA_PATNA)])).toBeNull();
  });

  it('is not an order in the matter', () => {
    expect(pickLeadingJudgment(arnesh, [row([ARNESH[0], ARNESH[1], ARNESH[2], 'Supreme Court - Daily Orders'])])).toBeNull();
  });

  it('of two under one title, is the most cited, then the nearest year: the 2013 Constitution Bench, not the 2012 reference order', () => {
    const lalita: LeadingJudgment = { name: 'Lalita Kumari v. Government of Uttar Pradesh', year: 2013, court: 'Supreme Court' };
    expect(pickLeadingJudgment(lalita, [row(LALITA_2012, 1), row(LALITA_2013, 2)])?.judgment_id).toBe('kanoon:10239019');
    // Indian Kanoon: the 2013 judgment is cited by 18,813 (6 Oct 2026).
    expect(pickLeadingJudgment({ ...lalita, year: 2012 }, [row(LALITA_2012, 1), row(LALITA_2013, 2, 18813)])?.judgment_id).toBe('kanoon:10239019');
  });

  it('of the respondent Kanoon spells its own way, on the petitioner alone', () => {
    const lalita: LeadingJudgment = { name: 'Lalita Kumari v. Government of Uttar Pradesh', year: 2013, court: 'Supreme Court' };
    expect(pickLeadingJudgment(lalita, [row(LALITA_2013)], { petitionerOnly: true })?.judgment_id).toBe('kanoon:10239019');
  });

  it('of a Supreme Court judgment, is from the Supreme Court: not the Patna High Court "Lalita Kumari" of 2025', () => {
    const lalita: LeadingJudgment = { name: 'Lalita Kumari v. Government of Uttar Pradesh', year: 2025, court: 'Supreme Court' };
    expect(pickLeadingJudgment(lalita, [row(LALITA_PATNA)], { petitionerOnly: true })).toBeNull();
    expect(pickLeadingJudgment({ ...lalita, court: null }, [row(LALITA_PATNA)], { askedCourt: 'supremecourt' })).toBeNull();
  });
});

describe('the list', () => {
  const p1 = (research.P1.rows as Fixture[]).map((r, i) => row(r, i + 1));

  it('opens with the leading judgments and stays at its length', () => {
    const out = leadingFirst([row(ARNESH)], p1, 10);
    expect(out).toHaveLength(10);
    expect(out[0].case_title).toBe('Arnesh Kumar vs State Of Bihar & Anr');
    expect(out[9].case_title).toBe('Siddharam Satlingappa Mhetre vs State Of Maharashtra And Ors');
  });

  it('shows a leading judgment once, even when the search found it too', () => {
    const lalita = p1.find((r) => r.judgment_id === 'kanoon:10239019')!;
    const out = leadingFirst([lalita], p1, 10);
    expect(out.filter((r) => r.judgment_id === 'kanoon:10239019')).toHaveLength(1);
    expect(out[0].judgment_id).toBe('kanoon:10239019');
  });

  it('says who chose them', () => {
    expect(orderingNote({ homeCourt: null, byCourt: false, leading: 1 })).toBe(
      'leading judgments first (named by AI, each found on Indian Kanoon), then newest first',
    );
    expect(orderingNote({ homeCourt: 'Delhi High Court', leading: 2 })).toBe(
      'leading judgments first (named by AI, each found on Indian Kanoon), then Delhi High Court first, then the Supreme Court, then other courts — newest first within each',
    );
    expect(orderingNote({ homeCourt: null })).toBe('Supreme Court first, then other courts — newest first within each');
  });
});

describe('a research search', () => {
  const p1 = (research.P1.rows as Fixture[]).map((r, i) => row(r, i + 1));
  const ARNESH_QUERY = 'doctypes:supremecourt fromdate: 1-1-2013 todate: 31-12-2015 title: Arnesh Kumar State of Bihar';

  function build(answer: string | Error, titleRows: PrecedentRow[] = [row(ARNESH, 1, research.V1.citedBy)]) {
    const search = jest.fn(async (query: string) => (query.includes('title:') ? titleRows : p1));
    const complete = answer instanceof Error ? jest.fn().mockRejectedValue(answer) : jest.fn().mockResolvedValue({ text: answer, model: 'gpt-4.1', inputTokens: 0, outputTokens: 0 });
    const service = new PrecedentsService(
      {} as never,
      {} as never,
      { isConfigured: true, isDegraded: false, search, documentHeader: jest.fn() } as never,
      { get: () => 'kanoon', getNumber: (_k: string, d: number) => d } as never,
      { isRouterMocked: true, isSynthesisMocked: false, complete } as never,
      { KANOON_ENRICH_MAX: 0, PRECEDENT_MAX_RESULTS: 10, PRECEDENT_PAGE_SIZE: 5 } as never,
    );
    return { service, search, complete };
  }
  // The model's answer is stubbed: Arnesh Kumar's real name and year.
  const NAMES_ARNESH = JSON.stringify({ cases: [{ name: 'Arnesh Kumar v. State of Bihar', year: 2014, court: 'Supreme Court' }] });

  it('puts the leading judgment Kanoon has first (P1: Arnesh Kumar, which the search did not find)', async () => {
    const { service, search, complete } = build(NAMES_ARNESH);

    const result = await service.search(intent('P1'), null);

    expect(complete.mock.calls[0][0].task).toBe('synthesis');
    expect(search.mock.calls.map((c) => c[0])).toContain(ARNESH_QUERY);
    expect(result.precedents[0].case_title).toBe('Arnesh Kumar vs State Of Bihar & Anr');
    expect(result.precedents).toHaveLength(10);
    expect(result.grouping).toEqual({ homeCourt: null, byCourt: false, leading: 1 });
  });

  it('adds nothing when Kanoon has no such judgment in that year', async () => {
    const { service } = build(NAMES_ARNESH, []);
    const result = await service.search(intent('P1'), null);
    expect(result.precedents.map((r) => r.judgment_id)).toEqual(p1.map((r) => r.judgment_id));
    expect(result.grouping).toBeUndefined();
  });

  it('stands without them when the model fails', async () => {
    const { service } = build(new Error('timeout'));
    const result = await service.search(intent('P1'), null);
    expect(result.precedents.map((r) => r.judgment_id)).toEqual(p1.map((r) => r.judgment_id));
  });

  it('asks nothing for a judgment named in the question', async () => {
    const { service, complete } = build(NAMES_ARNESH);
    await service.search(
      { intent: 'PRECEDENT_SEARCH', sectionNumber: null, actCode: null, cnrNumber: null, confidence: 0.9, rawText: 'Summarise Arnesh Kumar v. State of Bihar', searchQuery: 'Arnesh Kumar v. State of Bihar' } as never,
      null,
    );
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('the bench, which Kanoon cannot search by', () => {
  it('is not sent as words: NP5 in the second run of 6 October', () => {
    expect(
      topicQuery('Can a conviction be based solely on a dying declaration without corroboration? Supreme Court Constitution Bench ruling'),
    ).toBe('Can a conviction be based solely on a dying declaration without corroboration');
    expect(topicQuery('nine-judge bench on the right to privacy')).toBe('on the right to privacy');
  });
});

/**
 * The model's own names, from the server log of 6 October: Kanoon's title
 * search needs every word sent to be in the title.
 */
describe('a name the model wrote with "and Others" and brackets', () => {
  it('is searched in the words Kanoon titles it with (NP6: "Sushila Aggarwal vs State (Nct Of Delhi)")', () => {
    expect(
      leadingJudgmentQueries({ name: 'Sushila Aggarwal and Others v. State (NCT of Delhi) and Another', year: 2020, court: null }, 'supremecourt'),
    ).toEqual([
      'doctypes:supremecourt fromdate: 1-1-2019 todate: 31-12-2021 title: Sushila Aggarwal State NCT of Delhi',
      'doctypes:supremecourt fromdate: 1-1-2019 todate: 31-12-2021 title: Sushila Aggarwal',
    ]);
  });

  it('is still matched to the title by its parties', () => {
    const sushila: LeadingJudgment = { name: 'Sushila Aggarwal and Others v. State (NCT of Delhi) and Another', year: 2020, court: 'Supreme Court' };
    const p1 = research.P1.rows as Fixture[];
    expect(pickLeadingJudgment(sushila, [row(p1[1])])?.judgment_id).toBe('kanoon:123660783');
  });
});

/**
 * A question whose answer is one judgment (intent.service.ts, asksForOneJudgment).
 * Live test of 8 Oct: Kesavananda came first for "which case laid down the
 * basic structure doctrine", then nine unrelated judgments - four of them the
 * Delhi High Court's (S-SL-01). Titles and courts are the ones listed that day.
 */
describe('a question that asks for one judgment', () => {
  const kesavananda = row(['kanoon:2001', 'Kesavananda Bharati Sripadagalvaru And Ors vs State Of Kerala And Anr', '1973-04-24', 'Supreme Court of India'], 1, 9000);
  const padding = [
    row(['kanoon:2002', '9X Media Pvt. Ltd. & Ors vs Telecom Regulatory Authority Of India', '2024-05-01', 'Delhi High Court'], 1),
    row(['kanoon:2003', 'R P Agrawal vs The Union Of India Through The Secretary', '2023-03-01', 'Delhi High Court'], 2),
    row(['kanoon:2004', 'Modern Dental College & Res.Cen. & Ors vs State Of Madhya Pradesh', '2016-05-02', 'Supreme Court of India'], 3),
  ];
  const NAMES_KESAVANANDA = JSON.stringify({ cases: [{ name: 'Kesavananda Bharati v. State of Kerala', year: 1973, court: 'Supreme Court' }] });

  function build(answer: string, titleRows: PrecedentRow[]) {
    const search = jest.fn(async (query: string) => (query.includes('title:') ? titleRows : padding));
    const complete = jest.fn().mockResolvedValue({ text: answer, model: 'gpt-4.1', inputTokens: 0, outputTokens: 0 });
    const service = new PrecedentsService(
      {} as never,
      {} as never,
      { isConfigured: true, isDegraded: false, search, documentHeader: jest.fn() } as never,
      { get: () => 'kanoon', getNumber: (_k: string, d: number) => d } as never,
      { isRouterMocked: true, isSynthesisMocked: false, complete } as never,
      { KANOON_ENRICH_MAX: 0, PRECEDENT_MAX_RESULTS: 10, PRECEDENT_PAGE_SIZE: 5 } as never,
    );
    return { service, search };
  }
  const asked = (text: string) =>
    ({ intent: 'PRECEDENT_SEARCH', sectionNumber: null, actCode: null, cnrNumber: null, confidence: 0.9, rawText: text, searchQuery: 'basic structure doctrine' }) as never;

  it('is answered by the leading judgment alone, and the home court is not searched (S-SL-01)', async () => {
    const { service, search } = build(NAMES_KESAVANANDA, [kesavananda]);

    const result = await service.search(asked('Which case laid down the basic structure doctrine?'), 'Delhi');

    expect(result.precedents.map((r) => r.case_title)).toEqual(['Kesavananda Bharati Sripadagalvaru And Ors vs State Of Kerala And Anr']);
    expect(result.grouping).toEqual({ homeCourt: null, byCourt: false, leading: 1, onlyLeading: true });
    expect(orderingNote(result.grouping)).toBe('the leading judgment, named by AI and found on Indian Kanoon');
    expect(search.mock.calls.map((c) => c[0]).some((q) => q.includes('doctypes:delhi'))).toBe(false);
  });

  it('is the list as before, without the home court first, when no leading judgment is found', async () => {
    const { service } = build(NAMES_KESAVANANDA, []);

    const result = await service.search(asked('Which case laid down the basic structure doctrine?'), 'Delhi');

    expect(result.precedents.length).toBeGreaterThan(1);
    expect(result.grouping).toEqual({ homeCourt: null });
    // The Supreme Court first: the Delhi High Court is not promoted.
    expect(result.precedents[0].court_name).toBe('Supreme Court of India');
  });

  it('leaves a research question with its home court (P1)', async () => {
    const { service, search } = build(NAMES_KESAVANANDA, [kesavananda]);

    await service.search(asked('basic structure doctrine judgments'), 'Delhi');

    expect(search.mock.calls.map((c) => c[0]).some((q) => q.includes('doctypes:delhi'))).toBe(true);
  });

  it('does not search the home court for authorities to argue from (S-MT-03)', async () => {
    const { service, search } = build(NAMES_KESAVANANDA, []);

    await service.search(asked("I need authorities for 'bail is the rule, jail is the exception' for my memorial — with full citations."), 'Delhi');

    expect(search.mock.calls.map((c) => c[0]).some((q) => q.includes('doctypes:delhi'))).toBe(false);
  });
});

describe('a judgment from before the Constitution (S-SL-20)', () => {
  it('is believed from 1860: the Privy Council decided Mahbub Shah in 1945', () => {
    const text = JSON.stringify({
      cases: [
        { name: 'Mahbub Shah v. Emperor', year: 1945, court: 'Privy Council' },
        { name: 'Barendra Kumar Ghosh v. King Emperor', year: 1924, court: 'Privy Council' },
        { name: 'Someone v. The Crown', year: 1850, court: 'Privy Council' },
      ],
    });
    expect(parseLeadingJudgments(text, 2026)).toEqual([
      { name: 'Mahbub Shah v. Emperor', year: 1945, court: 'Privy Council' },
      { name: 'Barendra Kumar Ghosh v. King Emperor', year: 1924, court: 'Privy Council' },
    ]);
  });

  it('is looked for by title and year, in no court Kanoon has no slug for', () => {
    expect(leadingJudgmentQueries({ name: 'Mahbub Shah v. Emperor', year: 1945, court: 'Privy Council' }, null)).toEqual([
      'fromdate: 1-1-1944 todate: 31-12-1946 title: Mahbub Shah Emperor',
      'fromdate: 1-1-1944 todate: 31-12-1946 title: Mahbub Shah',
    ]);
  });
});

/**
 * "Is X still good law?" (precedents.service.ts, overruledBy). Live test of 8
 * Oct: Shafhi Mohammad, Suresh Kumar Koushal and P.V. Narasimha Rao were each
 * returned alone, with no word of the judgments that overruled them (J-GL-01,
 * 02, 08).
 */
describe('a judgment asked about as "still good law?"', () => {
  /** The Supreme Court Reports headnote of Arjun Panditrao Khotkar (2020), as published. */
  const ARJUN_HEADNOTE = 'Shafhi Mohammad and the judgment dtd. 03.04.18 reported as [2018] 3 SCR 1096 are overruled.';
  const shafhi = row(['kanoon:3001', 'Shafhi Mohammad vs The State Of Himachal Pradesh', '2018-01-30', 'Supreme Court of India']);
  const arjun = row(['kanoon:3002', 'Arjun Panditrao Khotkar vs Kailash Kushanrao Gorantyal', '2020-07-14', 'Supreme Court of India']);
  const NAMES_ARJUN = JSON.stringify({ cases: [{ name: 'Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal', year: 2020, court: 'Supreme Court' }] });
  const QUESTION = 'Is Shafhi Mohammad v. State of H.P. still good law on the Section 65B certificate?';

  function build(answer: string, document: string) {
    const search = jest.fn(async (query: string) => (query.includes('Arjun') ? [arjun] : query.includes('Shafhi') ? [shafhi] : []));
    const complete = jest.fn().mockResolvedValue({ text: answer, model: 'gpt-4.1', inputTokens: 0, outputTokens: 0 });
    const lawDocument = jest.fn().mockResolvedValue(document);
    const service = new PrecedentsService(
      {} as never,
      {} as never,
      { isConfigured: true, isDegraded: false, search, documentHeader: jest.fn(), lawDocument } as never,
      { get: () => 'kanoon', getNumber: (_k: string, d: number) => d } as never,
      { isRouterMocked: true, isSynthesisMocked: false, complete } as never,
      { KANOON_ENRICH_MAX: 0, PRECEDENT_MAX_RESULTS: 10, PRECEDENT_PAGE_SIZE: 5, KANOON_TIMEOUT_MS: 15000 } as never,
    );
    return { service, complete, lawDocument };
  }
  const asked = { intent: 'PRECEDENT_SEARCH', sectionNumber: null, actCode: null, cnrNumber: null, confidence: 0.9, rawText: QUESTION, searchQuery: QUESTION } as never;

  it('is recognised', () => {
    expect(asksIfStillGoodLaw(QUESTION)).toBe(true);
    expect(asksIfStillGoodLaw('Is Suresh Kumar Koushal v. Naz Foundation still good law?')).toBe(true);
    expect(asksIfStillGoodLaw('Summarise Suresh Kumar Koushal v. Naz Foundation')).toBe(false);
  });

  it('lists the judgment that overruled it, after it, and says so (J-GL-01)', async () => {
    const { service, lawDocument } = build(NAMES_ARJUN, `<p>${ARJUN_HEADNOTE}</p>`);

    const result = await service.search(asked, null);

    expect(lawDocument).toHaveBeenCalledWith(3002, 15000);
    expect(result.precedents.map((r) => r.case_title)).toEqual([
      'Shafhi Mohammad vs The State Of Himachal Pradesh',
      'Arjun Panditrao Khotkar vs Kailash Kushanrao Gorantyal',
    ]);
    expect(result.notes).toEqual([
      'Overruled: Shafhi Mohammad vs The State Of Himachal Pradesh was overruled by Arjun Panditrao Khotkar vs Kailash Kushanrao Gorantyal (2020), listed below it. ' +
        'The later judgment was named by AI and found on Indian Kanoon, and its text says the earlier one is overruled.',
    ]);
  });

  it('claims nothing when the later judgment\'s text does not say it overruled the earlier one', async () => {
    const { service } = build(NAMES_ARJUN, '<p>The certificate under Section 65B(4) is a condition precedent to admissibility.</p>');

    const result = await service.search(asked, null);

    expect(result.precedents.map((r) => r.judgment_id)).toEqual(['kanoon:3001']);
    expect(result.notes?.[0]).toMatch(/^Ley Legal did not find a later judgment overruling Shafhi Mohammad vs The State Of Himachal Pradesh\. That does not confirm/);
  });

  it('finds a known overruling when the model names none, still checked in the text (J-GL-08)', async () => {
    // Live, 9 Oct: asked what overruled P.V. Narasimha Rao, the model answered
    // {"cases": []} three times. Shafhi Mohammad is on the same list.
    const { service, complete, lawDocument } = build(JSON.stringify({ cases: [] }), `<p>${ARJUN_HEADNOTE}</p>`);

    const result = await service.search(asked, null);

    expect(lawDocument).toHaveBeenCalledWith(3002, 15000);
    // Found from the list: the model is not asked at all.
    expect(complete).not.toHaveBeenCalled();
    expect(result.precedents.map((r) => r.judgment_id)).toEqual(['kanoon:3001', 'kanoon:3002']);
    expect(result.notes?.[0]).toMatch(/^Overruled: Shafhi Mohammad/);
  });

  it('claims nothing from the list when the later judgment\'s text does not say so', async () => {
    const { service, complete } = build(JSON.stringify({ cases: [] }), '<p>Section 65B(4) certificate is a condition precedent.</p>');

    const result = await service.search(asked, null);

    // The list's candidate failed the text check, so the model is asked next - and names none.
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.precedents).toHaveLength(1);
    expect(result.notes?.[0]).toMatch(/^Ley Legal did not find a later judgment overruling/);
  });

  it('reads an overruling only where the text says it, not where it denies it', () => {
    expect(textOverrules(`<p>${ARJUN_HEADNOTE}</p>`, ['Shafhi', 'Mohammad'])).toBe(true);
    expect(textOverrules('<p>The view in Shafhi Mohammad has not been overruled and is followed here.</p>', ['Shafhi', 'Mohammad'])).toBe(false);
    expect(textOverrules('<p>Shafhi Mohammad is not overruled.</p>', ['Shafhi', 'Mohammad'])).toBe(false);
    // Overruled, but not that judgment.
    expect(textOverrules(`<p>${ARJUN_HEADNOTE}</p>`, ['Suresh', 'Kumar', 'Koushal'])).toBe(false);
  });
});

describe('the overrulings Ley Legal knows of (KNOWN_OVERRULINGS)', () => {
  it.each([
    ['P.V. Narasimha Rao vs State(Cbi/Spe)', 1998, 'Sita Soren v. Union of India'],
    ['Suresh Kumar Koushal & Anr vs Naz Foundation & Ors', 2013, 'Navtej Singh Johar v. Union of India'],
    ['Bhatia International vs Bulk Trading S.A. & Anr', 2002, 'Bharat Aluminium Co. v. Kaiser Aluminium Technical Services Inc.'],
    ['Gurdwara Sahib vs Gram Panchayat Village Sirthala & Anr', 2013, 'Ravinder Kaur Grewal v. Manjit Kaur'],
  ])('%s (%i) -> %s', (title, year, later) => {
    expect(knownOverrulingsOf(title, year).map((j) => j.name)).toEqual([later]);
  });

  it.each([
    ['State Of Punjab vs Davinder Singh', 2024],
    ['Lalita Kumari vs Govt.Of U.P.& Ors', 2013],
    ['Kesavananda Bharati Sripadagalvaru vs State Of Kerala And Anr', 1973],
    // The right title in the wrong year is another judgment.
    ['P.V. Narasimha Rao vs State(Cbi/Spe)', 2005],
  ])('names nothing for %s (%i)', (title, year) => {
    expect(knownOverrulingsOf(title, year)).toEqual([]);
  });

  it('carries the name a later judgment uses for ADM Jabalpur', () => {
    expect(knownOverrulingsOf('Additional District Magistrate, Jabalpur vs Shivakant Shukla', 1976)[0]).toMatchObject({ alias: 'ADM Jabalpur' });
  });

  it('reads "overrule the decisions" and "overrule the law laid down" as an overruling', () => {
    expect(textOverrules('<p>We overrule the decisions in Gurdwara Sahib and the cases that followed it.</p>', ['Gurdwara', 'Sahib'])).toBe(true);
    expect(textOverrules('<p>We overrule the law laid down in Bhatia International.</p>', ['Bhatia', 'International'])).toBe(true);
  });
});
