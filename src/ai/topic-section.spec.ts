import { StatuteRow } from '../database/types';
import { IntentService, asksWhichSection } from './intent.service';
import { topicQuery } from './legal-patterns';
import { RagService, closestToBest, mostCovered } from './rag.service';

/**
 * A section asked for by its subject, not its number (audit of 2 October).
 *
 * "What is the BNS section for organised crime" was answered from memory as
 * "the BNS (Bihar and Maharashtra Special) Act ... Section 3", and "जमानत के
 * लिए कौन सी section? BNS में" as the "Bombay Non-Bailable Offences Act". The
 * Gazette text holds both answers - BNS 111, and BNSS 478 to 483 - and the
 * search never reached them: every word of the router's sentence had to be in
 * the section, and only the code named was searched.
 *
 * Scores below are the ones search_statutes gave on the Gazette text (0021).
 */
describe('the words a provision on the subject would contain', () => {
  it.each([
    ['BNS section for organised crime and IPC equivalent', 'organised crime'],
    ['What is the BNS section for organized crime, and was there any equivalent in the IPC?', 'organised crime'],
    ['जमानत के लिए कौन सी section? BNS में', 'bail'],
    ['bail section in BNS', 'bail'],
    ['electronic evidence certificate under Bharatiya Sakshya Adhiniyam', 'electronic evidence certificate'],
    ['punishment for stalking a woman', 'punishment stalking woman'],
    // The router's phrasing on the live site (audit re-run, S4).
    ['provisions relating to bail in BNS', 'bail'],
  ])('%p -> %p', (question, words) => {
    expect(topicQuery(question)).toBe(words);
  });

  it.each([
    // Each in the enacted wording of the section it is: BNSS 482, 187, 173, 528.
    ['anticipatory bail under BNSS', 'bail apprehending arrest'],
    ['section for default bail', 'investigation cannot completed'],
    ['which section for zero FIR', 'information cognizable'],
    ['quashing of FIR under BNSS', 'inherent powers'],
    // BNS 103(2): "a group of five or more persons acting in concert commits murder".
    ['Which BNS section covers mob lynching?', 'group five persons acting concert murder'],
  ])('says %p as the Act does', (question, words) => {
    expect(topicQuery(question)).toBe(words);
  });

  it('is empty when the question has no subject', () => {
    expect(topicQuery('what is section')).toBe('');
  });
});

function row(act_code: string, section_number: string, section_title: string, score: number): StatuteRow {
  return {
    id: `${act_code}-${section_number}`, act_code, act_name: act_code, section_number, section_title, section_text: `${section_number}. text`,
    punishment: null, is_cognizable: null, is_bailable: null, is_compoundable: null, triable_by: null,
    corresponding_act: null, corresponding_section: null, match_type: 'FULLTEXT', score, correspondence: [],
  };
}

describe('the provisions kept for a subject', () => {
  it('keeps those close to the best match, and drops a passing mention', () => {
    const kept = closestToBest([
      row('BNS', '111', 'Organised crime', 60.3),
      row('BNS', '112', 'Petty organised crime', 18.2),
      row('BNSS', '43', 'Arrest how made', 4.0),
    ]);
    expect(kept.map((r) => r.section_number)).toEqual(['111', '112']);
  });

  it('keeps four at most, best first, each once', () => {
    const bail = [
      row('BNSS', '478', 'In what cases bail to be taken', 38),
      row('BNSS', '480', 'When bail may be taken in case of non-bailable offence', 54),
      row('BNSS', '430', 'Suspension of sentence pending appeal', 50),
      row('BNSS', '483', 'Special powers of High Court or Court of Session regarding bail', 42),
      row('BNSS', '482', 'Direction for grant of bail to person apprehending arrest', 26),
      row('BNSS', '480', 'When bail may be taken in case of non-bailable offence', 54),
    ];
    expect(closestToBest(bail).map((r) => r.section_number)).toEqual(['480', '430', '483', '478']);
  });
});

describe('searching for a subject', () => {
  function service(byAct: Record<string, StatuteRow[]>) {
    const corpus = {
      searchStatutes: jest.fn(async (_q: string, _n: string | null, act: string | null) => byAct[act ?? 'ALL'] ?? []),
      withCorrespondence: jest.fn(async (rows: StatuteRow[]) => rows),
      statutesCovering: jest.fn().mockResolvedValue([]),
    };
    const registry = { complete: jest.fn().mockResolvedValue({ text: 'answer', model: 'm', inputTokens: 1, outputTokens: 1 }) };
    const guardrails = { verify: jest.fn(async (text: string) => ({ text, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null })) };
    const rag = new RagService(corpus as never, {} as never, registry as never, guardrails as never, {} as never, {} as never);
    return { rag, corpus, registry };
  }

  it('searches all three new codes when the BNS is named, by the subject alone', async () => {
    const { rag, corpus, registry } = service({
      BNS: [row('BNS', '269', 'Failure by person released on bail bond or bond to appear in Court', 18)],
      BNSS: [row('BNSS', '480', 'When bail may be taken in case of non-bailable offence', 54)],
    });

    await rag.answer({
      intent: 'SECTION_LOOKUP', language: 'hi', cnrNumber: null, sectionNumber: null, actCode: 'BNS',
      searchQuery: 'bail section in BNS', rawText: 'जमानत के लिए कौन सी section? BNS में', confidence: 0.9,
    });

    expect(corpus.searchStatutes.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['bail', 'BNS'],
      ['bail', 'BNSS'],
      ['bail', 'BSA'],
    ]);
    const system: string = registry.complete.mock.calls[0][0].system;
    expect(system).toContain('BNSS Section 480');
    expect(system).toContain('BNS Section 269');
    expect(system).toContain('bail is in the BNSS, not the BNS');
  });

  it('searches the code named and nothing else when it is not a criminal code', async () => {
    const { rag, corpus } = service({});

    await rag.answer({
      intent: 'SECTION_LOOKUP', language: 'en', cnrNumber: null, sectionNumber: null, actCode: 'COI',
      searchQuery: 'right to equality', rawText: 'which article covers equality', confidence: 0.9,
    });

    expect(corpus.searchStatutes.mock.calls.map((c) => c[2])).toEqual(['COI']);
  });
});

describe('a question asking which section', () => {
  it.each([
    'What is the BNS section for organised crime, and was there any equivalent in the IPC?',
    'जमानत के लिए कौन सी section? BNS में',
    'bail ke liye kaunsi dhara lagti hai',
    'section for cheating in BNS',
    'Which provision deals with zero FIR?',
  ])('is a section question: %p', (text) => {
    expect(asksWhichSection(text)).toBe(true);
  });

  it.each([
    'What is the punishment for murder?',
    'what are the guidelines on arrest',
    'Can a High Court quash a 498A FIR on the basis of a compromise?',
  ])('is not: %p', (text) => {
    expect(asksWhichSection(text)).toBe(false);
  });

  it('is not a section number when the router fills one with words', async () => {
    // section_number "bail sections" was answered "I don't have the official
    // text of Section BAIL SECTIONS of the BNS" (audit re-run, S4).
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: 'SECTION_LOOKUP', section_number: 'bail sections', act_code: 'BNS', search_query: 'bail sections in BNS', confidence: 0.8 }),
        model: 'router', inputTokens: 0, outputTokens: 0,
      }),
    };
    const intent = await new IntentService(registry as never).classify('जमानत के लिए कौन सी section? BNS में');
    expect(intent.intent).toBe('SECTION_LOOKUP');
    expect(intent.sectionNumber).toBeNull();
  });

  it.each([
    ['302', '302'],
    ['498A', '498A'],
    ['103(1)', '103(1)'],
    ['167(2)', '167(2)'],
    ['Article 21', 'ARTICLE 21'],
    ['Order 39 Rule 1', 'ORDER 39 RULE 1'],
    // Without the word: "SECTION 65B" was printed "Section SECTION 65B" (Fix 2, M-IEA-024).
    ['section 65B', '65B'],
  ])('keeps a real one: %p', async (section, kept) => {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: 'SECTION_LOOKUP', section_number: section, confidence: 0.8 }),
        model: 'router', inputTokens: 0, outputTokens: 0,
      }),
    };
    const intent = await new IntentService(registry as never).classify(`explain ${section}`);
    expect(intent.sectionNumber?.toUpperCase()).toBe(kept);
  });

  it('is looked up in the codes even when the router called it general', async () => {
    const registry = {
      complete: jest.fn().mockResolvedValue({
        text: JSON.stringify({ intent: 'GENERAL_LEGAL', act_code: 'BNS', search_query: 'organised crime', confidence: 0.8 }),
        model: 'router', inputTokens: 0, outputTokens: 0,
      }),
    };
    const intent = await new IntentService(registry as never).classify(
      'What is the BNS section for organised crime, and was there any equivalent in the IPC?',
    );
    expect(intent.intent).toBe('SECTION_LOOKUP');
  });
});

/**
 * A subject no section contains every word of (live test of 4 October).
 *
 * "allows" and "inadmissible" are not in the Acts, so "Which BNSS section
 * allows a zero FIR to be registered?" and "Which BSA section makes a
 * confession to a police officer inadmissible?" found nothing and were
 * answered from memory, wrongly. Scores are statutesCovering's on the Gazette
 * text: 2 x title words + words anywhere.
 */
describe('the sections covering most of the subject', () => {
  const scored = (act: string, n: string, title: string, score: number) => ({ ...row(act, n, title, score) });

  it('keeps those near the best, and none when the best covers too little', () => {
    expect(
      mostCovered([
        scored('BNSS', '173', 'Information in cognizable cases', 9),
        scored('BNSS', '174', 'Information as to non-cognizable cases and investigation of such cases', 9),
        scored('BNSS', '472', 'Mercy petition in death sentence cases', 5),
      ]).map((r) => r.section_number),
    ).toEqual(['173', '174']);
    expect(mostCovered([scored('BNS', '2', 'Definitions', 2)])).toEqual([]);
  });

  it('adds the section titled with a second subject of the same question', () => {
    // "theft ka case hai ... bail kis section mein?" (X34).
    const rows = [
      scored('BNSS', '480', 'When bail may be taken in case of non-bailable offence', 6),
      scored('BNSS', '478', 'In what cases bail to be taken', 6),
      scored('BNS', '303', 'Theft', 4),
      scored('BNSS', '146', 'Alteration in allowance', 4),
    ];
    expect(mostCovered(rows, ['theft', 'bail']).map((r) => r.section_number)).toEqual(['480', '478', '303']);
  });

  it('is searched when no section has every word, and not otherwise', async () => {
    const corpus = {
      searchStatutes: jest.fn().mockResolvedValue([]),
      withCorrespondence: jest.fn(async (rows: StatuteRow[]) => rows),
      statutesCovering: jest.fn().mockResolvedValue([scored('BSA', '23', 'Confession to police officer', 9)]),
    };
    const registry = { complete: jest.fn().mockResolvedValue({ text: 'answer', model: 'm', inputTokens: 1, outputTokens: 1 }) };
    const guardrails = { verify: jest.fn(async (text: string) => ({ text, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null })) };
    const rag = new RagService(corpus as never, {} as never, registry as never, guardrails as never, {} as never, {} as never);

    await rag.answer({
      intent: 'SECTION_LOOKUP', language: 'en', cnrNumber: null, sectionNumber: null, actCode: 'BSA',
      searchQuery: 'Which BSA section makes a confession to a police officer inadmissible?',
      rawText: 'Which BSA section makes a confession to a police officer inadmissible?', confidence: 0.9,
    });

    expect(corpus.statutesCovering).toHaveBeenCalledWith(['confession', 'police', 'officer', 'inadmissible'], ['BNS', 'BNSS', 'BSA']);
    expect(registry.complete.mock.calls[0][0].system).toContain('BSA Section 23 - Confession to police officer');
  });

  it('does not take a long section that only mentions every word for the answer', async () => {
    // "theft ... bail" matched BNSS 401 (release on probation) alone.
    const corpus = {
      searchStatutes: jest.fn(async (_q: string, _n: string | null, act: string | null) =>
        act === 'BNSS' ? [scored('BNSS', '401', 'Order to release on probation of good conduct or after admonition', 0.01)] : []),
      withCorrespondence: jest.fn(async (rows: StatuteRow[]) => rows),
      statutesCovering: jest.fn().mockResolvedValue([scored('BNS', '303', 'Theft', 3), scored('BNSS', '480', 'When bail may be taken in case of non-bailable offence', 3)]),
    };
    const registry = { complete: jest.fn().mockResolvedValue({ text: 'answer', model: 'm', inputTokens: 1, outputTokens: 1 }) };
    const guardrails = { verify: jest.fn(async (text: string) => ({ text, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null })) };
    const rag = new RagService(corpus as never, {} as never, registry as never, guardrails as never, {} as never, {} as never);

    await rag.answer({
      intent: 'SECTION_LOOKUP', language: 'hi', cnrNumber: null, sectionNumber: null, actCode: 'BNS',
      searchQuery: 'theft bail', rawText: 'theft ka case hai, bail kis section mein?', confidence: 0.9,
    });

    const system: string = registry.complete.mock.calls[0][0].system;
    expect(system).toContain('BNS Section 303 - Theft');
    expect(system).not.toContain('release on probation');
  });
});
