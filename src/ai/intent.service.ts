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
  namedOtherAct,
  recodifiedReference,
  normaliseActCode,
} from './legal-patterns';
import { INTENT_CLASSIFIER_SYSTEM } from './prompts';
import { nonexistentProvision } from './provision-range';
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
     * A CNR is the advocate's, never the router's - the same rule as a
     * section number below.
     *
     * "Check status of CNR ABCD1234" came back with cnr_number
     * "ABCD123400002024", padded out to sixteen characters; it was looked up,
     * and the web search charged a credit for instructions on using eCourts
     * (live test, 6 October, NC1). A CNR written neither in the question nor
     * earlier in the conversation is dropped, and the reply asks for the CNR.
     */
    if (!regexCnr && classified.cnrNumber && !cnrWrittenIn(classified.cnrNumber, [text, ...history.map((m) => m.content)])) {
      classified.cnrNumber = null;
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
    /*
     * A section number is the advocate's, never the router's.
     *
     * "What is the punishment for dowry death under the BNS?" came back as BNS
     * 304B, and "theft ka case hai ... bail kis section mein?" as BNS 378 - the
     * old IPC numbers, from the model's memory - and both were answered "does
     * not exist" (live test of 4 October, X2 and X34). A number written neither
     * in the question nor earlier in the conversation is dropped, and the
     * subject search finds the section in the Act's own text.
     */
    if (classified.sectionNumber && !writtenIn(classified.sectionNumber, [text, ...history.map((m) => m.content)])) {
      classified.sectionNumber = regexSection;
    }
    if (regexSection && !classified.sectionNumber) classified.sectionNumber = regexSection;
    if (regexAct && !classified.actCode) classified.actCode = regexAct;

    /*
     * An Act the advocate named that is none of the codes is the Act asked
     * about.
     *
     * "What are the ingredients of Section 138 of the Negotiable Instruments
     * Act?" came back from the router once as BNS 138 - abduction - and was
     * answered "The corpus doesn't cover Section 138 of the Negotiable
     * Instruments Act"; minutes earlier the same question had been answered
     * from the Act's official text (live, 4 October). A code the question does
     * not name gives way to the Act it does.
     */
    const otherAct = namedActs(text).size === 0 ? namedOtherAct(text) : null;
    if (otherAct) {
      classified.actCode = null;
      classified.actName ??= otherAct;
    }

    /*
     * An Act the advocate did not name is not a reason to say the section does
     * not exist.
     *
     * "धारा 420 में जमानत मिलती है क्या?" names no Act; the router chose the BNS
     * and the reply was "Section 420 of the BNS does not exist" (X20). Every
     * advocate means IPC 420. When the number is past the end of the new code
     * the router guessed, and inside the code it replaced, it is that one.
     */
    const replaced = classified.actCode ? OLD_CODE_FOR[classified.actCode] : undefined;
    if (
      replaced &&
      namedActs(text).size === 0 &&
      nonexistentProvision(classified.actCode, classified.sectionNumber) &&
      !nonexistentProvision(replaced, classified.sectionNumber)
    ) {
      classified.actCode = replaced;
    }

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

    /*
     * A provision question that asks for the case that decided it is a
     * judgment search.
     *
     * "Compensation for custodial death under Article 32 - leading case" and
     * "Which case held that the procedure under Article 21 must be just, fair
     * and reasonable?" were read as section lookups on Articles 32 and 21, and
     * answered by the model from memory: "the corpus doesn't cover a specific
     * leading case", and Maneka Gandhi tagged "[unverified]" with no citation.
     * "धारा 482 CrPC ... सुप्रीम कोर्ट का फैसला" the same way, Bhajan Lal
     * "[unverified]" (live tests, J-PL-14, S-SL-02, J-PL-70). The words are
     * explicit, so they decide - after every rule above that can set
     * SECTION_LOOKUP, so none of them undoes it.
     */
    if (classified.intent === 'SECTION_LOOKUP' && asksWhichCase(text)) {
      classified.intent = 'PRECEDENT_SEARCH';
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
    if (order && trimmed.length <= 32 && !asksForJudgments(trimmed) && !asksWhichCase(trimmed)) {
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
      sectionNumber: sectionFrom(parsed.section_number),
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
/** The code each of the 2023 codes replaced. */
const OLD_CODE_FOR: Partial<Record<ActCode, ActCode>> = { BNS: 'IPC', BNSS: 'CRPC', BSA: 'IEA' };

/** Whether the number of a provision - "304B", "Order 39 Rule 1", "Article 21" - appears in any of these texts. */
export function writtenIn(provision: string, texts: string[]): boolean {
  const number = /\d+/.exec(provision)?.[0];
  if (!number) return false;
  const standalone = new RegExp(`(?:^|[^0-9])${number}(?:[^0-9]|$)`);
  return texts.some((t) => standalone.test(t));
}

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

/**
 * The router's section number, kept only when it is one: "302", "498A",
 * "103(1)", "Article 21", "Order 39 Rule 1".
 *
 * "जमानत के लिए कौन सी section? BNS में" came back with section_number "bail
 * sections", and was answered "I don't have the official text of Section BAIL
 * SECTIONS of the BNS" - with a credit spent on the web for it.
 */
const PROVISION = /^(?:(?:SECTION|SEC\.?|ARTICLE|ART\.?|ORDER)\s*)?\d+[A-Z]{0,3}(?:\s*\(\s*[0-9A-Z]+\s*\))*(?:\s+RULE\s+\d+[A-Z]?(?:\s*\(\s*[0-9A-Z]+\s*\))*)?$/;

function sectionFrom(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  /*
   * "SECTION 106" is section 106. Kept with the word, it was printed as "I
   * don't have the official text of Section SECTION 106 of the BSA" (live
   * test, 4 Oct, M-IEA-024). Articles and Orders keep theirs - "Article 21"
   * and "Order 39" are how those provisions are named.
   */
  const section = String(value).trim().toUpperCase().replace(/^(?:SECTION|SEC\.?)\s*/, '');
  return PROVISION.test(section) ? section : null;
}

function cnrFrom(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const cnr = String(value).toUpperCase().replace(/[\s\-_/]/g, '');
  return isValidCnr(cnr) ? cnr : null;
}

/** Whether a CNR appears in any of these texts, however its separators were typed. */
export function cnrWrittenIn(cnr: string, texts: string[]): boolean {
  return texts.some((t) => t.toUpperCase().replace(/[\s\-_/]/g, '').includes(cnr));
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

/**
 * A request to write the student's assignment, essay or dissertation.
 *
 * "Write my 2,000-word assignment on Article 21" was declined in words - and
 * charged two credits as a section lookup (live test, 4 Oct, S-MT-07). The
 * homepage says Ley Legal is "not built to write your assignment"; the reply
 * is now fixed and free (web/chat.service.ts).
 */
export function asksToWriteAssignment(text: string): boolean {
  return (
    /\b(?:write|draft|prepare|make)\b[^.?!\n]{0,40}\b(?:assignment|essay|dissertation|thesis|term\s+paper|project\s+report|homework)s?\b/i.test(text) ||
    /\b\d[\d,]*\s*-?\s*words?\s+(?:assignment|essay|answer)\b/i.test(text)
  );
}

export const ASSIGNMENT_REPLY =
  "Ley Legal is not built to write assignments. It can find what you would cite in one: ask for the leading judgments " +
  'on your topic, or for the sections that apply, and build the assignment from those.';

/**
 * Requests for something Ley Legal does not do, and questions about Ley Legal
 * itself: a fixed reply, free, like the assignment one above.
 *
 * Each was answered by the model and charged two credits (live test, 8 Oct):
 * "Give me 10 MCQs on BNSS for judiciary prelims" got a quiz with a question
 * that had no right option (S-MT-05) - practice questions are "Planned" on the
 * homepage, not live; "Track all my cases automatically" got "I can't automate
 * case tracking" (C-19); "Is your answer legal advice?" got a correct "no"
 * (B-13), free the day before. Narrow on purpose: each pattern names the
 * request itself, so a legal question that mentions a quiz or a case is still
 * answered as one.
 */
export function productReply(text: string): string | null {
  if (/\b(?:mcqs?|quiz(?:zes)?|multiple[\s-]+choice|objective\s+questions?|mock\s+(?:tests?|papers?|exams?)|practice\s+(?:questions?|tests?|sets?|papers?)|flash\s*cards?)\b/i.test(text)) {
    return PRACTICE_REPLY;
  }
  if (
    // "track all my cases", "monitor my pending matters" - not "can the police track my phone in criminal cases".
    /\b(?:track|monitor|keep\s+track\s+of|follow\s+up\s+on)\s+(?:all\s+)?(?:of\s+)?(?:my|our|the|these|those|his|her|their|client'?s?)?\s*(?:\w+\s+)?(?:cases?|matters?|hearings?)\b/i.test(text) ||
    /\b(?:alerts?|notif(?:y|ications?)|reminders?|remind\s+me)\b[^.?!\n]{0,25}\b(?:hearings?|hearing\s+dates?|next\s+(?:hearing\s+)?dates?|my\s+cases?)\b/i.test(text)
  ) {
    return TRACKING_REPLY;
  }
  if (/\b(?:you|your|ley\s*legal|this\s+(?:app|tool|bot|service))\b[^.?!\n]{0,40}\blegal\s+advice\b|\blegal\s+advice\b[^.?!\n]{0,30}\b(?:you|your|ley\s*legal)\b/i.test(text)) {
    return ADVICE_REPLY;
  }
  return null;
}

export const PRACTICE_REPLY =
  'Practice questions and MCQs are not live in Ley Legal yet - "New criminal laws practice" is planned for students. ' +
  'For now, ask about any BNS, BNSS or BSA section and its old-code counterpart, and Ley Legal will explain it from the Act\'s own text.';

export const TRACKING_REPLY =
  'Ley Legal does not track cases or send hearing alerts. You can look up a case\'s current status at any time by sending ' +
  'its 16-character CNR number - one credit per lookup.';

export const ADVICE_REPLY =
  'No. Ley Legal is a research tool for advocates: it finds the sections and judgments that bear on a question and shows where ' +
  'each one comes from. It is not legal advice - read every authority in full and apply your own judgment before relying on it.';

/**
 * "Which case held ...", "leading case on ...", "landmark judgment", and in
 * Hindi "सुप्रीम कोर्ट का फैसला" - a request for the judgment that decided a
 * point. Narrow on purpose: "decision" and "निर्णय" alone are also how a
 * provision question is asked ("decision of the Magistrate under BNSS 175").
 */
export function asksWhichCase(text: string): boolean {
  return (
    /\b(?:which|what)\s+(?:case|judg(?:e)?ment)s?\b|\b(?:leading|landmark)\s+(?:case|judg(?:e)?ment|decision)s?\b/i.test(text) ||
    // No \b: JavaScript's word boundary does not see Devanagari letters.
    /(?:सुप्रीम|उच्चतम|हाई|उच्च)\s*(?:कोर्ट|न्यायालय)\s*(?:का|के|की)\s*(?:फ़ैसल|फ़ैसल|फैसल|निर्णय)/.test(text)
  );
}

/**
 * A question whose answer is one judgment, described rather than named: "which
 * case laid down the basic structure doctrine", "custodial death under Article
 * 32 - leading case", "Nandini Satpathy judgment ka citation aur holding",
 * "यह किस मामले में तय हुआ?".
 *
 * The leading judgment came first for each in the live test of 8 Oct, and then
 * nine unrelated ones followed - "9X Media vs TRAI" under Kesavananda (S-SL-01,
 * 02, 03, 27, 28; J-PL-14; J-NL-24). For these the leading judgments are the
 * answer, and nothing is added to them (precedents.service.ts). A question
 * that asks for several - "judgments", "cases", "authorities" - is not one.
 */
export function asksForOneJudgment(text: string): boolean {
  if (/\b(?:judg(?:e)?ments|cases|authorities|precedents|rulings|decisions|citations)\b/i.test(text)) return false;
  return (
    /\b(?:which|what)\s+(?:[\w'-]+\s+){0,3}?(?:case|judg(?:e)?ment)\b(?!\s+(?:law|status|number))/i.test(text) ||
    /\b(?:leading|landmark)\s+(?:case|judg(?:e)?ment|decision)\b(?!\s+law)/i.test(text) ||
    // "Nandini Satpathy judgment ka citation aur holding batao"
    /\b(?:judg(?:e)?ment|case|faisla|faisle)\s+(?:ka|ki|ke)\s+(?:citation|holding|ratio)\b/i.test(text) ||
    // No \b: JavaScript's word boundary does not see Devanagari letters.
    /किस\s+(?:मामले|मुकदमे|मुक़दमे|केस|फ़ैसले|फैसले|निर्णय)|(?:मामले|केस|फ़ैसले|फैसले)\s+(?:का|की)\s+(?:साइटेशन|उद्धरण)/.test(text)
  );
}

/**
 * A request for authorities to argue from - "authorities on both sides", "for
 * my memorial", "landmark judgments" - which the Supreme Court decides.
 *
 * The advocate's own High Court is searched for every topic question and put
 * first. For these it filled the list with recent bail orders that had nothing
 * to do with the proposition: "authorities for 'bail is the rule, jail is the
 * exception' for my memorial" got seven Delhi High Court bail orders under
 * Balchand, Sanjay Chandra and Arnesh Kumar (live test, 8 Oct, S-MT-03; S-MT-02
 * the same).
 */
export function seeksAuthorities(text: string): boolean {
  return /\b(?:authorit(?:y|ies)|memorial|moot|landmark|leading)\b/i.test(text);
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
