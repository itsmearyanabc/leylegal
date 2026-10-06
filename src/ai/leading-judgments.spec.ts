import research from './__fixtures__/research-6oct.json';
import { PrecedentRow } from '../database/types';
import {
  leadingFirst,
  LeadingJudgment,
  leadingJudgmentQueries,
  MAX_LEADING,
  parseLeadingJudgments,
  pickLeadingJudgment,
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
