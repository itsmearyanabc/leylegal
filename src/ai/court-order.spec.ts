import { PRACTICE_STATES, canonicalState } from '../common/states';
import { PrecedentRow } from '../database/types';
import { asksAboutNamedJudgment } from './intent.service';
import {
  PrecedentsService,
  arrangeByCourt,
  homeCourtName,
  homeHighCourt,
  orderingNote,
  priorityQueries,
} from './precedents.service';

/**
 * "Show results from the home High Court or Supreme Court first - if I am
 * registered in Karnataka I should receive Karnataka High Court results first,
 * if available, but that search has to be done - in the order of the DATE OF
 * JUDGMENT."
 *
 * Three requirements, each tested here: the home court and the Supreme Court
 * are *searched*, not merely picked out of a general search; the list is
 * arranged home, then Supreme Court, then the rest; and each group runs newest
 * first by date of judgment.
 */

let id = 0;
function row(court: string, date: string, over: Partial<PrecedentRow> = {}): PrecedentRow {
  id += 1;
  return {
    judgment_id: `kanoon:${id}`,
    case_title: `Case ${id} vs State`,
    neutral_citation: null,
    reporter_citations: [],
    court_name: court,
    court_type: 'HIGH_COURT',
    judgment_date: new Date(date),
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
    relevance_rank: id,
    total_matches: 100,
    ...over,
  } as PrecedentRow;
}

function intent(text: string, over: Record<string, unknown> = {}) {
  return {
    intent: 'PRECEDENT_SEARCH' as const,
    language: 'en',
    cnrNumber: null,
    sectionNumber: null,
    actCode: null,
    searchQuery: text,
    rawText: text,
    confidence: 0.9,
    ...over,
  };
}

describe('the order an advocate reads authority in', () => {
  it('puts their High Court first, then the Supreme Court, then the rest', () => {
    const out = arrangeByCourt(
      {
        home: [],
        supreme: [],
        general: [
          row('Delhi High Court', '2024-06-01'),
          row('Supreme Court of India', '2023-01-01'),
          row('Karnataka High Court', '2019-03-03'),
        ],
      },
      'Karnataka',
      10,
    );

    expect(out.map((r) => r.court_name)).toEqual([
      'Karnataka High Court',
      'Supreme Court of India',
      'Delhi High Court',
    ]);
  });

  it('runs newest first by date of judgment within each court', () => {
    const out = arrangeByCourt(
      {
        home: [row('Karnataka High Court', '2015-01-01'), row('Karnataka High Court', '2023-05-05')],
        supreme: [row('Supreme Court of India', '2001-01-01'), row('Supreme Court of India', '2020-02-02')],
        general: [],
      },
      'Karnataka',
      10,
    );

    expect(out.map((r) => (r.judgment_date as Date).getUTCFullYear())).toEqual([2023, 2015, 2020, 2001]);
  });

  it('gives a court with nothing on the question no space, and never leaves the page short', () => {
    const home = Array.from({ length: 8 }, (_, i) => row('Karnataka High Court', `201${i}-01-01`));
    const out = arrangeByCourt({ home, supreme: [], general: [row('Delhi High Court', '2024-01-01')] }, 'Karnataka', 10);

    expect(out).toHaveLength(9);
    expect(out.slice(0, 8).every((r) => r.court_name === 'Karnataka High Court')).toBe(true);
  });

  it('shares the page when every court has plenty', () => {
    const many = (court: string) => Array.from({ length: 10 }, (_, i) => row(court, `201${i}-01-01`));
    const out = arrangeByCourt(
      { home: many('Karnataka High Court'), supreme: many('Supreme Court of India'), general: many('Delhi High Court') },
      'Karnataka',
      10,
    );

    const count = (court: string) => out.filter((r) => r.court_name === court).length;
    expect([count('Karnataka High Court'), count('Supreme Court of India'), count('Delhi High Court')]).toEqual([4, 3, 3]);
  });

  it('lists a judgment found by two searches once', () => {
    const shared = row('Karnataka High Court', '2022-01-01');
    const out = arrangeByCourt({ home: [shared], supreme: [], general: [shared] }, 'Karnataka', 10);
    expect(out).toHaveLength(1);
  });

  it("recognises the home court under Kanoon's own spelling of it", () => {
    // Kanoon writes "Chattisgarh"; the state is Chhattisgarh.
    const out = arrangeByCourt(
      { home: [], supreme: [], general: [row('Delhi High Court', '2024-01-01'), row('Chattisgarh High Court', '2010-01-01')] },
      'Chhattisgarh',
      10,
    );
    expect(out[0].court_name).toBe('Chattisgarh High Court');
  });

  it('does not trust a court-restricted search over the judgment itself', () => {
    const out = arrangeByCourt(
      { home: [row('Delhi High Court', '2024-01-01'), row('Karnataka High Court', '2001-01-01')], supreme: [], general: [] },
      'Karnataka',
      10,
    );
    expect(out[0].court_name).toBe('Karnataka High Court');
  });

  it('still puts the Supreme Court first for an advocate with no state on record', () => {
    const out = arrangeByCourt(
      { home: [], supreme: [], general: [row('Delhi High Court', '2024-01-01'), row('Supreme Court of India', '2000-01-01')] },
      null,
      10,
    );
    expect(out[0].court_name).toBe('Supreme Court of India');
  });

  it('says so on the page', () => {
    expect(orderingNote({ homeCourt: 'Karnataka High Court' })).toContain('Karnataka High Court first, then the Supreme Court');
    expect(orderingNote({ homeCourt: null })).toContain('Supreme Court first');
    expect(orderingNote(undefined)).toBe('newest first');
  });
});

describe('which searches are run', () => {
  it('searches the home court and the Supreme Court on their own, for a topic', () => {
    expect(priorityQueries(intent('anticipatory bail after chargesheet') as never, 'Karnataka')).toEqual({
      home: 'anticipatory bail after chargesheet doctypes:karnataka',
      supreme: 'anticipatory bail after chargesheet doctypes:supremecourt',
    });
  });

  it('keeps the provision as the query for a provision search', () => {
    const scoped = priorityQueries(
      intent('judgments on 302 IPC', { sectionNumber: '302', actCode: 'IPC' }) as never,
      'Karnataka',
    );
    expect(scoped?.home).toBe('"Section 302" "Indian Penal Code" doctypes:karnataka');
  });

  it('adds nothing for a named case, a citation, or a court the advocate named', () => {
    expect(priorityQueries(intent('summary of Vishaka vs State of Rajasthan') as never, 'Karnataka')).toBeNull();
    expect(priorityQueries(intent('AIR 1973 SC 1461') as never, 'Karnataka')).toBeNull();
    expect(priorityQueries(intent('Patna High Court judgments on bail') as never, 'Karnataka')).toBeNull();
  });

  it('searches the Supreme Court alone when the advocate has no state', () => {
    expect(priorityQueries(intent('bail') as never, null)).toEqual({ home: null, supreme: 'bail doctypes:supremecourt' });
  });

  it('runs them through Kanoon, and survives one of them failing', async () => {
    const search = jest.fn(async (query: string) => {
      if (query.includes('doctypes:supremecourt')) throw new Error('kanoon hiccup');
      if (query.includes('doctypes:karnataka')) return [row('Karnataka High Court', '2018-01-01')];
      return [row('Delhi High Court', '2024-01-01')];
    });
    const service = new PrecedentsService(
      {} as never,
      {} as never,
      { isConfigured: true, isDegraded: false, search, documentHeader: jest.fn().mockResolvedValue({ bench: [] }) } as never,
      { get: () => 'kanoon', getNumber: (_k: string, d: number) => d } as never,
      { isRouterMocked: true } as never,
      { KANOON_ENRICH_MAX: 0, PRECEDENT_MAX_RESULTS: 10, PRECEDENT_PAGE_SIZE: 5 } as never,
    );

    const result = await service.search(intent('bail in NDPS cases') as never, 'Karnataka');

    expect(search.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['bail in NDPS cases doctypes:karnataka', 'bail in NDPS cases doctypes:supremecourt']),
    );
    expect(result.precedents.map((r) => r.court_name)).toEqual(['Karnataka High Court', 'Delhi High Court']);
    expect(result.grouping).toEqual({ homeCourt: 'Karnataka High Court' });
  });
});

describe('every state on the signup list', () => {
  it.each(PRACTICE_STATES.map((s) => [s]))('%s has a High Court', (state) => {
    expect(homeHighCourt(state)).not.toBeNull();
    expect(homeCourtName(state)).toMatch(/High Court$/);
  });

  it('is stored as listed, whatever the case', () => {
    expect(canonicalState('karnataka')).toBe('Karnataka');
    expect(canonicalState('  tamil   nadu ')).toBe('Tamil Nadu');
    expect(canonicalState('Orissa')).toBe('Odisha');
    expect(canonicalState('Karnatka')).toBeNull();
    expect(canonicalState('')).toBeNull();
  });
});

describe('a case summary goes to the judgment search', () => {
  it.each([
    'summary of Vishaka vs State of Rajasthan in 100 words',
    'what is the summary of Arnesh Kumar v State of Bihar',
    'Vishaka vs State of Rajasthan ka summary 100 words me do',
    'facts of Kesavananda Bharati vs State of Kerala',
    'the case of Rajesh Kumar Mittal vs State of Bihar',
  ])('%p', (text) => {
    expect(asksAboutNamedJudgment(text)).toBe(true);
  });

  it.each([
    'difference between bail vs anticipatory bail',
    'summary of section 420 IPC',
    'is anticipatory bail maintainable after chargesheet',
  ])('but not %p', (text) => {
    expect(asksAboutNamedJudgment(text)).toBe(false);
  });
});
