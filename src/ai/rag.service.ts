import { Injectable, Optional } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { PrecedentRow, RetrievedChunk, StatuteRow } from '../database/types';
import { extractCaseName, namesCase } from './case-name';
import { DraftReleaser } from './draft-release';
import { EmbeddingService } from './embedding.service';
import { GuardrailsService } from './guardrails.service';
import { asksForCounterpart, asksToDraft, ClassifiedIntent } from './intent.service';
import { NEW_CRIMINAL_CODES, expandQuery, extractStatuteRefs, isHinglish, namedActs, namedOtherAct, topicQuery } from './legal-patterns';
import { Authorities, PrecedentsService } from './precedents.service';
import {
  buildGeneralLegalPrompt,
  buildPointOfLawPrompt,
  buildPrecedentSearchPrompt,
  buildSectionExplanationPrompt,
  buildSmallTalkPrompt,
} from './prompts';
import { nonexistentProvision, OLD_NUMBER_HINT, sectionCountReply } from './provision-range';
import { LlmMessage } from './providers/llm-provider.interface';
import { ProviderRegistry } from './providers/provider.registry';
import { kanoonSearchLink, ProvisionTarget, provisionTarget, StatuteFetcher } from './statute-fetcher';

/**
 * Stages the pipeline actually passes through, in order.
 *
 * Reported to callers that want to show progress. Each one is emitted at the
 * moment the corresponding work begins, so a client rendering them is showing
 * what is happening rather than a decorative animation - which matters because
 * "Searching judgments" appearing while nothing is being searched is a lie the
 * user has no way to detect.
 */
export type RagStage = 'retrieving' | 'generating' | 'verifying';

/**
 * The answer as written so far, its lines checked as the finished answer is
 * checked (draft-release.ts). An empty draft withdraws the one before it.
 */
export interface RagDraft {
  draft: string;
}

/** Optional progress sink. Never awaited; a slow observer must not slow the answer. */
export type RagProgress = (event: RagStage | RagDraft) => void;

export interface RagAnswer {
  text: string;
  citations: string[];
  passages: RetrievedChunk[];
  statutes: StatuteRow[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  guardrailTriggered: boolean;
  guardrailReason: string | null;
  /** True when no provider is configured and the answer is a placeholder. */
  mocked: boolean;
  /**
   * The provision asked about has no official text here - not in the corpus,
   * not on Indian Kanoon - and the reply says so instead of answering from
   * memory. Nothing was delivered, so the channel refunds the charge.
   */
  unavailable?: boolean;
  /** With `unavailable`: the provision asked about, as the reply names it - "Section 2 of the Companies Act, 2013". */
  provision?: string;
  /**
   * A fixed reply that delivers no research: a question back ("IPC 302 or BNS
   * 302?"), or "none of the sections answers this". Refunded by the channel,
   * and never sent to the web search - there is nothing to look for.
   */
  free?: boolean;
  /**
   * The judgments found on Indian Kanoon that the answer names, for listing
   * under it with their links (answerPointOfLaw). Only ones it names.
   */
  judgments?: PrecedentRow[];
}

/**
 * The retrieval-augmented generation pipeline (spec section 9.1).
 *
 *   query
 *     -> expansion (synonyms)
 *     -> parallel: dense (pgvector) + lexical (tsvector)
 *     -> RRF fusion, in SQL
 *     -> prompt assembly with anti-hallucination rules
 *     -> generation
 *     -> citation verification
 *
 * Two deviations from the spec, both deliberate and both documented in the
 * README: fusion and retrieval happen inside Postgres rather than in Qdrant and
 * Elasticsearch, and there is no cross-encoder re-ranking stage. RRF over a
 * 50+50 candidate pool is a large fraction of the quality of a re-ranker at
 * none of the latency or infrastructure cost; a re-ranker is the obvious next
 * upgrade once there is real traffic to measure it against.
 */
@Injectable()
export class RagService {
  private readonly logger = getLogger().child({ module: 'rag' });

  constructor(
    private readonly corpus: CorpusRepository,
    private readonly embeddings: EmbeddingService,
    private readonly registry: ProviderRegistry,
    private readonly guardrails: GuardrailsService,
    @InjectEnv() private readonly env: AppEnv,
    private readonly statutes: StatuteFetcher,
    /** For the leading judgments on a point of law (answerPointOfLaw). Absent, that answer is the general one. */
    @Optional() private readonly precedents?: PrecedentsService,
  ) {}

  /** When the judgment corpus was last found to be empty or not - read again every CORPUS_CHECK_MS. */
  private corpusChecked: { searchable: boolean; at: number } | null = null;

  /**
   * Whether the ingested judgment corpus has anything in it. Remembered for
   * CORPUS_CHECK_MS, so an ingest is picked up within minutes; when the check
   * itself fails the search runs, as it always did.
   */
  private async corpusSearchable(): Promise<boolean> {
    if (this.corpusChecked && Date.now() - this.corpusChecked.at < CORPUS_CHECK_MS) return this.corpusChecked.searchable;
    try {
      const searchable = await this.corpus.hasJudgmentChunks();
      this.corpusChecked = { searchable, at: Date.now() };
      return searchable;
    } catch {
      return true;
    }
  }

  /** Statute explanation. No case law retrieval; the acts table is authority enough. */
  async answerSectionLookup(
    intent: ClassifiedIntent,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
  ): Promise<RagAnswer> {
    const started = Date.now();

    // A bare number both penal codes use for different offences, with no code
    // named: asked back, free (ambiguousNumber).
    const ambiguous = await this.ambiguousNumber(intent, history, started);
    if (ambiguous) return ambiguous;

    // A number past the end of its Act has a certain answer, and it is not
    // one to hand to a model told to stop when it is unsure.
    const impossible = nonexistentProvision(intent.actCode, intent.sectionNumber);
    if (impossible) {
      // "BNS 498A" does not exist; IPC 498A does, and the table says where it went.
      const mapping = await this.oldCodeMapping(intent);
      const text = mapping ? `${impossible.replace(`\n\n${OLD_NUMBER_HINT}`, '')}\n\n${mapping}` : impossible;
      // Free: a fixed reply from the Act's length, not research. "FIR is under
      // BNS 498A", "IPC 512 kya hai?" and "Section 490 of the CrPC" were each
      // charged two credits for it (client's audit, 9 Oct, T-08, T-15, T-16).
      return { ...fixedAnswer(text, 'rule:provision-range', started), free: true };
    }

    const target = provisionTarget(intent);
    onStage?.('retrieving');

    /*
     * An Act outside the loaded codes, named by the advocate: its number is
     * never looked up in the codes. "Section 138 NI Act" found BNS 138, BNSS
     * 138 and BSA 138 by number alone - three sections of the wrong laws.
     */
    if (!intent.actCode && intent.actName && intent.sectionNumber) {
      const official = target ? ((await this.statutes.stored(target)) ?? (await this.statutes.fetch(target)).row) : null;
      if (!official) return unavailableAnswer(intent, target, started);
      return this.explain([official], intent, started, history, onStage);
    }

    // The Constitution's rows are keyed "21", not "Article 21".
    const searchNumber = intent.actCode === 'COI' && target ? target.number : intent.sectionNumber;
    const found = intent.sectionNumber
      ? await this.corpus.searchStatutes(intent.searchQuery, searchNumber, intent.actCode, 3)
      : await this.onSubject(intent);

    // When the named provision itself was found, the model gets that provision,
    // its sub-sections and its official counterparts - not its neighbours by
    // spelling. With the full Acts loaded, "BNSS 520" also matched BNSS 52 by
    // number similarity (examination of a person accused of rape), which can
    // only distract an answer about trials before High Courts.
    const named = intent.sectionNumber ? found.filter((s) => s.match_type === 'EXACT' || s.match_type === 'RECODIFIED') : [];
    /*
     * A named section is answered from itself and its official counterparts,
     * or not at all - never from sections that merely look like it. "Section
     * 377 IPC ka BNS mein equivalent" fell back to IPC 379 and IPC 376, the
     * nearest numbers, and the model wrote "IPC 377 = BNS 66" from them: BNS 66
     * is death caused in the course of rape, and IPC 377 has no BNS
     * counterpart at all.
     */
    let statutes = intent.sectionNumber ? named : found;

    /*
     * The provision asked about, in its own enacted words. "IPC 415" was
     * answered from BNS 318 alone, through the correspondence; "IPC 302" from
     * 0006's abridged summary. The official text is fetched once and kept.
     */
    if (target && intent.actCode) {
      const whole = statutes.find((s) => s.act_code.toUpperCase() === intent.actCode && s.section_number.toUpperCase() === target.number);
      if (!whole) {
        const fetched = (await this.statutes.fetch(target)).row;
        if (fetched) {
          // With its official counterparts, so "none listed" can be told from "not looked up".
          const [official] = await this.corpus.withCorrespondence([fetched]);
          statutes = [official ?? fetched, ...statutes.filter((s) => s.id !== fetched.id)];
        }
      } else if (whole.source_url === null) {
        const replaced = await this.statutes.replaceAbridged(whole, target);
        if (replaced) statutes = statutes.map((s) => (s.id === whole.id ? replaced : s));
      }
    }

    /*
     * The number of one code with the subject of another: "BNS 302 murder ki
     * saza" - BNS 302 is wounding religious feelings; murder was IPC 302 and is
     * BNS 103(1). See numberCollision.
     */
    const collision = await this.numberCollision(intent, statutes);
    if (collision) {
      /*
       * Only the section the subject belongs to goes to the model. Handed BNS
       * 302 beside BNS 103, it wrote the right line above the answer - "BNS
       * 302 is ... The section on what you asked about is BNS 103" - and then
       * explained BNS 302, wounding religious feelings, under all four
       * headings; BNS 323 the same for hurt (live test, 8 Oct, T-01, T-04).
       * What the number named is said by that line, from the table.
       */
      statutes = collision.rows;
    }

    // An old section the table maps to nothing: what the new code has that is
    // close, labelled as not a counterpart (relatedProvisions).
    statutes = [...statutes, ...(await this.relatedProvisions(intent, statutes))];

    if (statutes.length === 0) {
      /*
       * Nothing official for a provision the advocate named. This used to be
       * answered from the model's memory under a "not verified" line, and that
       * is how "Section 520 BNSS" became disposal of property pending appeal.
       * A named provision is now answered from its text or not at all.
       */
      if (describeProvision(intent)) {
        // An old-code section with no counterpart in the official table: that
        // much is known from the table, text or no text.
        const noCounterpart =
          !!intent.actCode && intent.actCode in NEW_CODE_FOR && !found.some((s) => s.match_type === 'RECODIFIED');
        return unavailableAnswer(intent, target, started, noCounterpart);
      }

      // No provision named either - a general legal question, answered as one.
      return this.answerGeneral(intent, started, history, onStage);
    }

    return this.explain(statutes, intent, started, history, onStage, collision ?? undefined);
  }

  /**
   * "What is the punishment under Section 302?", "धारा 307 की सजा क्या है?" -
   * no code named, and the number is two different offences: IPC 302 is
   * murder (now BNS 103(1)), BNS 302 is wounding religious feelings.
   *
   * Both were answered about the BNS section alone, with nothing to say the
   * advocate probably meant the other (live tests of 4 and 7 October, T-18,
   * T-17). The answer is a question back with both meanings, read off the
   * official table, and it costs nothing.
   *
   * Only for the penal codes, only when the question is about an offence
   * (PENAL_WORDS), and only when no code is named in it or in the turns before
   * it. A number the BNS does not have is left to the rule that reads it as
   * the IPC's (intent.service.ts).
   */
  private async ambiguousNumber(intent: ClassifiedIntent, history: LlmMessage[], started: number): Promise<RagAnswer | null> {
    const n = intent.sectionNumber?.trim().toUpperCase() ?? '';
    if (!/^\d+[A-Z]?$/.test(n) || intent.actName) return null;
    if (namedActs(intent.rawText).size > 0 || namedOtherAct(intent.rawText)) return null;
    if (history.some((turn) => namedActs(turn.content).size > 0)) return null;
    if (!PENAL_WORDS.test(intent.rawText) || nonexistentProvision('BNS', n)) return null;

    const [wasIpc, bnsRows] = await Promise.all([
      this.corpus.recodifiedFrom('IPC', n),
      this.corpus.searchStatutes(intent.searchQuery, n, 'BNS', 3),
    ]);
    const bns = bnsRows.find((r) => r.act_code.toUpperCase() === 'BNS' && baseOf(r.section_number) === n);
    if (!bns || wasIpc.length === 0) return null;
    // IPC N became BNS N itself: one offence, nothing to ask.
    if (wasIpc.every((r) => baseOf(r.section_number) === n)) return null;

    const now = wasIpc.map((r) => `*${r.mapped_to}* - ${r.section_title}`).join(' and ');
    const hindi = /[ऀ-ॿ]/.test(intent.rawText);
    const text = hindi
      ? [
          `*धारा ${n}* - आपने संहिता नहीं बताई, और इस संख्या के दो अलग अर्थ हैं:`,
          `• *IPC ${n}* (1 जुलाई 2024 से पहले के अपराध) अब ${now} है।`,
          `• *BNS ${n}* - ${bns.section_title}`,
          `संहिता के साथ फिर पूछें - *IPC ${n}* या *BNS ${n}*।`,
        ].join('\n\n')
      : [
          `*Section ${n}* - you have not said which code, and the number is two different provisions:`,
          `• *IPC ${n}* (offences before 1 July 2024) is now ${now}.`,
          `• *BNS ${n}* - ${bns.section_title}`,
          `Ask again with the code - *IPC ${n}* or *BNS ${n}* - and I will explain it.`,
        ].join('\n\n');
    return { ...fixedAnswer(text, 'rule:ambiguous-number', started), free: true };
  }

  /**
   * For a new-code number that does not exist: where the same old-code number
   * went. "FIR is under BNS 498A" was answered "Section 498 of the BNS does not
   * exist" and nothing more (live test, 7 Oct, T-08); the advocate needed
   * "IPC 498A is BNS 85 and 86".
   */
  private async oldCodeMapping(intent: ClassifiedIntent): Promise<string | null> {
    const old = intent.actCode ? OLD_CODE_FOR[intent.actCode] : undefined;
    const n = intent.sectionNumber?.trim().toUpperCase();
    if (!old || !n || nonexistentProvision(old, n)) return null;
    const rows = await this.corpus.recodifiedFrom(old, n);
    if (rows.length === 0) return null;
    const label = old === 'CRPC' ? 'CrPC' : old;
    return `If you mean *${label} ${n}*, the official 2023 correspondence table maps it to ${rows
      .map((r) => `*${r.mapped_to}* (${r.section_title})`)
      .join(' and ')}.`;
  }

  /**
   * A new-code section named with the subject of the old code's section of
   * the same number - the trap the recodification set.
   *
   * "BNS 302 murder ki saza kya hai?" was answered about BNS 302 (wounding
   * religious feelings) and ended "murder is under a different provision" -
   * without naming it. "BNS 323 mein hurt ki saza" asked the advocate to supply
   * the section; "criminal conspiracy under BNS 120" was "not covered" (live
   * tests, T-01, T-04, T-12). Each time the old code's section of that number
   * - or a lettered one beside it, IPC 120A and 120B - is the subject asked
   * about, and the official table says where it went.
   *
   * Fires only when a subject word of the question is not in the title of the
   * section named, and is in the title of what the old number became. "BNS 316 ... bail" does not fire: IPC 316's section is not about
   * bail. The answer then opens with a fixed line saying both things, and is
   * written about the section the subject belongs to.
   */
  private async numberCollision(
    intent: ClassifiedIntent,
    statutes: StatuteRow[],
  ): Promise<{ rows: StatuteRow[]; lead: string; asked: string } | null> {
    const act = intent.actCode;
    const old = act ? OLD_CODE_FOR[act] : undefined;
    const n = intent.sectionNumber?.trim().toUpperCase() ?? '';
    if (!act || !old || !/^\d+$/.test(n)) return null;

    const named = statutes.find((s) => s.act_code.toUpperCase() === act && baseOf(s.section_number) === n);
    if (!named) return null;
    const words = subjectWords(intent.rawText);
    if (words.length === 0) return null;
    /*
     * The named section's title only, not its text. "What is the punishment
     * under BNS 307 for attempt to murder?" found "attempt" in BNS 307's
     * illustration ("should attempt to apprehend A"), stood down, and the reply
     * was "the corpus does not cover BNS 307", charged (client's audit, 9 Oct,
     * T-02). BNS 307 is theft after preparation; attempt to murder is BNS 109.
     */
    const own = named.section_title.toLowerCase();
    if (words.some((word) => own.includes(stem(word)))) return null;

    const became = (await this.corpus.recodifiedFrom(old, n, true)).filter((r) => words.some((word) => titleHas(r, word)));
    if (became.length === 0) return null;

    // One entry per section, with every old section that went into it.
    const sections = new Map<string, { row: StatuteRow; from: string[] }>();
    for (const row of became) {
      const entry = sections.get(row.id) ?? { row, from: [] };
      const whole = `${row.act_code} ${baseOf(row.section_number)}`;
      entry.from.push(row.mapped_to && row.mapped_to !== whole ? `${row.mapped_from} (now ${row.mapped_to})` : `${row.mapped_from}`);
      sections.set(row.id, entry);
    }
    const listed = [...sections.values()];
    const label = `${act} ${n}`;
    const lead =
      `*${label}* is "${named.section_title}". The section on what you asked about is ` +
      listed.map(({ row, from }) => `*${row.act_code} ${baseOf(row.section_number)}* ("${row.section_title}"), formerly ${from.join(' and ')}`).join('; ') +
      '.';
    const first = listed[0].row;
    const answerAbout = `${first.act_code} Section ${baseOf(first.section_number)}`;
    return {
      rows: listed.map(({ row }) => row),
      lead,
      asked:
        `${answerAbout}* - the advocate wrote ${label}, which is a different provision ("${named.section_title}"). ` +
        `A line saying so is already printed above your answer: do not repeat it, and do not explain ${label}. ` +
        `Explain *${answerAbout}`,
    };
  }

  /**
   * An old-code section the official table maps to nothing, and a new-code
   * section on the same subject.
   *
   * "IPC 309 attempt to suicide ka BNS mein kya hua?" was answered "no
   * equivalent" - true of the table, and incomplete: BNS 226 punishes an
   * attempt at suicide made to compel or restrain a public servant (live test,
   * 4 Oct, O-02). The new code is searched for the words of the old section's
   * title, and what it finds is given to the model marked as related, not a
   * counterpart (formatStatutes).
   */
  private async relatedProvisions(intent: ClassifiedIntent, statutes: StatuteRow[]): Promise<StatuteRow[]> {
    const act = intent.actCode;
    const newCode = act ? NEW_CODE_FOR[act] : undefined;
    const n = intent.sectionNumber?.trim().toUpperCase() ?? '';
    if (!act || !newCode || !n) return [];
    const asked = statutes.find((s) => s.act_code.toUpperCase() === act && baseOf(s.section_number) === baseOf(n));
    if (!asked || !Array.isArray(asked.correspondence) || asked.correspondence.length > 0) return [];

    // Words of the title that are a subject: IPC 143's title is just
    // "Punishment", which every other section's title also has.
    const words = subjectWords(asked.section_title ?? '').filter((w) => w.length >= 4);
    if (words.length === 0) return [];
    const found = await this.corpus.searchStatutes(words.join(' '), null, newCode, 3);
    const label = `${act === 'CRPC' ? 'CrPC' : act} ${n}`;
    return found
      .filter((row) => row.act_code.toUpperCase() === newCode && words.filter((w) => titleHas(row, w)).length >= Math.ceil(words.length / 2))
      .slice(0, 2)
      .map((row) => ({ ...row, related_to: label }));
  }

  /**
   * The provisions on the subject of a question that names no section: "what
   * is the BNS section for organised crime", "bail ke liye kaunsi section".
   *
   * Searched by the words the provision would contain (topicQuery), in all
   * three new criminal codes when any of the six was named, and only the
   * provisions close to the best match are kept - a section that mentions bail
   * once is not an answer about bail.
   */
  private async onSubject(intent: ClassifiedIntent): Promise<StatuteRow[]> {
    const query = topicQuery(intent.searchQuery) || topicQuery(intent.rawText);
    if (!query) return [];
    const criminal = intent.actCode !== null && (intent.actCode in NEW_CODE_FOR || NEW_CRIMINAL_CODES.includes(intent.actCode));
    const acts: (string | null)[] = criminal ? [...new Set([...NEW_CRIMINAL_CODES, intent.actCode])] : [intent.actCode];
    const rows = (await Promise.all(acts.map((act) => this.corpus.searchStatutes(query, null, act, 4)))).flat();
    const exact = closestToBest(rows);
    const words = query.split(' ');

    // Every word in a section whose title carries one of them is the answer.
    // Every word somewhere in a long text is not: "theft ... bail" matched
    // only BNSS 401 (release on probation), which mentions both in passing.
    if (exact.some((row) => words.some((word) => titleHas(row, word))) || words.length < 2) return exact;

    // Otherwise the sections with the most of the words, title first.
    const named = acts.filter((act): act is string => act !== null);
    const covered = mostCovered(await this.corpus.statutesCovering(words, named.length === acts.length ? named : null), words);
    return covered.length > 0 ? covered : exact;
  }

  private explain(
    statutes: StatuteRow[],
    intent: ClassifiedIntent,
    started: number,
    history: LlmMessage[],
    onStage?: RagProgress,
    /** From numberCollision: the provision to explain instead, and the line said above the answer. */
    instead?: { asked: string; lead: string },
  ): Promise<RagAnswer> {
    const system = buildSectionExplanationPrompt(statutes, replyLanguage(intent), instead?.asked ?? describeProvision(intent));
    return this.generate(system, intent, [], statutes, started, history, onStage, { lead: instead?.lead, given: statutes, subjectOnly: !intent.sectionNumber });
  }

  /** Case law research over the judgment corpus. */
  async answerPrecedentSearch(
    intent: ClassifiedIntent,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
  ): Promise<RagAnswer> {
    const started = Date.now();

    onStage?.('retrieving');
    const expanded = expandQuery(intent.searchQuery);

    // Nothing ingested to search: the dense and lexical search can only come
    // back empty, and the question's embedding alone took most of 1.4 s of a
    // general answer (latency baseline of 4 October). Judgments come from
    // Indian Kanoon, not from here, so the answer is exactly what it was.
    const searchable = await this.corpusSearchable();
    const embedding = searchable ? await this.embeddings.embedQuery(expanded) : null;
    const passages = searchable
      ? await this.corpus.hybridSearch({
          queryText: expanded,
          embedding,
          denseK: this.env.RAG_DENSE_TOP_K,
          sparseK: this.env.RAG_SPARSE_TOP_K,
          rrfK: this.env.RAG_RRF_K,
          finalK: this.env.RAG_FINAL_TOP_K,
          sections: intent.sectionNumber && intent.actCode ? [`${intent.actCode} ${intent.sectionNumber}`] : null,
        })
      : [];

    // Drop weak fusion scores. A passage that only just cleared the threshold
    // adds tokens and tempts the model to cite something barely relevant.
    const relevant = passages.filter((p) => p.score >= this.env.RAG_MIN_RELEVANCE);

    // If a section was named, include it - "bail under 437" needs both the
    // provision and the case law.
    const statutes = intent.sectionNumber
      ? await this.corpus.searchStatutes(intent.searchQuery, intent.sectionNumber, intent.actCode, 2)
      : [];

    this.logger.debug(
      {
        retrieved: passages.length,
        keptAfterThreshold: relevant.length,
        dense: Boolean(embedding),
        topScore: passages[0]?.score,
      },
      'Hybrid retrieval complete',
    );

    // A point of law, unless it only asks where a section went - "Convert CrPC
    // 357 to the new code" is answered from the table, as it always was. A
    // court document asked to be drafted is answered the same way, with what
    // it would rest on (intent.service.ts, asksToDraft).
    const drafting = intent.intent === 'DRAFTING_HELP' || asksToDraft(intent.rawText);
    if (relevant.length === 0 && (drafting || (intent.intent === 'GENERAL_LEGAL' && !(statutes.length > 0 && asksForCounterpart(intent.rawText))))) {
      return this.answerPointOfLaw(intent, started, history, onStage, statutes, drafting);
    }

    if (relevant.length === 0 && statutes.length === 0) {
      return this.answerGeneral(intent, started, history, onStage);
    }

    const system = buildPrecedentSearchPrompt(relevant, statutes, intent.language);
    return this.generate(system, intent, relevant, statutes, started, history, onStage);
  }

  /**
   * A point of law - "can a 307 case be quashed on compromise", "is community
   * service a punishment under the BNS" - answered from the leading judgments
   * found on Indian Kanoon and, when the question names one of the codes, the
   * sections of the codes on its subject.
   *
   * These went to the general prompt, which has neither and answered from
   * memory: no case for the 307 question (Narinder Singh), "not a punishment"
   * for community service (BNS 4(f) says it is), "the corpus doesn't cover
   * this" for liquidated damages (Kailash Nath) - each for two credits (live
   * test, 8 Oct, J-PL-05, O-10, J-PL-53; client's audit, gaps 1 and 2).
   *
   * The judgments are named by the model and each one found on Kanoon by title
   * and year (precedents.service.ts, authoritiesFor); the prompt allows no
   * other case. With neither judgments nor sections found, the answer is the
   * general one, exactly as before.
   */
  private async answerPointOfLaw(
    intent: ClassifiedIntent,
    started: number,
    history: LlmMessage[],
    onStage?: RagProgress,
    /** The section the question named, as looked up by number (answerPrecedentSearch). */
    sectionRows: StatuteRow[] = [],
    /** A court document was asked for: never drafted, answered with what it would rest on. */
    drafting = false,
  ): Promise<RagAnswer> {
    onStage?.('retrieving');
    /*
     * The named section itself, of the Act named - never a section of the
     * same number in another Act. "Section 74 of the Contract Act" was looked
     * up as sections numbered 74 of the codes, and answered "the corpus doesn't
     * cover this" (live test, 8 Oct, J-PL-53).
     */
    const otherAct = !intent.actCode && !!intent.actName && !!intent.sectionNumber;
    const named = sectionRows.filter(
      (s) =>
        (s.match_type === 'EXACT' || s.match_type === 'RECODIFIED') &&
        (intent.actCode ? true : !!intent.actName && sameAct(s.act_name, intent.actName)),
    );
    const none: Authorities = { judgments: [], overruled: [] };
    const [{ judgments, overruled }, onSubject, fetched] = await Promise.all([
      this.precedents ? this.precedents.authoritiesFor(intent).catch(() => none) : Promise.resolve(none),
      sectionRows.length > 0 || otherAct ? Promise.resolve([] as StatuteRow[]) : this.codesOnSubject(intent).catch(() => [] as StatuteRow[]),
      // A section of an Act outside the codes - "Section 138 NI Act" - in its
      // official text, as a section lookup gets it. Looked up by number in the
      // codes it found BSA 138 and IEA 138, and the answer was "the corpus
      // doesn't cover this", for two credits (client's audit, 9 Oct, J-PL-40).
      otherAct && named.length === 0 ? this.otherActSection(intent).catch(() => null) : Promise.resolve(null),
    ]);
    const ofTheAct = fetched ? [fetched] : named;

    // No judgment found on Kanoon: a question that named a section of the
    // codes is answered as before, from that section.
    if (judgments.length === 0 && ofTheAct.length > 0 && !otherAct && !drafting) {
      return this.generate(buildPrecedentSearchPrompt([], ofTheAct, intent.language), intent, [], ofTheAct, started, history, onStage);
    }
    const statutes = sectionRows.length > 0 || otherAct ? ofTheAct : onSubject;
    if (judgments.length === 0 && statutes.length === 0 && !drafting) return this.answerGeneral(intent, started, history, onStage);

    const system = buildPointOfLawPrompt(judgments, statutes, replyLanguage(intent), overruled, drafting);
    // Section numbers are checked as the general answer's always were - that
    // each exists - and not against what was given: a quashing answer that
    // names CrPC 482 beside Narinder Singh is right, and would be struck.
    const answer = await this.generate(system, intent, [], statutes, started, history, onStage, {
      confirmed: judgments.flatMap((j) => [j.neutral_citation, ...(j.reporter_citations ?? [])].filter((c): c is string => !!c)),
    });
    // Listed under the answer only when it names them. A Kanoon title with a
    // long respondent - "Nipun Saxena And Anr vs Union Of India Ministry Of
    // Home Affairs And Ors" - is no cause title to extractCaseName, so it is
    // split at "vs" instead.
    const cited = judgments.filter((j) => {
      const [petitioner, respondent = ''] = j.case_title.split(/\s+vs?\.?\s+/i);
      const name = extractCaseName(j.case_title) ?? (petitioner ? { petitioner, respondent } : null);
      return name !== null && namesCase(name, answer.text);
    });
    return cited.length > 0 ? { ...answer, judgments: cited } : answer;
  }

  /** The official text of a section of an Act outside the codes, stored or fetched once from Kanoon (StatuteFetcher). */
  private async otherActSection(intent: ClassifiedIntent): Promise<StatuteRow | null> {
    const target = provisionTarget(intent);
    if (!target) return null;
    return (await this.statutes.stored(target)) ?? (await this.statutes.fetch(target)).row;
  }

  /**
   * The sections on a question's subject, when it names one of the six codes:
   * "community service ... under the BNS" finds BNS 4, whose clause (f) is
   * community service. A question that names none is not searched - the codes
   * are not where a contract or consumer question is answered.
   */
  private async codesOnSubject(intent: ClassifiedIntent): Promise<StatuteRow[]> {
    const codes = ['IPC', 'BNS', 'CRPC', 'BNSS', 'IEA', 'BSA'];
    /*
     * A criminal-law question that names no code is searched in the three new
     * ones. "Can police arrest a 65-year-old for an offence punishable with 2
     * years without any permission?" named none, was answered from memory, and
     * missed the one rule it is about - BNSS 35(7) (client's audit, 9 Oct, N-03).
     */
    const named =
      (intent.actCode && codes.includes(intent.actCode) ? intent.actCode : [...namedActs(intent.rawText)].find((act) => codes.includes(act))) ??
      (CRIMINAL_TOPIC.test(intent.rawText) && !namedOtherAct(intent.rawText) ? 'BNSS' : undefined);
    if (!named) return [];
    const rows = await this.onSubject({ ...intent, actCode: named as ClassifiedIntent['actCode'] });
    return rows.length > 0 ? this.corpus.withCorrespondence(rows) : rows;
  }

  /** No corpus support available; the prompt bars citing anything. */
  async answerGeneral(
    intent: ClassifiedIntent,
    startedAt?: number,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
  ): Promise<RagAnswer> {
    const started = startedAt ?? Date.now();
    const system = buildGeneralLegalPrompt(replyLanguage(intent));
    return this.generate(system, intent, [], [], started, history, onStage);
  }

  /**
   * Greetings, thanks and "what can you do".
   *
   * Runs on the cheap router model, not the synthesis one - this is a
   * pleasantry, and paying synthesis rates for "hi" on every new user would be
   * a meaningful share of the bill.
   *
   * History is passed so a second "hi" in the same conversation does not get
   * the identical sentence back, which is what made the bot feel like a phone
   * tree. If the call fails the caller falls back to a fixed string; a greeting
   * is never worth failing a message over.
   */
  async answerSmallTalk(
    userMessage: string,
    language: string,
    userName: string | null,
    history: LlmMessage[] = [],
  ): Promise<string> {
    const result = await this.registry.complete({
      task: 'router',
      system: buildSmallTalkPrompt(language, userName),
      messages: [...history.slice(-4), { role: 'user', content: userMessage }],
      maxTokens: 300,
    });
    return result.text.trim();
  }

  /** Dispatch on intent. CASE_STATUS is handled upstream by the eCourts adapter. */
  async answer(
    intent: ClassifiedIntent,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
  ): Promise<RagAnswer> {
    // How many sections a code has is read off the code, not asked of a model (provision-range.ts).
    const counts = sectionCountReply(intent.rawText, namedActs(intent.rawText));
    if (counts) return fixedAnswer(counts, 'rule:section-count', Date.now());

    switch (intent.intent) {
      case 'SECTION_LOOKUP':
        return this.answerSectionLookup(intent, history, onStage);
      case 'PRECEDENT_SEARCH':
        return this.answerPrecedentSearch(intent, history, onStage);
      case 'DRAFTING_HELP':
      case 'GENERAL_LEGAL':
      default:
        // Drafting benefits from precedent context too, so route it through
        // retrieval rather than answering from nothing.
        return this.answerPrecedentSearch(intent, history, onStage);
    }
  }

  private async generate(
    system: string,
    intent: ClassifiedIntent,
    passages: RetrievedChunk[],
    statutes: StatuteRow[],
    startedAt: number,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
    opts: {
      /** A fixed line printed above the model's answer, in drafts and in the answer (numberCollision). */
      lead?: string;
      /** The provisions the model was given - checked against what it wrote (GuardrailsService). */
      given?: StatuteRow[];
      /** A subject question: the model may answer NOT_COVERED (prompts.ts). */
      subjectOnly?: boolean;
      /** Citations Kanoon prints on the judgments the model was given - verified by that (GuardrailsService). */
      confirmed?: string[];
    } = {},
  ): Promise<RagAnswer> {
    const lead = opts.lead ? `${opts.lead}\n\n` : '';
    onStage?.('generating');
    const generating = Date.now();
    const request = {
      task: 'synthesis' as const,
      system,
      // Prior turns first, then the current question. History is already
      // trimmed and isolated per advocate by ChatMemoryService.
      messages: [...history, { role: 'user' as const, content: intent.rawText }],
    };

    // With someone watching, the lines are shown as they are written - each one
    // only once every reference in it has passed the same check the finished
    // answer gets (draft-release.ts). The request is the same either way.
    let firstDraftAt: number | null = null;
    const drafts = onStage
      ? new DraftReleaser(
          (prefix, known) => this.guardrails.verifiedDraft(prefix, intent, known, opts.given, history, opts.confirmed),
          (draft) => {
            firstDraftAt ??= Date.now();
            onStage({ draft: draft ? `${lead}${draft}` : draft });
          },
        )
      : null;
    let result = drafts
      ? await this.registry.completeStreaming(request, (written) => drafts.offer(written))
      : await this.registry.complete(request);
    await drafts?.close();

    /*
     * Written in the question's language, or written once more.
     *
     * "Reply in Hinglish" is in the prompt, and the model ignored it on about
     * half the Hinglish questions - 12 of 25 - and on some Hindi ones (client's
     * audit, 9 Oct, pattern I: M-IPC-001, M-IPC-019, B-09). The draft shown so
     * far is withdrawn and the answer asked for again, plainly; if that is no
     * better, the first stands.
     */
    const wanted = replyLanguage(intent);
    if (!result.mocked && !/^\s*NOT_COVERED\b/.test(result.text) && wrongLanguage(wanted, result.text)) {
      onStage?.({ draft: '' });
      const again = await this.registry
        .complete({ ...request, system: `${system}\n\n${LANGUAGE_AGAIN[wanted] ?? ''}` })
        .catch(() => null);
      this.logger.info({ wanted, retried: true, fixed: !!again && !wrongLanguage(wanted, again.text) }, 'Answer written in the wrong language');
      if (again && !wrongLanguage(wanted, again.text)) {
        result = { ...again, inputTokens: result.inputTokens + again.inputTokens, outputTokens: result.outputTokens + again.outputTokens };
      }
    }

    // Every generated answer passes through verification before anyone sees it.
    onStage?.('verifying');
    const verifying = Date.now();
    const checked = opts.confirmed
      ? await this.guardrails.verify(result.text, passages, intent, history, opts.given, opts.confirmed)
      : await this.guardrails.verify(result.text, passages, intent, history, opts.given);
    this.logger.info(
      {
        intent: intent.intent,
        ms: Date.now() - startedAt,
        retrieveMs: generating - startedAt,
        writeMs: verifying - generating,
        // When the advocate first saw a line of it, from when writing began.
        firstDraftMs: firstDraftAt === null ? undefined : firstDraftAt - generating,
        checkMs: Date.now() - verifying,
        outputTokens: result.outputTokens,
      },
      'Answer timings',
    );

    /*
     * None of the provisions found answers a subject question. The model was
     * told to say only NOT_COVERED (prompts.ts), and the reply is fixed and
     * free: "Corpus mein hit and run ke liye koi specific section nahi mil raha"
     * and "The corpus doesn't cover that BSA section" were each charged two
     * credits (live test, 7 Oct, O-04, N-12).
     */
    if (opts.subjectOnly && /^\s*NOT_COVERED\b/.test(checked.text)) {
      return { ...fixedAnswer(notCoveredReply(intent), 'rule:not-covered', startedAt), statutes: [], free: true };
    }

    return {
      text: `${lead}${withoutPromptEcho(checked.text)}`,
      citations: checked.verifiedCitations,
      passages,
      statutes,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - startedAt,
      guardrailTriggered: checked.triggered,
      guardrailReason: checked.reason,
      mocked: result.mocked === true,
      // A written answer that delivers nothing - "The corpus doesn't cover the
      // limitation period ..." - is free, as the fixed non-answers are
      // (client's audit, 9 Oct, J-PL-40). Not when a line above it delivers
      // something (the number-trap lead).
      ...(!lead && isNonAnswer(checked.text) ? { free: true } : {}),
    };
  }
}

/**
 * An answer that says it has no answer, and little else: it opens by saying
 * the material does not cover the question, and is short.
 */
export function isNonAnswer(text: string): boolean {
  const t = text.trim();
  return (
    t.length < 400 &&
    /^(?:Unfortunately,?\s+)?(?:the\s+(?:corpus|provided\s+material|material\s+(?:provided|above))\s+(?:does\s+not|doesn't|did\s+not)\s+(?:cover|contain|include|address)|I\s+(?:could\s+not|couldn't|cannot|can't)\s+find\s+(?:any|anything|a\s+(?:specific|relevant))|(?:there\s+is\s+)?no\s+(?:relevant\s+)?(?:information|material)\s+(?:is\s+)?(?:available|found))/i.test(t)
  );
}

/**
 * The provision the advocate named, as a phrase to put in a prompt.
 *
 * Null when they named none - "is anticipatory bail maintainable" is a legal
 * question, not a provision lookup, and answering it as though a provision had
 * been named would invite the model to pick one.
 */
const ACT_FULL_NAMES: Record<string, string> = {
  IPC: 'Indian Penal Code (IPC)',
  BNS: 'Bharatiya Nyaya Sanhita (BNS)',
  CRPC: 'Code of Criminal Procedure (CrPC)',
  BNSS: 'Bharatiya Nagarik Suraksha Sanhita (BNSS)',
  IEA: 'Indian Evidence Act (IEA)',
  BSA: 'Bharatiya Sakshya Adhiniyam (BSA)',
  CPC: 'Civil Procedure Code (CPC)',
  COI: 'Constitution of India',
};

function describeProvision(intent: ClassifiedIntent): string | null {
  if (!intent.sectionNumber) return null;

  const provision = intent.sectionNumber.trim();
  const act = intent.actCode;

  // "Order 32" already reads as a provision; a bare "302" needs the word.
  const head = /^(order|rule|article)\b/i.test(provision) ? provision : `Section ${provision}`;

  if (!act) return intent.actName ? `${head} of the ${intent.actName}` : head;
  const actName = ACT_FULL_NAMES[act] ?? act;
  return `${head} of the ${actName}`;
}

function fixedAnswer(text: string, model: string, started: number, unavailable = false): RagAnswer {
  return {
    text,
    citations: [],
    passages: [],
    statutes: [],
    model,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: Date.now() - started,
    guardrailTriggered: false,
    guardrailReason: null,
    mocked: false,
    ...(unavailable ? { unavailable: true } : {}),
  };
}

/** The code that replaced each old one, for saying that a section has no counterpart in it. */
const NEW_CODE_FOR: Record<string, string> = { IPC: 'BNS', CRPC: 'BNSS', IEA: 'BSA' };
/** The code each new one replaced. */
const OLD_CODE_FOR: Record<string, 'IPC' | 'CRPC' | 'IEA'> = { BNS: 'IPC', BNSS: 'CRPC', BSA: 'IEA' };

/** A question about an offence: its punishment, its ingredients, whether bail is granted. */
const PENAL_WORDS =
  /punish|\bsaza+\b|\bsazaa\b|सज़ा|सजा|दंड|\bdand\b|offen[cs]e|अपराध|\bcrime\b|\bbail|जमानत|ingredients|cogni[sz]able/i;

/** Words of a question that say what is asked, not what it is about. */
const GENERIC_WORDS = new Set([
  'punishment', 'punished', 'punish', 'penalty', 'sentence', 'imprisonment', 'fine', 'ingredients', 'ingredient',
  'definition', 'define', 'defined', 'meaning', 'provision', 'criminal', 'explain', 'essential', 'elements', 'element',
  'years', 'year', 'maximum', 'minimum', 'kitni', 'kitna', 'whoever', 'person', 'persons',
]);

/** The subject of a question - topicQuery's words without the ones every question about an offence has. */
export function subjectWords(text: string): string[] {
  return topicQuery(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
}

/**
 * An answer not in the language it was asked for: a Hindi question answered
 * with no Devanagari, a Hinglish one in English (fewer than three of the Hindi
 * words a Hinglish sentence is built from, and no Devanagari).
 */
export function wrongLanguage(wanted: string, answer: string): boolean {
  const devanagari = /[ऀ-ॿ]/.test(answer);
  if (wanted === 'hi') return !devanagari && answer.trim().length > 40;
  if (wanted !== 'hinglish' || devanagari || answer.trim().length < 40) return false;
  const words = new Set(answer.toLowerCase().split(/[^a-z]+/).filter((w) => HINGLISH_REPLY_WORDS.has(w)));
  // One short Hinglish sentence has fewer of them: "BNSS Section 48 purane
  // CrPC ke Section 50A ke samanvayi hai."
  return words.size < (answer.trim().length < 300 ? 2 : 3);
}

/** Hindi words a Hinglish reply cannot do without. */
const HINGLISH_REPLY_WORDS = new Set([
  'hai', 'hain', 'ka', 'ki', 'ke', 'mein', 'ko', 'se', 'aur', 'ya', 'yeh', 'ye', 'jo', 'tha', 'thi', 'hota', 'hoti', 'hote',
  'nahi', 'kiya', 'kiye', 'karta', 'karti', 'karte', 'liye', 'agar', 'toh', 'jab', 'tak', 'saza', 'milti', 'milta', 'gaya', 'gayi',
]);

/** Said to the model when its first answer was in the wrong language (generate). */
const LANGUAGE_AGAIN: Record<string, string> = {
  hinglish:
    'YOUR LAST ANSWER WAS IN ENGLISH. Write the whole answer in Hinglish - Hindi in Latin script, as the question was written, e.g. "IPC 34 ka BNS mein Section 3(5) hai". Keep section numbers, case names and Act names in English. Use plain, correct Hindi words; do not invent words.',
  hi: 'YOUR LAST ANSWER WAS NOT IN HINDI. Write the whole answer in Hindi (Devanagari script). Keep section numbers, case names and Act names in English, exactly as given.',
};

/** The reply when the AI provider failed for a request and nothing was written (web/chat.service.ts). */
export const AI_UNAVAILABLE =
  'The AI service Ley Legal uses to write answers is not responding right now, so no answer was written. ' +
  'You have not been charged. Please ask again in a few minutes - judgment search and case status still work.';

export const AI_UNAVAILABLE_HI =
  'Ley Legal जिस AI सेवा से उत्तर लिखता है, वह अभी जवाब नहीं दे रही, इसलिए कोई उत्तर नहीं लिखा गया। ' +
  'आपसे कोई क्रेडिट नहीं लिया गया। कुछ मिनट बाद फिर से पूछें - फ़ैसलों की खोज और केस स्टेटस अभी भी काम कर रहे हैं।';

/** Words that put a question in criminal law or procedure, where the BNS, BNSS and BSA answer it. */
const CRIMINAL_TOPIC =
  /\b(?:police|arrest(?:ed)?|bail|fir|charge-?\s?sheet|investigation|accused|offen[cs]es?|punishable|remand|custody|cognizable|magistrate|confession|undertrial|prosecution|warrant|rape|murder|dowry|kidnapping|theft|snatching|lynching)\b/i;

/** Sentences that are the prompt's own instructions, copied into an answer. */
const PROMPT_ECHO = [
  /\bthe advocate (?:asked about|wrote|described)\b/i,
  /\ba line saying so is already printed\b/i,
  /\bdo not (?:repeat it|explain (?:BNS|IPC|BNSS|CrPC|BSA|IEA))\b/i,
];

/**
 * An answer without the prompt's words in it.
 *
 * "Is BNS 354 (outraging modesty of a woman) bailable?" was answered with "The
 * advocate asked about *BNS Section 74* - the advocate wrote BNS 354 ..." -
 * the instruction for a number trap, copied out; another answer said
 * "(from the Classification line of IPC 323)" (client's audit, 9 Oct, T-05,
 * M-IPC-026). Each such sentence is dropped; a heading in front of one stays.
 */
export function withoutPromptEcho(text: string): string {
  return text
    .replace(/\s*\((?:as\s+)?(?:from|per|according\s+to|see)\s+the\s+["“']?Classification:?["”']?\s+line[^)]*\)/gi, '')
    .split('\n')
    .map((line) => {
      if (!PROMPT_ECHO.some((re) => re.test(line))) return line;
      const prefix = /^\s*(?:[-•*]\s+)?(?:\*[^*\n]{1,40}:\*\s*)?/.exec(line)?.[0] ?? '';
      const kept = line
        .slice(prefix.length)
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !PROMPT_ECHO.some((re) => re.test(sentence)))
        .join(' ')
        .trim();
      return kept ? `${prefix}${kept}` : prefix.trim() && /\*[^*]+:\*/.test(prefix) ? prefix.trimEnd() : null;
    })
    .filter((line): line is string => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Whether two names are one Act: "The Negotiable Instruments Act, 1881" and
 * "Negotiable Instruments Act, 1881" are; the Contract Act and the BNS are not.
 */
function sameAct(a: string | null | undefined, b: string): boolean {
  const norm = (name: string) =>
    name
      .toLowerCase()
      .replace(/\bthe\b|[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return !!a && norm(a) === norm(b);
}

/** "403(1)" -> "403". */
function baseOf(section: string): string {
  return section.split('(')[0].trim().toUpperCase();
}

/** Near enough for "offences" and "offence", as titleHas reads them. */
function stem(word: string): string {
  return word.slice(0, Math.max(4, word.length - 2));
}

/** The reply language: Hinglish when the question is (legal-patterns.ts, isHinglish), else the router's. */
function replyLanguage(intent: ClassifiedIntent): string {
  return intent.language === 'en' && isHinglish(intent.rawText) ? 'hinglish' : intent.language;
}

function notCoveredReply(intent: ClassifiedIntent): string {
  return intent.language === 'hi'
    ? 'Ley Legal में रखी BNS, BNSS और BSA की धाराओं में से किसी से इसका उत्तर नहीं मिला। विषय को अधिनियम के शब्दों में लिखें, या धारा संख्या पता हो तो वह बताएं।'
    : "None of the sections Ley Legal holds answers this. Try the subject in the words the Act would use, or name the section if you know it.";
}

/**
 * The provisions to list under an answer: the ones it actually names.
 *
 * Everything retrieved was listed. "BNS 316(5) purane IPC mein Section 409
 * tha" - right - sat over a list naming IPC 406, which is plain criminal
 * breach of trust; "BSA 23(1) ... IEA 25" over IEA 27 (live tests, M-REV-007,
 * M-REV-017, O-12). An answer that names no section keeps the list as it was.
 *
 * Read in the forms answers write them, too: the Act's full name, in English
 * or Hindi ("Section 316(5) of the Bharatiya Nyaya Sanhita", "भारतीय साक्ष्य
 * अधिनियम की धारा 63"), and a bare "Section 132(1)" when only one provision
 * retrieved has that number. Missed, the list fell back to everything - IPC
 * 406 under an answer on IPC 409, IEA 65B alone under one on BSA 63, three
 * unrelated sections under "Section 113" (client's audit, 9 Oct, M-REV-007,
 * N-11, M-IEA-030, O-06). An answer that names sections, none of them listed,
 * gets no list rather than a wrong one.
 */
export function statutesShown(text: string, statutes: StatuteRow[]): StatuteRow[] {
  const written = withCodeNames(text);
  const refs = extractStatuteRefs(written);
  const named = new Set(refs.map((ref) => {
    const [act, section] = ref.split(' ');
    return `${act} ${baseOf(section ?? '')}`;
  }));
  // "Section 132(1)" with no Act beside it: the one provision of that number.
  for (const match of written.matchAll(/\b(?:sections?|secs?|s\.)\s*(\d+[A-Z]?)/gi)) {
    const same = statutes.filter((s) => baseOf(s.section_number) === match[1].toUpperCase());
    if (same.length === 1) named.add(`${same[0].act_code.toUpperCase()} ${baseOf(same[0].section_number)}`);
  }
  const shown = statutes.filter((s) => named.has(`${s.act_code.toUpperCase()} ${baseOf(s.section_number)}`));
  if (shown.length > 0) return shown;
  return refs.length > 0 || /\b(?:sections?|secs?)\s*\d/i.test(written) ? [] : statutes;
}

/** The codes' full names, English and Hindi, as the abbreviations extractStatuteRefs reads; "की धारा" as "Section". */
function withCodeNames(text: string): string {
  return text
    .replace(/\bBharatiya\s+Nyaya\s+Sanhita(?:,?\s*2023)?/gi, 'BNS')
    .replace(/\bBharatiya\s+Nagarik\s+Suraksha\s+Sanhita(?:,?\s*2023)?/gi, 'BNSS')
    .replace(/\bBharatiya\s+Sakshya\s+Adhiniyam(?:,?\s*2023)?/gi, 'BSA')
    .replace(/\bIndian\s+Penal\s+Code(?:,?\s*1860)?/gi, 'IPC')
    .replace(/\b(?:Code\s+of\s+Criminal\s+Procedure|Criminal\s+Procedure\s+Code)(?:,?\s*1973)?/gi, 'CrPC')
    .replace(/\b(?:Indian\s+)?Evidence\s+Act(?:,?\s*1872)?/gi, 'IEA')
    .replace(/भारतीय\s*न्याय\s*संहिता/g, 'BNS')
    .replace(/भारतीय\s*नागरिक\s*सुरक्षा\s*संहिता/g, 'BNSS')
    .replace(/भारतीय\s*साक्ष्य\s*अधिनियम/g, 'BSA')
    .replace(/भारतीय\s*दंड\s*संहिता/g, 'IPC')
    .replace(/दंड\s*प्रक्रिया\s*संहिता/g, 'CrPC')
    .replace(/(?:भारतीय\s*)?साक्ष्य\s*अधिनियम/g, 'IEA')
    .replace(/\b(BNSS|BNS|BSA|IPC|CrPC|IEA)\s+(?:की|का|के|ki|ka|ke)\s+/g, '$1 ')
    .replace(/धारा\s*/g, 'Section ');
}

/** How long "the judgment corpus is empty" (or not) is believed before it is read again. */
const CORPUS_CHECK_MS = 10 * 60_000;

/**
 * The best full-text matches on a subject: within 30% of the top score, four
 * at most. Measured on the Gazette text: "bail" ranks BNSS 480 at 54 and BNS
 * 269 (failing to appear on a bail bond) at 18; "organised crime" ranks BNS 111
 * at 60, BNS 112 at 18 and BNSS 43 (arrest how made) at 4.
 */
export function closestToBest(rows: StatuteRow[]): StatuteRow[] {
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()].sort((a, b) => b.score - a.score);
  const best = unique[0]?.score ?? 0;
  return unique.filter((r) => r.score >= best * 0.3).slice(0, 4);
}

/**
 * The sections covering the most of the subject's words (statutesCovering's
 * score: 2 x title words + words anywhere): within 80% of the best, four at
 * most, and none when the best covers less than a title word and one more or
 * three words in the body. Measured on the Gazette text: "allows information
 * cognizable cases registered" scores BNSS 173 and 174 at 9 and BNSS 472 at 5;
 * "makes confession police officer inadmissible" scores BSA 23 at 9 and BNSS
 * 193 at 7.
 */
export function mostCovered(rows: StatuteRow[], words: string[] = []): StatuteRow[] {
  const best = rows[0]?.score ?? 0;
  if (best < 3) return [];
  const chosen = rows.filter((r) => r.score >= best * 0.8).slice(0, 4);

  // A question about two things gets the section titled with each: "theft ka
  // case hai ... bail kis section mein?" covered bail best, and BNS 303 (Theft)
  // was left out (live test, 4 Oct, X34).
  for (const word of words.filter((w) => w.length >= 4)) {
    if (chosen.length >= 4) break;
    if (chosen.some((row) => titleHas(row, word))) continue;
    const other = rows.find((row) => row.score >= Math.max(3, best * 0.5) && !chosen.includes(row) && titleHas(row, word));
    if (other) chosen.push(other);
  }
  return chosen;
}

/** Whether a section's title carries this word, near enough for "offences" and "offence". */
function titleHas(row: StatuteRow, word: string): boolean {
  return word.length >= 3 && (row.section_title ?? '').toLowerCase().includes(word.slice(0, Math.max(4, word.length - 2)));
}

/**
 * The reply when a named provision has no official text here. Says so, points
 * to where it can be read, and does not describe it: a wrong number or wording
 * costs an advocate more than no answer. The charge is refunded upstream.
 */
function unavailableAnswer(intent: ClassifiedIntent, target: ProvisionTarget | null, started: number, noCounterpart = false): RagAnswer {
  const provision = describeProvision(intent) ?? 'that provision';
  const link = target
    ? kanoonSearchLink(target)
    : kanoonSearchLink({ query: `${intent.sectionNumber ?? ''} ${intent.actName ?? (intent.actCode ? ACT_FULL_NAMES[intent.actCode] ?? intent.actCode : '')}`.trim() });
  const text = [
    `I don't have the official text of *${provision}* in Ley Legal yet, so I won't describe it from memory - a wrong section number or wording would cost you more than no answer.`,
    `You can read it on Indian Kanoon: ${link}`,
    noCounterpart && intent.actCode
      ? `The official 2023 correspondence table lists no ${NEW_CODE_FOR[intent.actCode]} section for it: it was not carried into the ${NEW_CODE_FOR[intent.actCode]}.`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');
  // What it cost is said by the channel, which knows: nothing, or one credit
  // for unverified information found on the web (web-fallback.ts).
  return { ...fixedAnswer(text, 'rule:no-official-text', started, true), provision };
}

