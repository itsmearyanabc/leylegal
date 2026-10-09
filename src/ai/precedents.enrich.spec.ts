import { PrecedentRow } from '../database/types';
import { PrecedentsService } from './precedents.service';

/**
 * Filling CASE NO. and BENCH from the judgment, at a cost worth controlling.
 *
 * Indian Kanoon's search response was captured live and carries neither. There
 * is no case-number field, and `bench` is `[888, 1990]` - author ids, not
 * names. Both are inside the judgment's own header, which means one extra
 * billed call per row, against documents that ran to 1.1 MB in the sample.
 *
 * So what is asserted here is mostly about restraint: which rows are fetched,
 * how many, and what happens when the fetch fails.
 */

function kanoonRow(over: Partial<PrecedentRow> = {}): PrecedentRow {
  return {
    judgment_id: 'kanoon:113036187',
    case_title: 'Rajender Kumar & Ors vs State Of H.P.',
    neutral_citation: null,
    reporter_citations: [],
    court_name: 'Himachal Pradesh High Court',
    court_type: 'HIGH_COURT',
    judgment_date: new Date('2022-08-16'),
    bench: [],
    bench_strength: null,
    act_sections: [],
    headnote: null,
    ratio_decidendi: null,
    disposition: null,
    source_url: 'https://indiankanoon.org/doc/113036187/',
    best_excerpt: '',
    para_number: null,
    score: 0.5,
    relevance_rank: 1,
    total_matches: 1,
    ...over,
  } as PrecedentRow;
}

function build(
  over: { rows?: PrecedentRow[]; enrichMax?: number; header?: unknown; registry?: unknown } = {},
) {
  const rows = over.rows ?? [kanoonRow()];

  const kanoon = {
    isConfigured: true,
    isDegraded: false,
    search: jest.fn().mockResolvedValue(rows),
    documentHeader: jest.fn().mockResolvedValue(
      over.header ?? {
        caseNumber: 'CWP No. 2843/2019',
        neutralCitation: null,
        equivalentCitations: [],
        bench: ['Tarlok Singh Chauhan', 'Virender Singh'],
        extract: '',
      },
    ),
  };

  const service = new PrecedentsService(
    {} as never,
    {} as never,
    kanoon as never,
    { get: () => 'kanoon', getNumber: (_k: string, d: number) => d } as never,
    (over.registry ?? { isRouterMocked: true }) as never,
    {
      KANOON_ENRICH_MAX: over.enrichMax ?? 5,
      PRECEDENT_MAX_RESULTS: 15,
      PRECEDENT_PAGE_SIZE: 5,
    } as never,
  );

  return { service, kanoon };
}

function intent(text = 'judgments on service law') {
  return {
    intent: 'PRECEDENT_SEARCH' as const,
    language: 'en',
    cnrNumber: null,
    sectionNumber: null,
    actCode: null,
    searchQuery: text,
    rawText: text,
    confidence: 0.9,
  };
}

describe('filling the two fields Kanoon has no field for', () => {
  it('puts the registry number under CASE NO. and the real coram under BENCH', async () => {
    const { service } = build();

    const result = await service.search(intent() as never);

    expect(result.precedents[0].neutral_citation).toBe('CWP No. 2843/2019');
    expect(result.precedents[0].bench).toEqual(['Tarlok Singh Chauhan', 'Virender Singh']);
    expect(result.precedents[0].bench_strength).toBe(2);
  });

  it('stops at the page the advocate will actually see', async () => {
    // Fifteen results, five shown. Enriching the other ten is paid for and
    // thrown away - the sample document was 1.1 MB and each is a billed call.
    const rows = Array.from({ length: 15 }, (_, i) => kanoonRow({ judgment_id: `kanoon:${i + 1}` }));
    const { service, kanoon } = build({ rows, enrichMax: 5 });

    await service.search(intent() as never);

    expect(kanoon.documentHeader).toHaveBeenCalledTimes(5);
  });

  it('fetches nothing at all when the cap is zero', async () => {
    const { service, kanoon } = build({ enrichMax: 0 });

    await service.search(intent() as never);

    expect(kanoon.documentHeader).not.toHaveBeenCalled();
  });

  it('leaves corpus judgments alone', async () => {
    // An ingested row has a UUID, a real bench and a neutral citation already,
    // and no Kanoon document to fetch.
    const { service, kanoon } = build({
      rows: [kanoonRow({ judgment_id: '8f1c2d34-0000-4000-8000-000000000001' })],
    });

    await service.search(intent() as never);

    expect(kanoon.documentHeader).not.toHaveBeenCalled();
  });

  it('does not overwrite a citation the row already carries', async () => {
    const { service } = build({ rows: [kanoonRow({ neutral_citation: '2022 INSC 900' })] });

    const result = await service.search(intent() as never);

    expect(result.precedents[0].neutral_citation).toBe('2022 INSC 900');
  });

  it('still returns the search when a header cannot be read', async () => {
    // A judgment whose header states no case number still has a title, a date
    // and a court. Losing the card over the missing field would be a poor trade.
    const { service } = build({ header: { caseNumber: null, bench: [] } });

    const result = await service.search(intent() as never);

    expect(result.precedents).toHaveLength(1);
    expect(result.precedents[0].case_title).toContain('Rajender Kumar');
  });
});

describe('EQUIVALENT CITATIONS, from the judgment Kanoon printed them in', () => {
  /*
   * Empty on every card for months and explained as impossible. It was
   * concluded from probing one unreported judgment. A reported one carries its
   * citations on the search result and, in full, in the document's
   * doc_citations heading.
   */
  const reported = {
    caseNumber: 'Writ Petition (civil) 135 of 1970',
    neutralCitation: null,
    equivalentCitations: ['AIR 1973 SUPREME COURT 1461', '1973 4 SCC 225'],
    bench: ['S.M. Sikri'],
    extract: '',
  };

  it('fills the field from the document', async () => {
    const { service } = build({ header: reported });

    const result = await service.search(intent() as never);

    // SCC first, then AIR - the order an advocate cites in (client's audit, 9 Oct).
    expect(result.precedents[0].reporter_citations).toEqual([
      '1973 4 SCC 225',
      'AIR 1973 SUPREME COURT 1461',
    ]);
  });

  it('does not print the citation twice when the search result carried it too', async () => {
    // The search result sends the first citation and the document sends all of
    // them, so the first one arrives from both.
    const { service } = build({
      rows: [kanoonRow({ reporter_citations: ['AIR 1973 SUPREME COURT 1461'] })],
      header: reported,
    });

    const result = await service.search(intent() as never);

    // SCC first, then AIR - the order an advocate cites in (client's audit, 9 Oct).
    expect(result.precedents[0].reporter_citations).toEqual([
      '1973 4 SCC 225',
      'AIR 1973 SUPREME COURT 1461',
    ]);
  });

  it('lists a reporter citation ahead of a neutral one', async () => {
    const { service } = build({
      header: {
        caseNumber: null,
        neutralCitation: '2024:PHHC:012345',
        equivalentCitations: ['2024 SCC OnLine P&H 99'],
        bench: [],
        extract: '',
      },
    });

    const result = await service.search(intent() as never);

    expect(result.precedents[0].reporter_citations).toEqual([
      '2024 SCC OnLine P&H 99',
      '2024:PHHC:012345',
    ]);
  });

  it('still enriches a row whose only new information is a citation', async () => {
    // The early return used to require a case number, a bench or an extract,
    // so a header carrying nothing but citations was discarded.
    const { service } = build({
      header: { caseNumber: null, neutralCitation: null, equivalentCitations: ['AIR 1990 SC 1'], bench: [], extract: '' },
    });

    const result = await service.search(intent() as never);

    expect(result.precedents[0].reporter_citations).toEqual(['AIR 1990 SC 1']);
  });
});

describe('which rows get the document fetched', () => {
  /*
   * Enrichment pays for one page of documents, and the home-court promotion ran
   * afterwards, at the call site - so it lifted judgments from positions six to
   * fifteen into positions one to three, and those are exactly the rows no
   * document had been fetched for.
   *
   * The advocate's own High Court binds them, so those are the cards read
   * first. They were the ones showing "Not available" for the case number, the
   * bench and the citations, while the persuasive judgments below them were
   * complete.
   */
  function mixed() {
    return Array.from({ length: 15 }, (_, i) =>
      kanoonRow({
        judgment_id: `kanoon:${i + 1}`,
        // The advocate's own court sits well past the enriched page.
        court_name: i === 10 ? 'Karnataka High Court' : 'Himachal Pradesh High Court',
      }),
    );
  }

  it('fetches the document for the judgment it is about to put first', async () => {
    const { service, kanoon } = build({ rows: mixed(), enrichMax: 5 });

    await service.search(intent() as never, 'Karnataka');

    const fetched = kanoon.documentHeader.mock.calls.map((call) => call[0]);
    expect(fetched).toContain(11);
  });

  it('puts it first', async () => {
    const { service } = build({ rows: mixed(), enrichMax: 5 });

    const result = await service.search(intent() as never, 'Karnataka');

    expect(result.precedents[0].court_name).toBe('Karnataka High Court');
  });

  it('still pays for only one page', async () => {
    const { service, kanoon } = build({ rows: mixed(), enrichMax: 5 });

    await service.search(intent() as never, 'Karnataka');

    expect(kanoon.documentHeader).toHaveBeenCalledTimes(5);
  });

  it('changes nothing when the advocate has no home court on record', async () => {
    const { service, kanoon } = build({ rows: mixed(), enrichMax: 5 });

    await service.search(intent() as never, null);

    const fetched = kanoon.documentHeader.mock.calls.map((call) => call[0]);
    expect(fetched).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('the documented search operators, and falling back from them', () => {
  /*
   * A named case was searched as free text over the parties, so it competed
   * with every judgment against the same State. Kanoon documents `title:` for
   * exactly this lookup, and `cite:` for a pasted citation. Each narrows, so
   * each is followed by a broader attempt - a narrowing that matches nothing
   * must not become "no authority found".
   */
  function named(text: string) {
    return { ...intent(text), rawText: text, searchQuery: text };
  }

  const mittal = kanoonRow({
    judgment_id: 'kanoon:500',
    case_title: 'Rajesh Kumar Mittal vs State Of Bihar',
    court_name: 'Patna High Court',
  });
  const stranger = kanoonRow({
    judgment_id: 'kanoon:501',
    case_title: 'Atc Telecom Infrastructure Pvt Ltd vs The State Of Bihar',
    court_name: 'Patna High Court',
  });

  it('asks for the title first, and stops there when it answers', async () => {
    const { service, kanoon } = build();
    kanoon.search.mockResolvedValue([mittal]);

    await service.search(named('Rajesh Kumar Mittal vs State of Bihar in Patna High Court') as never);

    expect(kanoon.search).toHaveBeenCalledTimes(1);
    expect(kanoon.search.mock.calls[0][0]).toBe(
      'doctypes:patna title: Rajesh Kumar Mittal State of Bihar',
    );
  });

  it('falls back to the parties when the title search finds somebody else', async () => {
    // Ten results that are all a different case are not an answer, however
    // many there are.
    const { service, kanoon } = build();
    kanoon.search.mockImplementation(async (query: string) =>
      query.startsWith('doctypes:patna title:') ? [stranger] : [mittal],
    );

    const result = await service.search(
      named('Rajesh Kumar Mittal vs State of Bihar in Patna High Court') as never,
    );

    expect(kanoon.search).toHaveBeenCalledTimes(2);
    expect(result.precedents[0].case_title).toBe('Rajesh Kumar Mittal vs State Of Bihar');
  });

  it('searches on past results that are only orders in the matter, for the judgment', async () => {
    // "Satender Kumar Antil v. CBI bail guidelines" stopped at a 2024 daily
    // order; the 2022 judgment was one search further on (live test, X24).
    // Titles and courts as Kanoon returned them.
    const { service, kanoon } = build();
    const order = kanoonRow({
      judgment_id: 'kanoon:801', case_title: 'Satender Kumar Antil vs Central Bureau Of Investigation',
      court_name: 'Supreme Court - Daily Orders', judgment_date: new Date('2024-08-06'),
    });
    const judgment = kanoonRow({
      judgment_id: 'kanoon:802', case_title: 'Satender Kumar Antil vs Central Bureau Of Investigation',
      court_name: 'Supreme Court of India', judgment_date: new Date('2022-07-11'),
    });
    // "CBI" is not in Kanoon's title; the last search spells it out (looseTitle).
    kanoon.search.mockImplementation(async (query: string) =>
      query === 'title: satender kumar antil investigation' ? [judgment] : query.startsWith('title:') ? [] : [order],
    );

    const result = await service.search(named('Satender Kumar Antil v. CBI bail guidelines') as never);

    expect(kanoon.search).toHaveBeenCalledTimes(3);
    expect(result.precedents.map((p) => p.court_name)).toEqual(['Supreme Court of India']);
  });

  it('shows the orders when no search finds the judgment itself', async () => {
    const { service, kanoon } = build();
    const order = kanoonRow({ judgment_id: 'kanoon:801', case_title: 'Satender Kumar Antil vs Central Bureau Of Investigation', court_name: 'Supreme Court - Daily Orders' });
    kanoon.search.mockImplementation(async (query: string) => (query.startsWith('title:') ? [] : [order]));

    const result = await service.search(named('Satender Kumar Antil v. CBI bail guidelines') as never);

    expect(result.namedCase?.found).toBe(true);
    expect(result.precedents.map((p) => p.court_name)).toEqual(['Supreme Court - Daily Orders']);
  });

  it('skips an attempt that throws instead of losing the whole search', async () => {
    // A malformed operand is still a failed call, and it must not cost the
    // advocate the broader search behind it.
    const { service, kanoon } = build();
    kanoon.search.mockImplementation(async (query: string) => {
      if (query.includes('title:')) throw new Error('Indian Kanoon error: bad query');
      return [mittal];
    });

    const result = await service.search(named('Rajesh Kumar Mittal vs State of Bihar') as never);

    expect(result.precedents[0].case_title).toBe('Rajesh Kumar Mittal vs State Of Bihar');
  });

  it('surfaces the error only when every attempt failed', async () => {
    // That is what lets a charge be refunded, and lets the auto source fall back.
    const { service, kanoon } = build();
    kanoon.search.mockRejectedValue(new Error('indian kanoon is down'));

    await expect(
      service.search(named('Rajesh Kumar Mittal vs State of Bihar') as never),
    ).rejects.toThrow('indian kanoon is down');
  });

  it('says the named case was not found, and lists nothing in its place', async () => {
    // The near misses used to come back as the answer, and the website showed
    // "3 authorities on the ratio of Mercy v. Mankind" - a case that does not
    // exist - under the name that was asked for.
    const { service, kanoon } = build();
    kanoon.search.mockResolvedValue([stranger]);

    const result = await service.search(named('Rajesh Kumar Mittal vs State of Bihar') as never);

    expect(result.namedCase).toEqual({ name: 'Rajesh Kumar Mittal vs State of Bihar', found: false });
    expect(result.precedents).toEqual([]);
  });

  it('shows the judgment ahead of the orders in the same matter, and drops the orders', async () => {
    // Titles, courts and dates as Kanoon returned them for V1 in the audit
    // re-run of 4 October: six Patna High Court orders came before the 2014
    // Supreme Court judgment.
    const { service, kanoon } = build();
    const listed: [string, string, string][] = [
      ['Arnesh Kumar Yadav @ Arnesh Kumar @ vs The State Of Bihar', 'Patna High Court - Orders', '2026-01-29'],
      ['Supreme Court In Arnesh Kumar vs State Of Bihar', 'Andhra Pradesh High Court - Amravati', '2019-09-30'],
      ['Arnesh Kumar @ Kumar Amresh vs State Of Bihar And Anr', 'Patna High Court - Orders', '2019-07-03'],
      ['Arnesh Kumar vs State Of Bihar & Anr', 'Supreme Court of India', '2014-07-02'],
      ['Arnesh Kumar vs State Of Bihar', 'Supreme Court - Daily Orders', '2014-07-02'],
    ];
    kanoon.search.mockResolvedValue(
      listed.map(([case_title, court_name, date], i) => kanoonRow({ judgment_id: `kanoon:${700 + i}`, case_title, court_name, judgment_date: new Date(date) })),
    );

    const result = await service.search(named('Give the full SCC citation of Arnesh Kumar v. State of Bihar and its key holding') as never);

    expect(result.namedCase?.found).toBe(true);
    // "Supreme Court In Arnesh Kumar" is someone else's title - see samePetitioner.
    expect(result.precedents.map((p) => p.court_name)).toEqual(['Supreme Court of India']);
  });

  it('finds a judgment written with an abbreviated office and another spelling of a name', async () => {
    // "ADM Jabalpur v. Shivkant Shukla" is titled in full on Kanoon, with
    // "Shivakant" - and was reported as not found (audit re-run, P7).
    const { service, kanoon } = build();
    const adm = kanoonRow({
      judgment_id: 'kanoon:1735094',
      case_title: 'Additional District Magistrate, Jabalpur vs Shivakant Shukla',
      court_name: 'Supreme Court of India',
    });
    kanoon.search.mockResolvedValue([stranger, adm]);

    const result = await service.search(named('Is ADM Jabalpur v. Shivkant Shukla still good law?') as never);

    expect(result.namedCase?.found).toBe(true);
    expect(result.precedents.map((p) => p.case_title)).toEqual(['Additional District Magistrate, Jabalpur vs Shivakant Shukla']);
  });

  it('finds a judgment asked for by citation only when a result carries that citation', async () => {
    // "What did the Supreme Court hold in (2020) 7 SCC 1?" was answered with
    // ten unrelated judgments: any result was taken as the answer.
    const { service, kanoon } = build();
    kanoon.search.mockResolvedValue([stranger]);

    const result = await service.search(named('What did the Supreme Court hold in (2020) 7 SCC 1?') as never);

    expect(result.namedCase).toEqual({ name: '(2020) 7 SCC 1', found: false });
    expect(result.precedents).toEqual([]);
  });

  it('uses cite: for a pasted citation - in the spelling Kanoon prints, then as typed', async () => {
    // Kanoon prints "AIR 1973 SUPREME COURT 1461"; its cite: operator matches
    // its own spelling (citation-match.ts). Neither result carries the
    // citation here, so both spellings are tried and nothing is found.
    const { service, kanoon } = build();
    kanoon.search.mockResolvedValue([mittal]);

    const result = await service.search(named('AIR 1973 SC 1461') as never);

    expect(kanoon.search.mock.calls.map((call) => call[0])).toEqual([
      'cite: AIR 1973 SUPREME COURT 1461',
      'cite: 1973 AIR 1461',
      'cite: AIR 1973 SC 1461',
    ]);
    expect(result.namedCase).toEqual({ name: 'AIR 1973 SC 1461', found: false });
  });
});

describe('"summary in 100 words"', () => {
  /*
   * Asked for and not delivered, three ways at once: the length never reached
   * the summariser on the Kanoon path, the card cut whatever it wrote at 200
   * characters, and the request itself was read as part of the case name.
   */
  const mittal = kanoonRow({
    judgment_id: 'kanoon:500',
    case_title: 'Rajesh Kumar Mittal vs State Of Bihar',
    court_name: 'Patna High Court',
  });
  const header = {
    caseNumber: 'CWJC No. 1/2020',
    neutralCitation: null,
    equivalentCitations: [],
    bench: [],
    extract:
      'The petitioner challenges the order of the District Magistrate cancelling his arms licence. ' +
      'The only ground stated is a pending criminal case in which he has since been acquitted. ' +
      'The question is whether the licensing authority may rely on a charge that has ended in acquittal.',
  };

  function summariser(principle = 'The petitioner challenged the cancellation of his arms licence.') {
    return {
      isRouterMocked: false,
      complete: jest
        .fn()
        .mockResolvedValue({ text: JSON.stringify({ principles: [{ n: 1, principle }] }) }),
    };
  }

  function asked(text: string) {
    return { ...intent(text), rawText: text, searchQuery: text };
  }

  it('finds the named case with the request wrapped around it', async () => {
    const registry = summariser();
    const { service, kanoon } = build({ rows: [mittal], header, registry });

    const result = await service.search(
      asked('give me summary of Rajesh Kumar Mittal vs State of Bihar in 100 words') as never,
    );

    expect(kanoon.search.mock.calls[0][0]).toBe('title: Rajesh Kumar Mittal State of Bihar');
    expect(result.namedCase).toEqual({ name: 'Rajesh Kumar Mittal vs State of Bihar', found: true });
  });

  it('tells the summariser the length, and gives it room to write it', async () => {
    const registry = summariser();
    const { service } = build({ rows: [mittal], header, registry });

    await service.search(asked('Rajesh Kumar Mittal vs State of Bihar summary 100 words me do') as never);

    const call = registry.complete.mock.calls[0][0];
    expect(call.system).toContain('about 100 words');
    expect(call.maxTokens).toBeGreaterThanOrEqual(100 * 2);
  });

  it('writes one summary at that length, not a second one under it', async () => {
    const registry = summariser();
    const { service } = build({ rows: [mittal], header, registry });

    const result = await service.search(
      asked('summary of Rajesh Kumar Mittal vs State of Bihar in 100 words') as never,
    );

    expect(registry.complete).toHaveBeenCalledTimes(1);
    expect(result.precedents[0].generated_principle).toContain('arms licence');
  });

  /*
   * Every card's summary in one call - deliberately.
   *
   * Written three cards to a call, in parallel, the judgment search took half
   * the time (p50 3.3 s -> 1.7 s, live, 4 October) - and the model wrote
   * different summaries: shown fewer extracts at once it declined more of
   * them. "Supreme Court judgments on compensation for custodial death" lost
   * the summaries of two cards in four runs out of four, and in one run that
   * of Nilabati Behera itself. Speed that changes the answer is not had here.
   */
  it('summarises every card in one call, each summary on its own card', async () => {
    const cards = Array.from({ length: 7 }, (_, i) =>
      kanoonRow({
        judgment_id: `kanoon:${900 + i}`,
        case_title: `Petitioner ${i + 1} vs State Of Bihar`,
        best_excerpt: `Extract of judgment ${i + 1}: the question was whether the order of the authority could stand, and the court set it aside.`,
      }),
    );
    const registry = {
      isRouterMocked: false,
      complete: jest.fn(async (request: { messages: { content: string }[] }) => {
        const principles = [...request.messages[0].content.matchAll(/^(\d+)\. (Petitioner \d+) vs/gm)].map((m) => ({
          n: Number(m[1]),
          principle: `Principle of ${m[2]}.`,
        }));
        return { text: JSON.stringify({ principles }) };
      }),
    };
    const { service } = build({ rows: cards, registry, enrichMax: 0 });

    const result = await service.search(asked('judgments on cancellation of licence by the authority') as never);

    expect(registry.complete).toHaveBeenCalledTimes(1);
    for (const p of result.precedents) {
      expect(p.generated_principle).toBe(`Principle of ${p.case_title.replace(/ vs .*/, '')}.`);
    }
  });

  it('keeps both summaries on a named case when no length was asked for', async () => {
    const registry = summariser();
    const { service } = build({ rows: [mittal], header, registry });

    await service.search(asked('Rajesh Kumar Mittal vs State of Bihar') as never);

    expect(registry.complete).toHaveBeenCalledTimes(2);
    expect(registry.complete.mock.calls[0][0].system).toContain('at most 80 words');
  });

  it('applies to every card of a topic search too', async () => {
    const registry = summariser();
    const { service, kanoon } = build({ rows: [mittal], header, registry });

    await service.search(asked('judgments on cancellation of arms licence, summary in 150 words') as never);

    expect(kanoon.search.mock.calls[0][0]).not.toContain('150');
    expect(registry.complete.mock.calls[0][0].system).toContain('about 150 words');
  });
});
