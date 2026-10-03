import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getLogger } from '../common/logger';
import { CacheRepository } from '../database/repositories/cache.repository';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { StatuteRow } from '../database/types';
import { KanoonService } from '../kanoon/kanoon.service';
import { parseLawSection } from '../kanoon/statute.parser';
import { ClassifiedIntent } from './intent.service';
import { ActCode, KNOWN_ACTS } from './legal-patterns';

/**
 * The official text of a provision the corpus does not hold, from Indian
 * Kanoon - fetched once, kept in `statutes`, and never guessed.
 *
 * ## Why
 *
 * A provision the corpus did not hold was answered from the model's memory,
 * under a "not verified" line. "Section 520 BNSS" came back as disposal of
 * property pending appeal; it is "Trials before High Courts". The new codes are
 * now loaded in full (0021); this covers every other Act - the NI Act, POCSO,
 * the Constitution, and the old codes' own text.
 *
 * ## Precision
 *
 * Kanoon's search returns the right document first for a well-formed query,
 * and unrelated State Acts after it - and for "CrPC 41A" its first hit is
 * section 41. So a result is accepted only when its title reads "<Section|
 * Article> <N> in <Act>" with exactly the number asked, letter included, and
 * exactly the Act asked (same significant words; same year when both give
 * one). The document must then parse as that provision (statute.parser).
 * Anything short of that is "not available", not a near miss.
 *
 * ## Speed and cost
 *
 * One search and one document, with their own short timeouts (search p95
 * measured at 2.7s, document 0.65s): a miss costs the advocate a few seconds,
 * not the 15s a research search may take. A found provision is stored, so the
 * next ask is a database read. A provision Kanoon does not have is remembered
 * for a day, so it is not paid for again on every ask.
 */

/** The codes Kanoon carries that are not loaded in full, by Kanoon's own title. */
const FETCHABLE: Partial<Record<ActCode, { actName: string; word: 'Section' | 'Article' }>> = {
  IPC: { actName: 'Indian Penal Code, 1860', word: 'Section' },
  CRPC: { actName: 'Code of Criminal Procedure, 1973', word: 'Section' },
  IEA: { actName: 'Indian Evidence Act, 1872', word: 'Section' },
  CPC: { actName: 'Code of Civil Procedure, 1908', word: 'Section' },
  COI: { actName: 'Constitution of India', word: 'Article' },
};

/** Loaded in full from the Gazette (0021): a section missing there does not exist. */
const LOADED_IN_FULL: readonly string[] = ['BNS', 'BNSS', 'BSA'];

const SEARCH_TIMEOUT_MS = 4_000;
const DOCUMENT_TIMEOUT_MS = 3_000;
const MISS_TTL_SECONDS = 86_400;

export interface ProvisionTarget {
  /** One of the known codes, or null for any other Act. */
  actCode: ActCode | null;
  /** The Act as Kanoon titles it, or as the router named it. */
  actName: string;
  word: 'Section' | 'Article';
  /** "138", "498A", "21" - no sub-clause; Kanoon documents are whole sections. */
  number: string;
}

export type FetchOutcome = 'stored' | 'not-found' | 'unavailable' | 'unparsable';

export interface FetchResult {
  row: StatuteRow | null;
  outcome: FetchOutcome;
}

const STOPWORDS = new Set(['the', 'of', 'and', 'in', 'for', 'a', 'an', 'to', 'on']);

function significantWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "(1933 A. D.)"
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w) && !/^\d{4}$/.test(w));
}

const yearOf = (name: string) => /\b(1[6-9]\d\d|20\d\d)\b/.exec(name.replace(/\([^)]*\)/g, ' '))?.[1] ?? null;

/** "Section 138 in The Negotiable Instruments Act, 1881" -> parts, or null. */
export function parseLawTitle(title: string): { word: 'Section' | 'Article'; number: string; act: string } | null {
  /*
   * Plain text first. The API highlights the words searched for:
   * "<b>Section</b> <b>377</b> in The <b>Indian</b> <b>Penal</b> <b>Code</b>, 1860"
   * (from production's own log). Read with the tags in, no title ever matched,
   * and every provision of every Act was reported "not available" - the
   * website's copy of the same title, which the fixtures were built from, has
   * no tags.
   */
  const plain = title
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const m = /^\s*(Section|Article)\s+([0-9]+[A-Z]*)\s+in\s+(.+?)\s*$/i.exec(plain);
  if (!m) return null;
  return { word: (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as 'Section' | 'Article', number: m[2].toUpperCase(), act: m[3] };
}

/**
 * The same Act: the same significant words, and the same year when both state
 * one. "NI Act" is not "The Negotiable Instruments Act" (no expansion was
 * given), and "Code of Criminal Procedure, 1973" is not Kanoon's "Code of
 * Criminal Procedure, 1989 (1933 A. D.)".
 */
export function sameAct(asked: string, kanoonAct: string): boolean {
  const a = significantWords(asked);
  const k = significantWords(kanoonAct);
  if (a.length === 0 || a.length !== k.length || !a.every((w, i) => w === k[i])) {
    // Order-insensitive equality, for "Act" placement and the like.
    const as = new Set(a);
    const ks = new Set(k);
    if (as.size === 0 || as.size !== ks.size || ![...as].every((w) => ks.has(w))) return false;
  }
  const ya = yearOf(asked);
  const yk = yearOf(kanoonAct);
  return !(ya && yk && ya !== yk);
}

/** A stable act_code for an Act outside the known codes: initials, year, and a hash against collisions. */
export function otherActCode(kanoonAct: string): string {
  const initials = significantWords(kanoonAct).map((w) => w[0]).join('').toUpperCase().slice(0, 8);
  const year = yearOf(kanoonAct) ?? '';
  const hash = createHash('sha256').update(significantWords(kanoonAct).join(' ') + year).digest('hex').slice(0, 4);
  return `${initials}${year}-${hash}`;
}

/** The plain search Kanoon ranks the provision first for: "section 138 negotiable instruments act". */
export function lawQuery(target: ProvisionTarget): string {
  return `${target.word} ${target.number} ${significantWords(target.actName).join(' ')}`.toLowerCase();
}

/** Where the advocate can read it themselves when it is not available here. */
export function kanoonSearchLink(target: ProvisionTarget | { query: string }): string {
  const query = 'query' in target ? target.query : lawQuery(target);
  return `https://indiankanoon.org/search/?formInput=${encodeURIComponent(query)}`;
}

/**
 * What to fetch for a classified question, or null when Kanoon cannot have it
 * as a document: an Order of the CPC (not a separate document there), or a
 * provision of a code already loaded in full.
 */
export function provisionTarget(intent: Pick<ClassifiedIntent, 'actCode' | 'sectionNumber' | 'actName'>): ProvisionTarget | null {
  const raw = intent.sectionNumber?.trim();
  if (!raw || /^(order|rule)\b/i.test(raw)) return null;

  const number = raw.replace(/^(article|section)\s+/i, '').replace(/\(.*$/, '').trim().toUpperCase();
  if (!/^[0-9]+[A-Z]*$/.test(number)) return null;

  if (intent.actCode) {
    if (LOADED_IN_FULL.includes(intent.actCode)) return null;
    const known = FETCHABLE[intent.actCode];
    return known ? { actCode: intent.actCode, actName: known.actName, word: known.word, number } : null;
  }
  const actName = intent.actName?.trim();
  if (!actName || significantWords(actName).length === 0) return null;
  // The Constitution is numbered in Articles, however the question was worded.
  const word = /^article\b/i.test(raw) || /\bconstitution\b/i.test(actName) ? 'Article' : 'Section';
  return { actCode: null, actName, word, number };
}

@Injectable()
export class StatuteFetcher {
  private readonly logger = getLogger().child({ module: 'statute-fetcher' });

  constructor(
    private readonly kanoon: KanoonService,
    private readonly corpus: CorpusRepository,
    private readonly cache: CacheRepository,
  ) {}

  /** A fetched provision of an Act outside the known codes, if one was kept earlier. */
  async stored(target: ProvisionTarget): Promise<StatuteRow | null> {
    if (target.actCode) return null; // the known codes are found by searchStatutes
    const rows = await this.corpus.lawsWithSection(target.number, KNOWN_ACTS);
    return rows.find((r) => sameAct(target.actName, r.act_name)) ?? null;
  }

  async fetch(target: ProvisionTarget): Promise<FetchResult> {
    const started = Date.now();
    const found = await this.official(target);

    if (!found.ok) {
      this.log(target, found.outcome, started, found.detail);
      return { row: null, outcome: found.outcome };
    }
    const row = await this.corpus.storeLaw({
      actCode: target.actCode ?? otherActCode(found.kanoonAct),
      actName: target.actCode ? target.actName : found.kanoonAct,
      sectionNumber: target.number,
      sectionTitle: found.title,
      sectionText: found.text,
      sourceUrl: found.sourceUrl,
    });
    this.log(target, 'stored', started, { tid: found.tid });
    return { row, outcome: 'stored' };
  }

  /**
   * The official text for 0006's abridged seed row of the same provision, put
   * in its place. Returns the row as it now reads, or null if Kanoon could not
   * supply it - the abridged row is then left exactly as it was.
   */
  async replaceAbridged(row: StatuteRow, target: ProvisionTarget): Promise<StatuteRow | null> {
    const started = Date.now();
    const found = await this.official(target);
    if (!found.ok) {
      this.log(target, found.outcome, started, { ...found.detail, abridged: row.id });
      return null;
    }
    // False when another request replaced it first: this one's copy is not the stored row.
    if (!(await this.corpus.replaceAbridged(row.id, found.title, found.text, found.sourceUrl))) return null;
    this.log(target, 'replaced', started, { tid: found.tid, abridged: row.id });
    return { ...row, section_title: found.title, section_text: found.text, source_url: found.sourceUrl };
  }

  /** One line per Kanoon lookup, whatever came of it - the place to look when a provision is "not available". */
  private log(target: ProvisionTarget, outcome: FetchOutcome | 'replaced', started: number, extra: Record<string, unknown> = {}): void {
    this.logger.info({ act: target.actName, number: target.number, outcome, ms: Date.now() - started, ...extra }, 'Official provision lookup');
  }

  /** One search, one document, every check - or why not. */
  private async official(target: ProvisionTarget): Promise<
    | { ok: true; tid: number; kanoonAct: string; title: string; text: string; sourceUrl: string }
    | { ok: false; outcome: Exclude<FetchOutcome, 'stored'>; detail?: Record<string, unknown> }
  > {
    if (!this.kanoon.isConfigured) return { ok: false, outcome: 'unavailable', detail: { why: 'Kanoon not configured' } };

    // v2: the misses recorded before parseLawTitle read highlighted titles are
    // not misses - Kanoon had every one of them - so they are left behind.
    const missKey = `law-miss:v2:${createHash('sha256').update(lawQuery(target)).digest('hex').slice(0, 32)}`;
    if (await this.cache.get<boolean>(missKey).catch(() => null)) {
      return { ok: false, outcome: 'not-found', detail: { from: 'miss cache' } };
    }

    try {
      const docs = await this.kanoon.searchLaws(lawQuery(target), SEARCH_TIMEOUT_MS);
      const match = docs.find((d) => {
        const t = parseLawTitle(d.title ?? '');
        return t !== null && t.word === target.word && t.number === target.number && sameAct(target.actName, t.act);
      });
      if (!match) {
        await this.cache.set(missKey, true, MISS_TTL_SECONDS).catch(() => undefined);
        return { ok: false, outcome: 'not-found', detail: { candidates: docs.slice(0, 3).map((d) => d.title) } };
      }

      const parsed = parseLawSection(await this.kanoon.lawDocument(match.tid, DOCUMENT_TIMEOUT_MS), target.number);
      if (!parsed.ok) {
        await this.cache.set(missKey, true, MISS_TTL_SECONDS).catch(() => undefined);
        return { ok: false, outcome: 'unparsable', detail: { tid: match.tid, reason: parsed.reason } };
      }

      return {
        ok: true,
        tid: match.tid,
        kanoonAct: parseLawTitle(match.title)!.act,
        title: parsed.section.title,
        text: parsed.section.text,
        sourceUrl: `https://indiankanoon.org/doc/${match.tid}/`,
      };
    } catch (err) {
      // Timeout, outage, an open breaker: not remembered as a miss - it may
      // well be there next time.
      return { ok: false, outcome: 'unavailable', detail: { err: err instanceof Error ? err.message : String(err) } };
    }
  }
}
