import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { RetrievedChunk, StatuteRow } from '../database/types';
import { DraftReleaser } from './draft-release';
import { EmbeddingService } from './embedding.service';
import { GuardrailsService } from './guardrails.service';
import { ClassifiedIntent } from './intent.service';
import { NEW_CRIMINAL_CODES, expandQuery, topicQuery } from './legal-patterns';
import {
  buildGeneralLegalPrompt,
  buildPrecedentSearchPrompt,
  buildSectionExplanationPrompt,
  buildSmallTalkPrompt,
} from './prompts';
import { nonexistentProvision } from './provision-range';
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

    // A number past the end of its Act has a certain answer, and it is not
    // one to hand to a model told to stop when it is unsure.
    const impossible = nonexistentProvision(intent.actCode, intent.sectionNumber);
    if (impossible) return fixedAnswer(impossible, 'rule:provision-range', started);

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

    return this.explain(statutes, intent, started, history, onStage);
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
  ): Promise<RagAnswer> {
    const system = buildSectionExplanationPrompt(statutes, intent.language, describeProvision(intent));
    return this.generate(system, intent, [], statutes, started, history, onStage);
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

    if (relevant.length === 0 && statutes.length === 0) {
      return this.answerGeneral(intent, started, history, onStage);
    }

    const system = buildPrecedentSearchPrompt(relevant, statutes, intent.language);
    return this.generate(system, intent, relevant, statutes, started, history, onStage);
  }

  /** No corpus support available; the prompt bars citing anything. */
  async answerGeneral(
    intent: ClassifiedIntent,
    startedAt?: number,
    history: LlmMessage[] = [],
    onStage?: RagProgress,
  ): Promise<RagAnswer> {
    const started = startedAt ?? Date.now();
    const system = buildGeneralLegalPrompt(intent.language);
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
  ): Promise<RagAnswer> {
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
          (prefix, known) => this.guardrails.verifiedDraft(prefix, intent, known),
          (draft) => {
            firstDraftAt ??= Date.now();
            onStage({ draft });
          },
        )
      : null;
    const result = drafts
      ? await this.registry.completeStreaming(request, (written) => drafts.offer(written))
      : await this.registry.complete(request);
    await drafts?.close();

    // Every generated answer passes through verification before anyone sees it.
    onStage?.('verifying');
    const verifying = Date.now();
    const checked = await this.guardrails.verify(result.text, passages, intent, history);
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

    return {
      text: checked.text,
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
    };
  }
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

