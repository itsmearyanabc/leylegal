import { PrecedentRow, StatuteRow } from '../database/types';
import { extractCaseName } from './case-name';
import {
  asksForCounterpart,
  asksForReminder,
  asksToDraft,
  DELETE_ACCOUNT_REPLY,
  IntentService,
  productReply,
  TRACKING_REPLY,
  WHATSAPP_NOT_OPEN,
} from './intent.service';
import { asksIfStillGoodLaw } from './leading-judgments';
import { PrecedentsService } from './precedents.service';
import { buildPointOfLawPrompt } from './prompts';
import { sectionCountReply } from './provision-range';
import { isNonAnswer, RagService, statutesShown, withoutPromptEcho, wrongLanguage } from './rag.service';

/**
 * The client's audit of 9 October 2026 (release 9fe6aef): a third random 100
 * and 52 re-checks. Each test names the question it comes from; the answers
 * quoted are the ones the audit recorded.
 */

function statute(act_code: string, section_number: string, section_title: string, over: Partial<StatuteRow> = {}): StatuteRow {
  return {
    id: `${act_code}-${section_number}`,
    act_code,
    act_name: act_code,
    section_number,
    section_title,
    section_text: `${section_number}. ${section_title}.`,
    punishment: null,
    is_cognizable: null,
    is_bailable: null,
    is_compoundable: null,
    triable_by: null,
    corresponding_act: null,
    corresponding_section: null,
    match_type: 'EXACT',
    score: 1000,
    correspondence: [],
    source_url: 'https://www.mha.gov.in/gazette.pdf',
    ...over,
  };
}

function judgment(id: string, case_title: string, date: string, court = 'Supreme Court of India', reporter_citations: string[] = []): PrecedentRow {
  return {
    judgment_id: `kanoon:${id}`,
    case_title,
    neutral_citation: null,
    reporter_citations,
    court_name: court,
    court_type: null,
    judgment_date: new Date(date),
    bench: [],
    bench_strength: null,
    act_sections: [],
    headnote: null,
    ratio_decidendi: null,
    disposition: null,
    source_url: `https://indiankanoon.org/doc/${id}/`,
    best_excerpt: '',
    para_number: null,
    score: 1,
    relevance_rank: 1,
    total_matches: 1,
  };
}

function intent(over: Record<string, unknown>) {
  return { intent: 'SECTION_LOOKUP' as const, language: 'en', cnrNumber: null, sectionNumber: null, actCode: null, actName: null, searchQuery: 'q', rawText: 'q', confidence: 0.9, ...over };
}

function rag(opts: {
  search?: (n: string | null, act: string | null) => StatuteRow[];
  recodified?: (act: string, n: string) => StatuteRow[];
  judgments?: PrecedentRow[];
  overruled?: { earlier: PrecedentRow; later: PrecedentRow }[];
  model?: string;
  fetched?: StatuteRow | null;
}) {
  const corpus = {
    hasJudgmentChunks: jest.fn().mockResolvedValue(false),
    searchStatutes: jest.fn(async (_q: string, n: string | null, act: string | null) => opts.search?.(n, act) ?? []),
    withCorrespondence: jest.fn(async (rows: StatuteRow[]) => rows),
    statutesCovering: jest.fn().mockResolvedValue([]),
    recodifiedFrom: jest.fn(async (act: string, n: string) => opts.recodified?.(act, n) ?? []),
  };
  const registry = { complete: jest.fn().mockResolvedValue({ text: opts.model ?? 'answer', model: 'gpt-4.1', inputTokens: 1, outputTokens: 1 }) };
  const guardrails = {
    verify: jest.fn(async (text: string, ..._rest: unknown[]) => ({ text, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null })),
  };
  const statutes = {
    fetch: jest.fn().mockResolvedValue({ row: opts.fetched ?? null }),
    stored: jest.fn().mockResolvedValue(null),
    replaceAbridged: jest.fn().mockResolvedValue(null),
  };
  const precedents = { authoritiesFor: jest.fn().mockResolvedValue({ judgments: opts.judgments ?? [], overruled: opts.overruled ?? [] }) };
  const service = new RagService(corpus as never, {} as never, registry as never, guardrails as never, {} as never, statutes as never, precedents as never);
  return { service, registry, corpus, statutes, precedents };
}

const system = (registry: { complete: jest.Mock }): string => registry.complete.mock.calls[0][0].system;

// ---------------------------------------------------------------------------
// Fix 2 follow-ups (client's #3)
// ---------------------------------------------------------------------------

describe('a number trap whose section text happens to use the word (T-02)', () => {
  it('is caught on the title alone: BNS 307 is theft after preparation; attempt to murder is BNS 109', async () => {
    // BNS 307's illustration says "should attempt to apprehend A" - and the
    // check that read the whole text stood down: "The corpus does not cover
    // BNS 307 or its punishment for attempt to murder", two credits.
    const bns307 = statute('BNS', '307', 'Theft after preparation made for causing death, hurt or restraint in order to the committing of the theft', {
      section_text: '307. Whoever commits theft, having made preparation for causing death ... Illustration: A commits theft ... and should attempt to apprehend A ...',
    });
    const bns109 = statute('BNS', '109', 'Attempt to murder', { match_type: 'RECODIFIED', mapped_from: 'IPC 307', mapped_to: 'BNS 109', correspondence: ['IPC 307 = BNS 109'] });
    const { service } = rag({ search: (n, act) => (act === 'BNS' && n === '307' ? [bns307] : []), recodified: (act, n) => (act === 'IPC' && n === '307' ? [bns109] : []) });

    const answer = await service.answer(intent({ actCode: 'BNS', sectionNumber: '307', rawText: 'What is the punishment under BNS 307 for attempt to murder?' }) as never);

    expect(answer.text).toContain('The section on what you asked about is *BNS 109* ("Attempt to murder"), formerly IPC 307.');
  });
});

describe("the prompt's own words in an answer (T-05, M-IPC-026)", () => {
  it('are taken out, and the heading and the rest stay', () => {
    expect(
      withoutPromptEcho(
        '*SECTION:* The advocate asked about *BNS Section 74* - the advocate wrote BNS 354, which is a different provision. BNS Section 74 - Assault or use of criminal force to woman with intent to outrage her modesty.',
      ),
    ).toBe('*SECTION:* BNS Section 74 - Assault or use of criminal force to woman with intent to outrage her modesty.');
    expect(withoutPromptEcho('- Non-cognizable, bailable, compoundable (from the Classification line of IPC 323).')).toBe(
      '- Non-cognizable, bailable, compoundable.',
    );
  });

  it('leave an ordinary sentence about an advocate alone', () => {
    expect(withoutPromptEcho('The advocate must prove intent.')).toBe('The advocate must prove intent.');
  });
});

describe('the sections listed under an answer (M-REV-007, N-11, M-IEA-030, O-06)', () => {
  const bns316 = statute('BNS', '316', 'Criminal breach of trust');
  const ipc406 = statute('IPC', '406', 'Punishment for criminal breach of trust');
  const ipc409 = statute('IPC', '409', 'Criminal breach of trust by public servant, or by banker, merchant or agent');

  it('reads the Act written out in full', () => {
    expect(statutesShown('Section 316(5) of the Bharatiya Nyaya Sanhita, 2023 IPC Section 409 से मेल खाता है', [bns316, ipc406, ipc409])).toEqual([bns316, ipc409]);
  });

  it('reads the Act written in Hindi', () => {
    const bsa63 = statute('BSA', '63', 'Admissibility of electronic records');
    const iea65b = statute('IEA', '65B', 'Admissibility of electronic records');
    expect(statutesShown('भारतीय साक्ष्य अधिनियम की धारा 63 के तहत प्रमाणपत्र ...', [iea65b, bsa63])).toEqual([bsa63]);
  });

  it('reads a bare section number when only one listed provision has it', () => {
    const bns113 = statute('BNS', '113', 'Terrorist act');
    expect(statutesShown('Yes, the BNS defines a terrorist act in Section 113.', [bns113, statute('BNS', '169', 'x'), statute('BSA', '15', 'y'), statute('BNS', '86', 'z')])).toEqual([bns113]);
    const iea126 = statute('IEA', '126', 'Professional communications');
    const bsa132 = statute('BSA', '132', 'Professional communications');
    expect(statutesShown('IEA Section 126 ... The BSA equivalent is Section 132(1).', [iea126, bsa132])).toEqual([iea126, bsa132]);
  });

  it('lists nothing rather than the wrong sections (J-PL-40)', () => {
    expect(statutesShown('The limitation period is one month - Section 142 of the NI Act.', [statute('BSA', '138', 'a'), statute('IEA', '138', 'b')])).toEqual([]);
  });
});

describe('a section that does not exist (T-08, T-15, T-16)', () => {
  it('is said free', async () => {
    const { service } = rag({});
    const answer = await service.answer(intent({ actCode: 'IPC', sectionNumber: '512', rawText: 'IPC 512 kya hai?' }) as never);
    expect(answer.text).toMatch(/does not exist/);
    expect(answer.free).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// New-code content from the codes (client's #4)
// ---------------------------------------------------------------------------

describe('how many sections the codes have (N-15)', () => {
  it('is read off the codes: 358, 531 and 170 - the model said 356 and 533', async () => {
    const { service, registry } = rag({});
    const answer = await service.answer(intent({ intent: 'UNSUPPORTED', rawText: 'How many sections are in the BNS, BNSS and BSA?' }) as never);
    expect(answer.text).toBe('The BNS has 358 sections. The BNSS has 531 sections. The BSA has 170 sections.');
    expect(registry.complete).not.toHaveBeenCalled();
  });

  it('states only the numbering for a code with lettered sections', () => {
    expect(sectionCountReply('IPC mein kitne sections hain?', new Set(['IPC'] as never))).toBe(
      "The IPC's sections are numbered 1 to 511, with lettered sections (such as 120A and 498A) added in between.",
    );
    expect(sectionCountReply('What does BNS 358 say?', new Set(['BNS'] as never))).toBeNull();
  });
});

describe('a criminal-law question that names no code (N-03)', () => {
  it('is answered from the new codes: BNSS 35(7) on arresting a person above sixty', async () => {
    const bnss35 = statute('BNSS', '35', 'When police may arrest without warrant', {
      match_type: 'FULLTEXT',
      score: 40,
      section_text:
        '35. ... (7) No arrest shall be made without prior permission of an officer not below the rank of Deputy Superintendent of Police in case of an offence which is punishable for imprisonment of less than three years and such person is infirm or is above sixty years of age.',
    });
    const { service, registry } = rag({ search: (n, act) => (!n && act === 'BNSS' ? [bnss35] : []) });

    await service.answer(intent({ intent: 'GENERAL_LEGAL', rawText: 'Can police arrest a 65-year-old for an offence punishable with 2 years without any permission?' }) as never);

    expect(system(registry)).toContain('BNSS Section 35 - When police may arrest without warrant');
    expect(system(registry)).toContain('above sixty years of age');
  });
});

describe('a section of an Act outside the codes (J-PL-40)', () => {
  it('is fetched in its official text, not taken from the codes by number', async () => {
    const ni138 = statute('NIA', '138', 'Dishonour of cheque for insufficiency, etc., of funds in the account', { act_name: 'Negotiable Instruments Act, 1881' });
    const { service, registry, statutes } = rag({
      search: (n) => (n === '138' ? [statute('BSA', '138', 'Cross-examination of witness'), statute('IEA', '138', 'Order of examinations')] : []),
      fetched: ni138,
      judgments: [judgment('1', 'K. Bhaskaran vs Sankaran Vaidhyan Balan And Anr', '1999-09-29')],
    });

    await service.answer(
      intent({ intent: 'GENERAL_LEGAL', sectionNumber: '138', actName: 'Negotiable Instruments Act, 1881', rawText: 'What is the limitation period for filing a Section 138 NI Act complaint?' }) as never,
    );

    expect(statutes.fetch).toHaveBeenCalled();
    expect(system(registry)).toContain('Dishonour of cheque');
    expect(system(registry)).not.toContain('Cross-examination of witness');
  });
});

describe('a written answer that delivers nothing (J-PL-40)', () => {
  it('is free', async () => {
    expect(isNonAnswer("The corpus doesn't cover the limitation period for filing a Section 138 NI Act complaint. Try narrowing the search.")).toBe(true);
    expect(isNonAnswer('Yes, community service is a punishment under the BNS. Refer to BNS Section 4(f) for details.')).toBe(false);

    const { service } = rag({ model: "The corpus doesn't cover the limitation period for filing a Section 138 NI Act complaint." });
    const answer = await service.answer(intent({ intent: 'GENERAL_LEGAL', rawText: 'What is the limitation period for filing a Section 138 NI Act complaint?' }) as never);
    expect(answer.free).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Overruled law (client's #1)
// ---------------------------------------------------------------------------

describe('a point-of-law answer whose leading judgment was overruled (J-PL-50)', () => {
  it('is told so, and names the overruling judgment instead', async () => {
    const bhatia = judgment('1', 'Bhatia International vs Bulk Trading S.A. & Anr', '2002-03-13');
    const balco = judgment('2', 'Bharat Aluminium Co vs Kaiser Aluminium Technical Service', '2012-09-06', 'Supreme Court of India', ['2012 (9) SCC 552']);
    const { service, registry } = rag({ judgments: [balco], overruled: [{ earlier: bhatia, later: balco }] });

    await service.answer(intent({ intent: 'GENERAL_LEGAL', rawText: 'Does Part I of the Arbitration Act apply to foreign-seated arbitrations?' }) as never);

    expect(system(registry)).toContain(
      'OVERRULED - never give these as the law; say they were overruled, by the judgment named, wherever they bear on the answer:\n' +
        '- Bhatia International vs Bulk Trading S.A. & Anr (2002) was overruled by Bharat Aluminium Co vs Kaiser Aluminium Technical Service (2012).',
    );
    expect(system(registry)).toContain('[1] Bharat Aluminium Co vs Kaiser Aluminium Technical Service');
  });

  it('is replaced in the list of authorities once its overruling is confirmed in the text', async () => {
    const bhatia = judgment('1', 'Bhatia International vs Bulk Trading S.A. & Anr', '2002-03-13');
    const balco = judgment('2', 'Bharat Aluminium Co. vs Kaiser Aluminium Technical Services Inc.', '2012-09-06');
    const search = jest.fn(async (query: string) => (query.includes('Bharat Aluminium') ? [balco] : query.includes('title:') ? [bhatia] : []));
    const complete = jest.fn().mockResolvedValue({ text: JSON.stringify({ cases: [{ name: 'Bhatia International v. Bulk Trading S.A.', year: 2002, court: 'Supreme Court' }] }), model: 'gpt-4.1', inputTokens: 0, outputTokens: 0 });
    const precedents = new PrecedentsService(
      {} as never,
      {} as never,
      { isConfigured: true, isDegraded: false, search, documentHeader: jest.fn(), lawDocument: jest.fn().mockResolvedValue('<p>We overrule the law laid down in Bhatia International.</p>') } as never,
      { get: () => 'kanoon', getNumber: (_k: string, d: number) => d } as never,
      { isRouterMocked: true, isSynthesisMocked: false, complete } as never,
      { KANOON_ENRICH_MAX: 0, PRECEDENT_MAX_RESULTS: 10, PRECEDENT_PAGE_SIZE: 5, KANOON_TIMEOUT_MS: 15000 } as never,
    );

    const found = await precedents.authoritiesFor(intent({ intent: 'GENERAL_LEGAL', rawText: 'Does Part I of the Arbitration Act apply to foreign-seated arbitrations?' }) as never);

    expect(found.judgments.map((j) => j.case_title)).toEqual(['Bharat Aluminium Co. vs Kaiser Aluminium Technical Services Inc.']);
    expect(found.overruled.map((o) => o.earlier.case_title)).toEqual(['Bhatia International vs Bulk Trading S.A. & Anr']);
  });

  it('asks the model for judgments that are good law today', () => {
    expect(buildPointOfLawPrompt([], [], 'en')).not.toContain('OVERRULED');
  });
});

describe('"Can I rely on X?" (J-GL-10)', () => {
  it('is a good-law question, and the case is read without the question words', () => {
    expect(asksIfStillGoodLaw('Can I rely on Ritu Chhabaria v. Union of India (2023) for default bail?')).toBe(true);
    expect(extractCaseName('Can I rely on Ritu Chhabaria v. Union of India (2023) for default bail?')).toEqual({ petitioner: 'Ritu Chhabaria', respondent: 'Union of India' });
  });
});

// ---------------------------------------------------------------------------
// Things Ley Legal does not do (client's #5, #8)
// ---------------------------------------------------------------------------

describe('a court document asked to be drafted (B-04, S-MT-08)', () => {
  it('is recognised', () => {
    expect(asksToDraft('Draft a bail application for my client accused under BNS 115(2).')).toBe(true);
    expect(asksToDraft('Draft the full petitioner memorial for my moot on Section 377.')).toBe(true);
    expect(asksToDraft('What does the draft BNSS rule on bail say?')).toBe(false);
  });

  it('is answered with what it would rest on, never drafted', async () => {
    const bns115 = statute('BNS', '115', 'Voluntarily causing hurt');
    const { service, registry } = rag({ search: (n, act) => (act === 'BNS' && n === '115(2)' ? [bns115] : []) });

    await service.answer(intent({ intent: 'DRAFTING_HELP', actCode: 'BNS', sectionNumber: '115(2)', rawText: 'Draft a bail application for my client accused under BNS 115(2).' }) as never);

    expect(system(registry)).toContain('Ley Legal does not draft court documents, memorials or templates: say so in one line first.');
    expect(system(registry)).toContain('BNS Section 115 - Voluntarily causing hurt');
  });
});

describe('product requests with a fixed reply (B-12, C-12)', () => {
  it('gives the privacy notice route for deleting an account', () => {
    expect(productReply('How do I delete my account and history?')).toBe(DELETE_ACCOUNT_REPLY);
    expect(productReply('Can the court delete a party from the suit?')).toBeNull();
  });

  it('says reminders are not a feature, and that WhatsApp is not open, when asked for on WhatsApp', () => {
    expect(productReply('Remind me on WhatsApp before my next date in DLCT010012342024')).toBe(`${TRACKING_REPLY} ${WHATSAPP_NOT_OPEN}`);
    expect(asksForReminder('Remind me on WhatsApp before my next date in DLCT010012342024')).toBe(true);
    expect(asksForReminder('Track my case DLCT010012342024')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routing (client's #10)
// ---------------------------------------------------------------------------

describe('"where did this section go" (pattern O: M-IEA-027, M-CRPC-017, M-IPC-055)', () => {
  it.each(['Convert IEA 114A to the new code.', 'CrPC की धारा 164 अब BNSS में कौन सी धारा है?', 'BNSS 187 corresponds to which CrPC section?'])('%p asks for a counterpart', (text) => {
    expect(asksForCounterpart(text)).toBe(true);
  });

  it('is a section lookup whatever the router called it', async () => {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: 'UNSUPPORTED', language: 'en', act_code: 'IEA', section_number: '114A', search_query: 'IEA 114A in BSA' }),
      }),
    };
    const classified = await new IntentService(registry as never).classify('Convert IEA 114A to the new code.');
    expect(classified).toMatchObject({ intent: 'SECTION_LOOKUP', actCode: 'IEA', sectionNumber: '114A' });
  });
});

// ---------------------------------------------------------------------------
// A judgment asked for by name (client's #6)
// ---------------------------------------------------------------------------

describe('a judgment asked for by name (J-NL-04, J-NL-13)', () => {
  function search(rows: PrecedentRow[]) {
    return new PrecedentsService(
      {} as never,
      {} as never,
      { isConfigured: true, isDegraded: false, search: jest.fn().mockResolvedValue(rows), documentHeader: jest.fn() } as never,
      { get: () => 'kanoon', getNumber: (_k: string, d: number) => d } as never,
      { isRouterMocked: true, isSynthesisMocked: true } as never,
      { KANOON_ENRICH_MAX: 0, PRECEDENT_MAX_RESULTS: 10, PRECEDENT_PAGE_SIZE: 5 } as never,
    );
  }
  const asked = (text: string) => ({ intent: 'PRECEDENT_SEARCH', sectionNumber: null, actCode: null, cnrNumber: null, confidence: 0.9, rawText: text, searchQuery: text }) as never;

  it('is the Supreme Court judgment alone, without High Court namesakes', async () => {
    const service = search([
      judgment('768175', 'Joginder Kumar vs State Of U.P', '1994-04-25'),
      judgment('9001', 'Joginder Kumar vs State Of U.P. And 3 Others', '2016-02-10', 'Allahabad High Court'),
      judgment('9002', 'Joginder Kumar vs State Of U.P. Thru. Prin. Secy.', '2024-07-01', 'Allahabad High Court'),
    ]);

    const result = await service.search(asked('Joginder Kumar v. State of U.P. — citation and holding'));

    expect(result.precedents.map((r) => r.judgment_id)).toEqual(['kanoon:768175']);
  });

  it('is one card per judgment: two Kanoon copies of Maneka Gandhi are one', async () => {
    const service = search([
      judgment('1766147', 'Maneka Gandhi vs Union Of India', '1978-01-25'),
      judgment('1766148', 'Maneka Gandhi vs Union Of India', '1978-01-25'),
    ]);

    const result = await service.search(asked('Maneka Gandhi v. Union of India — citation and ratio'));

    expect(result.precedents).toHaveLength(1);
  });

  it('keeps a High Court judgment when the question names the court', async () => {
    const service = search([
      judgment('1', 'Ramesh Kumar vs State', '2019-01-01', 'Delhi High Court'),
      judgment('2', 'Ramesh Kumar vs State', '2001-01-01'),
    ]);

    const result = await service.search(asked('Ramesh Kumar v. State, Delhi High Court — citation'));

    expect(result.precedents.map((r) => r.court_name)).toContain('Delhi High Court');
  });
});

// ---------------------------------------------------------------------------
// The reply's language (client's #9)
// ---------------------------------------------------------------------------

describe('an answer in the wrong language (pattern I)', () => {
  it('is recognised: a Hinglish question answered in English, a Hindi one with no Devanagari', () => {
    // From the live run of 9 Oct, after release 49efb4b.
    expect(wrongLanguage('hinglish', '*SECTION:* IPC Section 379; corresponds to BNS Section 303.\n\n*SUMMARY:* IPC Section 379 punishes theft with imprisonment up to three years, or fine, or both.')).toBe(true);
    expect(wrongLanguage('hi', '*SECTION:* Section 23(1) of the Bharatiya Sakshya Adhiniyam (BSA)\n\n*SUMMARY:* This section makes a confession to a police officer inadmissible.')).toBe(true);
  });

  it('is not raised for Hinglish, short or long, or for Hindi', () => {
    expect(wrongLanguage('hinglish', 'BNSS Section 48 purane CrPC ke Section 50A ke samanvayi hai.')).toBe(false);
    expect(wrongLanguage('hinglish', '*SECTION:* BNS Section 106 - Causing death by negligence\n\n*SUMMARY:* Yeh section us vyakti ke liye hai jo gaadi chala kar kisi ki maut ka kaaran banta hai aur bina report kiye bhaag jaata hai.')).toBe(false);
    expect(wrongLanguage('hi', 'BNS की धारा 294 पुरानी IPC की धारा 292 के बराबर है।')).toBe(false);
    expect(wrongLanguage('en', 'Any English answer at all, of whatever length it happens to be.')).toBe(false);
  });

  it('is written once more, plainly, and the second answer kept when it is right', async () => {
    const english = '*SECTION:* IPC Section 379; corresponds to BNS Section 303(2).\n\n*SUMMARY:* IPC Section 379 punishes theft with imprisonment up to three years, or fine, or both.';
    const hinglish = '*SECTION:* IPC Section 379, ab BNS Section 303(2).\n\n*SUMMARY:* Yeh section chori ki saza deta hai - teen saal tak ki kaid, ya jurmana, ya dono.';
    const ipc379 = statute('IPC', '379', 'Punishment for theft', { correspondence: ['IPC 379 = BNS 303(2)'] });
    const { service, registry } = rag({ search: (n, act) => (act === 'IPC' && n === '379' ? [ipc379] : []) });
    registry.complete.mockResolvedValueOnce({ text: english, model: 'gpt-4.1', inputTokens: 1, outputTokens: 1 }).mockResolvedValueOnce({ text: hinglish, model: 'gpt-4.1', inputTokens: 1, outputTokens: 1 });

    const answer = await service.answer(intent({ actCode: 'IPC', sectionNumber: '379', rawText: 'IPC 379 ka BNS mein kaunsa section hai?' }) as never);

    expect(registry.complete).toHaveBeenCalledTimes(2);
    expect(registry.complete.mock.calls[1][0].system).toContain('YOUR LAST ANSWER WAS IN ENGLISH.');
    expect(answer.text).toBe(hinglish);
  });
});
