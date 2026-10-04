import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { RetrievedChunk } from '../database/types';
import { ClassifiedIntent } from './intent.service';
import { extractCitations, extractStatuteRefs } from './legal-patterns';
import { LlmMessage } from './providers/llm-provider.interface';

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

  async verify(answer: string, retrieved: RetrievedChunk[], intent?: ClassifiedIntent, history: LlmMessage[] = []): Promise<GuardrailReport> {
    if (!answer.trim()) {
      return { text: answer, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null };
    }

    const citations = extractCitations(answer);
    const statuteRefs = extractStatuteRefs(answer);

    if (citations.length === 0 && statuteRefs.length === 0) {
      return { text: answer, verifiedCitations: [], removed: [], flagged: [], triggered: false, reason: null };
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
    const verified: string[] = [];

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

    let text = answer;
    for (const item of removed) {
      text = removedStatuteRefs.includes(item) ? this.strikeStatuteRef(text, item) : this.strike(text, item);
    }

    if (removed.length > 0) {
      // Without this the advocate cannot tell the answer was altered, and an
      // answer that quietly lost its authority reads as an unsupported
      // assertion.
      // "Case law database" alone was wrong whenever the struck reference was a
      // section - which, with a corpus of a few dozen sections, is most of them.
      text += "\n\n_One or more references could not be verified against Ley Legal's database of statutes and judgments and were removed._";
    }

    const triggered = removed.length > 0 || flagged.length > 0;

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
  async verifiedDraft(prefix: string, intent: ClassifiedIntent | undefined, known: Map<string, boolean>): Promise<string> {
    const citations = extractCitations(prefix);
    const statuteRefs = extractStatuteRefs(prefix);
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
    for (const ref of statuteRefs) if (known.get(`s:${ref}`)) text = this.strikeStatuteRef(text, ref);
    return text;
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
