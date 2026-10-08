import { StatuteRow } from '../database/types';
import { CLASSIFICATION_NOTE, GuardrailsService, groundedRefs, stripUnsupportedClassification } from './guardrails.service';
import { asksToWriteAssignment, asksWhichCase, IntentService } from './intent.service';
import { extractSectionReference, extractStatuteRefs, isHinglish, recodifiedReference, topicQuery } from './legal-patterns';
import { CRIMINAL_CODES_TEXT, PROMPT_GIVEN_REFS } from './prompts';
import { nonexistentProvision } from './provision-range';
import { RagService, statutesShown, subjectWords } from './rag.service';

/**
 * Fix 2: every section-lookup issue from the live tests of 4 and 7 October 2026.
 *
 * Each test names the question it comes from (the ID in leylegal_test_set_500.xlsx).
 * Titles and texts of sections are the Gazette's (migration 0021); the
 * correspondence is the official BPR&D table's, with the sub-sections migration
 * 0022 adds.
 */

function row(act_code: string, section_number: string, section_title: string, over: Partial<StatuteRow> = {}): StatuteRow {
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

const BNS_302 = row('BNS', '302', 'Uttering words, etc., with deliberate intent to wound religious feelings of any person', {
  section_text: '302. Whoever, with the deliberate intention of wounding the religious feelings of any person, utters any word or makes any sound in the hearing of that person ...',
});
const BNS_103 = row('BNS', '103', 'Punishment for murder', {
  match_type: 'RECODIFIED', section_text: '103. (1) Whoever commits murder shall be punished with death or imprisonment for life, and shall also be liable to fine.',
  correspondence: ['IPC 302 = BNS 103(1)'], mapped_from: 'IPC 302', mapped_to: 'BNS 103(1)',
});
const BNS_323 = row('BNS', '323', 'Dishonest or fraudulent removal or concealment of property to prevent distribution among creditors');
const BNS_115 = row('BNS', '115', 'Voluntarily causing hurt', { match_type: 'RECODIFIED', correspondence: ['IPC 321 = BNS 115(1)', 'IPC 323 = BNS 115(2)'], mapped_from: 'IPC 323', mapped_to: 'BNS 115(2)' });
const BNS_120 = row('BNS', '120', 'Voluntarily causing hurt to extort confession, or to compel restoration of property', {
  section_text: '120. (1) Whoever voluntarily causes hurt for the purpose of extorting from the sufferer ... any confession ...',
});
const BNS_60 = row('BNS', '60', 'Concealing design to commit offence punishable with imprisonment', { match_type: 'RECODIFIED', mapped_from: 'IPC 120', mapped_to: 'BNS 60' });
const BNS_61a = row('BNS', '61', 'Criminal conspiracy', { match_type: 'RECODIFIED', mapped_from: 'IPC 120A', mapped_to: 'BNS 61(1)' });
const BNS_61b = { ...BNS_61a, mapped_from: 'IPC 120B', mapped_to: 'BNS 61(2)' };
const BNS_85 = row('BNS', '85', 'Husband or relative of husband of a woman subjecting her to cruelty', { match_type: 'RECODIFIED', mapped_from: 'IPC 498A', mapped_to: 'BNS 85' });
const BNS_86 = row('BNS', '86', 'Cruelty defined', { match_type: 'RECODIFIED', mapped_from: 'IPC 498A', mapped_to: 'BNS 86' });
const BNS_307 = row('BNS', '307', 'Theft after preparation made for causing death, hurt or restraint in order to the committing of the theft');
const BNS_109 = row('BNS', '109', 'Attempt to murder', { match_type: 'RECODIFIED', mapped_from: 'IPC 307', mapped_to: 'BNS 109' });
const BNS_316 = row('BNS', '316', 'Criminal breach of trust');
const BNS_92 = row('BNS', '92', 'Causing death of quick unborn child by act amounting to culpable homicide', { match_type: 'RECODIFIED', mapped_from: 'IPC 316', mapped_to: 'BNS 92' });
const BNS_226 = row('BNS', '226', 'Attempt to commit suicide to compel or restrain exercise of lawful power', { match_type: 'FULLTEXT', score: 12 });
const IPC_309 = row('IPC', '309', 'Attempt to commit suicide', { source_url: 'https://indiankanoon.org/doc/1/' });

function intent(over: Record<string, unknown>) {
  return { intent: 'SECTION_LOOKUP' as const, language: 'en', cnrNumber: null, sectionNumber: null, actCode: null, actName: null, searchQuery: 'q', rawText: 'q', confidence: 0.9, ...over };
}

function build(opts: {
  search?: (n: string | null, act: string | null, query: string) => StatuteRow[];
  recodified?: (act: string, n: string, siblings: boolean) => StatuteRow[];
  fetched?: StatuteRow | null;
  model?: string;
}) {
  const corpus = {
    searchStatutes: jest.fn(async (query: string, n: string | null, act: string | null) => opts.search?.(n, act, query) ?? []),
    withCorrespondence: jest.fn(async (rows: StatuteRow[]) => rows),
    statutesCovering: jest.fn().mockResolvedValue([]),
    recodifiedFrom: jest.fn(async (act: string, n: string, siblings = false) => opts.recodified?.(act, n, siblings) ?? []),
  };
  const registry = { complete: jest.fn().mockResolvedValue({ text: opts.model ?? 'answer', model: 'm', inputTokens: 1, outputTokens: 1 }) };
  const guardrails = { verify: jest.fn(async (text: string) => ({ text, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null })) };
  const statutes = {
    fetch: jest.fn().mockResolvedValue({ row: opts.fetched ?? null }),
    stored: jest.fn().mockResolvedValue(null),
    replaceAbridged: jest.fn().mockResolvedValue(null),
  };
  const rag = new RagService(corpus as never, {} as never, registry as never, guardrails as never, {} as never, statutes as never);
  return { rag, corpus, registry, guardrails };
}

// ---------------------------------------------------------------------------
// R2. Hindi and Hinglish section references
// ---------------------------------------------------------------------------

describe('a section written "की धारा" (M-REV-011, M-CRPC-010, M-CRPC-031, M-IEA-024)', () => {
  it.each([
    ['BNSS की धारा 174 पुराने CrPC की कौन सी धारा थी?', '174', 'BNSS'],
    ['CrPC की धारा 133 अब BNSS में कौन सी धारा है?', '133', 'CRPC'],
    ['CrPC की धारा 311 अब BNSS में कौन सी धारा है?', '311', 'CRPC'],
    ['IEA की धारा 106 अब BSA में कौन सी धारा है?', '106', 'IEA'],
    ['BSA की धारा 23(1) पुराने IEA की कौन सी धारा थी?', '23(1)', 'BSA'],
    ['धारा 307 की सजा क्या है?', '307', null],
    ['IPC ki dhara 302 kya hai', '302', 'IPC'],
  ])('%p -> %s %s', (text, section, act) => {
    expect(extractSectionReference(text)).toEqual({ section, act });
  });

  it.each([
    ['BNSS की धारा 174 पुराने CrPC की कौन सी धारा थी?', 'BNSS', '174'],
    ['CrPC की धारा 133 अब BNSS में कौन सी धारा है?', 'CRPC', '133'],
    ['IEA की धारा 106 अब BSA में कौन सी धारा है?', 'IEA', '106'],
    ['BSA की धारा 23(1) पुराने IEA की कौन सी धारा थी?', 'BSA', '23(1)'],
    ['IPC ki dhara 302 BNS mein kya hai', 'IPC', '302'],
  ])('belongs to the code before it: %p', (text, act, section) => {
    expect(recodifiedReference(text)).toEqual({ act, section });
  });

  it('wins over the router, which read BNSS 174 as CrPC 154 (M-REV-011)', async () => {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: 'SECTION_LOOKUP', language: 'hi', act_code: 'CRPC', section_number: '154', search_query: 'FIR' }),
      }),
    };
    const classified = await new IntentService(registry as never).classify('BNSS की धारा 174 पुराने CrPC की कौन सी धारा थी?');
    expect(classified).toMatchObject({ intent: 'SECTION_LOOKUP', actCode: 'BNSS', sectionNumber: '174' });
  });
});

describe('the router\'s "SECTION 106" (M-IEA-024)', () => {
  it('is section 106, never "Section SECTION 106"', async () => {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: 'SECTION_LOOKUP', language: 'hi', act_code: 'BSA', section_number: 'SECTION 106', search_query: 'IEA 106' }),
      }),
    };
    const classified = await new IntentService(registry as never).classify('BSA section 106 kya hai?');
    expect(classified.sectionNumber).toBe('106');
  });
});

describe('Hinglish is answered in Hinglish (M-IPC-026, O-02)', () => {
  it.each([
    ['punishment for voluntarily causing hurt — purana IPC 323 tha, naya BNS section kya hai?', true],
    ['IPC 309 attempt to suicide ka BNS mein kya hua?', true],
    ['Reply in Hinglish: what does BSA 63 cover?', true],
    ['What is the punishment under Section 302?', false],
    ['धारा 307 की सजा क्या है?', false],
  ])('%p -> %s', (text, expected) => {
    expect(isHinglish(text)).toBe(expected);
  });

  it('tells the model to reply in Hinglish when the router said English', async () => {
    const { rag, registry } = build({ search: (n) => (n === '323' ? [row('IPC', '323', 'Punishment for voluntarily causing hurt', { correspondence: ['IPC 323 = BNS 115(2)'] })] : []) });

    await rag.answer(intent({ actCode: 'IPC', sectionNumber: '323', rawText: 'punishment for voluntarily causing hurt — purana IPC 323 tha, naya BNS section kya hai?' }) as never);

    expect(registry.complete.mock.calls[0][0].system).toContain('Reply in Hinglish - Hindi written in Latin script');
  });
});

// ---------------------------------------------------------------------------
// R7. Subjects the Acts word differently
// ---------------------------------------------------------------------------

describe('a subject in the words the Act uses', () => {
  it.each([
    // BNS 106(2) - "rash and negligent driving ... escapes without reporting it" (O-04)
    ['Hit and run ke liye naya section kaunsa hai BNS mein?', 'negligent driving escapes reporting'],
    // BSA 26(a) - "the statement is made by a person as to the cause of his death" (N-12)
    ['Which BSA section deals with dying declarations?', 'statement cause death circumstances transaction'],
    ['BNS 302 murder ki saza kya hai?', 'murder punishment'],
  ])('%p -> %p', (question, words) => {
    expect(topicQuery(question)).toBe(words);
  });

  it('leaves the asking words out of the subject used to spot a wrong section number', () => {
    expect(subjectWords('BNS 302 murder ki saza kya hai?')).toEqual(['murder']);
    expect(subjectWords('BNS 323 mein hurt ki saza kitni hai?')).toEqual(['hurt']);
    expect(subjectWords('What is criminal conspiracy under BNS 120?')).toEqual(['conspiracy']);
  });
});

// ---------------------------------------------------------------------------
// R3. A number of one code with the subject of the other
// ---------------------------------------------------------------------------

describe('no code named, and the number is two different offences (T-17, T-18)', () => {
  const recodified = (act: string, n: string) => (act === 'IPC' && n === '302' ? [BNS_103] : act === 'IPC' && n === '307' ? [BNS_109] : []);
  const search = (n: string | null, act: string | null) => (act === 'BNS' && n === '302' ? [BNS_302] : act === 'BNS' && n === '307' ? [BNS_307] : []);

  it('asks which code, gives both, and is free (T-17)', async () => {
    const { rag, registry } = build({ search, recodified });

    // The router guessed the BNS; nothing in the question says so.
    const answer = await rag.answer(intent({ actCode: 'BNS', sectionNumber: '302', rawText: 'What is the punishment under Section 302?' }) as never);

    expect(registry.complete).not.toHaveBeenCalled();
    expect(answer.free).toBe(true);
    expect(answer.text).toBe(
      [
        '*Section 302* - you have not said which code, and the number is two different provisions:',
        '• *IPC 302* (offences before 1 July 2024) is now *BNS 103(1)* - Punishment for murder.',
        '• *BNS 302* - Uttering words, etc., with deliberate intent to wound religious feelings of any person',
        'Ask again with the code - *IPC 302* or *BNS 302* - and I will explain it.',
      ].join('\n\n'),
    );
  });

  it('asks in Hindi when asked in Hindi (T-18)', async () => {
    const { rag } = build({ search, recodified });

    const answer = await rag.answer(intent({ language: 'hi', sectionNumber: '307', rawText: 'धारा 307 की सजा क्या है?' }) as never);

    expect(answer.free).toBe(true);
    expect(answer.text).toContain('*IPC 307* (1 जुलाई 2024 से पहले के अपराध) अब *BNS 109* - Attempt to murder है।');
    expect(answer.text).toContain('*BNS 307* - Theft after preparation made for causing death');
  });

  it.each([
    ['a code is named', 'IPC 302 ki saza kya hai?', []],
    ['the question is not about an offence', 'What does Section 302 say?', []],
    ['an earlier turn named the code', 'and Section 302?', [{ role: 'user', content: 'BNS 299 kya hai' }]],
  ])('does not ask when %s', async (_, rawText, history) => {
    const { rag, registry } = build({ search, recodified });

    const answer = await rag.answer(intent({ actCode: 'BNS', sectionNumber: '302', rawText }) as never, history as never);

    expect(answer.free).toBeUndefined();
    expect(registry.complete).toHaveBeenCalled();
  });
});

describe('a new-code number that does not exist (T-08)', () => {
  it('keeps the letter, and says where the old section of that number went', async () => {
    const { rag } = build({ recodified: (act, n) => (act === 'IPC' && n === '498A' ? [BNS_85, BNS_86] : []) });

    const answer = await rag.answer(intent({ actCode: 'BNS', sectionNumber: '498A', rawText: 'FIR is under BNS 498A. What are the ingredients?' }) as never);

    expect(answer.text).toMatch(/^\*Section 498A of the Bharatiya Nyaya Sanhita \(BNS\)\* does not exist\. The BNS has 358 sections/);
    expect(answer.text).toContain(
      'If you mean *IPC 498A*, the official 2023 correspondence table maps it to *BNS 85* (Husband or relative of husband of a woman subjecting her to cruelty) and *BNS 86* (Cruelty defined).',
    );
    // 498 exists in the BNSS and the IPC; 498A does not exist in the BNSS.
    expect(answer.text).not.toContain('does exist in');
    // The general hint gives way to the mapping itself.
    expect(answer.text).not.toContain('If you are working from an old IPC or CrPC number');
    expect(answer.text.endsWith('*BNS 86* (Cruelty defined).')).toBe(true);
  });

  it('does not say a repealed section exists (T-16: IPC 490, repealed in 1925)', () => {
    const text = nonexistentProvision('CRPC', '490')!;
    expect(text).toContain('Section 490 does exist in the BNSS - if you meant');
    expect(text).not.toMatch(/exist in the [^-]*IPC/);
  });
});

describe('the number of a new-code section with the subject of the old one (T-01, T-04, T-12)', () => {
  it('opens with what the named section is and where the subject went, and explains that (T-01)', async () => {
    const { rag, registry } = build({
      search: (n, act) => (act === 'BNS' && n === '302' ? [BNS_302] : []),
      recodified: (act, n, siblings) => (act === 'IPC' && n === '302' && siblings ? [BNS_103] : []),
      model: '*SECTION:* BNS 103 - Punishment for murder',
    });

    const answer = await rag.answer(intent({ actCode: 'BNS', sectionNumber: '302', rawText: 'BNS 302 murder ki saza kya hai?' }) as never);

    expect(answer.text).toBe(
      '*BNS 302* is "Uttering words, etc., with deliberate intent to wound religious feelings of any person". ' +
        'The section on what you asked about is *BNS 103* ("Punishment for murder"), formerly IPC 302 (now BNS 103(1)).\n\n' +
        '*SECTION:* BNS 103 - Punishment for murder',
    );
    const system: string = registry.complete.mock.calls[0][0].system;
    expect(system).toContain(
      'The advocate asked about *BNS Section 103* - the advocate wrote BNS 302, which is a different provision ' +
        '("Uttering words, etc., with deliberate intent to wound religious feelings of any person"). ' +
        'A line saying so is already printed above your answer: do not repeat it, and do not explain BNS 302. Explain *BNS Section 103*.',
    );
    // Only the section the subject belongs to is given: with BNS 302 beside
    // it, the body explained BNS 302 under the right lead line (live, 8 Oct).
    expect(answer.statutes.map((s) => `${s.act_code} ${s.section_number}`)).toEqual(['BNS 103']);
    expect(system).not.toContain('BNS Section 302 - Uttering words');
    expect(system).toContain('BNS Section 103 - Punishment for murder');
  });

  it('works the same for hurt (T-04)', async () => {
    const { rag, registry } = build({
      search: (n, act) => (act === 'BNS' && n === '323' ? [BNS_323] : []),
      recodified: (act, n) => (act === 'IPC' && n === '323' ? [BNS_115] : []),
    });

    const answer = await rag.answer(intent({ actCode: 'BNS', sectionNumber: '323', rawText: 'BNS 323 mein hurt ki saza kitni hai?' }) as never);

    expect(answer.text).toContain('The section on what you asked about is *BNS 115* ("Voluntarily causing hurt"), formerly IPC 323 (now BNS 115(2)).');
    expect(answer.statutes.map((s) => `${s.act_code} ${s.section_number}`)).toEqual(['BNS 115']);
    expect(registry.complete.mock.calls[0][0].system).not.toContain('BNS Section 323 - Dishonest or fraudulent removal');
  });

  it('looks at the lettered sections of the same number - IPC 120A and 120B for conspiracy (T-12)', async () => {
    const { rag } = build({
      search: (n, act) => (act === 'BNS' && n === '120' ? [BNS_120] : []),
      recodified: (act, n, siblings) => (act === 'IPC' && n === '120' && siblings ? [BNS_60, BNS_61a, BNS_61b] : []),
    });

    const answer = await rag.answer(intent({ actCode: 'BNS', sectionNumber: '120', rawText: 'What is criminal conspiracy under BNS 120?' }) as never);

    expect(answer.text).toContain(
      'The section on what you asked about is *BNS 61* ("Criminal conspiracy"), formerly IPC 120A (now BNS 61(1)) and IPC 120B (now BNS 61(2)).',
    );
    expect(answer.text).not.toContain('BNS 60');
  });

  it.each([
    ['the subject is the named section\'s own', 'BNS 103 murder ki saza kya hai?', '103', [BNS_103]],
    ['a second subject that the old number is not about', 'BNS 316 case mein bail kab milti hai?', '316', [BNS_316]],
  ])('adds nothing when %s', async (_, rawText, n, found) => {
    const { rag } = build({
      search: (sn, act) => (act === 'BNS' && sn === n ? found.map((r) => ({ ...r, match_type: 'EXACT' as const })) : []),
      recodified: (act, on) => (act === 'IPC' && on === '316' ? [BNS_92] : []),
      model: 'answer',
    });

    const answer = await rag.answer(intent({ actCode: 'BNS', sectionNumber: n, rawText }) as never);

    expect(answer.text).toBe('answer');
  });
});

// ---------------------------------------------------------------------------
// R5/R10. An old section with no counterpart, and what is close to it
// ---------------------------------------------------------------------------

describe('an old section the table maps to nothing (O-02)', () => {
  it('gives the model the new section on the same subject, marked as not a counterpart', async () => {
    const { rag, registry, corpus } = build({
      fetched: IPC_309,
      search: (n, act, query) => (n === null && act === 'BNS' && query === 'attempt commit suicide' ? [BNS_226] : []),
    });

    await rag.answer(intent({ actCode: 'IPC', sectionNumber: '309', rawText: 'IPC 309 attempt to suicide ka BNS mein kya hua?' }) as never);

    expect(corpus.searchStatutes).toHaveBeenCalledWith('attempt commit suicide', null, 'BNS', 3);
    const system: string = registry.complete.mock.calls[0][0].system;
    expect(system).toContain('BNS Section 226 - Attempt to commit suicide to compel or restrain exercise of lawful power');
    expect(system).toContain('RELATED, NOT A COUNTERPART: the official 2023 correspondence table does not map IPC 309 to this section.');
    expect(system).toContain('Corresponds to: no BNS section - the official 2023 correspondence table lists none (not carried into the BNS). Do not call any section its counterpart.');
  });

  it('does not search on a title that is only "Punishment" (IPC 143 before migration 0022)', async () => {
    const { rag, corpus } = build({ fetched: row('IPC', '143', 'Punishment', { source_url: 'https://indiankanoon.org/doc/2/' }) });

    await rag.answer(intent({ actCode: 'IPC', sectionNumber: '143', rawText: 'IPC 143 — which section is it in the BNS?' }) as never);

    expect(corpus.searchStatutes.mock.calls.filter((c) => c[1] === null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R7. Nothing answers a subject question: say so, free
// ---------------------------------------------------------------------------

describe('when none of the sections found answers the question (O-04, N-12)', () => {
  it('is a fixed reply, free, with no sections listed', async () => {
    const { rag } = build({ search: () => [row('BNS', '236', 'False statement made in declaration which is by law receivable as evidence', { match_type: 'FULLTEXT', score: 10 })], model: 'NOT_COVERED' });

    const answer = await rag.answer(intent({ actCode: 'BSA', rawText: 'Which BSA section deals with dying declarations?' }) as never);

    expect(answer.free).toBe(true);
    expect(answer.statutes).toEqual([]);
    expect(answer.text).toBe("None of the sections Ley Legal holds answers this. Try the subject in the words the Act would use, or name the section if you know it.");
  });

  it('tells the model to answer NOT_COVERED for a subject question only', async () => {
    const { rag, registry } = build({ search: () => [row('BNS', '111', 'Organised crime', { match_type: 'FULLTEXT', score: 60 })] });

    await rag.answer(intent({ actCode: 'BNS', rawText: 'Which BNS section covers organised crime?' }) as never);

    expect(registry.complete.mock.calls[0][0].system).toContain('reply with exactly NOT_COVERED and nothing else');
  });
});

// ---------------------------------------------------------------------------
// R6. The statute list names what the answer names
// ---------------------------------------------------------------------------

describe('the provisions listed under an answer (M-REV-007, M-REV-017, O-12)', () => {
  const bns316 = row('BNS', '316', 'Criminal breach of trust');
  const ipc406 = row('IPC', '406', 'Punishment for criminal breach of trust');

  it('are the ones the answer names', () => {
    expect(statutesShown('BNS 316(5) purane IPC mein Section 409 tha.', [bns316, ipc406])).toEqual([bns316]);
  });

  it('are left as they were when the answer names none', () => {
    expect(statutesShown('No section number here.', [bns316, ipc406])).toEqual([bns316, ipc406]);
  });
});

// ---------------------------------------------------------------------------
// R3/R5. What the answer may cite, and what it may say about classification
// ---------------------------------------------------------------------------

describe('a section number the model was not given (B-10)', () => {
  const corpus = {
    verifyCitations: jest.fn(async (c: string[]) => c.map((citation) => ({ citation, found: true }))),
    verifyStatuteRefs: jest.fn(async (r: string[]) => r.map((ref) => ({ ref, found: true }))),
  };
  const guardrails = new GuardrailsService(corpus as never);
  const intimidationAsked = intent({ rawText: 'Facts: ... threatened ... Which BNS sections apply?' });

  it('is struck, though the section exists: BNS 302 is not criminal intimidation', async () => {
    const given = [row('BNSS', '223', 'Examination of complainant'), row('BNSS', '273', 'Evidence for prosecution')];

    const report = await guardrails.verify('*BNS Section 302* - Ingredients of Criminal Intimidation', [], intimidationAsked as never, [], given);

    expect(report.text).toBe(
      '*[unverified]* - Ingredients of Criminal Intimidation\n\n_A section number that was not among the provisions looked up for this question was removed._',
    );
    expect(report.removed).toEqual(['BNS 302']);
  });

  it('keeps the provisions given, both sides of their correspondence, and the facts every prompt states', async () => {
    const given = [BNS_103];
    const text = 'Murder was IPC 302 and is now BNS 103(1). Bail is under BNSS 480.';

    const report = await guardrails.verify(text, [], intent({ actCode: 'BNS', sectionNumber: '103' }) as never, [], given);

    expect(report.text).toBe(text);
  });

  it('is not applied to an answer given no provisions to check against', async () => {
    const report = await guardrails.verify('See BNS 302.', [], intimidationAsked as never, []);
    expect(report.text).toBe('See BNS 302.');
  });

  it('is struck the same way in a draft', async () => {
    const draft = await guardrails.verifiedDraft('*BNS Section 302* - Ingredients\n', intimidationAsked as never, new Map(), [row('BNSS', '223', 'x')]);
    expect(draft).toBe('*[unverified]* - Ingredients\n');
  });

  it('counts every section the prompt states as given', () => {
    const stated = extractStatuteRefs(CRIMINAL_CODES_TEXT).map((ref) => ref.replace(/\(.*$/, ''));
    const listed = new Set(PROMPT_GIVEN_REFS);
    for (const ref of stated) expect(listed).toContain(ref);
    // IEA 26 is inside "Evidence Act 25 to 27".
    for (const ref of PROMPT_GIVEN_REFS.filter((r) => r !== 'IEA 26')) expect(CRIMINAL_CODES_TEXT).toContain(ref.split(' ')[1]);
    expect(groundedRefs([], undefined, [])).toContain('BNSS 480');
  });
});

describe('classification said from memory (M-IPC-007, M-IPC-053)', () => {
  const mischief = row('BNS', '324', 'Mischief', { section_text: '324. (1) Whoever with intent to cause ... wrongful loss or damage ... commits "mischief". (2) Whoever commits mischief shall be punished ...' });

  it('is removed when nothing given states it, and the reader is told why', () => {
    const answer = '*SECTION:* BNS 324 - Mischief\n*KEY ELEMENTS:* Cognizable offence.\n- Intent to cause wrongful loss.\n- It is non-bailable and non-compoundable. Punishment up to six months.';
    expect(stripUnsupportedClassification(answer, [mischief])).toEqual({
      text: '*SECTION:* BNS 324 - Mischief\n*KEY ELEMENTS:*\n- Intent to cause wrongful loss.\n- Punishment up to six months.',
      stripped: true,
    });
  });

  it('is removed in Hindi too', () => {
    expect(stripUnsupportedClassification('यह अपराध संज्ञेय और गैर-जमानती है। सजा छह महीने तक।', [mischief]).text).toBe('सजा छह महीने तक।');
  });

  it('stays when a provision given states it', () => {
    const classified = row('BNS', '318(4)', 'Cheating', { punishment: 'Up to 7 years and fine', is_cognizable: true, is_bailable: false });
    expect(stripUnsupportedClassification('Cognizable and non-bailable.', [classified]).stripped).toBe(false);
  });

  it('stays when the section itself is about it - BNSS 478, bail in bailable offences', () => {
    const bnss478 = row('BNSS', '478', 'In what cases bail to be taken', { section_text: '478. (1) When any person other than a person accused of a non-bailable offence is arrested ...' });
    expect(stripUnsupportedClassification('Bail is a right in a bailable offence.', [bnss478]).stripped).toBe(false);
  });

  it('adds the note to the checked answer', async () => {
    const guardrails = new GuardrailsService({ verifyCitations: jest.fn(), verifyStatuteRefs: jest.fn() } as never);
    const report = await guardrails.verify('Mischief is cognizable.', [], undefined, [], [mischief]);
    expect(report.text).toBe(CLASSIFICATION_NOTE);
  });
});

// ---------------------------------------------------------------------------
// R8. Questions that are not section lookups
// ---------------------------------------------------------------------------

describe('a provision question that asks for the case that decided it (J-PL-14, S-SL-02, J-PL-70)', () => {
  function classify(text: string, router: Record<string, unknown>) {
    const registry = { complete: jest.fn().mockResolvedValue({ text: JSON.stringify(router) }) };
    return new IntentService(registry as never).classify(text);
  }

  it.each([
    ['Compensation for custodial death under Article 32 — leading case', { intent: 'SECTION_LOOKUP', language: 'en', act_code: null, section_number: 'Article 32', search_query: 'compensation for custodial death Article 32' }],
    ['Which case held that the procedure under Article 21 must be just, fair and reasonable?', { intent: 'SECTION_LOOKUP', language: 'en', section_number: 'Article 21', search_query: 'procedure just fair reasonable Article 21' }],
    ['धारा 482 CrPC (अब BNSS 528) के तहत FIR रद्द करने के मानदंड क्या हैं? सुप्रीम कोर्ट का फैसला', { intent: 'SECTION_LOOKUP', language: 'hi', act_code: 'CRPC', section_number: '482', search_query: 'quashing FIR section 482' }],
  ])('%p is a judgment search', async (text, router) => {
    expect((await classify(text, router)).intent).toBe('PRECEDENT_SEARCH');
  });

  it.each([
    ['What does Article 21 say?'],
    ['decision of the Magistrate under BNSS 175(3)'],
    ['IPC 302 ka punishment kya hai'],
  ])('%p stays a section lookup', async (text) => {
    expect(asksWhichCase(text)).toBe(false);
    expect((await classify(text, { intent: 'SECTION_LOOKUP', language: 'en', search_query: text })).intent).toBe('SECTION_LOOKUP');
  });
});

describe('an assignment to write (S-MT-07)', () => {
  it.each([
    ['Write my 2,000-word assignment on Article 21.', true],
    ['write an essay on the basic structure doctrine', true],
    ['2000 words assignment on bail', true],
    ['Draft a legal notice for cheque bounce', false],
    ['draft a bail application under BNSS 480', false],
    ['What is the assignment of actionable claims under the Transfer of Property Act?', false],
    // Asking what to cite in one is research, which is what Ley Legal is for.
    ['Which sections do I cite in my assignment on bail?', false],
  ])('%p -> %s', (text, expected) => {
    expect(asksToWriteAssignment(text)).toBe(expected);
  });
});

describe('a short Article question that asks for the case (fast path)', () => {
  it('is not answered as a section lookup without the router', async () => {
    const registry = {
      complete: jest.fn().mockResolvedValue({ text: JSON.stringify({ intent: 'PRECEDENT_SEARCH', language: 'en', search_query: 'Article 21 leading case' }) }),
    };
    const classified = await new IntentService(registry as never).classify('Article 21 leading case');
    expect(registry.complete).toHaveBeenCalled();
    expect(classified.intent).toBe('PRECEDENT_SEARCH');
  });
});
