import { IntentService, isYearNotSection } from './intent.service';
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
