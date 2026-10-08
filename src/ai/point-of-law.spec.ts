import { PrecedentRow, StatuteRow } from '../database/types';
import { listedCitation } from './citation-match';
import { GuardrailsService } from './guardrails.service';
import { asksForCounterpart, RagService } from './rag.service';

/**
 * A point of law, answered from the leading judgments found on Indian Kanoon
 * and the sections of the codes on its subject (rag.service.ts,
 * answerPointOfLaw).
 *
 * Live test of 8 October 2026: these went to the general prompt and were
 * answered from memory - no case for the 307 compromise question (J-PL-05),
 * "not a punishment" for community service under the BNS (O-10, wrong: BNS
 * 4(f)), "the corpus doesn't cover this" for Section 74 (J-PL-53).
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

function judgment(id: string, case_title: string, date: string, reporter_citations: string[]): PrecedentRow {
  return {
    judgment_id: `kanoon:${id}`,
    case_title,
    neutral_citation: null,
    reporter_citations,
    court_name: 'Supreme Court of India',
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

/** Narinder Singh v. State of Punjab, (2014) 6 SCC 466 - the leading case on quashing a 307 case on settlement. */
const NARINDER_SINGH = judgment('100001', 'Narinder Singh & Ors vs State Of Punjab & Anr', '2014-03-27', ['2014 (6) SCC 466']);
/** IPC 307, as the Gazette prints its title. */
const IPC_307 = statute('IPC', '307', 'Attempt to murder', { correspondence: ['IPC 307 = BNS 109'] });
/** BNS 4: clause (f) is community service - new in the BNS. */
const BNS_4 = statute('BNS', '4', 'Punishments', {
  match_type: 'FULLTEXT',
  score: 40,
  section_text:
    '4. The punishments to which offenders are liable under the provisions of this Sanhita are— (a) Death; (b) Imprisonment for life; ' +
    '(c) Imprisonment, which is of two descriptions, namely:— (1) Rigorous, that is, with hard labour; (2) Simple; (d) Forfeiture of property; ' +
    '(e) Fine; (f) Community Service.',
});

function intent(over: Record<string, unknown>) {
  return { intent: 'GENERAL_LEGAL' as const, language: 'en', cnrNumber: null, sectionNumber: null, actCode: null, actName: null, searchQuery: 'q', rawText: 'q', confidence: 0.9, ...over };
}

function build(opts: { judgments?: PrecedentRow[]; byNumber?: StatuteRow[]; bySubject?: (act: string | null) => StatuteRow[]; model?: string }) {
  const corpus = {
    hasJudgmentChunks: jest.fn().mockResolvedValue(false),
    searchStatutes: jest.fn(async (_q: string, n: string | null, act: string | null) => (n ? opts.byNumber ?? [] : opts.bySubject?.(act) ?? [])),
    statutesCovering: jest.fn().mockResolvedValue([]),
    withCorrespondence: jest.fn(async (rows: StatuteRow[]) => rows),
  };
  const registry = { complete: jest.fn().mockResolvedValue({ text: opts.model ?? 'answer', model: 'gpt-4.1', inputTokens: 1, outputTokens: 1 }) };
  const guardrails = {
    verify: jest.fn(async (text: string, ..._rest: unknown[]) => ({ text, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null })),
  };
  const precedents = { authoritiesFor: jest.fn().mockResolvedValue(opts.judgments ?? []) };
  const rag = new RagService(corpus as never, {} as never, registry as never, guardrails as never, {} as never, {} as never, precedents as never);
  return { rag, registry, guardrails, precedents, corpus };
}

const system = (registry: { complete: jest.Mock }): string => registry.complete.mock.calls[0][0].system;

describe('a point of law', () => {
  it('is answered from the leading judgment found on Kanoon and the section named (J-PL-05)', async () => {
    const { rag, registry, guardrails } = build({
      judgments: [NARINDER_SINGH],
      byNumber: [IPC_307],
      model: 'Yes, in a fit case. *Narinder Singh v. State of Punjab* (2014) 6 SCC 466 sets out when a Section 307 IPC case can be quashed on a settlement.',
    });

    const answer = await rag.answer(
      intent({ sectionNumber: '307', actCode: 'IPC', rawText: 'Can a case under Section 307 IPC be quashed on compromise?' }) as never,
    );

    expect(system(registry)).toContain('JUDGMENTS (each found on Indian Kanoon - the ONLY cases you may name):');
    expect(system(registry)).toContain('[1] Narinder Singh & Ors vs State Of Punjab & Anr\n    Supreme Court of India, 2014\n    Citations: 2014 (6) SCC 466');
    expect(system(registry)).toContain('IPC Section 307 - Attempt to murder');
    // Kanoon's citation is verified by Kanoon, not looked for in the empty corpus.
    expect(guardrails.verify.mock.calls[0][5]).toEqual(['2014 (6) SCC 466']);
    expect(answer.judgments?.map((j) => j.case_title)).toEqual(['Narinder Singh & Ors vs State Of Punjab & Anr']);
  });

  it('is answered from the section of the code on its subject when it names a code (O-10)', async () => {
    const { rag, registry, guardrails } = build({ bySubject: (act) => (act === 'BNS' ? [BNS_4] : []) });

    const answer = await rag.answer(intent({ actCode: 'BNS', rawText: 'Is community service a punishment under the BNS?' }) as never);

    expect(system(registry)).toContain('BNS Section 4 - Punishments');
    expect(system(registry)).toContain('(f) Community Service.');
    expect(system(registry)).toContain('JUDGMENTS (each found on Indian Kanoon - the ONLY cases you may name):\n(none)');
    // Section numbers are checked as the general answer's were: that each exists.
    expect(guardrails.verify.mock.calls[0][4]).toBeUndefined();
    expect(answer.judgments).toBeUndefined();
  });

  it('never gives a section of another Act for the number named (J-PL-53)', async () => {
    const KAILASH_NATH = judgment('100002', 'Kailash Nath Associates vs Delhi Development Authority & Anr', '2015-01-09', ['2015 (4) SCC 136']);
    const { rag, registry } = build({ judgments: [KAILASH_NATH], byNumber: [statute('BNS', '74', 'Assault or criminal force to woman with intent to outrage her modesty')] });

    await rag.answer(
      intent({
        sectionNumber: '74',
        actName: 'Indian Contract Act, 1872',
        rawText: 'Must actual loss be proved to recover liquidated damages under Section 74 of the Contract Act?',
      }) as never,
    );

    expect(system(registry)).toContain('Kailash Nath Associates vs Delhi Development Authority & Anr');
    expect(system(registry)).not.toContain('outrage her modesty');
  });

  it('is answered as before when nothing is found on Kanoon or in the codes', async () => {
    const { rag, registry } = build({});

    await rag.answer(intent({ rawText: 'Is instant triple talaq valid?' }) as never);

    expect(system(registry)).toContain('You have no newly retrieved case law or statutory text for this question.');
  });

  it('is answered as before, from the section named, when nothing is found on Kanoon', async () => {
    const { rag, registry } = build({ byNumber: [IPC_307] });

    await rag.answer(intent({ sectionNumber: '307', actCode: 'IPC', rawText: 'Can a case under Section 307 IPC be quashed on compromise?' }) as never);

    expect(system(registry)).toContain('RETRIEVED PASSAGES (the ONLY case law you may cite):');
    expect(system(registry)).toContain('IPC Section 307 - Attempt to murder');
  });

  it('does not look for judgments when the question only asks where a section went (M-CRPC-034)', async () => {
    const { rag, registry, precedents } = build({ judgments: [NARINDER_SINGH], byNumber: [statute('CRPC', '357', 'Order to pay compensation')] });

    await rag.answer(intent({ sectionNumber: '357', actCode: 'CRPC', rawText: 'Convert CrPC 357 to the new code.' }) as never);

    expect(precedents.authoritiesFor).not.toHaveBeenCalled();
    expect(system(registry)).toContain('RETRIEVED PASSAGES (the ONLY case law you may cite):');
  });

  it('lists under the answer only the judgments it names', async () => {
    const GIAN_SINGH = judgment('100003', 'Gian Singh vs State Of Punjab & Anr', '2012-09-24', ['2012 (10) SCC 303']);
    const { rag } = build({ judgments: [NARINDER_SINGH, GIAN_SINGH], model: 'Yes - *Narinder Singh v. State of Punjab* (2014).' });

    const answer = await rag.answer(intent({ rawText: 'Can a case under Section 307 IPC be quashed on compromise?' }) as never);

    expect(answer.judgments?.map((j) => j.judgment_id)).toEqual(['kanoon:100001']);
  });
});

describe('where a section went, not a point of law', () => {
  it.each([
    ['Convert CrPC 357 to the new code.', true],
    ['IPC 302 ka BNS mein kaunsa section hai?', true],
    ['BNS 316(5) purane IPC mein kaunsa section tha?', true],
    ['What is the BNSS equivalent of CrPC 438?', true],
    ['Can a case under Section 307 IPC be quashed on compromise?', false],
    ['Must actual loss be proved to recover liquidated damages under Section 74 of the Contract Act?', false],
  ])('%p -> %s', (text, expected) => {
    expect(asksForCounterpart(text)).toBe(expected);
  });
});

describe('a citation Kanoon prints on a judgment the model was given', () => {
  const corpus = {
    verifyCitations: jest.fn(async (citations: string[]) => citations.map((citation) => ({ citation, found: false }))),
    verifyStatuteRefs: jest.fn(async (refs: string[]) => refs.map((ref) => ({ ref, found: true }))),
  };
  const guardrails = new GuardrailsService(corpus as never);
  const text = 'Yes. *Shayara Bano v. Union of India* (2017) 9 SCC 1 held instant triple talaq invalid.';

  it('is kept, in the spelling the advocate uses (J-PL-44)', async () => {
    // Live, 8 Oct: "Shayara Bano v. Union of India [unverified]" - the corpus
    // it was looked up in holds no judgments.
    const report = await guardrails.verify(text, [], undefined, [], undefined, ['2017 (9) SCC 1', 'AIR 2017 SUPREME COURT 4609']);
    expect(report.text).toBe(text);
    expect(report.verifiedCitations).toEqual(['(2017) 9 SCC 1']);
    expect(report.removed).toEqual([]);
  });

  it('is struck as before when Kanoon did not print it', async () => {
    const report = await guardrails.verify(text, [], undefined, [], undefined, ['AIR 2017 SUPREME COURT 4609']);
    expect(report.text).toContain('[unverified]');
    expect(report.removed).toEqual(['(2017) 9 SCC 1']);
  });
});

/** Live test of 9 Oct, on release 9fe6aef. */
describe('what the 9 October run showed', () => {
  it('keeps a Kanoon citation the answer copied in an online-report form (J-PL-15, J-PL-51)', async () => {
    // "(AIRONLINE 2020 SC 929)" was read as "2020 SC 929", not found in the
    // corpus, and struck: "Vidya Drolia vs Durga Trading Corporation (AIRONLINE [unverified])".
    const corpus = {
      verifyCitations: jest.fn(async (citations: string[]) => citations.map((citation) => ({ citation, found: false }))),
      verifyStatuteRefs: jest.fn(async (refs: string[]) => refs.map((ref) => ({ ref, found: true }))),
    };
    const text = '*Vidya Drolia vs Durga Trading Corporation* (AIRONLINE 2020 SC 929) sets the test.';
    const report = await new GuardrailsService(corpus as never).verify(text, [], undefined, [], undefined, ['AIRONLINE 2020 SC 929']);
    expect(report.text).toBe(text);
    expect(report.removed).toEqual([]);
  });

  it('matches a citation to a listed one by its whole tail only', () => {
    expect(listedCitation('2020 SC 929', 'AIRONLINE 2020 SC 929')).toBe(true);
    expect(listedCitation('(2014) 2 SCC 1', '2014 (2) SCC 1')).toBe(true);
    expect(listedCitation('2014 SC 1', 'AIR 2014 SC 10')).toBe(false);
    expect(listedCitation('SC 929', 'AIRONLINE 2020 SC 929')).toBe(false);
  });

  it('gives the model the standard reports only, SCC first (Kanoon\'s list for Nilabati Behera, 9 Oct)', async () => {
    const nilabati = judgment('1628260', 'Smt. Nilabati Behera Alias Lalit Behera vs State Of Orissa And Ors', '1993-03-24', [
      '1993 AIR 1960', '1993 SCR (2) 581', 'AIR 1993 SUPREME COURT 1960', '1993 (2) SCC 746', '1993 AIR SCW 2366', '1993 SCC(CRI) 527', '1993 IJR 222',
    ]);
    const { rag, registry } = build({ judgments: [nilabati] });

    await rag.answer(intent({ rawText: 'Compensation for custodial death under Article 32?' }) as never);

    expect(system(registry)).toContain('Citations: 1993 (2) SCC 746; AIR 1993 SUPREME COURT 1960; 1993 SCR (2) 581');
    expect(system(registry)).not.toContain('AIR SCW');
  });

  it('lists a judgment whose Kanoon title has a long respondent (J-PL-19)', async () => {
    const nipun = judgment('100004', 'Nipun Saxena And Anr vs Union Of India Ministry Of Home Affairs And Ors', '2018-12-11', []);
    const { rag } = build({ judgments: [nipun], model: 'No. This principle was reinforced in *Nipun Saxena vs Union Of India* (2018).' });

    const answer = await rag.answer(intent({ rawText: 'Can the media disclose the identity of a rape victim?' }) as never);

    expect(answer.judgments?.map((j) => j.judgment_id)).toEqual(['kanoon:100004']);
  });
});
