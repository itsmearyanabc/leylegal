import { cnrWrittenIn, IntentService, isYearNotSection } from './intent.service';
import { recodifiedReference } from './legal-patterns';

/**
 * A year is not a section.
 *
 * "Mere client par 2023 mein 420 IPC ka case hua tha" came back from the
 * router as IPC section 2023, and was answered "Section 2023 of the IPC does
 * not exist" (audit of 2 October, NS7).
 */
function classifierSaying(json: Record<string, unknown>) {
  const registry = {
    complete: jest.fn().mockResolvedValue({ text: JSON.stringify(json), model: 'router', inputTokens: 0, outputTokens: 0 }),
  };
  return new IntentService(registry as never);
}

const NS7 =
  'Mere client par 2023 mein 420 IPC ka case hua tha, charge-sheet 2025 mein file hui. Ab kaunsa law lagega — IPC ya BNS? Aur procedure CrPC ya BNSS?';

describe('a year in the question', () => {
  it('gives way to the section the advocate wrote', async () => {
    const intent = await classifierSaying({ intent: 'SECTION_LOOKUP', section_number: '2023', act_code: 'IPC', confidence: 0.9 }).classify(NS7);

    expect(intent.sectionNumber).toBe('420');
    expect(intent.actCode).toBe('IPC');
  });

  it('is dropped when no section was written', async () => {
    const intent = await classifierSaying({ intent: 'SECTION_LOOKUP', section_number: '2024', act_code: 'BNSS', confidence: 0.9 }).classify(
      'Which procedure applies to an FIR registered in 2024 - CrPC or BNSS?',
    );

    expect(intent.sectionNumber).toBeNull();
  });

  it('is kept when the advocate wrote it as a section', () => {
    expect(isYearNotSection('2023', 'what is section 2023 IPC')).toBe(false);
    expect(isYearNotSection('1860', 'u/s 1860 of the IPC')).toBe(false);
    expect(isYearNotSection('2023', '2023 IPC kya hai')).toBe(false);
    expect(isYearNotSection('2023', 'BNS 2023 explain karo')).toBe(false);
  });

  it('is only ever a four-digit year', () => {
    expect(isYearNotSection('420', NS7)).toBe(false);
    expect(isYearNotSection('2023', NS7)).toBe(true);
    expect(isYearNotSection('2025', NS7)).toBe(true);
    expect(isYearNotSection('1500', 'in 1500 words')).toBe(false);
  });
});

describe('a number before a code named later in the question', () => {
  it("is not that code's section", () => {
    expect(recodifiedReference(NS7)).toEqual({ act: 'IPC', section: '420' });
    expect(recodifiedReference('Which procedure applies to an FIR registered in 2024 - CrPC or BNSS?')).toBeNull();
  });
});

/**
 * Live test of 4 October: section numbers the router supplied from memory.
 */
describe('a section number the advocate did not write', () => {
  it('is dropped, so the subject is searched instead', async () => {
    // "dowry death under the BNS" came back as BNS 304B - the IPC number - and
    // was answered "I don't have Section 304B of the BNS" (X2).
    const intent = await classifierSaying({ intent: 'SECTION_LOOKUP', section_number: '304B', act_code: 'BNS', confidence: 0.9 }).classify(
      'What is the punishment for dowry death under the BNS?',
    );
    expect(intent.sectionNumber).toBeNull();
    expect(intent.actCode).toBe('BNS');
  });

  it('is kept when it was written earlier in the conversation', async () => {
    const service = classifierSaying({ intent: 'SECTION_LOOKUP', section_number: '302', act_code: 'IPC', confidence: 0.9 });
    const intent = await service.classify('what is the punishment?', [{ role: 'user', content: 'explain IPC 302' }]);
    expect(intent.sectionNumber).toBe('302');
  });
});

describe('a code the advocate did not name', () => {
  it('is the old code when the number is past the end of the new one', async () => {
    // "धारा 420 में जमानत मिलती है क्या?" was answered "Section 420 of the BNS
    // does not exist" (X20). Every advocate means IPC 420.
    const intent = await classifierSaying({ intent: 'SECTION_LOOKUP', section_number: '420', act_code: 'BNS', confidence: 0.9 }).classify(
      'धारा 420 में जमानत मिलती है क्या?',
    );
    expect(intent.actCode).toBe('IPC');
    expect(intent.sectionNumber).toBe('420');
  });

  it('is the old code for a lettered number, which no 2023 code has (X30, 6 Oct)', async () => {
    const intent = await classifierSaying({ intent: 'PRECEDENT_SEARCH', section_number: '304B', act_code: 'BNS', confidence: 0.9 }).classify(
      'Patna High Court judgments on dowry death conviction under Section 304B',
    );
    expect(intent.actCode).toBe('IPC');
    expect(intent.sectionNumber).toBe('304B');
  });

  it('stays as written when the advocate named it', async () => {
    const intent = await classifierSaying({ intent: 'SECTION_LOOKUP', section_number: '420', act_code: 'BNS', confidence: 0.9 }).classify(
      'BNS 420 kya hai?',
    );
    expect(intent.actCode).toBe('BNS');
  });
});

/**
 * Live, 4 October: the same question about the NI Act was answered from the
 * Act's official text, then minutes later routed as BNS 138 (abduction) and
 * answered "The corpus doesn't cover Section 138 of the Negotiable
 * Instruments Act".
 */
describe('an Act the advocate named that is not one of the codes', () => {
  const NI = 'What are the ingredients of Section 138 of the Negotiable Instruments Act?';

  it('outranks a code the router guessed', async () => {
    const intent = await classifierSaying({ intent: 'SECTION_LOOKUP', section_number: '138', act_code: 'BNS', confidence: 0.9 }).classify(NI);
    expect(intent.actCode).toBeNull();
    expect(intent.actName).toBe('Negotiable Instruments Act');
    expect(intent.sectionNumber).toBe('138');
  });

  it("keeps the router's full name for it when the router gave one", async () => {
    const intent = await classifierSaying({
      intent: 'SECTION_LOOKUP', section_number: '138', act_code: 'BNS', act_name: 'Negotiable Instruments Act, 1881', confidence: 0.9,
    }).classify(NI);
    expect(intent.actCode).toBeNull();
    expect(intent.actName).toBe('Negotiable Instruments Act, 1881');
  });

  it('leaves a question that names a code to that code', async () => {
    const intent = await classifierSaying({ intent: 'SECTION_LOOKUP', section_number: '65B', act_code: 'IEA', confidence: 0.9 }).classify(
      'What does Section 65B(4) of the Evidence Act require in the certificate?',
    );
    expect(intent.actCode).toBe('IEA');
  });

  it('does not take a question word for the name of an Act', async () => {
    const intent = await classifierSaying({ intent: 'SECTION_LOOKUP', act_code: 'BNS', confidence: 0.9 }).classify('Under which Act is dowry death punished?');
    expect(intent.actCode).toBe('BNS');
    expect(intent.actName ?? null).toBeNull();
  });
});

/**
 * Live, 6 October (second run), NC1: "Check status of CNR ABCD1234" came back
 * as CNR ABCD123400002024 - eight characters the advocate never typed - and the
 * web search charged a credit for instructions on using eCourts.
 */
describe('a CNR the advocate did not write', () => {
  it('is dropped, so the reply asks for the CNR', async () => {
    const intent = await classifierSaying({ intent: 'CASE_STATUS', cnr_number: 'ABCD123400002024', confidence: 0.9 }).classify(
      'Check status of CNR ABCD1234',
    );
    expect(intent.cnrNumber).toBeNull();
  });

  it('is kept when it was written earlier in the conversation', async () => {
    const intent = await classifierSaying({ intent: 'CASE_STATUS', cnr_number: 'DLCT010012342024', confidence: 0.9 }).classify(
      'agli date kab hai?',
      [{ role: 'user', content: 'Check the status of CNR DLCT010012342024' }],
    );
    expect(intent.cnrNumber).toBe('DLCT010012342024');
  });

  it('is found however its separators were typed', () => {
    expect(cnrWrittenIn('DLCT010012342024', ['CNR: dlct01-001234-2024 please'])).toBe(true);
    expect(cnrWrittenIn('ABCD123400002024', ['Check status of CNR ABCD1234'])).toBe(false);
  });
});
