import { Injectable } from '@nestjs/common';
import { IntentService } from '../ai/intent.service';
import { extractCnr, isValidCnr } from '../ai/legal-patterns';
import { costLine, UnverifiedInfo, WebFallbackService } from '../ai/web-fallback';
import {
  NOT_AVAILABLE,
  PrecedentsService,
  legalPrinciple,
  orderingNote,
  splitParties,
  stripEllipsis,
} from '../ai/precedents.service';
import { ProviderRegistry } from '../ai/providers/provider.registry';
import { RagDraft, RagService, RagStage } from '../ai/rag.service';
import { CircuitOpenError } from '../common/circuit-breaker';
import { getLogger } from '../common/logger';
import { CREDIT_COST, CreditBalance, CreditsService } from '../credits/credits.service';
import { AnalyticsRepository } from '../database/repositories/analytics.repository';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { ChatRepository } from '../database/repositories/chat.repository';
import { ChatMessageRow, PrecedentRow, UserRow } from '../database/types';
import { forBrowser } from '../ecourts/for-browser';
import { caseNumberIn, cnrNeededReply, matchEarlierCase } from '../ecourts/cnr-help';
import { CnrNotFoundError, EcourtsService } from '../ecourts/ecourts.service';
import { StageChannel } from './stage-channel';

/**
 * What the client is told while an answer is being produced.
 *
 * Every `stage` corresponds to a step that has actually started - see the
 * RagStage comment in rag.service.ts. Nothing here is a timer or an animation
 * pretending to be progress.
 */
export type ChatEvent =
  | { type: 'thread'; threadId: string; title: string }
  | { type: 'message'; message: PublicChatMessage }
  | { type: 'stage'; stage: ChatStage }
  /**
   * The answer as written so far - only lines whose every reference has
   * passed the citation check (draft-release.ts). Shown until `answer`
   * replaces it; an empty text withdraws it.
   */
  | { type: 'draft'; text: string }
  | { type: 'answer'; message: PublicChatMessage; credits: CreditBalance; charged: number }
  | { type: 'error'; code: string; message: string; credits?: CreditBalance };

export type ChatStage = 'classifying' | 'looking-up' | 'searching' | 'searching-web' | RagStage;

export interface PublicChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent: string | null;
  citations: string[];
  structured: Record<string, unknown> | null;
  creditsCharged: number;
  guardrailFlagged: boolean;
  error: string | null;
  createdAt: Date;
}

/**
 * The web chat.
 *
 * ## Why this is not the WhatsApp conversation service with a different output
 *
 * They share the pipeline underneath - the same intent classifier, the same
 * retrieval, the same guardrail - and they diverge above it, because the two
 * clients are not the same kind of thing.
 *
 * WhatsApp is a stateful text terminal: there is one conversation, the state
 * machine remembers where in a flow the advocate is, and the answer has to be
 * flattened into WhatsApp's own markup. The web client has many threads, no
 * modal flow to be stuck in, and a renderer - so a precedent list is delivered
 * as structured rows the browser lays out as cards, not as asterisks and line
 * breaks that have to be parsed back into fields.
 *
 * Trying to serve both from one method was the alternative, and it produces a
 * function whose every branch asks "which client is this" - which is two
 * functions wearing a trench coat.
 *
 * ## Why answering is synchronous here and queued there
 *
 * Meta expects a webhook acknowledged in well under a second and throttles
 * subscriptions that are slow, so the WhatsApp path must return immediately and
 * do the work on a queue. A browser waiting on its own fetch has no such
 * constraint - and the advocate is watching, so streaming stages back over the
 * open connection is better than a queue plus a polling loop.
 *
 * ## Streaming stages rather than tokens
 *
 * There is no token streaming, and that is a product decision rather than a
 * missing feature. The citation guardrail runs on the *complete* answer and
 * strips citations that are not in the corpus. Streaming raw model output would
 * put unverified citations on screen and then remove them - showing an advocate
 * a case that does not exist, however briefly, is precisely the failure this
 * whole system is built to prevent.
 */
@Injectable()
export class ChatService {
  private readonly logger = getLogger().child({ module: 'web:chat' });

  constructor(
    private readonly chats: ChatRepository,
    private readonly intents: IntentService,
    private readonly rag: RagService,
    private readonly precedents: PrecedentsService,
    private readonly ecourts: EcourtsService,
    private readonly credits: CreditsService,
    private readonly analytics: AnalyticsRepository,
    private readonly corpus: CorpusRepository,
    private readonly registry: ProviderRegistry,
    private readonly web: WebFallbackService,
  ) {}

  /**
   * Ask a question and stream what happens.
   *
   * An async generator rather than a callback so the controller owns the
   * transport: the same sequence drives an SSE stream today and could fill a
   * plain JSON response by collecting it, without this method knowing which.
   */
  async *ask(input: {
    user: UserRow;
    threadId: string | null;
    question: string;
    /**
     * An edited question: this earlier question of the advocate's, and
     * everything after it, is replaced by the new one.
     */
    replaceMessageId?: string | null;
    /** True once the advocate has pressed Stop - see ChatController.stop. */
    stopped?: () => boolean;
  }): AsyncGenerator<ChatEvent> {
    const question = input.question.trim();
    const user = input.user;
    const started = Date.now();

    if (!question) {
      yield { type: 'error', code: 'EMPTY', message: 'Type a question first.' };
      return;
    }

    // A thread is created on the first message rather than when the user
    // presses "New chat", so an abandoned empty thread never reaches the
    // sidebar.
    const thread = input.threadId
      ? await this.chats.findThread(user.id, input.threadId)
      : await this.chats.createThread(user.id);

    if (!thread) {
      yield { type: 'error', code: 'NO_THREAD', message: 'That conversation could not be found.' };
      return;
    }

    // Before the title, so a thread emptied by the edit is named by the edit.
    if (input.replaceMessageId) {
      await this.chats.deleteFromMessage(user.id, thread.id, input.replaceMessageId);
    }

    await this.chats.autoTitle(thread.id, question);
    yield { type: 'thread', threadId: thread.id, title: thread.title };

    const userMessage = await this.chats.appendMessage({
      threadId: thread.id,
      userId: user.id,
      role: 'user',
      content: question,
    });
    yield { type: 'message', message: toPublic(userMessage) };

    // The idempotency key for anything this turn charges. Derived from the
    // stored message id, which exists exactly once however many times the
    // client retries the request.
    const reference = `spend:web:${userMessage.id}`;
    const setUp = Date.now();

    try {
      yield* this.answer({ user, threadId: thread.id, question, reference, stopped: input.stopped });
      // One line per question, from the server's side: what an advocate waits
      // for, less the network. The steps are in "Question routed" and the
      // "Answer timings" / "Judgment search timings" lines.
      this.logger.info({ ms: Date.now() - started, setupMs: setUp - started }, 'Question answered');
    } catch (err) {
      this.logger.error({ err, userId: user.id, threadId: thread.id }, 'Web chat answer failed');

      // The credits are returned before the error is reported. A failure the
      // advocate can see, that also silently cost them two credits, is the
      // version of this that generates support mail.
      await this.credits.refund(user.id, user.role, reference, 'The answer could not be produced');

      const failed = await this.chats.appendMessage({
        threadId: thread.id,
        userId: user.id,
        role: 'assistant',
        content: 'Something went wrong while answering that. Your credits have not been charged.',
        errorDetail: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
      });

      yield {
        type: 'error',
        code: 'ANSWER_FAILED',
        message: 'Something went wrong while answering that. Your credits have not been charged.',
        credits: await this.credits.peek(user.id, user.role),
      };
      yield { type: 'message', message: toPublic(failed) };
    }
  }

  private async *answer(input: {
    user: UserRow;
    threadId: string;
    question: string;
    reference: string;
    stopped?: () => boolean;
  }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question, reference } = input;

    // Nobody to answer (the client left while this was being set up): stop
    // before the model call, not only before the charge.
    if (input.stopped?.()) return;

    yield { type: 'stage', stage: 'classifying' };
    const routing = Date.now();
    const intent = await this.intents.classify(question);
    this.logger.info({ intent: intent.intent, routeMs: Date.now() - routing }, 'Question routed');

    // A CNR anywhere in the message is decisive. Someone who pastes a case
    // number wants that case, whatever else the sentence around it says, and
    // the classifier has no better information than the pattern does.
    const cnr = intent.cnrNumber ?? extractCnr(question);
    if (cnr) {
      yield* this.answerCaseStatus({ user, threadId, question, cnr, reference });
      return;
    }

    // A case-status question without a CNR - "status of CNR 831/2024", a filing
    // number. It used to be charged and sent to eCourts as one, and answered
    // "No case found". There is nothing to look up; say what is needed, free.
    if (intent.intent === 'CASE_STATUS') {
      yield* this.askForCnr({ user, threadId, question });
      return;
    }

    const isPrecedentSearch = intent.intent === 'PRECEDENT_SEARCH';
    const cost = isPrecedentSearch ? CREDIT_COST.PRECEDENT_SEARCH : CREDIT_COST.SECTION_LOOKUP;

    // Small talk is free, and answered on the cheap router model. Charging two
    // credits for "thanks" would be indefensible, and refusing it would make
    // the product feel like a vending machine.
    if (intent.intent === 'SMALL_TALK') {
      yield* this.answerSmallTalk({ user, threadId, question, language: intent.language });
      return;
    }

    // Stopped while the question was being read: nothing has been charged yet,
    // and nothing will be. Checked here because this is the last moment that
    // costs nothing - past it the charge is taken and the model is called.
    if (input.stopped?.()) return;

    const decision = await this.credits.spend({
      userId: user.id,
      role: user.role,
      cost,
      action: isPrecedentSearch ? 'PRECEDENT_SEARCH' : 'SECTION_LOOKUP',
      reference,
    });

    if (!decision.allowed) {
      yield {
        type: 'error',
        code: 'INSUFFICIENT_CREDITS',
        message:
          decision.balance.total > 0
            ? `That search costs ${cost} credits and you have ${decision.balance.total} left.`
            : // No date, because there is not one. The free allowance has been
              // granted once for the life of the account since migration 0014;
              // it does not reset daily, monthly or at all. Telling an advocate
              // to come back tomorrow is the expensive version of this mistake -
              // they wait for credits that are never coming instead of verifying
              // their licence or buying more. Replies.quotaExceeded() on the
              // WhatsApp side has said the right thing since 0014 landed.
              'You have used all the free credits on this account.',
        credits: decision.balance,
      };
      return;
    }

    if (isPrecedentSearch) {
      yield* this.answerPrecedents({
        user,
        threadId,
        question,
        intent,
        charged: decision.charged,
        reference,
      });
      return;
    }

    yield* this.answerWithRag({ user, threadId, question, intent, charged: decision.charged, reference });
  }

  /**
   * Undo a turn the advocate stopped before its answer reached them.
   *
   * The charge is refunded and the question - with anything written in reply
   * to it - is removed, so the thread reads as if it had not been asked and the
   * edited question lands in its place. Safe to run twice, and it is: once the
   * moment Stop is pressed, so a resend finds the thread clean, and again when
   * the abandoned answer finishes, for whatever it charged or wrote after the
   * first pass. The refund is keyed on the question, so the second pays out
   * only what the first could not yet see.
   */
  async discardTurn(input: {
    user: UserRow;
    threadId: string | null;
    userMessageId: string | null;
    messageIds: string[];
  }): Promise<void> {
    const { user, threadId, userMessageId } = input;

    if (userMessageId) {
      await this.credits.refund(
        user.id,
        user.role,
        `spend:web:${userMessageId}`,
        'Stopped before the answer arrived',
      );
    }
    if (threadId && input.messageIds.length > 0) {
      await this.chats.deleteMessages(user.id, threadId, input.messageIds);
    }

    this.logger.info({ userId: user.id, threadId, removed: input.messageIds.length }, 'Stopped turn discarded');
  }

  // ---------------------------------------------------------------------------
  // Case status - free, no model call
  // ---------------------------------------------------------------------------

  /**
   * A case-status question with no CNR in it: what is needed, and - when the
   * number typed is one of a case looked up earlier in this chat - that case's
   * CNR. No eCourts call and no charge (see cnr-help.ts).
   */
  private async *askForCnr(input: { user: UserRow; threadId: string; question: string }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question } = input;
    const started = Date.now();

    const typed = caseNumberIn(question);
    const match = typed ? matchEarlierCase(typed, await this.chats.caseCardsInThread(threadId)) : null;

    const message = await this.chats.appendMessage({
      threadId,
      userId: user.id,
      role: 'assistant',
      content: cnrNeededReply(typed, match),
      intent: 'CASE_STATUS',
      latencyMs: Date.now() - started,
      creditsCharged: 0,
    });

    yield {
      type: 'answer',
      message: toPublic(message),
      credits: await this.credits.peek(user.id, user.role),
      charged: 0,
    };
  }

  private async *answerCaseStatus(input: {
    user: UserRow;
    threadId: string;
    question: string;
    cnr: string;
    /** The idempotency key the charge and any refund share. */
    reference: string;
  }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question, cnr, reference } = input;
    const started = Date.now();

    yield { type: 'stage', stage: 'looking-up' };

    /*
     * Priced like every other lookup, and priced the same here as on WhatsApp.
     *
     * This path used to record `creditsCharged: 0` and never call spend, which
     * was correct while CASE_STATUS cost nothing. Leaving it after the price
     * changed would mean one feature with two prices depending on which screen
     * an advocate happened to open - the kind of difference nobody reports as a
     * bug and everybody notices.
     */
    const decision = await this.credits.spend({
      userId: user.id,
      role: user.role,
      cost: CREDIT_COST.CASE_STATUS,
      action: 'CASE_STATUS',
      reference,
    });

    if (!decision.allowed) {
      yield {
        type: 'error',
        code: 'INSUFFICIENT_CREDITS',
        message: `A case status lookup costs ${CREDIT_COST.CASE_STATUS} credit and you have ${decision.balance.total} left.`,
        credits: decision.balance,
      };
      return;
    }

    try {
      const status = await this.ecourts.lookup(cnr);

      const message = await this.chats.appendMessage({
        threadId,
        userId: user.id,
        role: 'assistant',
        content: `Case status for ${cnr}`,
        intent: 'CASE_STATUS',
        // The whole record goes to the client as data. `mocked` travels with
        // it so the interface can label synthetic data as synthetic - an
        // advocate must never mistake the mock adapter's output for a court
        // record.
        structured: { kind: 'caseStatus', ...status },
        latencyMs: Date.now() - started,
        creditsCharged: decision.charged,
      });

      await this.analytics.recordSearch({
        userId: user.id,
        queryText: question,
        detectedLanguage: user.preferred_language,
        resolvedQuery: cnr,
        intent: 'CASE_STATUS',
        citations: [],
        resultCount: 1,
        modelUsed: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - started,
        guardrailFlagged: false,
      });

      yield {
        type: 'answer',
        message: toPublic(message),
        credits: await this.credits.peek(user.id, user.role),
        // What this actually cost. It reported 0 from the day the lookup was
        // priced - left over from when it was free - which contradicted the
        // creditsCharged stored on the message beside it.
        charged: decision.charged,
      };
    } catch (err) {
      // eCourts has no record of a well-formed CNR: what the web has, apart and
      // marked unverified, for the credit already taken (web-fallback.ts).
      if (err instanceof CnrNotFoundError && isValidCnr(cnr)) {
        yield { type: 'stage', stage: 'searching-web' };
        const unverified = await this.web.find('cnr', question, cnr);
        if (unverified) {
          const charged = (await this.credits.chargeUnverified(user.id, user.role, reference)) ?? decision.charged;
          const message = await this.chats.appendMessage({
            threadId,
            userId: user.id,
            role: 'assistant',
            content: `eCourts has no record of CNR ${cnr}.\n\n${costLine(charged, true)}`,
            intent: 'CASE_STATUS',
            structured: { kind: 'notice', unverified },
            latencyMs: Date.now() - started,
            creditsCharged: charged,
          });
          yield { type: 'answer', message: toPublic(message), credits: await this.credits.peek(user.id, user.role), charged };
          return;
        }
      }

      const reason =
        err instanceof CnrNotFoundError
          ? `No case found for CNR ${cnr}. Check the 16-character number and try again.`
          : err instanceof CircuitOpenError
            ? 'The court records service is not responding at the moment. Try again shortly.'
            : 'The court records service could not be reached. Try again shortly.';

      if (!(err instanceof CnrNotFoundError)) {
        this.logger.error({ err, cnr }, 'CNR lookup failed');
      }

      /*
       * The credit goes back before the failure is reported.
       *
       * This block used to note that case status was free and therefore had
       * nothing to refund. It is priced now, and because the error is recorded
       * as a message rather than thrown, the outer catch that refunds every
       * other failure never sees it - so the refund has to happen here or not
       * at all.
       */
      await this.credits
        .refund(user.id, user.role, reference, 'Case status lookup failed')
        .catch((refundErr) => this.logger.warn({ refundErr, cnr }, 'Could not refund a failed lookup'));

      // Recorded as a message rather than thrown, so the advocate's question
      // and the reason it failed stay together in the thread.
      const message = await this.chats.appendMessage({
        threadId,
        userId: user.id,
        role: 'assistant',
        content: reason,
        intent: 'CASE_STATUS',
        errorDetail: err instanceof Error ? err.name : 'unknown',
      });

      yield {
        type: 'answer',
        message: toPublic(message),
        credits: await this.credits.peek(user.id, user.role),
        charged: 0,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Precedents - structured rows, no model call
  // ---------------------------------------------------------------------------

  private async *answerPrecedents(input: {
    user: UserRow;
    threadId: string;
    question: string;
    intent: Awaited<ReturnType<IntentService['classify']>>;
    charged: number;
    reference: string;
  }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question, intent, reference } = input;
    let charged = input.charged;

    yield { type: 'stage', stage: 'searching' };

    /*
     * The advocate's own High Court binds them; everything else is persuasive.
     * A pure date sort buries the one authority they can actually cite.
     *
     * Passed in rather than applied to the result: the search enriches only the
     * page it expects to be read, so reordering afterwards promoted rows that
     * no document had been fetched for.
     */
    const searched = await this.precedents.search(intent, user.bar_council_state);
    const rows = searched.precedents;

    // A named case with no judgment may still be a case - a district-court
    // matter rarely has a reported judgment. See party-search.ts.
    const cases = searched.namedCase?.found ? null : await this.ecourts.casesForQuestion(question);

    const citations = rows.map(
      (p) => p.neutral_citation ?? p.reporter_citations?.[0] ?? p.case_title,
    );

    // A search that found nothing is refunded.
    //
    // Credits buy authorities, and none arrived. The distinction between "your
    // query matched nothing" and "this deployment has no judgments to match
    // against" is invisible from the advocate's side, and one of those two is
    // entirely our problem - so charging for either is the thing that produces
    // refund requests. The downside is bounded: an empty result costs at most
    // one Kanoon call, which is cheaper than the support mail.
    let emptyReason: string | null = null;
    let unverified: UnverifiedInfo | null = null;
    if (rows.length === 0 && !cases) {
      // Nothing from Kanoon or eCourts: what the web has, apart and marked
      // unverified, for one credit (web-fallback.ts) - or the refund.
      yield { type: 'stage', stage: 'searching-web' };
      unverified = await this.web.find('judgment', question, intent.searchQuery);
      if (unverified) {
        charged = (await this.credits.chargeUnverified(user.id, user.role, reference)) ?? charged;
      } else {
        await this.credits.refund(user.id, user.role, reference, 'Search returned no authorities');
        charged = 0;
      }

      // Said plainly, because the two causes need different actions from
      // whoever reads it. "No judgments found" on a deployment with nothing to
      // search reads as "your question was bad", and sends an advocate off
      // rephrasing a query that was never going to work.
      //
      // Which of the two it is depends on *who answered*, not just on whether
      // the local corpus is empty. With Indian Kanoon configured the search ran
      // against their index and genuinely found nothing - an empty local corpus
      // is irrelevant, and reporting it would be a false alarm about
      // infrastructure that is working correctly.
      if (searched.source === 'kanoon') {
        emptyReason = 'no-match';
      } else {
        const corpus = await this.corpus.countCorpus().catch(() => ({ judgments: 0 }));
        emptyReason = Number(corpus.judgments ?? 0) === 0 ? 'no-corpus' : 'no-match';
      }
    }

    // A judgment asked for by name or citation is said to be missing by that
    // name - not as a topic search for the router's rewrite of the question,
    // which read as if other judgments might still answer it (precedents.service.ts).
    const missing = searched.namedCase && !searched.namedCase.found
      ? `No judgment found for "${searched.namedCase.name}" in Ley Legal's sources. ` +
        'Check the party names or the citation, or describe the point of law instead.'
      : null;

    const message = await this.chats.appendMessage({
      threadId,
      userId: user.id,
      role: 'assistant',
      content: rows.length
        ? `${rows.length} ${rows.length === 1 ? 'authority' : 'authorities'} on "${intent.searchQuery}"`
        : cases
          ? `No reported judgment found for "${cases.query}". ` +
            `${cases.result.totalHits === 1 ? 'One case' : `${cases.result.totalHits} cases`} on eCourts with these parties.`
        : unverified
          ? `${missing ?? `No judgments matched "${intent.searchQuery}" in Ley Legal's sources.`} ${costLine(charged, true)}`
        : emptyReason === 'no-corpus'
          ? 'No judgment database is available on this deployment yet, so there is nothing to search. ' +
            'You have not been charged.'
          : `${missing ?? `No judgments matched "${intent.searchQuery}".`} You have not been charged.`,
      intent: 'PRECEDENT_SEARCH',
      // Every citation here came straight out of the corpus, so they are
      // verified by construction - there is nothing for the guardrail to strip
      // because no part of this list was generated.
      citations,
      structured: {
        kind: 'precedents',
        query: intent.searchQuery,
        source: searched.source,
        // Worded here, once, so the web says what WhatsApp says.
        ordering: searched.namedCase ? null : orderingNote(searched.grouping),
        lexicalOnly: searched.lexicalOnly,
        totalMatches: searched.totalMatches,
        emptyReason,
        items: rows.map(toPublicPrecedent),
        // Cases on eCourts with the parties named; rows are added in forBrowser().
        cases: cases
          ? {
              query: cases.query,
              totalHits: cases.result.totalHits,
              statusCost: CREDIT_COST.CASE_STATUS,
              items: cases.result.cases,
            }
          : null,
        unverified,
      },
      latencyMs: searched.latencyMs,
      creditsCharged: charged,
    });

    await this.analytics.recordSearch({
      userId: user.id,
      queryText: question,
      detectedLanguage: intent.language,
      resolvedQuery: intent.searchQuery,
      intent: 'PRECEDENT_SEARCH',
      citations,
      resultCount: rows.length + (cases?.result.cases.length ?? 0),
      modelUsed: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: searched.latencyMs,
      guardrailFlagged: false,
    });

    yield {
      type: 'answer',
      message: toPublic(message),
      credits: await this.credits.peek(user.id, user.role),
      charged,
    };
  }

  // ---------------------------------------------------------------------------
  // Retrieval-augmented answers
  // ---------------------------------------------------------------------------

  private async *answerWithRag(input: {
    user: UserRow;
    threadId: string;
    question: string;
    intent: Awaited<ReturnType<IntentService['classify']>>;
    charged: number;
    reference: string;
  }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question, intent, reference } = input;
    let { charged } = input;

    const history = await this.chats.recentTurns(threadId, 10);

    // The pipeline reports each step as it begins, through a callback. The
    // channel bridges that to this generator so the stages reach the browser
    // while the work is happening - see stage-channel.ts for why replaying them
    // afterwards would make the progress display a decoration.
    const channel = new StageChannel<ChatStage | RagDraft>();

    const answerPromise = this.rag.answer(
      intent,
      // The current question is appended by the pipeline, so history must stop
      // short of it - it was already persisted above.
      history.slice(0, -1).map((turn) => ({ role: turn.role, content: turn.content })),
      (event) => channel.push(event),
    );

    // Closed on both settlements. Without the rejection branch a failed answer
    // would leave this generator waiting on a stage that will never arrive, and
    // the request would hang until the client gave up rather than reporting the
    // error that already happened.
    void answerPromise.then(
      () => channel.close(),
      () => channel.close(),
    );

    for await (const event of channel) {
      yield typeof event === 'string' ? { type: 'stage', stage: event } : { type: 'draft', text: event.draft };
    }

    const answer = await answerPromise;
    let text = answer.text.trim();
    const mocked = answer.mocked || this.registry.isFullyMocked;

    // No official text for the provision asked about. What the web has, apart
    // and marked unverified, for one credit (web-fallback.ts); if it has
    // nothing either, an answer was not delivered - refunded, as a search that
    // found nothing is.
    let unverified: UnverifiedInfo | null = null;
    if (answer.unavailable) {
      yield { type: 'stage', stage: 'searching-web' };
      unverified = await this.web.find('provision', question, answer.provision ?? null);
      if (unverified) {
        charged = (await this.credits.chargeUnverified(user.id, user.role, reference)) ?? charged;
      } else if (charged > 0) {
        await this.credits.refund(user.id, user.role, reference, 'No official text for that provision');
        charged = 0;
      }
      text = `${text}\n\n${costLine(charged, unverified !== null)}`;
    }

    const message = await this.chats.appendMessage({
      threadId,
      userId: user.id,
      role: 'assistant',
      content:
        text ||
        'I could not produce an answer for that. Try rephrasing it, or ask about a specific section or judgment.',
      intent: intent.intent,
      citations: answer.citations,
      structured: {
        kind: 'answer',
        // Surfaced so the interface can say so plainly. An answer from the mock
        // provider is a placeholder, and an advocate who mistakes one for legal
        // research is the worst outcome this system has.
        mocked,
        statutes: answer.statutes.map((s) => ({
          actCode: s.act_code,
          actName: s.act_name,
          sectionNumber: s.section_number,
          sectionTitle: s.section_title,
        })),
        sources: answer.passages.map((p) => ({
          caseTitle: p.case_title,
          citation: p.neutral_citation ?? p.reporter_citations?.[0] ?? null,
          court: p.court_name,
          date: p.judgment_date,
          paragraph: p.para_number,
        })),
        // Shown after the answer, in its own marked section - never as part of it.
        unverified,
      },
      modelUsed: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      latencyMs: answer.latencyMs,
      creditsCharged: charged,
      guardrailFlagged: answer.guardrailTriggered,
      guardrailReason: answer.guardrailReason,
    });

    await this.analytics.recordSearch({
      userId: user.id,
      queryText: question,
      detectedLanguage: intent.language,
      resolvedQuery: intent.searchQuery,
      intent: intent.intent,
      citations: answer.citations,
      resultCount: answer.passages.length,
      modelUsed: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      latencyMs: answer.latencyMs,
      guardrailFlagged: answer.guardrailTriggered,
      guardrailReason: answer.guardrailReason,
    });

    this.logger.info(
      {
        userId: user.id,
        threadId,
        intent: intent.intent,
        citations: answer.citations.length,
        latencyMs: answer.latencyMs,
        guardrail: answer.guardrailTriggered,
      },
      'Web query answered',
    );

    yield {
      type: 'answer',
      message: toPublic(message),
      credits: await this.credits.peek(user.id, user.role),
      charged,
    };
  }

  private async *answerSmallTalk(input: {
    user: UserRow;
    threadId: string;
    question: string;
    language: string;
  }): AsyncGenerator<ChatEvent> {
    const { user, threadId, question, language } = input;

    yield { type: 'stage', stage: 'generating' };

    const history = await this.chats.recentTurns(threadId, 4);

    let reply = '';
    try {
      reply = await this.rag.answerSmallTalk(
        question,
        language,
        user.full_name,
        history.slice(0, -1).map((turn) => ({ role: turn.role, content: turn.content })),
      );
    } catch (err) {
      this.logger.warn({ err }, 'Small talk generation failed - using the fixed greeting');
    }

    const message = await this.chats.appendMessage({
      threadId,
      userId: user.id,
      role: 'assistant',
      // A greeting is never worth failing a message over.
      content: reply.trim() || 'Namaste. What can I help you with?',
      intent: 'SMALL_TALK',
      creditsCharged: 0,
    });

    yield {
      type: 'answer',
      message: toPublic(message),
      credits: await this.credits.peek(user.id, user.role),
      charged: 0,
    };
  }
}

function toPublic(row: ChatMessageRow): PublicChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    intent: row.intent,
    citations: row.citations ?? [],
    structured: forBrowser(row.structured),
    creditsCharged: row.credits_charged,
    guardrailFlagged: row.guardrail_flagged,
    error: row.error_detail,
    createdAt: row.created_at,
  };
}

/**
 * One judgment, as the browser receives it.
 *
 * ## Why the fields are computed here and not in the browser
 *
 * This used to ship the row's raw columns and let the client decide how to
 * present them, and the client decided differently: WhatsApp rendered the seven
 * labelled fields the output format requires, while the web app rendered a
 * title, three pills and a paragraph of excerpt. Same query, same pipeline, two
 * different answers depending on which screen an advocate happened to open.
 *
 * The fields the format names are therefore assembled once, on the server, by
 * the same functions the WhatsApp card uses - `splitParties`, `legalPrinciple`,
 * the equivalent-citation filter. The two surfaces can now differ in styling,
 * which is what a renderer is for, and not in content, which is what a
 * requirement is for.
 *
 * Still an explicit projection rather than the row: `PrecedentRow` carries
 * retrieval internals - fusion scores, ranks, the total match count - which are
 * useful for debugging and meaningless to an advocate, and which would otherwise
 * be shipped to every client forever because nobody noticed they were there.
 */
export function toPublicPrecedent(row: PrecedentRow) {
  const { petitioner, respondent } = splitParties(row.case_title);

  const bench = row.bench?.length
    ? row.bench.join(', ')
    : row.bench_strength && row.bench_strength > 1
      ? `${row.bench_strength}-judge bench`
      : null;

  // The equivalents are the *other* citations. CASE NO. already carries the
  // neutral one, and printing it twice was how this read on WhatsApp for months.
  const equivalents = (row.reporter_citations ?? []).filter(
    (citation) => citation && citation !== row.neutral_citation,
  );

  return {
    id: row.judgment_id,
    title: stripEllipsis(row.case_title),

    // The seven required fields, in the order the format names them. Null means
    // the source has nothing; the client prints the same "Not available" the
    // WhatsApp card does rather than dropping the row.
    caseNo: row.neutral_citation,
    petitioner,
    respondent,
    date: row.judgment_date,
    bench,
    equivalentCitations: equivalents,
    legalPrinciple: legalPrinciple(row),
    // The longer summary, only on a judgment asked for by name - see
    // PrecedentsService.withSummary. WhatsApp prints it as FULL SUMMARY.
    fullSummary: row.generated_summary ?? null,
    notAvailable: NOT_AVAILABLE,

    court: row.court_name,
    courtType: row.court_type,
    sections: row.act_sections ?? [],
    disposition: row.disposition,
    sourceUrl: row.source_url,
  };
}
