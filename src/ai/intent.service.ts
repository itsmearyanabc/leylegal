import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { QueryIntent } from '../database/types';
import { extractCaseName } from './case-name';
import { isAcknowledgement, isMenuWord } from './conversational';
import {
  ActCode,
  extractArticleReference,
  extractCnr,
  extractOrderReference,
  extractSectionReference,
  isValidCnr,
  namedActs,
  recodifiedReference,
  normaliseActCode,
} from './legal-patterns';
import { INTENT_CLASSIFIER_SYSTEM } from './prompts';
import { LlmMessage, parseJsonLoose } from './providers/llm-provider.interface';
import { ProviderRegistry } from './providers/provider.registry';

export interface ClassifiedIntent {
  intent: QueryIntent;
  language: string;
  cnrNumber: string | null;
  sectionNumber: string | null;
  actCode: ActCode | null;
  /**
   * The Act named when it is none of the codes act_code covers, by its full
   * title - "NI Act" -> "Negotiable Instruments Act, 1881". Without it a
   * question about "section 138 NI Act" carried only a number, and the search
   * found BNS 138, BNSS 138 and BSA 138: three sections of the wrong laws.
   * It is also what the official text is looked up by (StatuteFetcher).
   */
  actName?: string | null;
  /** Query rewritten in English legal terminology, for retrieval. */
  searchQuery: string;
  /**
   * What the advocate actually typed, before the model touched it.
   *
   * `searchQuery` is a rewrite aimed at retrieval, and it is the wrong input
   * for anything that needs to know what was *asked*. "case of Rajesh Kumar
   * Mittal vs State of Bihar . Patna High court" came back from the router as
   * "case law for Rajesh Kumar Mittal vs State of Bihar in Patna High Court" -
   * good for search, and reading a cause title out of it produced the parties
   * "law for Rajesh Kumar Mittal" and "State of Bihar in Patna High Court".
   *
   * Required rather than optional, so a caller cannot silently fall back to
   * the rewrite and reintroduce that.
   */
  rawText: string;
  confidence: number;
}

const VALID_INTENTS: readonly QueryIntent[] = [
  'CASE_STATUS',
  'SECTION_LOOKUP',
  'PRECEDENT_SEARCH',
  'DRAFTING_HELP',
  'GENERAL_LEGAL',
  'SMALL_TALK',
  'MENU_NAVIGATION',
  'UNSUPPORTED',
];

/**
 * Stage one of the pipeline: work out what the user wants and in what language.
 *
 * Everything downstream branches on this, so it runs on the cheap router model
 * and is defended on both sides - deterministic extraction first, the model
 * second, and rule-based fallback if the model output is unusable.
 */
@Injectable()
export class IntentService {
  private readonly logger = getLogger().child({ module: 'intent' });

  constructor(private readonly registry: ProviderRegistry) {}

  async classify(text: string, history: LlmMessage[] = []): Promise<ClassifiedIntent> {
    // Deterministic extraction first. A CNR or section number found by regex is
    // more reliable than one transcribed by a model, and it gives us a correct
    // answer even if the LLM call fails entirely.
    const regexCnr = extractCnr(text);
    const { section: regexSection, act: regexAct } = extractSectionReference(text);
    // An Order of the CPC and an Article of the Constitution are both
    // provisions the section matcher cannot see, and both were being answered
    // with case law. Treated identically from here down.
    const regexOrder = extractOrderReference(text) ?? extractArticleReference(text);

    // Some messages do not need a model to understand. Answering them still
    // cost a full router round trip - roughly a second of the advocate's time,
    // and a billed call - before the switch downstream threw the classification
    // away and sent a fixed menu. See fastPath() for what qualifies.
    const fast = this.fastPath(text, regexCnr, regexOrder, regexAct);
    if (fast) {
      this.logger.debug({ intent: fast.intent }, 'Intent resolved without the router model');
      return fast;
    }

    let classified: ClassifiedIntent;

    try {
      const result = await this.registry.complete({
        task: 'router',
        system: INTENT_CLASSIFIER_SYSTEM,
        messages: [...history.slice(-4), { role: 'user', content: text }],
        json: true,
        maxTokens: 512,
      });

      const parsed = parseJsonLoose<Record<string, unknown>>(result.text);
      classified = parsed ? this.fromModel(parsed, text) : this.heuristic(text, regexCnr, regexSection, regexAct);
    } catch (err) {
      this.logger.warn({ err }, 'Intent classification failed; using heuristic fallback');
      classified = this.heuristic(text, regexCnr, regexSection, regexAct);
    }

    // Regex wins where it found something concrete - the model occasionally
    // drops a digit when copying a 16-character CNR.
    if (regexCnr) {
      classified.cnrNumber = regexCnr;
      if (classified.intent === 'GENERAL_LEGAL') classified.intent = 'CASE_STATUS';
    }
    /*
     * A year is not a section.
     *
     * "Mere client par 2023 mein 420 IPC ka case hua tha" came back from the
     * router as IPC section 2023, and was answered "Section 2023 of the IPC
     * does not exist" - a realistic question, completely misread. A year the
     * advocate never wrote as a section gives way to the section they did write.
     */
    if (classified.sectionNumber && isYearNotSection(classified.sectionNumber, text)) {
      classified.sectionNumber = regexSection;
    }
    if (regexSection && !classified.sectionNumber) classified.sectionNumber = regexSection;
    if (regexAct && !classified.actCode) classified.actCode = regexAct;

    /*
     * The act the advocate wrote beats the act the router read.
     *
     * BNS and BNSS differ by one letter and are both "the new criminal code";
     * a router that reads "Section 520 BNSS" as BNS sends the question to a
     * section that does not exist - or, for a number both codes have, to the
     * wrong provision entirely. When the message names exactly one act, there
     * is nothing to interpret. Two named acts are left to the router and to
     * recodifiedReference() below.
     */
    if (regexAct && classified.actCode && classified.actCode !== regexAct && namedActs(text).size === 1) {
      classified.actCode = regexAct;
    }

    /*
     * An Order of the CPC is a provision, not a research topic.
     *
     * "order 32 CPC" was classified PRECEDENT_SEARCH and answered with ten
     * unrelated Patna judgments. The model has no reliable sense of this - it
     * sees the word "order" and thinks of judgments - but the regex is certain,
     * so the regex decides. Same principle as the CNR override above.
     *
     * DRAFTING_HELP is left alone: "draft an application under Order 39" is a
     * drafting request that happens to name a provision.
     */
    if (
      regexOrder &&
      !asksForJudgments(text) &&
      (classified.intent === 'PRECEDENT_SEARCH' || classified.intent === 'GENERAL_LEGAL')
    ) {
      classified.intent = 'SECTION_LOOKUP';
    }
    if (regexOrder && !classified.sectionNumber) classified.sectionNumber = regexOrder;
    if (regexOrder?.startsWith('Article') && !classified.actCode) classified.actCode = 'COI';

    /*
     * A summary of a named judgment is a judgment search.
     *
     * "summary of Vishaka vs State of Rajasthan in 100 words" was classified
     * GENERAL_LEGAL and answered from the model's own memory of the case,
     * signed off "unverified against the corpus". The search finds the
     * judgment itself and summarises what it actually says - the one thing a
     * model recalling a famous case is least reliable at. The router is told
     * this too; the rule is here because a router that forgets it costs an
     * advocate an unverified answer.
     */
    if (classified.intent === 'GENERAL_LEGAL' && asksAboutNamedJudgment(text)) {
      classified.intent = 'PRECEDENT_SEARCH';
    }

    /*
     * A question about the recodification names the provision on one side.
     *
     * "CrPC 125 maintenance - which section in BNSS?" came back from the router
     * as BNSS 125 - a real, different section - and was answered from memory
     * with the right BNSS number struck out. See recodifiedReference(). The
     * intent is left alone unless it was the catch-all: "judgments on CrPC 125
     * under the BNSS" is still a judgment search.
     */
    /*
     * "Which section is it?" is a section question with the number unknown.
     *
     * "What is the BNS section for organised crime, and was there any
     * equivalent in the IPC?" was classified GENERAL_LEGAL and answered from
     * memory: "the BNS (Bihar and Maharashtra Special) Act ... Section 3". As a
     * section lookup the codes are searched for the subject, and BNS 111 is
     * found in its enacted text.
     */
    if (classified.intent === 'GENERAL_LEGAL' && !classified.sectionNumber && asksWhichSection(text) && !asksForJudgments(text)) {
      classified.intent = 'SECTION_LOOKUP';
    }

    const recodified = recodifiedReference(text);
    if (recodified) {
      classified.actCode = recodified.act;
      classified.sectionNumber = recodified.section;
      if (classified.intent === 'GENERAL_LEGAL') classified.intent = 'SECTION_LOOKUP';
    }

    return classified;
  }

  /**
   * Messages a model cannot classify better than a regex can.
   *
   * This is deliberately narrow, and it is *not* the heuristic fallback below.
   * The fallback is a best effort at every intent when the model is unavailable;
   * this is a short list of cases where the answer is not in doubt, so paying a
   * router call for it buys nothing:
   *
   *   - **menu / help** goes straight to `sendMainMenu`. The classification was
   *     discarded either way, so the call was pure latency.
   *   - **a bare greeting** is small talk by construction. "hi" cannot be a
   *     section lookup. Anchored and length-capped so "thanks, now what does
   *     section 420 cover" still reaches the model.
   *   - **a message that is only a CNR** is a case-status lookup, and the regex
   *     already extracted it more reliably than the model would have.
   *
   * Everything else - and in particular section-lookup vs precedent-search, which
   * turns on phrasing rather than pattern - still goes to the model. Guessing
   * there would trade a second of latency for a wrong answer.
   *
   * Language detection degrades to a script check on this path. That is
   * acceptable because none of these branches generate prose from the query: the
   * menu is templated, and small talk passes the raw text to the LLM anyway.
   */
  private fastPath(
    text: string,
    cnr: string | null,
    order: string | null = null,
    act: ActCode | null = null,
  ): ClassifiedIntent | null {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    const language = /[ऀ-ॿ]/.test(trimmed) ? 'hi' : 'en';

    const base = {
      language,
      cnrNumber: cnr,
      sectionNumber: null,
      actCode: null,
      searchQuery: trimmed,
      rawText: text,
    };

    if (isMenuWord(lower)) {
      return { ...base, intent: 'MENU_NAVIGATION', confidence: 0.99 };
    }

    /*
     * Acknowledgements, not questions.
     *
     * The list moved to ai/conversational.ts, because the session router needs
     * the same judgement one step earlier - it takes the credit *before* this
     * method ever runs, so a list that lived only here could stop a wasted
     * model call but never a wasted charge.
     */
    if (isAcknowledgement(trimmed)) {
      return { ...base, intent: 'SMALL_TALK', confidence: 0.99 };
    }

    // Only when the CNR is the entire message. "status of ABCD01..." may carry a
    // question the model should see.
    if (cnr && trimmed.replace(/[\s-]/g, '').length === cnr.length) {
      return { ...base, intent: 'CASE_STATUS', confidence: 0.99 };
    }

    /*
     * A bare Order reference - "order 32 CPC", "O.37 R.3".
     *
     * Short and unambiguous, so it does not need the router model, and the
     * router model gets it wrong: it reads "order" as "judgment" and sends a
     * procedural question to case-law search. Length-capped so "what did the
     * court hold about Order 39 injunctions in NDPS matters" still reaches the
     * model, which is genuinely a research question.
     */
    if (order && trimmed.length <= 32 && !asksForJudgments(trimmed)) {
      return {
        ...base,
        intent: 'SECTION_LOOKUP',
        sectionNumber: order,
        // An Article belongs to the Constitution and nothing else; an Order,
        // absent any other act named, is the CPC's.
        actCode: act ?? (order.startsWith('Article') ? 'COI' : 'CPC'),
        confidence: 0.97,
      };
    }

    return null;
  }

  private fromModel(parsed: Record<string, unknown>, original: string): ClassifiedIntent {
    const rawIntent = String(parsed.intent ?? '').toUpperCase() as QueryIntent;

    return {
      intent: VALID_INTENTS.includes(rawIntent) ? rawIntent : 'GENERAL_LEGAL',
      language: this.normaliseLanguage(parsed.language),
      cnrNumber: cnrFrom(parsed.cnr_number),
      sectionNumber: parsed.section_number ? String(parsed.section_number).toUpperCase() : null,
      actCode: normaliseActCode(parsed.act_code ? String(parsed.act_code) : null),
      actName: typeof parsed.act_name === 'string' && parsed.act_name.trim() ? parsed.act_name.trim().slice(0, 160) : null,
      searchQuery: parsed.search_query ? String(parsed.search_query) : original,
      rawText: original,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
    };
  }

  private normaliseLanguage(value: unknown): string {
    const code = String(value ?? 'en')
      .toLowerCase()
      .slice(0, 2);
    return /^[a-z]{2}$/.test(code) ? code : 'en';
  }

  /**
   * Rule-based fallback.
   *
   * Not a great classifier, but it keeps the bot answering when the router
   * model is unavailable, which beats replying "sorry, try again" to someone
   * standing outside a courtroom.
   */
  private heuristic(
    text: string,
    cnr: string | null,
    section: string | null,
    act: ActCode | null,
  ): ClassifiedIntent {
    const lower = text.toLowerCase().trim();

    // Devanagari covers Hindi and Marathi; a script check is the best we can do
    // without the model, and getting the script right matters more than the
    // exact language for reply formatting.
    const language = /[ऀ-ॿ]/.test(text) ? 'hi' : 'en';

    let intent: QueryIntent = 'GENERAL_LEGAL';
    if (cnr) intent = 'CASE_STATUS';
    else if (section || act) intent = 'SECTION_LOOKUP';
    else if (/\b(menu|help|start|options|मदद|मेन्यू)\b/.test(lower)) intent = 'MENU_NAVIGATION';
    else if (/^(hi|hello|hey|namaste|hola|thanks|thank you|ok|okay|नमस्ते|धन्यवाद)\b/.test(lower))
      intent = 'SMALL_TALK';
    else if (/\b(precedent|judgment|judgement|case law|ruling|held|citation|authority)\b/.test(lower))
      intent = 'PRECEDENT_SEARCH';
    else if (/\b(draft|notice|petition|affidavit|application|reply)\b/.test(lower)) intent = 'DRAFTING_HELP';

    return {
      intent,
      language,
      cnrNumber: cnr,
      sectionNumber: section,
      actCode: act,
      searchQuery: text,
      rawText: text,
      confidence: 0.3,
    };
  }
}

/**
 * Is this a request about one named judgment - its summary, facts or holding?
 *
 * Two things must both be true. The message names a case, and it asks for
 * what a judgment says. The second is what keeps prose out: "bail vs
 * anticipatory bail" parses as a cause title, and sending it to a name lookup
 * would answer a legal question with "no judgment found by that name".
 */
/**
 * The model's cnr_number, only if it is a CNR.
 *
 * It was taken as given. "Check the status of CNR 831/2024" - a filing number,
 * copied off the case card above it - came back with cnr_number "831/2024", and
 * the lookup was charged, sent to eCourts, refunded, and reported as "No case
 * found for CNR 831/2024": as though the case did not exist, when what was sent
 * was never a CNR at all.
 */
/**
 * True for a number shaped like a year (1800-2099) that the text never names
 * as a provision - not "section 2023", "s. 2023", "u/s 2023", "Article 2023"
 * or "2023 IPC". Written that way it is the advocate's number, and a section
 * outside the Act's range is answered as one that does not exist.
 */
export function isYearNotSection(section: string, text: string): boolean {
  if (!/^(18|19|20)\d\d$/.test(section)) return false;
  const named = new RegExp(
    `\\b(?:u\\/s|section|sec|s|article|art|order|rule)\\.?\\s*${section}\\b|\\b${section}\\s+(?:ipc|bns|crpc|bnss|iea|bsa|cpc)\\b|\\b(?:ipc|bns|crpc|bnss|iea|bsa|cpc)\\s*(?:section|sec|s)?\\.?\\s*${section}\\b`,
    'i',
  );
  return !named.test(text);
}

function cnrFrom(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const cnr = String(value).toUpperCase().replace(/[\s\-_/]/g, '');
  return isValidCnr(cnr) ? cnr : null;
}

/** Does the question ask which provision covers something - "which section", "kaunsi dhara"? */
export function asksWhichSection(text: string): boolean {
  return (
    /\b(?:which|what)\b[^?.]{0,40}?\b(?:section|provision)s?\b/i.test(text) ||
    /\bsections?\s+(?:for|on|dealing\s+with|covering|that\s+(?:covers?|deals?|applies))\b/i.test(text) ||
    /\bkaun\s*s[aie]\b.{0,25}\b(?:section|dhara)\b|\b(?:section|dhara)\b.{0,25}\bkaun\s*s[aie]\b/i.test(text) ||
    // No \b here: JavaScript's word boundary does not see Devanagari letters.
    /कौन\s*(?:सी|सा)\s*(?:धारा|section)|(?:धारा|section)\s*कौन\s*(?:सी|सा)/i.test(text)
  );
}

export function asksAboutNamedJudgment(text: string): boolean {
  if (!extractCaseName(text)) return false;
  return (
    /\b(summary|summari[sz]e|synopsis|gist|ratio|holding|facts|saar)\b/i.test(text) ||
    // No \b here: JavaScript's word boundary does not see Devanagari letters.
    /सारांश/.test(text) ||
    /\b(case|judg(?:e)?ment|decision|ruling)\s+(?:of|in|titled)\b/i.test(text)
  );
}

/**
 * Did the advocate ask for judgments, rather than for what a provision says?
 *
 * ## Why the Order override needs this
 *
 * "order 32 CPC" is a provision lookup and the router model gets it wrong,
 * reading "order" as "judgment" - so the regex overrides it. That override was
 * unconditional, and it swallowed the opposite case: "list of judgements for
 * order 32 cpc" was forced to SECTION_LOOKUP, found no CPC text in the corpus,
 * and answered "I don't have a specific list of judgments for Order 32 CPC.
 * You might need to look into legal databases" - to a bot whose entire third
 * feature is a judgment database.
 *
 * The provision is the *subject* of that question, not the request. When the
 * advocate has named the thing they want, they are not guessing and the model
 * is not needed: the words are explicit, so they decide.
 *
 * Kept narrow deliberately. "What does Order 32 provide" and "explain Order 37
 * Rule 3" say nothing about judgments and must still be overridden, or the
 * original bug comes straight back.
 */
export function asksForJudgments(text: string): boolean {
  return /\b(judgment|judgement|judgments|judgements|case\s*laws?|precedents?|rulings?|authorit(?:y|ies)|citations?|decisions?|digests?)\b/i.test(
    text,
  );
}
