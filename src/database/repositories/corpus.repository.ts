import { Injectable } from '@nestjs/common';
import { getLogger } from '../../common/logger';
import { DatabaseService } from '../database.service';
import { CitationCheck, PrecedentRow, RetrievedChunk, StatuteRefCheck, StatuteRow } from '../types';

export interface PrecedentSearchOptions {
  queryText: string;
  embedding: number[] | null;
  denseK: number;
  sparseK: number;
  rrfK: number;
  /** Hard cap on distinct judgments returned for one research question. */
  maxResults: number;
  courtType?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sections?: string[] | null;
}

export interface CorrespondencePair {
  new_act: string;
  new_section: string;
  old_act: string;
  old_section: string;
}

const ACT_LABEL: Record<string, string> = { IPC: 'IPC', CRPC: 'CrPC', IEA: 'IEA', BNS: 'BNS', BNSS: 'BNSS', BSA: 'BSA' };
const label = (act: string, section: string) => `${ACT_LABEL[act.toUpperCase()] ?? act} ${section}`;
const base = (section: string) => section.split('(')[0].toUpperCase();

/**
 * "IPC 415 = BNS 318(1)", one entry per official pair touching this section,
 * in old-section order. Old rows list what replaced them; new rows list what
 * they replaced.
 */
export function describeCorrespondence(row: Pick<StatuteRow, 'act_code' | 'section_number'>, pairs: CorrespondencePair[]): string[] {
  const act = row.act_code.toUpperCase();
  const section = base(row.section_number);
  let matching = pairs.filter(
    (p) =>
      (p.new_act.toUpperCase() === act && base(p.new_section) === section) ||
      (p.old_act.toUpperCase() === act && base(p.old_section) === section),
  );
  // A sub-section row ("BNS 318(4)") lists its own pairing when the table
  // records one, not every pairing of the section.
  if (row.section_number.includes('(')) {
    const own = matching.filter((p) =>
      [p.new_act.toUpperCase() === act && p.new_section.toUpperCase(), p.old_act.toUpperCase() === act && p.old_section.toUpperCase()]
        .includes(row.section_number.toUpperCase()),
    );
    if (own.length > 0) matching = own;
  }
  const order = (s: string) => Number(s.match(/^\d+/)?.[0] ?? 0);
  matching.sort((a, b) => order(a.old_section) - order(b.old_section) || a.old_section.localeCompare(b.old_section) || a.new_section.localeCompare(b.new_section));
  return [...new Set(matching.map((p) => `${label(p.old_act, p.old_section)} = ${label(p.new_act, p.new_section)}`))];
}

export interface HybridSearchOptions {
  queryText: string;
  embedding: number[] | null;
  denseK: number;
  sparseK: number;
  rrfK: number;
  finalK: number;
  courtType?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sections?: string[] | null;
}

/**
 * Access to the legal knowledge base: bare acts and judgment passages.
 *
 * All the interesting work lives in the SQL functions from migration 0004; this
 * class is a thin, typed calling convention over them.
 */
@Injectable()
export class CorpusRepository {
  private readonly logger = getLogger().child({ module: 'corpus-repo' });

  constructor(private readonly db: DatabaseService) {}

  /**
   * Format a JS number array as a pgvector literal: `[0.1,0.2,...]`.
   *
   * pgvector's text input is its own format - not a Postgres array literal and
   * not JSON - so this cannot be replaced by passing the array directly.
   */
  private toVectorLiteral(embedding: number[]): string {
    return `[${embedding.join(',')}]`;
  }

  /**
   * Hybrid dense + lexical retrieval, fused with RRF inside Postgres.
   *
   * When `embedding` is null (no embedding provider configured, or the provider
   * failed) this degrades to lexical-only rather than returning nothing - a
   * keyword hit is far better than an apology, and the caller cannot tell the
   * difference beyond slightly worse ranking.
   */
  async hybridSearch(opts: HybridSearchOptions): Promise<RetrievedChunk[]> {
    const { sql } = this.db;

    if (!opts.embedding) {
      this.logger.debug('No embedding available; falling back to lexical-only retrieval');
      return this.lexicalOnlySearch(opts);
    }

    const vector = this.toVectorLiteral(opts.embedding);

    return sql<RetrievedChunk[]>`
      SELECT * FROM hybrid_search_judgments(
        ${vector}::vector,
        ${opts.queryText},
        ${opts.denseK},
        ${opts.sparseK},
        ${opts.rrfK},
        ${opts.finalK},
        ${opts.courtType ?? null},
        ${opts.dateFrom ?? null}::date,
        ${opts.dateTo ?? null}::date,
        ${opts.sections ?? null}::text[]
      )
    `;
  }

  /** Lexical half of the hybrid search, used when no embedding is available. */
  private async lexicalOnlySearch(opts: HybridSearchOptions): Promise<RetrievedChunk[]> {
    const { sql } = this.db;

    return sql<RetrievedChunk[]>`
      SELECT c.id            AS chunk_id,
             c.judgment_id,
             c.content,
             c.para_number,
             j.case_title,
             j.neutral_citation,
             j.reporter_citations,
             c.court_name,
             c.judgment_date,
             j.ratio_decidendi,
             NULL::INTEGER   AS dense_rank,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.search_vector, q.query) DESC)::INTEGER AS sparse_rank,
             ts_rank_cd(c.search_vector, q.query)::DOUBLE PRECISION AS score
        FROM judgment_chunks c
        JOIN judgments j ON j.id = c.judgment_id,
             websearch_to_tsquery('english', ${opts.queryText}) AS q(query)
       WHERE c.search_vector @@ q.query
         AND (${opts.courtType ?? null}::text IS NULL OR c.court_type = ${opts.courtType ?? null})
         AND (${opts.sections ?? null}::text[] IS NULL OR c.act_sections && ${opts.sections ?? null}::text[])
       ORDER BY score DESC
       LIMIT ${opts.finalK}
    `;
  }

  /**
   * Precedent list: one row per judgment, newest first.
   *
   * See migration 0008 for why this is not `hybridSearch` with a larger limit -
   * in short, that returns passages, and an advocate asking for precedents
   * wants distinct authorities, not the same case quoted three times.
   *
   * A null embedding is passed through rather than short-circuited: the SQL
   * function degrades to lexical-only on its own, so there is no separate
   * fallback path to keep in sync here.
   */
  async searchPrecedents(opts: PrecedentSearchOptions): Promise<PrecedentRow[]> {
    const { sql } = this.db;
    const vector = opts.embedding ? this.toVectorLiteral(opts.embedding) : null;

    return sql<PrecedentRow[]>`
      SELECT * FROM search_precedents(
        ${vector}::vector,
        ${opts.queryText},
        ${opts.denseK},
        ${opts.sparseK},
        ${opts.rrfK},
        ${opts.maxResults},
        ${opts.courtType ?? null},
        ${opts.dateFrom ?? null}::date,
        ${opts.dateTo ?? null}::date,
        ${opts.sections ?? null}::text[]
      )
    `;
  }

  /** Direct fetch when the advocate already knows the citation. */
  async lookupByCitation(citation: string): Promise<PrecedentRow[]> {
    return this.db.sql<PrecedentRow[]>`
      SELECT * FROM lookup_judgment_by_citation(${citation})
    `;
  }

  /**
   * Look up bare act sections.
   *
   * `sectionNumber` and `actCode` come from the intent classifier's structured
   * extraction; when it could not identify either, the full-text path still
   * handles plain-language questions like "punishment for cheating".
   */
  async searchStatutes(
    queryText: string,
    sectionNumber: string | null,
    actCode: string | null,
    limit = 5,
  ): Promise<StatuteRow[]> {
    const rows = await this.db.sql<StatuteRow[]>`
      SELECT * FROM search_statutes(
        ${queryText},
        ${sectionNumber},
        ${actCode},
        ${limit}
      )
    `;
    return this.withCorrespondence(rows);
  }

  /**
   * Sections ranked by how many of these words they contain - a word in the
   * title counting twice - for a subject no section contains every word of.
   *
   * "Which BNSS section allows a zero FIR to be registered?" and "Which BSA
   * section makes a confession to a police officer inadmissible?" matched
   * nothing with every word required ("allows", "inadmissible" are not in
   * the Acts) and were answered from memory, wrongly. Ranked by words covered,
   * BNSS 173 and BSA 23 come first on the Gazette text (live test, 4 Oct).
   * `score` is the coverage: 2 x title words + words anywhere.
   */
  async statutesCovering(words: string[], acts: string[] | null, limit = 12): Promise<StatuteRow[]> {
    if (words.length === 0) return [];
    const upperActs = acts?.map((a) => a.toUpperCase()) ?? null;
    const rows = await this.db.sql<StatuteRow[]>`
      SELECT s.id, s.act_code, s.act_name, s.section_number, s.section_title, s.section_text,
             s.punishment, s.is_cognizable, s.is_bailable, s.is_compoundable, s.triable_by,
             s.corresponding_act, s.corresponding_section,
             'FULLTEXT'::TEXT AS match_type,
             (2 * c.title_hits + c.hits)::DOUBLE PRECISION AS score
        FROM statutes s
       CROSS JOIN LATERAL (
             SELECT count(*) FILTER (WHERE s.search_vector @@ plainto_tsquery('english', w)) AS hits,
                    count(*) FILTER (WHERE to_tsvector('english', coalesce(s.section_title, '')) @@ plainto_tsquery('english', w)) AS title_hits
               FROM unnest(${words}::text[]) AS w
           ) c
       WHERE s.search_vector @@ websearch_to_tsquery('english', ${words.join(' or ')})
         AND s.language = 'en'
         AND (${upperActs}::text[] IS NULL OR upper(s.act_code) = ANY(${upperActs}::text[]))
       ORDER BY score DESC, ts_rank_cd(s.search_vector, websearch_to_tsquery('english', ${words.join(' or ')})) DESC
       LIMIT ${limit}
    `;
    return this.withCorrespondence(rows);
  }

  /**
   * The official old/new correspondence for each section, on whichever side of
   * the recodification it sits - and where its text came from, which is what
   * tells an enacted text from 0006's abridged seed.
   *
   * Public because a provision fetched from Kanoon needs it too: without it an
   * IPC section reads as having no BNS counterpart, which is a claim, not a gap.
   */
  async withCorrespondence(rows: StatuteRow[]): Promise<StatuteRow[]> {
    if (rows.length === 0) return rows;
    const acts = rows.map((r) => r.act_code.toUpperCase());
    const bases = rows.map((r) => r.section_number.split('(')[0].toUpperCase());
    const ids = rows.map((r) => r.id);
    const [pairs, sources] = await Promise.all([
      this.db.sql<CorrespondencePair[]>`
        SELECT DISTINCT c.new_act, c.new_section, c.old_act, c.old_section
          FROM statute_correspondence c
          JOIN unnest(${acts}::text[], ${bases}::text[]) AS q(act, base)
            ON (upper(c.new_act) = q.act AND split_part(upper(c.new_section), '(', 1) = q.base)
            OR (upper(c.old_act) = q.act AND split_part(upper(c.old_section), '(', 1) = q.base)
      `,
      this.db.sql<{ id: string; source_url: string | null }[]>`
        SELECT id, source_url FROM statutes WHERE id = ANY(${ids}::uuid[])
      `,
    ]);
    const sourceOf = new Map(sources.map((s) => [s.id, s.source_url]));
    for (const row of rows) {
      row.correspondence = describeCorrespondence(row, pairs);
      row.source_url = sourceOf.get(row.id) ?? null;
    }
    return rows;
  }

  /**
   * The new-code sections an old-code section became, by the official table -
   * "IPC 302" gives BNS 103 (mapped to "BNS 103(1)") - with the new section's
   * text. With `siblings`, the lettered sections of the same number too: IPC
   * 120 brings IPC 120A and 120B, criminal conspiracy, now BNS 61.
   *
   * For a question that names a new-code number with an old code's subject:
   * "BNS 302 murder ki saza" means IPC 302 (rag.service.ts, numberCollision).
   * One row per pair, the whole section's row rather than a seeded sub-section
   * row (0006 seeded "103(1)" beside 0021's "103").
   */
  async recodifiedFrom(oldAct: string, section: string, siblings = false): Promise<StatuteRow[]> {
    const act = oldAct.toUpperCase();
    const exact = section.toUpperCase();
    const base = exact.replace(/[^0-9].*$/, '');
    const rows = await this.db.sql<(StatuteRow & { old_section: string; new_section: string })[]>`
      SELECT DISTINCT ON (c.old_section, c.new_section)
             s.id, s.act_code, s.act_name, s.section_number, s.section_title, s.section_text,
             s.punishment, s.is_cognizable, s.is_bailable, s.is_compoundable, s.triable_by,
             s.corresponding_act, s.corresponding_section,
             'RECODIFIED'::TEXT AS match_type, 900.0::DOUBLE PRECISION AS score,
             c.old_section, c.new_section
        FROM statute_correspondence c
        JOIN statutes s
          ON upper(s.act_code) = upper(c.new_act)
         AND split_part(upper(s.section_number), '(', 1) = split_part(upper(c.new_section), '(', 1)
       WHERE upper(c.old_act) = ${act}
         AND (upper(c.old_section) = ${exact}
              OR (${siblings} AND upper(c.old_section) ~ ('^' || ${base} || '[A-Z]+$')))
         AND s.language = 'en'
       ORDER BY c.old_section, c.new_section, (s.section_number LIKE '%(%') ASC
    `;
    const label = (code: string, number: string) => `${code === 'CRPC' ? 'CrPC' : code} ${number}`;
    const mapped = rows.map(({ old_section, new_section, ...row }) => ({
      ...row,
      mapped_from: label(act, old_section),
      mapped_to: label(row.act_code.toUpperCase(), new_section),
    }));
    return this.withCorrespondence(mapped);
  }

  /** Sections of Acts outside the loaded codes with this number - the fetched ones. */
  async lawsWithSection(section: string, excludeActs: readonly string[]): Promise<StatuteRow[]> {
    return this.db.sql<StatuteRow[]>`
      SELECT s.id, s.act_code, s.act_name, s.section_number, s.section_title, s.section_text,
             s.punishment, s.is_cognizable, s.is_bailable, s.is_compoundable, s.triable_by,
             s.corresponding_act, s.corresponding_section, s.source_url,
             'EXACT'::TEXT AS match_type, 1000.0::DOUBLE PRECISION AS score
        FROM statutes s
       WHERE upper(s.section_number) = upper(${section})
         AND upper(s.act_code) <> ALL(${excludeActs.map((a) => a.toUpperCase())}::text[])
         AND s.language = 'en'
    `;
  }

  /**
   * Keep a provision's official text, fetched once. Never overwrites a row
   * already there - the Gazette text of the new codes least of all.
   */
  async storeLaw(law: {
    actCode: string;
    actName: string;
    sectionNumber: string;
    sectionTitle: string;
    sectionText: string;
    sourceUrl: string;
  }): Promise<StatuteRow | null> {
    await this.db.sql`
      INSERT INTO statutes (act_code, act_name, section_number, section_title, section_text, source_url, language)
      VALUES (${law.actCode}, ${law.actName}, ${law.sectionNumber}, ${law.sectionTitle}, ${law.sectionText}, ${law.sourceUrl}, 'en')
      ON CONFLICT (act_code, section_number, language) DO NOTHING
    `;
    const [row] = await this.db.sql<StatuteRow[]>`
      SELECT s.id, s.act_code, s.act_name, s.section_number, s.section_title, s.section_text,
             s.punishment, s.is_cognizable, s.is_bailable, s.is_compoundable, s.triable_by,
             s.corresponding_act, s.corresponding_section, s.source_url,
             'EXACT'::TEXT AS match_type, 1000.0::DOUBLE PRECISION AS score
        FROM statutes s
       WHERE s.act_code = ${law.actCode} AND s.section_number = ${law.sectionNumber} AND s.language = 'en'
    `;
    return row ?? null;
  }

  /**
   * Replace an abridged seed's text (0006: "ABRIDGED summaries, not the enacted
   * text") with the official text. Only a row with no source is touched, so an
   * enacted text can never be overwritten; classification and mapping stay.
   */
  async replaceAbridged(id: string, title: string, text: string, sourceUrl: string): Promise<boolean> {
    const updated = await this.db.sql`
      UPDATE statutes
         SET section_title = ${title}, section_text = ${text}, source_url = ${sourceUrl}, updated_at = NOW()
       WHERE id = ${id} AND source_url IS NULL
    `;
    return updated.count > 0;
  }

  /**
   * Anti-hallucination check for case citations (spec 9.2).
   *
   * Returns one row per input citation saying whether it exists in the corpus.
   * Anything false is stripped from the answer before it reaches the user.
   */
  async verifyCitations(citations: string[]): Promise<CitationCheck[]> {
    if (citations.length === 0) return [];
    return this.db.sql<CitationCheck[]>`
      SELECT * FROM verify_citations(${citations}::text[])
    `;
  }

  /** Same check for statutory references, e.g. 'IPC 302'. */
  async verifyStatuteRefs(refs: string[]): Promise<StatuteRefCheck[]> {
    if (refs.length === 0) return [];
    return this.db.sql<StatuteRefCheck[]>`
      SELECT * FROM verify_statute_refs(${refs}::text[])
    `;
  }

  /** Whether any judgment has been ingested to search - one row read, not a count. */
  async hasJudgmentChunks(): Promise<boolean> {
    const [row] = await this.db.sql<{ any: boolean }[]>`SELECT EXISTS (SELECT 1 FROM judgment_chunks) AS any`;
    return Boolean(row?.any);
  }

  async countCorpus(): Promise<{ judgments: number; chunks: number; statutes: number; embedded: number }> {
    const [row] = await this.db.sql<
      { judgments: string; chunks: string; statutes: string; embedded: string }[]
    >`
      SELECT (SELECT COUNT(*) FROM judgments)                                AS judgments,
             (SELECT COUNT(*) FROM judgment_chunks)                          AS chunks,
             (SELECT COUNT(*) FROM statutes)                                 AS statutes,
             (SELECT COUNT(*) FROM judgment_chunks WHERE embedding IS NOT NULL) AS embedded
    `;
    return {
      judgments: Number(row?.judgments ?? 0),
      chunks: Number(row?.chunks ?? 0),
      statutes: Number(row?.statutes ?? 0),
      embedded: Number(row?.embedded ?? 0),
    };
  }
}
