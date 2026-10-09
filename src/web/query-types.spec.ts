import { CREDIT_COST } from '../credits/credits.service';
import { ChatMessageRow, PrecedentRow, UserRow } from '../database/types';
import { CnrNotFoundError } from '../ecourts/ecourts.service';
import searchResponse from '../ecourts/__fixtures__/ecourtsindia-search-idfc.json';
import { mapSearchResponse } from '../ecourts/party-search';
import webSearchResponse from '../ai/__fixtures__/openai-web-search-order39.json';
import { parseWebAnswer } from '../ai/web-fallback';
import { ChatEvent, ChatService } from './chat.service';

/**
 * Every kind of question, end to end, on the web side.
 *
 * The same coverage as the WhatsApp query-types spec, and it exists separately
 * for the reason the two services exist separately: they share the pipeline and
 * diverge above it, so a fix applied to one is not applied to the other. That
 * divergence has already produced two live bugs - a case status that charged on
 * one channel and not the other, and a case-law card rendered in two different
 * formats - and both were invisible until somebody used both surfaces.
 */

function precedent(id: string): PrecedentRow {
  return {
    judgment_id: id,
    case_title: 'Ram Kumar vs State of Bihar',
    neutral_citation: '2024 INSC 1',
    reporter_citations: ['AIR 2024 SC 9'],
    court_name: 'Patna High Court',
    court_type: 'HIGH_COURT',
    judgment_date: new Date('2024-09-11'),
    bench: ['A Kumar'],
    bench_strength: 1,
    act_sections: [],
    headnote: null,
    ratio_decidendi: 'Bail is the rule and jail the exception.',
    disposition: null,
    source_url: null,
    best_excerpt: '',
    para_number: null,
    score: 0.5,
    relevance_rank: 1,
    total_matches: 1,
  } as PrecedentRow;
}

const USER = { id: 'user-1', role: 'GUEST_LAWYER', preferred_language: 'en' } as UserRow;

function build(
  over: {
    intent?: string;
    cnr?: string | null;
    precedents?: PrecedentRow[];
    allowed?: boolean;
    lookup?: jest.Mock;
    casesForQuestion?: jest.Mock;
    webFind?: jest.Mock;
    corpusJudgments?: number;
  } = {},
) {
  const messages: ChatMessageRow[] = [];

  const chats = {
    findThread: jest.fn().mockResolvedValue({ id: 'thread-1', title: 'A thread' }),
    createThread: jest.fn().mockResolvedValue({ id: 'thread-1', title: 'New chat' }),
    autoTitle: jest.fn().mockResolvedValue(undefined),
    recentTurns: jest.fn().mockResolvedValue([]),
    appendMessage: jest.fn(async (input: Record<string, unknown>) => {
      const row = {
        id: `msg-${messages.length + 1}`,
        role: input.role,
        content: input.content,
        intent: input.intent ?? null,
        citations: input.citations ?? [],
        structured: input.structured ?? null,
        credits_charged: input.creditsCharged ?? 0,
        guardrail_flagged: false,
        error_detail: input.errorDetail ?? null,
        created_at: new Date(),
      } as unknown as ChatMessageRow;
      messages.push(row);
      return row;
    }),
  };

  const intents = {
    classify: jest.fn().mockResolvedValue({
      intent: over.intent ?? 'SECTION_LOOKUP',
      language: 'en',
      cnrNumber: over.cnr ?? null,
      sectionNumber: null,
      actCode: null,
      searchQuery: 'q',
      confidence: 0.9,
    }),
  };

  const rag = {
    answer: jest.fn().mockResolvedValue({
      text: 'Section 302 IPC prescribes the punishment for murder.',
      citations: [],
      passages: [],
      statutes: [],
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 1,
      guardrailTriggered: false,
      guardrailReason: null,
      mocked: false,
    }),
    answerSmallTalk: jest.fn().mockResolvedValue('Namaste. What can I help with?'),
  };

  const precedents = {
    pageSize: 5,
    search: jest.fn().mockResolvedValue({
      precedents: over.precedents ?? [],
      totalMatches: (over.precedents ?? []).length,
      lexicalOnly: false,
      source: 'local' as const,
      latencyMs: 1,
    }),
  };

  const balance = { free: 10, paid: 0, total: 10, monthlyAllowance: 30, unlimited: false };
  const credits = {
    spend: jest.fn().mockResolvedValue({
      allowed: over.allowed !== false,
      charged: over.allowed === false ? 0 : 2,
      replay: false,
      balance,
    }),
    peek: jest.fn().mockResolvedValue(balance),
    refund: jest.fn().mockResolvedValue(undefined),
    chargeUnverified: jest.fn().mockResolvedValue(1),
  };

  const ecourts = {
    lookup: over.lookup ?? jest.fn().mockResolvedValue({ cnr: 'BRMG030000191989', mocked: false }),
    casesForQuestion: over.casesForQuestion ?? jest.fn().mockResolvedValue(null),
  };
  const analytics = { recordSearch: jest.fn().mockResolvedValue(undefined) };
  const corpus = {
    countCorpus: jest.fn().mockResolvedValue({ judgments: over.corpusJudgments ?? 100 }),
  };
  const registry = { isFullyMocked: false };
  // The web finds nothing unless a test says otherwise (web-fallback.ts).
  const web = { find: over.webFind ?? jest.fn().mockResolvedValue(null) };

  const service = new ChatService(
    chats as never,
    intents as never,
    rag as never,
    precedents as never,
    ecourts as never,
    credits as never,
    analytics as never,
    corpus as never,
    registry as never,
    web as never,
  );

  return { service, credits, ecourts, precedents, rag, chats, analytics, web };
}

/** Drain the generator, which is how the controller consumes it. */
async function ask(service: ChatService, question: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of service.ask({ user: USER, threadId: 'thread-1', question })) {
    events.push(event);
  }
  return events;
}

function answers(events: ChatEvent[]): string {
  return events
    .filter((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer')
    .map((e) => e.message.content)
    .join('\n');
}

function errors(events: ChatEvent[]): string {
  return events
    .filter((e): e is Extract<ChatEvent, { type: 'error' }> => e.type === 'error')
    .map((e) => `${e.code}: ${e.message}`)
    .join('\n');
}

function charged(credits: { spend: jest.Mock }): { action: string; cost: number } | null {
  const call = credits.spend.mock.calls[0]?.[0];
  return call ? { action: call.action, cost: call.cost } : null;
}

describe('small talk', () => {
  it('is answered without charging', async () => {
    const { service, credits } = build({ intent: 'SMALL_TALK' });

    const events = await ask(service, 'hi');

    expect(answers(events)).toContain('Namaste');
    expect(charged(credits)).toBeNull();
  });
});

describe('case status', () => {
  it('charges one credit, the same as the bot does', async () => {
    // The two channels charged differently for this once. They must not again.
    const { service, credits, ecourts } = build({ intent: 'CASE_STATUS', cnr: 'BRMG030000191989' });

    await ask(service, 'status of BRMG030000191989');

    expect(ecourts.lookup).toHaveBeenCalledWith('BRMG030000191989');
    expect(charged(credits)).toEqual({ action: 'CASE_STATUS', cost: CREDIT_COST.CASE_STATUS });
  });

  it('reports what it actually charged, not zero', async () => {
    const { service } = build({ intent: 'CASE_STATUS', cnr: 'BRMG030000191989' });

    const events = await ask(service, 'BRMG030000191989');
    const answer = events.find(
      (e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer',
    );

    expect(answer?.charged).toBe(2);
  });

  it('refunds and keeps the failure in the thread when the case is not found', async () => {
    // Recorded as a message rather than thrown, so the question and the reason
    // it failed stay together - which means the outer catch never sees it and
    // the refund has to happen on this path.
    const { service, credits } = build({
      intent: 'CASE_STATUS',
      cnr: 'BRMG030000191989',
      lookup: jest.fn().mockRejectedValue(new CnrNotFoundError('BRMG030000191989')),
    });

    const events = await ask(service, 'BRMG030000191989');

    expect(credits.refund).toHaveBeenCalled();
    expect(answers(events)).toContain('No case found');
  });

  it('does not charge for, or look up, a filing number sent as a CNR', async () => {
    // "Check the status of CNR 831/2024" - the filing number off the card above
    // it - was charged, sent to eCourts and answered "No case found for CNR
    // 831/2024", as though the case did not exist.
    const { service, credits, ecourts, chats } = build({ intent: 'CASE_STATUS', cnr: null });
    (chats as Record<string, unknown>).caseCardsInThread = jest.fn().mockResolvedValue([
      { cnr: 'DLCT010012342024', filingNumber: '831/2024', caseNumber: '79/2024', petitioner: 'Idfc First Bank', respondent: 'Aditya Bhatia 6897' },
    ]);

    const events = await ask(service, 'Check the status of CNR 831/2024');

    expect(credits.spend).not.toHaveBeenCalled();
    expect(ecourts.lookup).not.toHaveBeenCalled();
    expect(answers(events)).toContain('*831/2024* is not a CNR - it is the filing number of *DLCT010012342024*');
    expect(answers(events)).not.toContain('No case found');
    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    expect(answer?.charged).toBe(0);
  });
});

describe('section lookup', () => {
  it('charges the search rate and answers', async () => {
    const { service, credits } = build({ intent: 'SECTION_LOOKUP' });

    const events = await ask(service, 'what is IPC 302');

    expect(charged(credits)).toEqual({
      action: 'SECTION_LOOKUP',
      cost: CREDIT_COST.SECTION_LOOKUP,
    });
    expect(answers(events)).toContain('punishment for murder');
  });

  it('streams the stages the pipeline actually reached', async () => {
    // Progress that is real, not a timer - see RagStage. A client rendering
    // these is showing what is happening.
    const { service } = build({ intent: 'SECTION_LOOKUP' });

    const events = await ask(service, 'IPC 420');
    const stages = events.filter((e) => e.type === 'stage');

    expect(stages.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('thread');
  });

  it('refunds a provision with no official text, as a search that found nothing is', async () => {
    // The reply says the text is not available rather than describing it from
    // memory. Nothing was answered, so nothing is kept.
    const { service, credits, rag, chats } = build({ intent: 'SECTION_LOOKUP' });
    rag.answer.mockResolvedValueOnce({
      text: "I don't have the official text of *Section 138 of the Negotiable Instruments Act, 1881* in Ley Legal yet.",
      citations: [], passages: [], statutes: [], model: 'rule:no-official-text', inputTokens: 0, outputTokens: 0,
      latencyMs: 1, guardrailTriggered: false, guardrailReason: null, mocked: false, unavailable: true,
    });

    const events = await ask(service, 'section 138 NI Act');

    expect(credits.refund).toHaveBeenCalledWith('user-1', 'GUEST_LAWYER', expect.stringMatching(/^spend:web:/), 'No official text for that provision');
    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    expect(answer?.charged).toBe(0);
    const stored = chats.appendMessage.mock.calls.map((c) => c[0]).find((m) => m.role === 'assistant');
    expect(stored?.creditsCharged).toBe(0);
  });

  it('keeps the charge for a real answer', async () => {
    const { service, credits } = build({ intent: 'SECTION_LOOKUP' });

    await ask(service, 'what is IPC 302');
    expect(credits.refund).not.toHaveBeenCalled();
  });
});

describe('a named case with no reported judgment', () => {
  // "idfc First bank vs aditya bhatia 6897" was answered "No judgments matched":
  // Kanoon has no document with those parties, and eCourts has the case.
  // eCourtsIndia's real answer to that search.
  const reported = mapSearchResponse(searchResponse).cases[0];

  it('is answered with the case on eCourts, and the search charge stands', async () => {
    const casesForQuestion = jest.fn().mockResolvedValue({ query: 'idfc First bank vs aditya bhatia 6897', result: { totalHits: 1, cases: [reported] } });
    const { service, credits } = build({ intent: 'PRECEDENT_SEARCH', precedents: [], casesForQuestion });

    const events = await ask(service, 'idfc First bank vs aditya bhatia 6897');

    expect(casesForQuestion).toHaveBeenCalledWith('idfc First bank vs aditya bhatia 6897');
    expect(credits.refund).not.toHaveBeenCalled();
    expect(answers(events)).toBe('No reported judgment found for "idfc First bank vs aditya bhatia 6897". One case on eCourts with these parties.');

    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    const cases = (answer?.message.structured as { cases: { statusCost: number; items: { cnr: string; title: string; rows: { label: string; value: string }[] }[] } }).cases;
    expect(cases.statusCost).toBe(CREDIT_COST.CASE_STATUS);
    expect(cases.items[0]).toMatchObject({ cnr: 'DLCT010012342024', title: 'Idfc First Bank vs Aditya Bhatia 6897' });
    expect(cases.items[0].rows).toContainEqual({ label: 'Case Status', value: 'Disposed on 2024-03-12' });
  });

  it('is still refunded when eCourts has nothing either', async () => {
    const { service, credits } = build({ intent: 'PRECEDENT_SEARCH', precedents: [] });

    const events = await ask(service, 'idfc First bank vs aditya bhatia 6897');

    expect(credits.refund).toHaveBeenCalled();
    expect(answers(events)).toContain('You have not been charged.');
  });

  it('does not search eCourts, or pay for it, when the judgment was found', async () => {
    const casesForQuestion = jest.fn();
    const { service, precedents } = build({ intent: 'PRECEDENT_SEARCH', precedents: [precedent('j1')], casesForQuestion });
    precedents.search.mockResolvedValueOnce({
      precedents: [precedent('j1')], totalMatches: 1, lexicalOnly: false, source: 'kanoon', latencyMs: 1,
      namedCase: { name: 'Ram Kumar vs State of Bihar', found: true },
    });

    await ask(service, 'Ram Kumar vs State of Bihar');

    expect(casesForQuestion).not.toHaveBeenCalled();
  });

  it('says a named judgment it could not find is missing, by its name', async () => {
    // "Mercy v. Mankind judgment ka ratio kya hai?" - a case that does not
    // exist - was answered with ten judgments on something else (audit, P8).
    const { service, precedents } = build({ intent: 'PRECEDENT_SEARCH', precedents: [], casesForQuestion: jest.fn().mockResolvedValue(null) });
    precedents.search.mockResolvedValueOnce({
      precedents: [], totalMatches: 0, lexicalOnly: false, source: 'kanoon', latencyMs: 1,
      namedCase: { name: 'Mercy v. Mankind', found: false },
    });

    const events = await ask(service, 'Mercy v. Mankind judgment ka ratio kya hai?');

    expect(answers(events)).toBe(
      'No judgment found for "Mercy v. Mankind" in Ley Legal\'s sources. ' +
        'Check the party names or the citation, or describe the point of law instead. You have not been charged.',
    );
  });
});

describe('case law', () => {
  it('charges the search rate and returns structured rows', async () => {
    const { service, credits } = build({
      intent: 'PRECEDENT_SEARCH',
      precedents: [precedent('j1')],
    });

    const events = await ask(service, 'case law on anticipatory bail');

    expect(charged(credits)).toEqual({
      action: 'PRECEDENT_SEARCH',
      cost: CREDIT_COST.PRECEDENT_SEARCH,
    });

    const answer = events.find(
      (e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer',
    );
    const structured = answer?.message.structured as { kind?: string; items?: unknown[] };
    expect(structured?.kind).toBe('precedents');
    expect(structured?.items).toHaveLength(1);
  });

  it('sends every field the output format requires', async () => {
    // The web card is rendered from this projection. If a field is missing
    // here, no amount of correct rendering puts it on screen.
    const { service } = build({ intent: 'PRECEDENT_SEARCH', precedents: [precedent('j1')] });

    const events = await ask(service, 'bail precedents');
    const answer = events.find(
      (e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer',
    );
    const item = (answer?.message.structured as { items: Record<string, unknown>[] }).items[0];

    for (const field of [
      'caseNo',
      'petitioner',
      'respondent',
      'date',
      'bench',
      'equivalentCitations',
      'legalPrinciple',
    ]) {
      expect(item).toHaveProperty(field);
    }
  });

  it('refunds a search that found nothing', async () => {
    // Credits buy authorities, and none arrived.
    const { service, credits } = build({ intent: 'PRECEDENT_SEARCH', precedents: [] });

    const events = await ask(service, 'something obscure');

    expect(credits.refund).toHaveBeenCalledWith(
      'user-1',
      'GUEST_LAWYER',
      expect.stringContaining('spend:web:'),
      expect.any(String),
    );
    expect(answers(events)).toContain('not been charged');
  });

  it('says the corpus is empty rather than blaming the question', async () => {
    // "No judgments found" on a deployment with nothing to search reads as
    // "your question was bad", and sends an advocate off rephrasing a query
    // that was never going to work.
    const { service } = build({
      intent: 'PRECEDENT_SEARCH',
      precedents: [],
      corpusJudgments: 0,
    });

    const events = await ask(service, 'bail');

    expect(answers(events)).toContain('No judgment database');
  });
});

describe('running out of credits', () => {
  it('refuses without doing the work, and says what it would have cost', async () => {
    const { service, rag, precedents } = build({ intent: 'SECTION_LOOKUP', allowed: false });

    const events = await ask(service, 'IPC 302');

    expect(errors(events)).toContain('INSUFFICIENT_CREDITS');
    expect(rag.answer).not.toHaveBeenCalled();
    expect(precedents.search).not.toHaveBeenCalled();
  });

  it('never promises the credits come back tomorrow', async () => {
    // The free allowance is granted once for the life of the account. Naming a
    // reset date has an advocate wait instead of buying more.
    const { service, credits } = build({ intent: 'SECTION_LOOKUP', allowed: false });
    credits.spend.mockResolvedValue({
      allowed: false,
      charged: 0,
      replay: false,
      balance: { free: 0, paid: 0, total: 0, monthlyAllowance: 30, unlimited: false },
    });

    const events = await ask(service, 'IPC 302');

    expect(errors(events)).not.toMatch(/tomorrow|reset|refill/i);
  });
});

describe('the charge is keyed to the stored message', () => {
  it('derives the reference from the message id, so a retry charges once', async () => {
    const { service, credits } = build({ intent: 'SECTION_LOOKUP' });

    await ask(service, 'IPC 302');

    expect(credits.spend).toHaveBeenCalledWith(
      expect.objectContaining({ reference: 'spend:web:msg-1' }),
    );
  });
});

/**
 * Unverified information from the web (web-fallback.ts) - when every verified
 * source came up empty. The found text is OpenAI's real web_search answer for
 * "Order 39 Rule 1 CPC", captured on the production server.
 */
describe('when no verified source has the answer', () => {
  const found = parseWebAnswer(webSearchResponse)!;

  it('shows a provision the web has, apart and unverified, for one credit', async () => {
    const webFind = jest.fn().mockResolvedValue(found);
    const { service, credits, rag, chats } = build({ intent: 'SECTION_LOOKUP', webFind });
    rag.answer.mockResolvedValueOnce({
      text: "I don't have the official text of *Order 39 Rule 1 of the Civil Procedure Code (CPC)* in Ley Legal yet.",
      citations: [], passages: [], statutes: [], model: 'rule:no-official-text', inputTokens: 0, outputTokens: 0,
      latencyMs: 1, guardrailTriggered: false, guardrailReason: null, mocked: false, unavailable: true,
      provision: 'Order 39 Rule 1 of the Civil Procedure Code (CPC)',
    });

    const events = await ask(service, 'Order 39 Rule 1 CPC');

    expect(webFind).toHaveBeenCalledWith('provision', 'Order 39 Rule 1 CPC', 'Order 39 Rule 1 of the Civil Procedure Code (CPC)');
    expect(credits.chargeUnverified).toHaveBeenCalledWith('user-1', 'GUEST_LAWYER', expect.stringMatching(/^spend:web:/));
    expect(credits.refund).not.toHaveBeenCalled();
    expect(answers(events)).toMatch(/1 credit was charged for the unverified information below\.$/);
    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    expect(answer?.charged).toBe(1);
    expect((answer?.message.structured as { unverified: unknown }).unverified).toEqual(found);
    expect(events.some((e) => e.type === 'stage' && e.stage === 'searching-web')).toBe(true);
    const stored = chats.appendMessage.mock.calls.map((c) => c[0]).find((m) => m.role === 'assistant');
    expect(stored?.creditsCharged).toBe(1);
  });

  it('is refunded as before when the web has nothing either', async () => {
    const { service, credits, rag } = build({ intent: 'SECTION_LOOKUP' });
    rag.answer.mockResolvedValueOnce({
      text: "I don't have the official text of *Order 39 Rule 1 of the Civil Procedure Code (CPC)* in Ley Legal yet.",
      citations: [], passages: [], statutes: [], model: 'rule:no-official-text', inputTokens: 0, outputTokens: 0,
      latencyMs: 1, guardrailTriggered: false, guardrailReason: null, mocked: false, unavailable: true,
    });

    const events = await ask(service, 'Order 39 Rule 1 CPC');

    expect(credits.refund).toHaveBeenCalled();
    expect(credits.chargeUnverified).not.toHaveBeenCalled();
    expect(answers(events)).toMatch(/No credits were charged for this question\.$/);
  });

  it('searches the web for a judgment neither Kanoon nor eCourts has', async () => {
    const webFind = jest.fn().mockResolvedValue(found);
    const { service, credits } = build({ intent: 'PRECEDENT_SEARCH', precedents: [], webFind });

    const events = await ask(service, 'judgments on temporary injunction under order 39');

    expect(webFind).toHaveBeenCalledWith('judgment', 'judgments on temporary injunction under order 39', 'q');
    expect(credits.refund).not.toHaveBeenCalled();
    expect(answers(events)).toBe('No judgments matched "q" in Ley Legal\'s sources. 1 credit was charged for the unverified information below.');
  });

  it('says a citation that cannot exist cannot exist - free, and never searched on the web (audit 4 Oct, J-FK-13)', async () => {
    // Live, the web search said "(2022) 40 SCC 404" corresponded to another
    // case and charged a credit for it (web-fallback.ts, impossibleCitation).
    const webFind = jest.fn().mockResolvedValue(found);
    const { service, credits } = build({ intent: 'PRECEDENT_SEARCH', precedents: [], webFind });

    const events = await ask(service, 'Summarise (2023) 99 SCC 1');

    expect(webFind).not.toHaveBeenCalled();
    expect(credits.chargeUnverified).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalled();
    expect(answers(events)).toBe(
      'No judgments matched "q". That citation cannot exist: no year of the Supreme Court Cases (SCC) reports has a volume 99. ' +
        'You have not been charged.',
    );
    expect(events.some((e) => e.type === 'stage' && e.stage === 'searching-web')).toBe(false);
    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    expect(answer?.charged).toBe(0);
  });

  it('does not search the web for a CNR eCourts has no record of - it refunds (live test, 7 Oct, C-06)', async () => {
    // The web said a made-up CNR "is registered in the eCourts system", for a
    // credit. eCourts is the record; when it has nothing, there is nothing.
    const webFind = jest.fn().mockResolvedValue(found);
    const { service, credits } = build({
      intent: 'CASE_STATUS',
      cnr: 'UPLK010999992023',
      lookup: jest.fn().mockRejectedValue(new CnrNotFoundError('UPLK010999992023')),
      webFind,
    });

    const events = await ask(service, 'Status of CNR UPLK010999992023');

    expect(webFind).not.toHaveBeenCalled();
    expect(credits.chargeUnverified).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalled();
    expect(answers(events)).toBe('No case found for CNR UPLK010999992023. Check the 16-character number and try again.');
    expect(events.some((e) => e.type === 'stage' && e.stage === 'searching-web')).toBe(false);
  });

  it('answers a question asked in Hindi in Hindi when the citation cannot exist (live test, 7 Oct, J-FK-13)', async () => {
    const webFind = jest.fn().mockResolvedValue(found);
    const { service, precedents } = build({ intent: 'PRECEDENT_SEARCH', precedents: [], webFind });
    precedents.search.mockResolvedValue({
      precedents: [], totalMatches: 0, lexicalOnly: false, source: 'kanoon', latencyMs: 1,
      namedCase: { name: '(2022) 40 SCC 404', found: false },
    });

    const events = await ask(service, "सुप्रीम कोर्ट के 'राजेंद्र कुमार बनाम भारत संघ, (2022) 40 SCC 404' फैसले में क्या कहा गया?");

    expect(webFind).not.toHaveBeenCalled();
    expect(answers(events)).toBe(
      'Ley Legal के स्रोतों में "(2022) 40 SCC 404" का कोई फ़ैसला नहीं मिला। पक्षकारों के नाम या उद्धरण (citation) जाँचें, या क़ानूनी प्रश्न अपने शब्दों में लिखें। ' +
        'यह उद्धरण (citation) मौजूद नहीं हो सकता: सुप्रीम कोर्ट केसेज़ (SCC) के किसी भी वर्ष में खंड (volume) 40 नहीं होता। आपसे कोई क्रेडिट नहीं लिया गया।',
    );
  });

  it('keeps the English message for a question asked in English', async () => {
    const { service, precedents } = build({ intent: 'PRECEDENT_SEARCH', precedents: [] });
    precedents.search.mockResolvedValue({
      precedents: [], totalMatches: 0, lexicalOnly: false, source: 'kanoon', latencyMs: 1,
      namedCase: { name: 'Ravindra Prasad Kushwaha vs State of Jharkhand', found: false },
    });

    const events = await ask(service, 'Summarise Ravindra Prasad Kushwaha v. State of Jharkhand');

    expect(answers(events)).toBe(
      'No judgment found for "Ravindra Prasad Kushwaha vs State of Jharkhand" in Ley Legal\'s sources. ' +
        'Check the party names or the citation, or describe the point of law instead. You have not been charged.',
    );
  });
});

describe('notes above a judgment list (Fix 1b)', () => {
  it('says the citation is not the named case\'s, above the case (J-FK-11)', async () => {
    const { service, precedents } = build({ intent: 'PRECEDENT_SEARCH' });
    precedents.search.mockResolvedValue({
      precedents: [precedent('kanoon:2982624')], totalMatches: 1, lexicalOnly: false, source: 'kanoon', latencyMs: 1,
      namedCase: { name: 'Arnesh Kumar vs State of Bihar', found: true },
      notes: ['Indian Kanoon does not list (2019) 3 SCC 112 for this judgment. It lists: 2014 (8) SCC 273.'],
    });

    const events = await ask(service, 'Summarise Arnesh Kumar v. State of Bihar, (2019) 3 SCC 112');

    expect(answers(events)).toBe(
      'Indian Kanoon does not list (2019) 3 SCC 112 for this judgment. It lists: 2014 (8) SCC 273.\n\n1 authority on "q"',
    );
    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    expect((answer?.message.structured as { notes?: string[] } | null)?.notes).toEqual([
      'Indian Kanoon does not list (2019) 3 SCC 112 for this judgment. It lists: 2014 (8) SCC 273.',
    ]);
  });
});

/** Fix 2 - section lookups. */
describe('section lookup replies that deliver no research (Fix 2)', () => {
  it('refunds a question back, says so, and never searches the web (T-17)', async () => {
    const webFind = jest.fn();
    const { service, credits, rag } = build({ intent: 'SECTION_LOOKUP', webFind });
    rag.answer.mockResolvedValueOnce({
      text: '*Section 302* - you have not said which code, and the number is two different provisions:',
      citations: [], passages: [], statutes: [], model: 'rule:ambiguous-number', inputTokens: 0, outputTokens: 0,
      latencyMs: 1, guardrailTriggered: false, guardrailReason: null, mocked: false, free: true,
    });

    const events = await ask(service, 'What is the punishment under Section 302?');

    expect(webFind).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledWith('user-1', 'GUEST_LAWYER', expect.any(String), 'No research delivered');
    expect(answers(events)).toBe(
      '*Section 302* - you have not said which code, and the number is two different provisions:\n\nNo credits were charged for this question.',
    );
    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    expect(answer?.charged).toBe(0);
  });

  it('declines an assignment before charging (S-MT-07)', async () => {
    const { service, credits, rag } = build({ intent: 'SECTION_LOOKUP' });

    const events = await ask(service, 'Write my 2,000-word assignment on Article 21.');

    expect(credits.spend).not.toHaveBeenCalled();
    expect(rag.answer).not.toHaveBeenCalled();
    expect(answers(events)).toMatch(/^Ley Legal is not built to write assignments\./);
  });

  it('lists only the provisions the answer names (M-REV-007)', async () => {
    const { service, rag } = build({ intent: 'SECTION_LOOKUP' });
    const statute = (act_code: string, section_number: string, section_title: string) => ({ act_code, act_name: act_code, section_number, section_title });
    rag.answer.mockResolvedValueOnce({
      text: 'BNS 316(5) purane IPC mein Section 409 tha.',
      citations: [], passages: [], statutes: [statute('BNS', '316', 'Criminal breach of trust'), statute('IPC', '406', 'Punishment for criminal breach of trust')],
      model: 'm', inputTokens: 1, outputTokens: 1, latencyMs: 1, guardrailTriggered: false, guardrailReason: null, mocked: false,
    });

    const events = await ask(service, 'BNS 316(5) purane IPC mein kaunsa section tha?');

    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    expect((answer?.message.structured as { statutes: { sectionNumber: string }[] }).statutes.map((s) => s.sectionNumber)).toEqual(['316']);
  });
});

/** Live test of 8 October 2026: what the release that day got wrong, on the web side. */
describe('the 8 October fixes', () => {
  it('says a citation that cannot exist cannot exist, beside a case name too - free, no eCourts, no web (J-FK-10)', async () => {
    // Four High Court cases of other Laxmi Narayans were shown, for two credits.
    const webFind = jest.fn();
    const casesForQuestion = jest.fn();
    const { service, precedents, credits } = build({ intent: 'PRECEDENT_SEARCH', webFind, casesForQuestion });
    precedents.search.mockResolvedValue({
      precedents: [], totalMatches: 0, lexicalOnly: false, source: 'kanoon', latencyMs: 1,
      namedCase: { name: 'Laxmi Narayan vs State', found: false },
    });

    const events = await ask(service, 'Give the ratio of Laxmi Narayan v. State, (2028) 1 SCC 1');

    expect(casesForQuestion).not.toHaveBeenCalled();
    expect(webFind).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalled();
    expect(answers(events)).toBe(
      'No judgment found for "Laxmi Narayan vs State" in Ley Legal\'s sources. Check the party names or the citation, or describe the point of law instead. ' +
        'That citation cannot exist: 2028 is still in the future. You have not been charged.',
    );
    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    expect(answer?.charged).toBe(0);
  });

  it('says judgment search is unavailable when Kanoon cannot be reached, and refunds (7 Oct outage)', async () => {
    const webFind = jest.fn();
    const casesForQuestion = jest.fn();
    const { service, precedents, credits } = build({ intent: 'PRECEDENT_SEARCH', webFind, casesForQuestion });
    precedents.search.mockResolvedValue({ precedents: [], unavailable: true, totalMatches: 0, lexicalOnly: false, source: 'kanoon', latencyMs: 1 });

    const events = await ask(service, 'Summarise Arnesh Kumar v. State of Bihar');

    expect(casesForQuestion).not.toHaveBeenCalled();
    expect(webFind).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledWith('user-1', 'GUEST_LAWYER', expect.any(String), 'Judgment search unavailable');
    expect(answers(events)).toBe(
      'Judgment search is not available right now: Indian Kanoon, where Ley Legal looks for judgments, is not responding, ' +
        'so nothing was searched. You have not been charged. Please ask again in a few minutes.',
    );
    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    expect(answer?.charged).toBe(0);
  });

  it.each([
    ['Give me 10 MCQs on BNSS for judiciary prelims.', /^Practice questions and MCQs are not live in Ley Legal yet/], // S-MT-05
    ['Track all my cases automatically', /^Ley Legal does not track cases or send hearing alerts/], // C-19
    ['Is your answer legal advice?', /^No\. Ley Legal is a research tool for advocates/], // B-13
  ])('answers %p with a fixed reply before charging', async (question, reply) => {
    const { service, credits, rag } = build({ intent: 'UNSUPPORTED' });

    const events = await ask(service, question);

    expect(credits.spend).not.toHaveBeenCalled();
    expect(rag.answer).not.toHaveBeenCalled();
    expect(answers(events)).toMatch(reply);
    expect(answers(events)).toMatch(/No credits were charged for this question\.$/);
  });
});

describe('a CNR question with another question in it (C-15)', () => {
  it('answers the status and says which part it did not answer', async () => {
    const { service, credits } = build({ intent: 'CASE_STATUS', cnr: 'DLCT010012342024' });

    const events = await ask(service, "CNR DLCT010012342024 — what's the status and which Arbitration Act section governs interim relief?");

    const answer = events.find((e): e is Extract<ChatEvent, { type: 'answer' }> => e.type === 'answer');
    expect(answer?.message.content).toBe(
      'Case status for DLCT010012342024\n\nYour message also asked: "which Arbitration Act section governs interim relief?" ' +
        'This reply covers only the case status - send that question on its own and Ley Legal will answer it.',
    );
    expect((answer?.message.structured as { note?: string }).note).toMatch(/^Your message also asked/);
    expect(charged(credits)).toEqual({ action: 'CASE_STATUS', cost: CREDIT_COST.CASE_STATUS });
  });

  it('adds nothing to a plain status question', async () => {
    const { service } = build({ intent: 'CASE_STATUS', cnr: 'DLCT010012342024' });

    const events = await ask(service, 'Check the status of CNR DLCT010012342024');

    expect(answers(events)).toBe('Case status for DLCT010012342024');
  });
});

/** The client's audit of 9 October 2026. */
describe('the 9 October audit, on the web side', () => {
  it('says a reminder is not a feature, free, though the message carries a CNR (C-12)', async () => {
    const { service, credits, ecourts } = build({ intent: 'CASE_STATUS', cnr: 'DLCT010012342024' });

    const events = await ask(service, 'Remind me on WhatsApp before my next date in DLCT010012342024');

    expect(ecourts.lookup).not.toHaveBeenCalled();
    expect(credits.spend).not.toHaveBeenCalled();
    expect(answers(events)).toMatch(/^Ley Legal does not track cases or send hearing alerts\..*Ley Legal on WhatsApp is not open yet\. No credits were charged for this question\.$/);
  });

  it('still looks up a case asked to be tracked with its CNR', async () => {
    const { service, ecourts } = build({ intent: 'CASE_STATUS', cnr: 'DLCT010012342024' });

    await ask(service, 'Track my case DLCT010012342024');

    expect(ecourts.lookup).toHaveBeenCalledWith('DLCT010012342024');
  });

  it('says how many characters a mistyped CNR has, free (C-05)', async () => {
    const { service, credits, chats } = build({ intent: 'CASE_STATUS', cnr: null });
    (chats as Record<string, unknown>).caseCardsInThread = jest.fn().mockResolvedValue([]);

    const events = await ask(service, 'Check CNR DLCT0100123420245');

    expect(credits.spend).not.toHaveBeenCalled();
    expect(answers(events)).toMatch(/^\*DLCT0100123420245\* has 17 characters; a CNR has exactly 16/);
  });

  it('gives the route to delete an account, free (B-12)', async () => {
    const { service, credits } = build({ intent: 'UNSUPPORTED' });

    const events = await ask(service, 'How do I delete my account and history?');

    expect(credits.spend).not.toHaveBeenCalled();
    expect(answers(events)).toMatch(/^To delete your Ley Legal account and its history, follow section 7 of the Privacy notice/);
  });
});
