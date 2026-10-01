import { buildSectionExplanationPrompt } from '../../ai/prompts';
import { formatStatute } from '../../whatsapp/replies';
import { StatuteRow } from '../types';
import { CorpusRepository, CorrespondencePair, describeCorrespondence } from './corpus.repository';

/**
 * The official 2023 correspondence (BPR&D tables, migration 0021) reaches the
 * model and the WhatsApp card in full. One corresponding_* pair on a row could
 * not say that BNS 318 replaced four IPC sections, or which sub-section took
 * IPC 420.
 */
const PAIRS: CorrespondencePair[] = [
  { new_act: 'BNS', new_section: '318(4)', old_act: 'IPC', old_section: '420' },
  { new_act: 'BNS', new_section: '318(1)', old_act: 'IPC', old_section: '415' },
  { new_act: 'BNS', new_section: '318(3)', old_act: 'IPC', old_section: '418' },
  { new_act: 'BNS', new_section: '318(2)', old_act: 'IPC', old_section: '417' },
  { new_act: 'BNSS', new_section: '144', old_act: 'CRPC', old_section: '125' },
];

function statute(over: Partial<StatuteRow>): StatuteRow {
  return {
    id: 'x', act_code: 'BNS', act_name: 'Bharatiya Nyaya Sanhita, 2023', section_number: '318', section_title: 'Cheating',
    section_text: '318. (1) Whoever, by deceiving any person...', punishment: null, is_cognizable: null, is_bailable: null,
    is_compoundable: null, triable_by: null, corresponding_act: null, corresponding_section: null, match_type: 'EXACT', score: 1000,
    ...over,
  };
}

describe('the official correspondence for a section', () => {
  it('lists every old section a new one replaced, in old-section order', () => {
    expect(describeCorrespondence({ act_code: 'BNS', section_number: '318' }, PAIRS)).toEqual([
      'IPC 415 = BNS 318(1)', 'IPC 417 = BNS 318(2)', 'IPC 418 = BNS 318(3)', 'IPC 420 = BNS 318(4)',
    ]);
  });

  it('gives a sub-section row only its own pairing', () => {
    expect(describeCorrespondence({ act_code: 'BNS', section_number: '318(4)' }, PAIRS)).toEqual(['IPC 420 = BNS 318(4)']);
  });

  it('gives an old-code row what replaced it', () => {
    expect(describeCorrespondence({ act_code: 'CRPC', section_number: '125' }, PAIRS)).toEqual(['CrPC 125 = BNSS 144']);
  });

  it('is empty for a section with no official counterpart', () => {
    expect(describeCorrespondence({ act_code: 'BNSS', section_number: '530' }, PAIRS)).toEqual([]);
  });
});

describe('where the correspondence is shown', () => {
  it('reaches the model in full, ahead of the single recorded pair', () => {
    const prompt = buildSectionExplanationPrompt(
      [statute({ corresponding_act: 'IPC', corresponding_section: '420', correspondence: describeCorrespondence({ act_code: 'BNS', section_number: '318' }, PAIRS) })],
      'en',
      'Section 318 of the Bharatiya Nyaya Sanhita (BNS)',
    );
    expect(prompt).toContain('Corresponds to (official 2023 correspondence table): IPC 415 = BNS 318(1); IPC 417 = BNS 318(2); IPC 418 = BNS 318(3); IPC 420 = BNS 318(4)');
    expect(prompt).not.toContain('Corresponds to: IPC Section 420');
  });

  it('falls back to the recorded pair when there is no table entry', () => {
    const prompt = buildSectionExplanationPrompt([statute({ corresponding_act: 'IPC', corresponding_section: '420', correspondence: [] })], 'en', null);
    expect(prompt).toContain('Corresponds to: IPC Section 420');
  });

  it('is on the WhatsApp card', () => {
    const card = formatStatute(statute({ act_code: 'CRPC', section_number: '125', correspondence: ['CrPC 125 = BNSS 144'] }));
    expect(card).toContain('*Correspondence:* CrPC 125 = BNSS 144');
  });
});

describe('searchStatutes', () => {
  it('attaches the correspondence to every row it returns', async () => {
    const rows = [statute({}), statute({ act_code: 'CRPC', section_number: '125' })];
    const calls: unknown[][] = [];
    const sql = jest.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve(calls.length === 1 ? rows : PAIRS);
    });
    const repo = new CorpusRepository({ sql } as never);

    const found = await repo.searchStatutes('cheating', '318', 'BNS', 3);

    expect(calls[1]).toEqual([['BNS', 'CRPC'], ['318', '125']]);
    expect(found[0].correspondence).toHaveLength(4);
    expect(found[1].correspondence).toEqual(['CrPC 125 = BNSS 144']);
  });

  it('does not query the correspondence when nothing was found', async () => {
    const sql = jest.fn().mockResolvedValue([]);
    const repo = new CorpusRepository({ sql } as never);

    expect(await repo.searchStatutes('nothing', '999', 'BNS', 3)).toEqual([]);
    expect(sql).toHaveBeenCalledTimes(1);
  });
});
