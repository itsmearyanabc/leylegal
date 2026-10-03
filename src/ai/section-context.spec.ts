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

function service(found: StatuteRow[], fetcherOver: Partial<Record<'stored' | 'fetch' | 'replaceAbridged', jest.Mock>> = {}) {
  const registry = { complete: jest.fn().mockResolvedValue({ text: 'answer', model: 'm', inputTokens: 1, outputTokens: 1 }) };
  const guardrails = { verify: jest.fn(async (text: string) => ({ text, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null })) };
  const corpus = { searchStatutes: jest.fn().mockResolvedValue(found), withCorrespondence: jest.fn(async (rows: StatuteRow[]) => rows) };
  const statutes = {
    stored: fetcherOver.stored ?? jest.fn().mockResolvedValue(null),
    fetch: fetcherOver.fetch ?? jest.fn().mockResolvedValue({ row: null, outcome: 'not-found' }),
    replaceAbridged: fetcherOver.replaceAbridged ?? jest.fn().mockResolvedValue(null),
  };
  const rag = new RagService(corpus as never, {} as never, registry as never, guardrails as never, {} as never, statutes as never);
  return { rag, registry, corpus, statutes };
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

  it('answers a named section from itself, never from what merely looks like it', async () => {
    // "Section 377 IPC ka BNS mein equivalent" was answered from IPC 379 and
    // 376, the nearest numbers, as "IPC 377 = BNS 66". A named section the
    // corpus does not hold, and that cannot be fetched, is "not available".
    const { rag, registry } = service([row('144', 'Order for maintenance of wives, children and parents', 'FULLTEXT')]);

    // 300 is inside the BNSS's 531 sections, so this reaches the search.
    const answer = await rag.answer(intent('300'));

    expect(registry.complete).not.toHaveBeenCalled();
    expect(answer.unavailable).toBe(true);
  });

  it('uses everything found for a question that names no section', async () => {
    const { rag, registry } = service([row('144', 'Order for maintenance of wives, children and parents', 'FULLTEXT'), row('146', 'Alteration in allowance', 'FULLTEXT')]);

    await rag.answer(intent(null));
    const system: string = registry.complete.mock.calls[0][0].system;
    expect(system).toContain('BNSS Section 144');
    expect(system).toContain('BNSS Section 146');
  });
});

/**
 * A named provision is answered from its official text - from the corpus, or
 * fetched once from Indian Kanoon - or the reply says it is not available.
 * Never from the model's memory.
 */
describe('a provision the corpus does not hold', () => {
  const NI_138: StatuteRow = {
    ...row('138', 'Dishonour of cheque for insufficiency, etc., of funds in the account', 'EXACT', 'NIA1881-1a2b'),
    act_name: 'The Negotiable Instruments Act, 1881',
    source_url: 'https://indiankanoon.org/doc/1823824/',
  };
  const ni = (over: Partial<ClassifiedIntent> = {}): ClassifiedIntent => ({
    ...intent('138'), actCode: null, actName: 'Negotiable Instruments Act, 1881', rawText: 'section 138 NI Act', ...over,
  });

  it('never looks another Act up in the codes by its number', async () => {
    const { rag, registry, corpus, statutes } = service(
      [row('138', 'Kidnapping or maiming a child for begging', 'EXACT', 'BNS')],
      { fetch: jest.fn().mockResolvedValue({ row: NI_138, outcome: 'stored' }) },
    );

    await rag.answer(ni());
    const system: string = registry.complete.mock.calls[0][0].system;

    expect(corpus.searchStatutes).not.toHaveBeenCalled();
    expect(statutes.fetch).toHaveBeenCalledWith(expect.objectContaining({ actName: 'Negotiable Instruments Act, 1881', number: '138' }));
    expect(system).toContain('Section 138 of The Negotiable Instruments Act, 1881 - Dishonour of cheque');
    expect(system).not.toContain('Kidnapping');
  });

  it('uses a provision fetched earlier without asking Kanoon again', async () => {
    const { rag, statutes } = service([], { stored: jest.fn().mockResolvedValue(NI_138) });

    await rag.answer(ni());
    expect(statutes.fetch).not.toHaveBeenCalled();
  });

  it('says it is not available - with a link, and no model call - when Kanoon does not have it', async () => {
    const { rag, registry } = service([]);

    const answer = await rag.answer(ni());

    expect(registry.complete).not.toHaveBeenCalled();
    expect(answer.unavailable).toBe(true);
    expect(answer.text).toContain(`I don't have the official text of *Section 138 of the Negotiable Instruments Act, 1881*`);
    expect(answer.text).toContain(`won't describe it from memory`);
    expect(answer.text).toContain('https://indiankanoon.org/search/?formInput=section%20138%20negotiable%20instruments%20act');
    // What it cost is said by the channel, which knows (web-fallback.ts); the
    // provision is passed on for the web search.
    expect(answer.text).not.toContain('credits');
    expect(answer.provision).toBe('Section 138 of the Negotiable Instruments Act, 1881');
  });

  it('answers an old-code section from its own text as well as its new counterpart', async () => {
    const IPC_415 = { ...row('415', 'Cheating', 'EXACT', 'IPC'), source_url: 'https://indiankanoon.org/doc/1306824/' };
    const { rag, registry, statutes } = service(
      [{ ...row('318', 'Cheating', 'RECODIFIED', 'BNS'), source_url: 'gazette' }],
      { fetch: jest.fn().mockResolvedValue({ row: IPC_415, outcome: 'stored' }) },
    );

    await rag.answer({ ...intent('415'), actCode: 'IPC' });
    const system: string = registry.complete.mock.calls[0][0].system;

    expect(statutes.fetch).toHaveBeenCalledWith(expect.objectContaining({ actCode: 'IPC', number: '415' }));
    expect(system.indexOf('IPC Section 415')).toBeGreaterThan(-1);
    expect(system.indexOf('IPC Section 415')).toBeLessThan(system.indexOf('BNS Section 318'));
  });

  it('replaces an abridged seed with the official text, and labels one it could not replace', async () => {
    const abridged = { ...row('302', 'Punishment for murder', 'EXACT', 'IPC'), source_url: null };

    const replaced = service([abridged], {
      replaceAbridged: jest.fn().mockResolvedValue({ ...abridged, section_text: '302. Whoever commits murder shall be punished with death', source_url: 'kanoon' }),
    });
    await replaced.rag.answer({ ...intent('302'), actCode: 'IPC' });
    const official: string = replaced.registry.complete.mock.calls[0][0].system;
    expect(official).toContain('302. Whoever commits murder shall be punished with death');
    expect(official).not.toContain('Abridged summary');

    const kept = service([abridged]);
    await kept.rag.answer({ ...intent('302'), actCode: 'IPC' });
    expect(kept.registry.complete.mock.calls[0][0].system).toContain('(Abridged summary, not the enacted wording');
  });

  it('looks a Constitution Article up by its number', async () => {
    const { rag, corpus } = service([{ ...row('21', 'Protection of life and personal liberty', 'EXACT', 'COI'), source_url: 'kanoon' }]);

    await rag.answer({ ...intent('Article 21'), actCode: 'COI' });
    expect(corpus.searchStatutes).toHaveBeenCalledWith(expect.any(String), '21', 'COI', 3);
  });

  it('does not fetch a section of a code loaded in full', async () => {
    const { rag, statutes } = service([{ ...row('103', 'Punishment for murder', 'EXACT', 'BNS'), source_url: 'gazette' }]);

    await rag.answer({ ...intent('103'), actCode: 'BNS' });
    expect(statutes.fetch).not.toHaveBeenCalled();
  });

  it('says a CPC Order is not available rather than describing it from memory', async () => {
    const { rag, registry, statutes } = service([]);

    const answer = await rag.answer({ ...intent('Order 39 Rule 1'), actCode: 'CPC' });

    expect(statutes.fetch).not.toHaveBeenCalled();
    expect(registry.complete).not.toHaveBeenCalled();
    expect(answer.unavailable).toBe(true);
    expect(answer.text).toContain('Order 39 Rule 1 of the Civil Procedure Code (CPC)');
  });
});
