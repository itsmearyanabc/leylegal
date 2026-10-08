import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { RetrievedChunk, StatuteRow } from '../database/types';
import { sameCitation } from './citation-match';
import { ClassifiedIntent } from './intent.service';
import { extractCitations, extractStatuteRefs } from './legal-patterns';
import { PROMPT_GIVEN_REFS } from './prompts';
import { LlmMessage } from './providers/llm-provider.interface';

/** The six criminal codes, whose section numbers are checked against what the model was given. */
const CODES = new Set(['IPC', 'BNS', 'CRPC', 'BNSS', 'IEA', 'BSA']);

/** "BNS 103(1)" -> "BNS 103". */
function baseRef(ref: string): string {
  const [act, section = ''] = ref.toUpperCase().split(' ');
  return `${act} ${section.split('(')[0]}`;
}

/**
 * Every section the model was given for this answer: the provisions found,
 * both sides of their official correspondence, the facts every prompt states
 * (prompts.ts, CRIMINAL_CODES), the provision asked about, and anything said
 * earlier in the conversation.
 */
export function groundedRefs(given: StatuteRow[], intent?: ClassifiedIntent, history: LlmMessage[] = []): Set<string> {
  const refs = new Set<string>(PROMPT_GIVEN_REFS.map(baseRef));
  for (const row of given) {
    refs.add(baseRef(`${row.act_code} ${row.section_number}`));
    for (const pair of row.correspondence ?? []) {
      for (const side of pair.split('=')) {
        const ref = side.trim().replace(/^CrPC\b/i, 'CRPC');
        if (ref) refs.add(baseRef(ref));
      }
    }
  }
  if (intent?.actCode && intent.sectionNumber) refs.add(baseRef(`${intent.actCode} ${intent.sectionNumber}`));
  for (const turn of history) for (const ref of extractStatuteRefs(turn.content)) refs.add(baseRef(ref));
  return refs;
}

/**
 * A sentence that classifies an offence: cognizable, bailable, compoundable.
 * In Hindi and Hinglish too.
 */
const CLASSIFICATION =
  /\b(?:non[- ]?)?(?:cogni[sz]able|bailable|compoundable)\b|संज्ञेय|जमानती|ज़मानती|शमनीय|\b(?:gair[- ]?)?(?:zamanati|jamanati)\b/i;

export const CLASSIFICATION_NOTE =
  '_Whether the offence is cognizable, bailable or compoundable is set out in the First Schedule to the BNSS, which Ley Legal does not hold yet, so it is left out here._';

/** A note after the answer - or alone, when nothing of the answer is left. */
function withNote(text: string, note: string): string {
  return text.trim() ? `${text}\n\n${note}` : note;
}

/**
 * Remove what the answer says about an offence's classification when nothing
 * it was given says it.
 *
 * Migration 0021 does not load the First Schedule ("cannot be read reliably"),
 * so the classification of almost every offence is absent - and the model
 * supplied it from memory: IPC 143 "non-bailable" (it is bailable), mischief
 * "cognizable" (simple mischief is not) (live test, 4 Oct, M-IPC-007,
 * M-IPC-053). The prompt already said "where the material states it"; this
 * makes it so. Kept when a provision given carries a classification, or uses
 * the word itself - BNSS 478 is about bailable offences.
 */
export function stripUnsupportedClassification(text: string, given: StatuteRow[]): { text: string; stripped: boolean } {
  const supported = given.some(
    (row) =>
      (row.punishment && (row.is_cognizable !== null || row.is_bailable !== null || row.is_compoundable !== null)) ||
      CLASSIFICATION.test(`${row.section_title} ${row.section_text}`),
  );
  if (supported || !CLASSIFICATION.test(text)) return { text, stripped: false };

  let stripped = false;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (!CLASSIFICATION.test(line)) {
      lines.push(line);
      continue;
    }
    // A heading or a bullet stays; what follows it is filtered sentence by sentence.
    const prefix = /^\s*(?:[-•*]\s+)?(?:\*[^*\n]{1,40}:\*\s*)?/.exec(line)?.[0] ?? '';
    const kept = line
      .slice(prefix.length)
      .split(/(?<=[.!?।])\s+/)
      .filter((sentence) => !CLASSIFICATION.test(sentence))
      .join(' ')
      .trim();
    stripped = true;
    if (kept) lines.push(`${prefix}${kept}`);
    else if (/\*[^*]+:\*/.test(prefix)) lines.push(prefix.trimEnd());
  }
  return { text: lines.join('\n'), stripped };
}

export interface GuardrailReport {
  /** The answer after removing anything that could not be verified. */
  text: string;
  /** Citations that survived verification. */
  verifiedCitations: string[];
  /** Fabricated references that were stripped. */
  removed: string[];
  /** Real, but not among the passages retrieved for this query. */
  flagged: string[];
  /** True if anything was removed or flagged - drives the auditor queue. */
  triggered: boolean;
  reason: string | null;
}

/**
 * Post-generation citation verification (spec section 9.2).
 *
 * This is the load-bearing safety control of the product. Prompt instructions
 * reduce how often a model invents a citation; they do not prevent it. A
 * fabricated "AIR 2019 SC 1234" that reads perfectly and does not exist is the
 * single worst thing this system could produce, because an advocate may repeat
 * it in court.
 *
 * So every case citation and every section number in the generated answer is
 * checked against the database before the message is sent, and there are two
 * distinct outcomes:
 *
 *   REMOVED - not in the corpus at all. Almost certainly fabricated. The text
 *             is struck from the answer and replaced with a visible marker, so
 *             the advocate sees that something was withheld rather than reading
 *             a subtly altered answer.
 *
 *   FLAGGED - real and present in the corpus, but not among the passages
 *             retrieved for this query. Probably drawn from model memory rather
 *             than the provided context. Kept (it is a genuine case) but
 *             recorded for auditor review.
 *
 * Erring towards removal is deliberate: a missing citation is an inconvenience,
 * a fabricated one is a professional liability.
 */
@Injectable()
export class GuardrailsService {
  private readonly logger = getLogger().child({ module: 'guardrails' });

  constructor(private readonly corpus: CorpusRepository) {}

  /**
   * `given`: the provisions the model was handed, for a section answer. With
   * it, a section number of the six codes that is none of them - nor their
   * official counterparts, nor a fact the prompt states - is struck, as an
   * invented one is: "BNS Section 302 - Ingredients of Criminal Intimidation"
   * was written for a question about a threat (live test, 4 Oct, B-10). BNS
   * 302 exists, so the database check alone passed it; intimidation is BNS
   * 351. And what the answer says about classification is removed unless
   * something given says it (stripUnsupportedClassification).
   */
  async verify(
    answer: string,
    retrieved: RetrievedChunk[],
    intent?: ClassifiedIntent,
    history: LlmMessage[] = [],
    given?: StatuteRow[],
    /**
     * Citations Indian Kanoon prints on the judgments the model was given
     * (rag.service.ts, answerPointOfLaw). Verified by that, in any spelling:
     * the ingested corpus they would otherwise be looked up in holds no
     * judgments, and "Shayara Bano v. Union of India [unverified]" was the
     * result (live test, 8 Oct, J-PL-44).
     */
    confirmed: string[] = [],
  ): Promise<GuardrailReport> {
    if (!answer.trim()) {
      return { text: answer, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null };
    }

    let classificationStripped = false;
    if (given) {
      const result = stripUnsupportedClassification(answer, given);
      answer = result.text;
      classificationStripped = result.stripped;
    }

    const all = extractCitations(answer);
    const onKanoon = all.filter((citation) => confirmed.some((c) => sameCitation(c, citation)));
    const citations = all.filter((citation) => !onKanoon.includes(citation));
    const statuteRefs = extractStatuteRefs(answer);
    const ungrounded = given ? this.ungrounded(statuteRefs, given, intent, history) : [];

    if (citations.length === 0 && statuteRefs.length === 0) {
      return {
        text: classificationStripped ? withNote(answer, CLASSIFICATION_NOTE) : answer,
        verifiedCitations: onKanoon,
        removed: [],
        flagged: [],
        triggered: classificationStripped,
        reason: classificationStripped ? 'unsupported classification removed' : null,
      };
    }

    // Everything the model was actually shown, normalised for comparison.
    const grounded = new Set<string>();
    for (const chunk of retrieved) {
      if (chunk.neutral_citation) grounded.add(this.normalise(chunk.neutral_citation));
      for (const reporter of chunk.reporter_citations ?? []) grounded.add(this.normalise(reporter));
    }
    for (const msg of history) {
      const historyCitations = extractCitations(msg.content);
      for (const cit of historyCitations) grounded.add(this.normalise(cit));
    }

    const [citationChecks, statuteChecks] = await Promise.all([
      this.corpus.verifyCitations(citations),
      this.corpus.verifyStatuteRefs(statuteRefs),
    ]);

    const removed: string[] = [];
    const flagged: string[] = [];
    const verified: string[] = [...onKanoon];

    for (const check of citationChecks) {
      if (!check.found) {
        removed.push(check.citation);
      } else if (!grounded.has(this.normalise(check.citation))) {
        flagged.push(check.citation);
        verified.push(check.citation);
      } else {
        verified.push(check.citation);
      }
    }

    const removedStatuteRefs: string[] = [];
    const askedStatute = intent?.actCode && intent?.sectionNumber
      ? `${intent.actCode} ${intent.sectionNumber}`.toUpperCase()
      : null;

    for (const check of statuteChecks) {
      if (!check.found) {
        if (askedStatute && check.ref === askedStatute) {
          // The advocate specifically asked for this provision, so repeating it is not a hallucination.
          continue;
        }
        removed.push(check.ref);
        removedStatuteRefs.push(check.ref);
      }
    }
    // Real sections, but not among those looked up for this question.
    const offTopic = ungrounded.filter((ref) => !removedStatuteRefs.includes(ref));

    let text = answer;
    for (const item of removed) {
      text = removedStatuteRefs.includes(item) ? this.strikeStatuteRef(text, item) : this.strike(text, item);
    }
    for (const ref of offTopic) text = this.strikeStatuteRef(text, ref);

    if (removed.length > 0) {
      // Without this the advocate cannot tell the answer was altered, and an
      // answer that quietly lost its authority reads as an unsupported
      // assertion.
      // "Case law database" alone was wrong whenever the struck reference was a
      // section - which, with a corpus of a few dozen sections, is most of them.
      text += "\n\n_One or more references could not be verified against Ley Legal's database of statutes and judgments and were removed._";
    }
    if (offTopic.length > 0) {
      text += '\n\n_A section number that was not among the provisions looked up for this question was removed._';
    }
    if (classificationStripped) text = withNote(text, CLASSIFICATION_NOTE);
    removed.push(...offTopic);

    const triggered = removed.length > 0 || flagged.length > 0 || classificationStripped;

    if (triggered) {
      this.logger.warn(
        { removed, flagged, citationCount: citations.length },
        'Guardrail modified a generated answer',
      );
    }

    return {
      text,
      verifiedCitations: verified,
      removed,
      flagged,
      triggered,
      reason: triggered
        ? [
            removed.length > 0 ? `${removed.length} unverifiable reference(s) removed` : null,
            flagged.length > 0 ? `${flagged.length} citation(s) not in retrieved context` : null,
            classificationStripped ? 'unsupported classification removed' : null,
          ]
            .filter(Boolean)
            .join('; ')
        : null,
    };
  }

  /**
   * The finished lines of an answer still being written, checked as verify()
   * checks the whole answer, for showing before the answer is complete.
   *
   * Every citation and section reference in `prefix` is looked up exactly as
   * verify() looks it up - the same queries, the same exception for the
   * provision the advocate asked about - and every one that fails is struck
   * the same way, before the text is returned. So nothing is shown that the
   * finished answer will not also show, and nothing fabricated is shown at all.
   * The note about removed references is left to verify(), which runs on the
   * whole answer once it is written and whose text is the one that is kept.
   *
   * `known` carries the verdicts across calls - "removed?" by reference - so a
   * reference is looked up once however many drafts it appears in. A failed
   * lookup throws: the caller stops showing drafts rather than show one
   * unchecked.
   */
  async verifiedDraft(
    prefix: string,
    intent: ClassifiedIntent | undefined,
    known: Map<string, boolean>,
    given?: StatuteRow[],
    history: LlmMessage[] = [],
    /** As verify()'s: citations Kanoon prints on the judgments given. */
    confirmed: string[] = [],
  ): Promise<string> {
    // The same two checks as verify(), line for line, so a draft never shows
    // what the finished answer will not.
    if (given) prefix = stripUnsupportedClassification(prefix, given).text;
    const citations = extractCitations(prefix).filter((citation) => !confirmed.some((c) => sameCitation(c, citation)));
    const statuteRefs = extractStatuteRefs(prefix);
    const ungrounded = given ? this.ungrounded(statuteRefs, given, intent, history) : [];
    const askedStatute = intent?.actCode && intent?.sectionNumber
      ? `${intent.actCode} ${intent.sectionNumber}`.toUpperCase()
      : null;

    const newCitations = citations.filter((c) => !known.has(`c:${c}`));
    const newRefs = statuteRefs.filter((r) => !known.has(`s:${r}`));
    const [citationChecks, statuteChecks] = await Promise.all([
      newCitations.length > 0 ? this.corpus.verifyCitations(newCitations) : Promise.resolve([]),
      newRefs.length > 0 ? this.corpus.verifyStatuteRefs(newRefs) : Promise.resolve([]),
    ]);
    for (const check of citationChecks) known.set(`c:${check.citation}`, !check.found);
    for (const check of statuteChecks) known.set(`s:${check.ref}`, !check.found && check.ref !== askedStatute);

    // A reference the lookup did not answer for is not shown as checked.
    if (citations.some((c) => !known.has(`c:${c}`)) || statuteRefs.some((r) => !known.has(`s:${r}`))) {
      throw new Error('A reference in the draft was not verified');
    }

    let text = prefix;
    for (const citation of citations) if (known.get(`c:${citation}`)) text = this.strike(text, citation);
    for (const ref of statuteRefs) if (known.get(`s:${ref}`) || ungrounded.includes(ref)) text = this.strikeStatuteRef(text, ref);
    return text;
  }

  /** The section references of the six codes in an answer that the model was not given. */
  private ungrounded(refs: string[], given: StatuteRow[], intent?: ClassifiedIntent, history: LlmMessage[] = []): string[] {
    const grounded = groundedRefs(given, intent, history);
    return refs.filter((ref) => CODES.has(ref.split(' ')[0]) && !grounded.has(baseRef(ref)));
  }

  /** Strip punctuation and case so "AIR 2018 S.C. 1234" matches "AIR 2018 SC 1234". */
  private normalise(citation: string): string {
    return citation.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  }

  /**
   * Remove one reference from the answer.
   *
   * Also drops a wrapping parenthesis pair, so striking the citation out of
   * "*Case Name* (AIR 2019 SC 1234)" does not leave "*Case Name* ()".
   */
  private strike(text: string, reference: string): string {
    const escaped = this.escapeRegex(reference);
    return text
      .replace(new RegExp(`\\(\\s*${escaped}\\s*\\)`, 'gi'), '[unverified]')
      .replace(new RegExp(escaped, 'gi'), '[unverified]');
  }

  /**
   * Remove a statutory reference.
   *
   * Statute refs are normalised to "ACT SECTION" ("IPC 999") for verification,
   * but the answer text says "section 999 IPC" or "IPC Section 999". Searching
   * for the normalised form finds nothing, so the invented section would stay
   * in the reply while being reported as removed - the worst possible
   * combination. Both word orders are struck instead.
   */
  private strikeStatuteRef(text: string, ref: string): string {
    const [act, section] = ref.split(' ');
    if (!act || !section) return text;

    const a = this.escapeRegex(act);
    const s = this.escapeRegex(section);

    return (
      text
        // "section 999 IPC", "u/s 999 IPC", "999 IPC"
        .replace(
          new RegExp(`\\b(?:u/s|under\\s+sections?|sections?|secs?|s)?\\.?\\s*${s}\\s*(?:of\\s+(?:the\\s+)?)?${a}\\b`, 'gi'),
          '[unverified]',
        )
        // "IPC 999", "IPC Section 999"
        .replace(new RegExp(`\\b${a}\\s*(?:sections?|secs?|s)?\\.?\\s*${s}\\b`, 'gi'), '[unverified]')
    );
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
