import { StatuteRow } from '../database/types';
import { ClassifiedIntent } from './intent.service';
import { RagService } from './rag.service';

/**
 * With the full Acts loaded, "BNSS 520" also matched BNSS 52 by number
 * similarity - examination of a person accused of rape - and both went to the
 * model for an answer about trials before High Courts. When the named
 * provision is found, the model gets it, its sub-sections and its official
 * counterparts; spelling neighbours are only for when nothing was found.
 */
function row(section_number: string, section_title: string, match_type: StatuteRow['match_type'], act_code = 'BNSS'): StatuteRow {
  return {
    id: section_number, act_code, act_name: 'x', section_number, section_title, section_text: `${section_number}. text`,
    punishment: null, is_cognizable: null, is_bailable: null, is_compoundable: null, triable_by: null,
    corresponding_act: null, corresponding_section: null, match_type, score: 1, correspondence: [],
  };
}

function service(found: StatuteRow[]) {
  const registry = { complete: jest.fn().mockResolvedValue({ text: 'answer', model: 'm', inputTokens: 1, outputTokens: 1 }) };
  const guardrails = { verify: jest.fn(async (text: string) => ({ text, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null })) };
  const corpus = { searchStatutes: jest.fn().mockResolvedValue(found) };
  const rag = new RagService(corpus as never, {} as never, registry as never, guardrails as never, {} as never);
  return { rag, registry };
}

const intent = (sectionNumber: string | null): ClassifiedIntent => ({
  intent: 'SECTION_LOOKUP', language: 'en', cnrNumber: null, sectionNumber, actCode: 'BNSS',
  searchQuery: 'trials before high courts', rawText: 'Section 520 BNSS', confidence: 0.9,
});

describe('the statutes a section answer is written from', () => {
  it('keeps the named section and its counterparts, and drops spelling neighbours', async () => {
    const { rag, registry } = service([
      row('520', 'Trials before High Courts', 'EXACT'),
      row('474', 'Trials before High Courts', 'RECODIFIED', 'CRPC'),
      row('52', 'Examination of person accused of rape by medical practitioner', 'FUZZY'),
    ]);

    await rag.answer(intent('520'));
    const system: string = registry.complete.mock.calls[0][0].system;

    expect(system).toContain('BNSS Section 520 - Trials before High Courts');
    expect(system).toContain('CRPC Section 474');
    expect(system).not.toContain('Examination of person accused of rape');
  });

  it('still uses what it found when the named section itself was not among it', async () => {
    const { rag, registry } = service([row('144', 'Order for maintenance of wives, children and parents', 'FULLTEXT')]);

    // 300 is inside the BNSS's 531 sections, so this reaches the search (999
    // would be answered as nonexistent before any search or model call).
    await rag.answer(intent('300'));
    expect(registry.complete.mock.calls[0][0].system).toContain('BNSS Section 144');
  });

  it('uses everything found for a question that names no section', async () => {
    const { rag, registry } = service([row('144', 'Order for maintenance of wives, children and parents', 'FULLTEXT'), row('146', 'Alteration in allowance', 'FULLTEXT')]);

    await rag.answer(intent(null));
    const system: string = registry.complete.mock.calls[0][0].system;
    expect(system).toContain('BNSS Section 144');
    expect(system).toContain('BNSS Section 146');
  });
});
