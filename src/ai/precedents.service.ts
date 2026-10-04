import { Injectable } from '@nestjs/common';
import { getLogger } from '../common/logger';
import { InjectEnv } from '../config/config.module';
import { AppEnv } from '../config/env';
import { CorpusRepository } from '../database/repositories/corpus.repository';
import { PrecedentRow } from '../database/types';
import { KanoonNotConfiguredError, KanoonService } from '../kanoon/kanoon.service';
import { courtFilter } from '../kanoon/kanoon.mapper';
import { SettingsService } from '../settings/settings.service';
// The formatter below emits WhatsApp markup and is only ever rendered into a
// WhatsApp message, so sharing the closing copy is the honest dependency.
import { CAVEAT, RETURN_TO_MENU } from '../whatsapp/replies';
import { EmbeddingService } from './embedding.service';
import { ClassifiedIntent } from './intent.service';
import { CASE_NAME_MATCH, CaseName, caseNameScore, extractCaseName, looseTitle, samePetitioner } from './case-name';
import { expandQuery, extractCitations } from './legal-patterns';
import { buildCaseSummaryPrompt, buildPrincipleSummaryPrompt } from './prompts';
import { DEFAULT_SUMMARY_WORDS, requestedWordCount, withoutLengthRequest } from './summary-length';
import { parseJsonLoose } from './providers/llm-provider.interface';
import { ProviderRegistry } from './providers/provider.registry';

/** Named so the extract builder below reads as prose rather than escapes. */
const NEWLINE = '\n';

/**
 * Citation lists joined in order, duplicates dropped without regard to case or
 * spacing - "AIR 1973 SUPREME COURT 1461" arrives from both the search result
 * and the document, and printing it twice would read as two reports.
 */
function mergeCitations(...sources: (string[] | string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const source of sources) {
    const list = Array.isArray(source) ? source : source ? [source] : [];
    for (const raw of list) {
      const citation = raw.replace(/\s+/g, ' ').trim();
      if (!citation) continue;

      const key = citation.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(citation);
    }
  }

  return out;
}

/**
 * The better of the row's own excerpt and the judgment's opening.
 *
 * Kanoon's `headline` is kept when it is a real body snippet - it is chosen
 * around the query terms, so it is more likely to be on point than a fixed
 * opening. It is discarded when it is the document's own header, which
 * isDocumentHeader already recognises because that same string was being
 * printed under LEGAL PRINCIPLE for months.
 */
function preferExtract(row: PrecedentRow, extract: string): string {
  const current = (row.best_excerpt || '').trim();
  if (!extract) return current;
  if (!current) return extract;

  return isDocumentHeader(current, row.case_title) ? extract : current;
}

/**
 * Kanoon's document id, out of the namespaced judgment id.
 *
 * Rows from the ingested corpus have UUIDs and no document to fetch, so null is
 * the answer for them and the enrichment skips over.
 */
function kanoonTid(judgmentId: string): number | null {
  const match = /^kanoon:(\d+)$/.exec(judgmentId);
  return match ? Number(match[1]) : null;
}

/** The name as the advocate would recognise it, for quoting back to them. */
/**
 * A judgment asked for by citation alone - "What did the Supreme Court hold in
 * (2020) 7 SCC 1?" - is found only if a result carries that citation.
 *
 * Any results were taken as the answer, and that question was answered with
 * ten unrelated judgments: Indian Kanoon does not index a judgment by its SCC
 * citation, so a search for one returns whatever mentions the numbers. Not
 * found says so and lists nothing, as for a name.
 */
function forCitation(
  typed: string,
  rows: PrecedentRow[],
): { precedents: PrecedentRow[]; namedCase?: { name: string; found: boolean } } {
  const citation = extractCitations(typed)[0];
  if (!citation) return { precedents: rows };

  const wanted = normaliseCitation(citation);
  const matches = rows.filter((row) =>
    [row.neutral_citation, ...(row.reporter_citations ?? [])].some((c) => !!c && normaliseCitation(c) === wanted),
  );
  return matches.length > 0
    ? { precedents: matches, namedCase: { name: citation, found: true } }
    : { precedents: [], namedCase: { name: citation, found: false } };
}

/** "(2020) 7 SCC 1" and "2020 7 SCC 1" alike: lowercase, no punctuation or spaces. */
function normaliseCitation(citation: string): string {
  return citation.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function display(name: CaseName): string {
  return `${name.petitioner} vs ${name.respondent}`;
}

/** An order in a matter rather than its judgment: Kanoon files them as "Supreme Court - Daily Orders", "Patna High Court - Orders". */
function isOrder(row: PrecedentRow): boolean {
  return /\b(daily\s+)?orders\s*$/i.test(row.court_name ?? '');
}

/** The Supreme Court above every other court. */
function courtWeight(row: PrecedentRow): number {
  return /^supreme court\b/i.test(row.court_name ?? '') ? 1 : 0;
}

/**
 * Every query worth sending to Indian Kanoon for this question, most specific
 * first.
 *
 * ## Why a list, and why these operators
 *
 * Kanoon's search API documents operators inside `formInput` for exactly the
 * lookups advocates make, and this used to use none of them:
 *
 *   title:  "a document will match only if those words and phrases are present
 *            in the title of the document"
 *   cite:   "restrict search to only documents that have a specific citation"
 *
 * A named case was searched as free text over the parties, which ranks every
 * judgment mentioning those words - so the case asked for competed with every
 * other judgment against the same State. `title:` asks the question that was
 * actually put: which document is *titled* this. A pasted citation was searched
 * the same way, and `cite:` is the documented form for it.
 *
 * Each operator narrows, and a narrowing that matches nothing - a misspelled
 * party, a citation Kanoon formats differently - must not become "no authority
 * found". So each specific attempt is followed by a broader one, and the search
 * stops at the first that answers the question.
 *
 * The court restriction is written before `title:` rather than after it. The
 * documented operators run to the next operator, and a title operand followed by
 * `doctypes:patna` could otherwise be read as a title containing "doctypes".
 */
export function kanoonQueries(intent: ClassifiedIntent): string[] {
  const court = courtFilter(intent.rawText);
  // "in 100 words" is about the reply. Left in, Kanoon scores judgments on it.
  const searchQuery = withoutLengthRequest(intent.searchQuery);

  // 1. A citation the advocate pasted. Unique on its own, so no court scope.
  const citation = extractCitations(intent.rawText)[0];
  if (citation) return unique([`cite: ${citation}`, searchQuery]);

  // 2. A named case.
  const name = extractCaseName(intent.rawText);
  if (name) {
    const parties = `${name.petitioner} ${name.respondent}`;
    const scope = (name.court ? courtFilter(name.court) : null) ?? court;
    // Last, the words of the title Kanoon keeps when it shortens a party
    // (looseTitle) - only reached when everything before found somebody else.
    const loose = looseTitle(name);
    return unique([
      scope ? `doctypes:${scope} title: ${parties}` : `title: ${parties}`,
      scope ? `${parties} doctypes:${scope}` : parties,
      parties,
      !loose ? '' : scope ? `doctypes:${scope} title: ${loose}` : `title: ${loose}`,
    ]);
  }

  // 3. A provision, kept to the court the advocate named.
  const provision = provisionPhrase(intent);
  if (provision) {
    return unique([court ? `${provision} doctypes:${court}` : provision, searchQuery]);
  }

  return [searchQuery];
}

/** The first attempt - what Kanoon is asked before any fallback. */
export function kanoonQuery(intent: ClassifiedIntent): string {
  return kanoonQueries(intent)[0];
}

function unique(queries: string[]): string[] {
  // Kanoon's search ignores case, so "title: Mercy Mankind" and "title: mercy
  // mankind" are one query - and each one sent is paid for.
  const seen = queries.map((query) => query.toLowerCase());
  return queries.filter((query, index) => query && seen.indexOf(seen[index]) === index);
}

/**
 * A provision, as the judgments that apply it actually write it.
 *
 * ## Why the rewrite is the wrong query here too
 *
 * "list of judgements for order 32 cpc" came back as *Royal Sundaram General
 * Insurance vs Commissioner Of GST* and *Bss Mines & Minerals vs Commissioner
 * Of Central Excise* - customs and excise tribunal decisions with no
 * connection to civil procedure at all.
 *
 * The router had rewritten the question to "list of judgments related to Order
 * 32 of the Civil Procedure Code", and Kanoon scored every word of it. "order",
 * "code" and "32" are among the most common tokens in Indian tax and excise
 * judgments - Order-in-Original, Order No. 32, the Customs Act - so the
 * documents that matched hardest were the ones that used those words most,
 * which had nothing to do with the question.
 *
 * The provision is the query. Quoted, so "Order 32" is matched as a phrase
 * rather than as the words "order" and "32" appearing anywhere, and paired with
 * the Act so a stray "Order 32" in a customs matter does not qualify.
 *
 * The act phrase is the form courts write, not the abbreviation: judgments say
 * "the Code of Civil Procedure" or "the Civil Procedure Code" far more often
 * than "CPC", and "Civil Procedure" is the part common to both.
 */
function provisionPhrase(intent: ClassifiedIntent): string | null {
  const provision = intent.sectionNumber?.trim();
  if (!provision) return null;

  // "Order 32" and "Article 226" already read as provisions; a bare "302" is a
  // section and needs the word, or the phrase match is just a number.
  const head = /^(order|rule|article)\b/i.test(provision) ? provision : `Section ${provision}`;
  const act = intent.actCode ? ACT_PHRASES[intent.actCode] : null;

  return act ? `"${head}" "${act}"` : `"${head}"`;
}

/**
 * How each Act is named in the body of a judgment.
 *
 * Searching for the abbreviation finds the minority of judgments that use it.
 * Courts write the name out, and these are the substrings shared across the
 * spellings they use - "Civil Procedure" covers both "Code of Civil Procedure"
 * and "Civil Procedure Code".
 */
const ACT_PHRASES: Record<string, string> = {
  IPC: 'Indian Penal Code',
  CRPC: 'Criminal Procedure',
  CPC: 'Civil Procedure',
  BNS: 'Bharatiya Nyaya Sanhita',
  BNSS: 'Bharatiya Nagarik Suraksha Sanhita',
  IEA: 'Evidence Act',
  BSA: 'Bharatiya Sakshya',
  COI: 'Constitution of India',
};

export interface PrecedentSearchResult {
  /** Already sorted newest-first, whichever source produced them. */
  precedents: PrecedentRow[];
  /** How many matched before the per-session cap. */
  totalMatches: number;
  /** True when retrieval ran keyword-only because no embedding was available. */
  lexicalOnly: boolean;
  /** Which backend actually answered - shown to the user and logged. */
  source: 'local' | 'kanoon';
  /**
   * Set when the advocate asked for a judgment by name.
   *
   * `found` says whether it is in these rows, and both cases need saying. A
   * miss must not wear the successful search's heading; a hit must not be
   * padded out with nine unrelated judgments to fill a page.
   *
   * Carried rather than inferred at render time, because deciding it needs the
   * name they gave and the titles that came back - and the second page has
   * neither.
   */
  namedCase?: { name: string; found: boolean };
  /**
   * Set when the list is arranged by court - the advocate's High Court, then
   * the Supreme Court, then the rest, newest first within each. Absent for a
   * named case, which is one judgment wherever it was decided.
   */
  grouping?: { homeCourt: string | null };
  latencyMs: number;
}

/**
 * Priority feature 3: case law and precedent search.
 *
 * The requirement is specific and worth restating, because it shapes every
 * decision below: *up to 15 precedents per session, in descending chronological
 * order, with citations where available.*
 *
 * Three consequences follow.
 *
 * 1. **One row per judgment, not per passage.** The general RAG path retrieves
 *    passages to feed a model. Here the passages are not the answer - the list
 *    of authorities is. Collapsing happens in SQL (migration 0008).
 *
 * 2. **Relevance decides membership, chronology decides order.** Sorting the
 *    corpus by date alone returns whatever is newest regardless of subject.
 *    So the engine ranks by relevance, takes the top 15, and then presents
 *    those newest-first - which is also the order you cite them in, since the
 *    court's latest position governs.
 *
 * 3. **No LLM call is required to produce the list.** The synopsis is the
 *    judgment's own headnote or ratio where the corpus has one, falling back to
 *    the best-matching passage. That keeps the feature working - and honest -
 *    when no model provider is configured, and removes any opportunity for a
 *    model to invent a citation, because nothing here is generated.
 */
@Injectable()
export class PrecedentsService {
  private readonly logger = getLogger().child({ module: 'precedents' });

  constructor(
    private readonly corpus: CorpusRepository,
    private readonly embeddings: EmbeddingService,
    private readonly kanoon: KanoonService,
    private readonly settings: SettingsService,
    private readonly registry: ProviderRegistry,
    @InjectEnv() private readonly env: AppEnv,
  ) {}

  get maxResults(): number {
    return this.settings.getNumber('PRECEDENT_MAX_RESULTS', this.env.PRECEDENT_MAX_RESULTS);
  }

  get pageSize(): number {
    return this.settings.getNumber('PRECEDENT_PAGE_SIZE', this.env.PRECEDENT_PAGE_SIZE);
  }

  /** local | kanoon | auto — resolved per call so the panel can switch it live. */
  private get source(): string {
    return this.settings.get('PRECEDENT_SOURCE') || this.env.PRECEDENT_SOURCE;
  }

  /**
   * `homeState` decides which judgments are promoted, and it belongs here
   * rather than at the call site.
   *
   * Both callers used to reorder the rows themselves, after this method
   * returned - and this method enriches only the first page, because each
   * document is a billed call. So the promotion moved home-court judgments from
   * positions six to fifteen into positions one to three, and those are exactly
   * the rows no document was ever fetched for.
   *
   * The advocate's own High Court binds them, so those are the cards they read
   * first - and they were the cards with "Not available" for the case number,
   * the bench and the citations, while the persuasive judgments below them were
   * complete. Ordering has to happen before enrichment, which means it has to
   * happen in here.
   */
  async search(intent: ClassifiedIntent, homeState?: string | null): Promise<PrecedentSearchResult> {
    const started = Date.now();
    const mode = this.source;

    // Indian Kanoon reaches far more case law than any corpus we would ingest,
    // so it is preferred when available. `auto` falls back to local on failure
    // rather than leaving the advocate with nothing.
    const useKanoon = mode === 'kanoon' || (mode === 'auto' && this.kanoon.isConfigured);
    // "Summary in 100 words" - read from what was typed, not the rewrite.
    const words = requestedWordCount(intent.rawText);

    if (useKanoon) {
      try {
        /*
         * The advocate's own High Court and the Supreme Court are searched on
         * their own, alongside the general search, not just picked out of it.
         *
         * Picking them out was all this did, and a general search returns ten
         * judgments from anywhere in the country - often none from the one
         * court whose decisions bind this advocate. A search restricted to that
         * court finds them when they exist. Three Kanoon calls rather than
         * one, in parallel so it costs no time, and each is cached.
         */
        const scoped = priorityQueries(intent, homeState);
        const [found, homeRows, supremeRows] = await Promise.all([
          this.searchKanoon(intent),
          scoped?.home ? this.searchKanoonQuietly(scoped.home) : [],
          scoped?.supreme ? this.searchKanoonQuietly(scoped.supreme) : [],
        ]);
        const { precedents, namedCase } = this.forNamedCase(intent.rawText, found);
        // Promote first, enrich second. The other way round pays for documents
        // the advocate will never see and leaves the top of the page empty.
        const ordered = scoped
          ? arrangeByCourt({ home: homeRows, supreme: supremeRows, general: precedents }, homeState, this.maxResults)
          : prioritiseHomeCourt(precedents, homeState);
        const searchedAt = Date.now();
        const headed = await this.withHeaders(ordered);
        const headedAt = Date.now();
        /*
         * The card summaries and a named case's own summary are written at the
         * same time: both read the extracts withHeaders just fetched, and
         * neither reads the other. One after the other, the named case waited
         * for every card's summary before its own was begun.
         *
         * With a length asked for, the SUMMARY line already is the summary at
         * that length, and a second one under it would say the same again.
         */
        const [enriched, summarised] = await Promise.all([
          this.withPrinciples(headed, words),
          namedCase?.found && !words ? this.withSummary(headed) : Promise.resolve(null),
        ]);
        const summary = summarised?.[0]?.generated_summary;
        this.logger.info(
          {
            ms: Date.now() - started,
            searchMs: searchedAt - started,
            documentsMs: headedAt - searchedAt,
            summariesMs: Date.now() - headedAt,
            rows: enriched.length,
            named: Boolean(namedCase),
          },
          'Judgment search timings',
        );
        return {
          precedents: summary ? [{ ...enriched[0], generated_summary: summary }, ...enriched.slice(1)] : enriched,
          namedCase,
          grouping: scoped ? { homeCourt: homeCourtName(homeState) } : undefined,
          totalMatches: precedents[0]?.total_matches ?? precedents.length,
          // Kanoon runs its own relevance ranking; the local dense/lexical
          // distinction does not apply, so this is never a degraded state.
          lexicalOnly: false,
          source: 'kanoon',
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        if (err instanceof KanoonNotConfiguredError) {
          this.logger.warn('PRECEDENT_SOURCE is kanoon but no API key is set - using the local corpus');
        } else if (mode === 'kanoon') {
          // Explicitly pinned to Kanoon: silently serving local results would
          // misrepresent where the authorities came from.
          throw err;
        } else {
          this.logger.error({ err }, 'Indian Kanoon search failed - falling back to the local corpus');
        }
      }
    }

    return this.searchLocal(intent, started, homeState, words);
  }

  /**
   * Try each query in turn and stop at the first that answers the question.
   *
   * "Answers" depends on the question. For a named case it means a result whose
   * title is that case - ten results that are all somebody else is not an
   * answer, however many there are. For anything else, any result at all.
   *
   * ## What happens when an attempt fails
   *
   * An attempt that throws is skipped, not fatal. The operators are documented
   * but a malformed operand is still a failed call, and one bad attempt must not
   * cost the advocate the broader search behind it. Only when every attempt
   * throws is the error surfaced - which is what lets the `auto` source fall back
   * to the local corpus, and lets a charge be refunded.
   *
   * When nothing answers, the narrowest non-empty result set is returned as the
   * near misses: they came from the most specific question, so they are the
   * closest to what was asked.
   *
   * Cost: a hit on the first attempt is one call, as before. Only a miss pays
   * for the broader ones.
   */
  private async searchKanoon(intent: ClassifiedIntent): Promise<PrecedentRow[]> {
    const attempts = kanoonQueries(intent);
    const name = extractCaseName(intent.rawText);

    const matching = (rows: PrecedentRow[]): PrecedentRow[] =>
      name ? rows.filter((row) => caseNameScore(name, row.case_title) >= CASE_NAME_MATCH) : rows;

    let nearest: PrecedentRow[] = [];
    // Results naming the case that are only its orders. "Satender Kumar Antil
    // v. CBI bail guidelines" stopped at a 2024 daily order; the 2022 judgment
    // was a search further on (live test, 4 Oct, X24). Kept in case no search
    // finds the judgment itself.
    let ordersOnly: PrecedentRow[] = [];
    let failures = 0;
    let lastError: unknown = null;

    for (const query of attempts) {
      try {
        const rows = await this.kanoon.search(query, this.maxResults);
        const matches = matching(rows);
        if (matches.length > 0 && (!name || matches.some((row) => !isOrder(row)))) return rows;
        if (matches.length > 0 && ordersOnly.length === 0) ordersOnly = rows;
        if (nearest.length === 0) nearest = rows;

        this.logger.info(
          { query, results: rows.length, named: Boolean(name) },
          'Kanoon attempt did not answer the question - trying the next',
        );
      } catch (err) {
        failures += 1;
        lastError = err;
        this.logger.warn({ err, query }, 'Kanoon attempt failed - trying the next');
      }
    }

    if (failures === attempts.length) throw lastError;
    return ordersOnly.length > 0 ? ordersOnly : nearest;
  }

  /**
   * One court-restricted search, for the home-court and Supreme Court passes.
   * Those only add to the answer, so a failure costs them and nothing else:
   * the general search still stands on its own.
   */
  private async searchKanoonQuietly(query: string): Promise<PrecedentRow[]> {
    try {
      return await this.kanoon.search(query, this.maxResults);
    } catch (err) {
      this.logger.warn({ err, query }, 'Court-restricted Kanoon search failed - the general results stand');
      return [];
    }
  }

  /**
   * Fill CASE NO. and BENCH from the judgments themselves.
   *
   * ## Why a second call per row is the only way
   *
   * Indian Kanoon's search response, captured live, is: authorid, bench,
   * catids, citation, docsize, docsource, doctype, fragment, headline,
   * numcitedby, numcites, publishdate, tid, title - `citation` only on a
   * reported judgment, and only the first of its citations. There is no case
   * number in it, and
   * `bench` is `[888, 1990]` - author ids, not names, which is why BENCH read
   * "Not available" on every card whose `author` happened to be absent.
   *
   * Both are in the judgment's own header, which means fetching the document.
   *
   * ## Why only the first page
   *
   * The sample document was 1.1 MB and each one is a billed call. Rows past the
   * first page are frequently never read - the advocate finds what they need in
   * the first five - so enriching all fifteen would be paid for and thrown
   * away. KANOON_ENRICH_MAX caps it, and 0 turns it off.
   *
   * Fetched in parallel: five sequential round trips would add seconds to a
   * reply an advocate is waiting on in a corridor.
   *
   * Only Kanoon rows are touched. Ingested corpus judgments already carry a
   * neutral citation and a real bench, and have no document to fetch.
   */
  private async withHeaders(rows: PrecedentRow[]): Promise<PrecedentRow[]> {
    const limit = this.env.KANOON_ENRICH_MAX;
    if (limit === 0 || rows.length === 0) return rows;

    const enriched = [...rows];

    await Promise.all(
      rows.slice(0, limit).map(async (row, index) => {
        const tid = kanoonTid(row.judgment_id);
        if (tid === null) return;

        const header = await this.kanoon.documentHeader(tid);
        const citations = header.equivalentCitations ?? [];
        if (
          !header.caseNumber &&
          (header.bench ?? []).length === 0 &&
          !header.extract &&
          citations.length === 0 &&
          !header.neutralCitation
        ) {
          return;
        }

        enriched[index] = {
          ...enriched[index],
          // Kanoon publishes no neutral citation, so CASE NO. has been empty on
          // every card. The registry's own number is what an advocate quotes to
          // a court registry anyway.
          neutral_citation: enriched[index].neutral_citation ?? header.caseNumber,
          // Names beat the single `author` the search sometimes carries, and
          // beat the numeric ids it always carries.
          bench: header.bench.length > 0 ? header.bench : enriched[index].bench,
          bench_strength: header.bench.length || enriched[index].bench_strength,
          /*
           * EQUIVALENT CITATIONS, from every source Kanoon has.
           *
           * The document's `doc_citations` heading first, because it is the
           * complete list; then whatever the search result carried, which is
           * only its first entry and is normally a duplicate; then the court's
           * neutral citation, last, because an advocate reaches for AIR or SCC
           * before a neutral one when both exist.
           *
           * This field was empty on every card for months, and was explained
           * as impossible - Kanoon "exposes no citations". That was concluded
           * from probing one unreported judgment. Reported ones carry them.
           * An unreported judgment still reads "Not available", and that is now
           * a statement about the judgment rather than about this code.
           */
          reporter_citations: mergeCitations(
            citations,
            enriched[index].reporter_citations,
            header.neutralCitation,
          ),
          /*
           * The judgment's own words, in place of a search snippet.
           *
           * best_excerpt was Kanoon's `headline`, which for a title match is
           * the title echoed back with the query words emboldened - so the
           * summariser was being asked to find a principle in a cause title,
           * and correctly answered that there was none. That is why LEGAL
           * PRINCIPLE read "Not available" on cards whose judgment we now have
           * in full.
           *
           * Only when the row has nothing better. A corpus judgment's own
           * headnote or a genuine body snippet both outrank this.
           */
          best_excerpt: preferExtract(enriched[index], header.extract),
        };
      }),
    );

    return enriched;
  }

  /**
   * A summary of the judgment, for the one somebody asked for by name.
   *
   * ## Why this is not on every card
   *
   * The LEGAL PRINCIPLE line answers "what did this decide" in forty words,
   * which is what a ten-result page has room for. An advocate who named one
   * judgment is not scanning a list - they have the case and want what the
   * first page of it would have told them: what the proceeding was, what was in
   * issue, how it came out.
   *
   * Ten of those would run past WhatsApp's 4096-character limit and bury the
   * list they were meant to describe. One card, one summary.
   *
   * ## Why it never throws
   *
   * The card is assembled from retrieved rows and is correct without this. A
   * failed summary leaves `generated_summary` unset and the reply is the card
   * that shipped yesterday, which is a far better outcome than losing the
   * answer over the paragraph under it.
   */
  private async withSummary(rows: PrecedentRow[]): Promise<PrecedentRow[]> {
    const first = rows[0];
    if (!first || this.registry.isRouterMocked) return rows;

    const extract = (first.best_excerpt || '').replace(/\s+/g, ' ').trim();
    if (extract.length < 200) return rows;

    try {
      const result = await this.registry.complete({
        task: 'router',
        system: buildCaseSummaryPrompt(),
        messages: [{ role: 'user', content: extract.slice(0, 2_000) }],
        json: true,
        maxTokens: 400,
      });

      const parsed = parseJsonLoose<{ summary?: string }>(result.text);
      const summary = String(parsed?.summary ?? '').trim();

      // "NONE" is the model refusing an extract that states nothing, the same
      // refusal the principle summariser makes, and it is honoured the same way.
      if (!summary || summary.toUpperCase() === 'NONE') return rows;

      return [{ ...first, generated_summary: summary }, ...rows.slice(1)];
    } catch (err) {
      this.logger.warn({ err }, 'Could not summarise the judgment - the card stands without it');
      return rows;
    }
  }

  /** Hybrid dense + lexical search over the ingested Postgres corpus. */
  private async searchLocal(
    intent: ClassifiedIntent,
    started: number,
    homeState?: string | null,
    words?: number | null,
  ): Promise<PrecedentSearchResult> {
    const expanded = expandQuery(withoutLengthRequest(intent.searchQuery));
    const embedding = await this.embeddings.embedQuery(expanded);

    const precedents = await this.corpus.searchPrecedents({
      queryText: expanded,
      embedding,
      denseK: this.settings.getNumber('RAG_DENSE_TOP_K', this.env.RAG_DENSE_TOP_K),
      sparseK: this.settings.getNumber('RAG_SPARSE_TOP_K', this.env.RAG_SPARSE_TOP_K),
      rrfK: this.settings.getNumber('RAG_RRF_K', this.env.RAG_RRF_K),
      maxResults: this.maxResults,
      sections:
        intent.sectionNumber && intent.actCode ? [`${intent.actCode} ${intent.sectionNumber}`] : null,
    });

    this.logger.debug(
      {
        returned: precedents.length,
        totalMatches: precedents[0]?.total_matches ?? 0,
        lexicalOnly: !embedding,
      },
      'Precedent search complete',
    );

    const named = this.forNamedCase(intent.rawText, precedents);

    // Ordered here too, so both sources hand back a list in the order it will
    // be read and neither caller has to remember to do it. The corpus is one
    // search, so the courts are arranged from what it returned.
    const ordered = named.namedCase
      ? prioritiseHomeCourt(named.precedents, homeState)
      : arrangeByCourt({ home: [], supreme: [], general: named.precedents }, homeState, named.precedents.length);

    return {
      precedents: await this.withPrinciples(ordered, words),
      namedCase: named.namedCase,
      grouping: named.namedCase ? undefined : { homeCourt: homeCourtName(homeState) },
      totalMatches: precedents[0]?.total_matches ?? precedents.length,
      lexicalOnly: !embedding,
      source: 'local',
      latencyMs: Date.now() - started,
    };
  }

  /**
   * When the advocate named a judgment, put that judgment first - or say it is
   * not there.
   *
   * ## The reply this replaces
   *
   * "case of Rajesh Kumar Mittal vs State of Bihar . Patna High court" was
   * answered with "Case law - 10 precedents" and *Sunil Bharti Mittal vs The
   * State Of Bihar* at number one. Relevance ranking was working exactly as
   * designed: given free text, "Mittal" and "State of Bihar" are the best
   * lexical match available once the named case is not in the result set.
   *
   * The error is a level up. A request for one named judgment and a request for
   * authority on a question are different questions, and the second answer -
   * ten cases, newest first, no caveat - was being given to both. An advocate
   * reading it has no way to tell that the case they asked for is simply absent.
   *
   * So: matches to the front, and when there are none, a flag the formatter
   * turns into a plain sentence. The results are still shown, because the
   * closest names are genuinely useful when a title was misremembered - they
   * are just no longer presented as if they were what was asked for.
   *
   * Note what is *not* claimed. Absence from the index is not absence from the
   * law reports, so nothing here says the case does not exist.
   */
  private forNamedCase(
    /**
     * What the advocate typed, NOT intent.searchQuery.
     *
     * The rewrite is aimed at retrieval and rephrases freely: this same
     * question came back from the router as "case law for Rajesh Kumar Mittal
     * vs State of Bihar in Patna High Court", out of which the parties read as
     * "law for Rajesh Kumar Mittal" and "State of Bihar in Patna High Court".
     * That is wrong twice over - it is quoted back in the heading, and the
     * junk tokens dilute the score enough that the real judgment would have
     * been rejected too.
     */
    typed: string,
    rows: PrecedentRow[],
  ): { precedents: PrecedentRow[]; namedCase?: { name: string; found: boolean } } {
    const name = extractCaseName(typed);
    if (!name) return forCitation(typed, rows);

    const scored = rows.map((row) => ({ row, score: caseNameScore(name, row.case_title) }));
    const matches = scored.filter((s) => s.score >= CASE_NAME_MATCH);

    /*
     * Not found is an answer of its own - with nothing listed under it.
     *
     * The near misses used to be returned here, and the website showed them as
     * "3 authorities on the ratio of Mercy v. Mankind" - a case that does not
     * exist, answered with three real judgments that have nothing to do with
     * it. A list under a name reads as that case's authorities however it is
     * headed. Nothing is listed; the reply says the case was not found, and the
     * caller tries eCourts and the labelled web search after it.
     */
    if (matches.length === 0) {
      this.logger.info(
        { petitioner: name.petitioner, respondent: name.respondent, candidates: rows.length },
        'Named case not found in the results - the reply will say so, with nothing listed',
      );
      return { precedents: [], namedCase: { name: display(name), found: false } };
    }

    /*
     * Only the matches. The rest are dropped, not demoted.
     *
     * Ranking them below the hit was the first attempt and it still reads
     * wrong: the advocate asked for one judgment, got it at number one, and
     * then got nine more under the heading "Case law - 10 precedents" - among
     * them *State Of Himachal Pradesh vs Chander Sharma*, which shares neither
     * a party nor a court nor a subject with the question. They are there
     * because Kanoon returns ten results, not because anything connects them.
     *
     * Padding an exact answer with near misses makes the answer look like a
     * guess. A topic search is one question away when they want authorities.
     */
    /*
     * The judgment, ahead of the orders in the same matter.
     *
     * "Is Prakash v. Phulavati still good law?" listed nine Supreme Court
     * daily orders around the one judgment, and "Arnesh Kumar v. State of
     * Bihar" put six Patna High Court bail orders above the 2014 Supreme Court
     * judgment (audit re-run, NP8 and V1). When a court's own judgment is among
     * the matches, its orders are dropped, and the Supreme Court comes first.
     */
    const judgments = matches.filter((s) => !isOrder(s.row));
    const pool = judgments.length > 0 ? judgments : matches;
    // And the parties asked for, not someone whose name contains theirs.
    const same = pool.filter((s) => samePetitioner(name, s.row.case_title));
    const found = (same.length > 0 ? same : pool)
      .sort((a, b) => courtWeight(b.row) - courtWeight(a.row) || b.score - a.score)
      .map((s) => s.row);

    this.logger.info(
      { petitioner: name.petitioner, matched: found.length, discarded: rows.length - found.length },
      'Named case found - showing only the matching judgments',
    );

    return { precedents: found, namedCase: { name: display(name), found: true } };
  }

  /**
   * Fill in the SUMMARY line (formerly LEGAL PRINCIPLE) for rows that have no
   * authored one: what the case was about, then what it decided - at the
   * length the advocate asked for, when they asked for one.
   *
   * ## Why this exists
   *
   * The output format requires a principle on every card. Ingested judgments
   * carry a headnote or a ratio and need nothing from a model. Indian Kanoon -
   * which is where most deployments' results actually come from - carries
   * neither, so those cards printed no principle at all, which is the field an
   * advocate scanning ten results reads first.
   *
   * ## Why the whole feature does not depend on it
   *
   * Everything else on the card is assembled from retrieved rows, and that is
   * deliberate: it is what makes a fabricated citation structurally impossible.
   * This step is the one exception, so it is bounded on every side. It runs on
   * the cheap router model, in one call for the whole page. It is skipped
   * entirely when that model is a mock, because a placeholder string printed
   * under LEGAL PRINCIPLE reads as a finding about the case above it. And it
   * never throws: a failure leaves `generated_principle` unset and the card
   * falls back to whatever the row itself states.
   *
   * Rows that already carry a headnote or ratio are not sent at all - there is
   * nothing a model can add to the court's own words, and it would be a chance
   * to contradict them.
   */
  private async withPrinciples(rows: PrecedentRow[], words?: number | null): Promise<PrecedentRow[]> {
    if (rows.length === 0 || this.registry.isRouterMocked) return rows;

    const needed = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !(row.ratio_decidendi || row.headnote || '').trim())
      .filter(({ row }) => (row.best_excerpt || '').trim().length > 0);

    if (needed.length === 0) {
      /*
       * Logged rather than returned silently.
       *
       * Every card in a live search came back "LEGAL PRINCIPLE: Not available",
       * and from the outside that is indistinguishable from four different
       * causes: the model failing, the parse failing, the rows already having a
       * ratio, or - what this counts - Indian Kanoon returning no `headline`
       * for the documents it matched, which leaves nothing to summarise.
       *
       * `withoutExtract` is the number that decides it. If it equals the row
       * count, the summariser is starving, not broken, and the fix is upstream
       * at the search - not here.
       */
      this.logger.info(
        {
          rows: rows.length,
          withoutExtract: rows.filter((row) => !(row.best_excerpt || '').trim()).length,
          alreadyAuthored: rows.filter((row) =>
            (row.ratio_decidendi || row.headnote || '').trim(),
          ).length,
        },
        'No legal principles to summarise - nothing had an extract to summarise from',
      );
      return rows;
    }

    try {
      // Facts and a holding need more of the judgment than a holding alone
      // did, and a requested length more again. The Kanoon extract stops at
      // 2,000 characters, so that is the ceiling either way.
      const extractChars = words ? 2_000 : 1_500;
      const extracts = needed
        .map(({ row }, n) =>
          [
            `${n + 1}. ${row.case_title}`,
            row.court_name ? `Court: ${row.court_name}` : '',
            `Extract: ${(row.best_excerpt || '').replace(/\s+/g, ' ').slice(0, extractChars)}`,
          ]
            .filter(Boolean)
            .join(NEWLINE),
        )
        .join(NEWLINE + NEWLINE);

      const result = await this.registry.complete({
        task: 'router',
        system: buildPrincipleSummaryPrompt(words),
        messages: [{ role: 'user', content: extracts }],
        json: true,
        // Sized to what was asked for. A fixed 900 held ten forty-word entries
        // and truncated the JSON - losing every entry, not just the last - the
        // moment somebody asked for a hundred.
        maxTokens: summaryTokenBudget(needed.length, words),
      });

      const parsed = parseJsonLoose<{ principles?: { n?: number; principle?: string }[] }>(result.text);
      const byNumber = new Map<number, string>();
      const declined = new Set<number>();

      for (const entry of parsed?.principles ?? []) {
        const n = Number(entry?.n);
        const principle = String(entry?.principle ?? '').trim();
        if (!Number.isInteger(n) || !principle) continue;

        /*
         * "NONE" is the model doing the right thing on an extract that states
         * nothing, and it used to be dropped on the floor.
         *
         * Dropping it meant the row fell through to the last resort, which
         * prints the extract itself - so the advocate was shown the very text
         * the model had just declined to summarise, under a heading claiming it
         * was the principle of the case. Recorded instead.
         */
        if (principle.toUpperCase() === 'NONE') declined.add(n);
        else byNumber.set(n, principle);
      }

      const filled = [...rows];
      needed.forEach(({ index }, n) => {
        const principle = byNumber.get(n + 1);
        if (principle) filled[index] = { ...filled[index], generated_principle: principle };
        else if (declined.has(n + 1)) filled[index] = { ...filled[index], principle_declined: true };
      });

      this.logger.debug(
        { asked: needed.length, written: byNumber.size },
        'Legal principles summarised',
      );

      return filled;
    } catch (err) {
      this.logger.warn({ err }, 'Could not summarise legal principles - cards fall back to the row');
      return rows;
    }
  }

  /** Direct citation fetch: "pull up 2024 INSC 452". */
  async byCitation(citation: string): Promise<PrecedentRow[]> {
    return this.corpus.lookupByCitation(citation);
  }
}

// ---------------------------------------------------------------------------
// Formatting
//
// Kept as free functions rather than methods so they are trivially testable
// without a DI container - see precedents.format.spec.ts.
// ---------------------------------------------------------------------------

/** Shown wherever a field genuinely has no value, rather than dropping the line. */
export const NOT_AVAILABLE = 'Not available';

// Re-exported so callers that already import from this module do not need to
// reach into replies.ts as well.
export { CAVEAT, RETURN_TO_MENU };

/** Best available citation for display, preferring the neutral one. */
export function bestCitation(p: PrecedentRow): string | null {
  if (p.neutral_citation) return p.neutral_citation;
  if (p.reporter_citations?.length) return p.reporter_citations[0];
  return null;
}

/**
 * Indian Kanoon truncates long party names in the title, and the ellipsis
 * travels all the way to the advocate's phone: "Tiger Global International Iii
 * ... vs The Authority For Advance Rulings ...". It is noise in every case and
 * actively misleading in some, since it can look like part of the party's name.
 */
export function stripEllipsis(value: string): string {
  return value
    .replace(/\s*(\.{2,}|…)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a judgment title into the two sides.
 *
 * Indian case titles are "<petitioner> vs <respondent>", with the separator
 * written half a dozen ways. Only the *first* separator splits - "State of
 * Bihar vs Ram Kumar vs Anr" is one case with a messy respondent, not three
 * parties, and splitting on every occurrence would silently drop the tail.
 */
export function splitParties(title: string): { petitioner: string | null; respondent: string | null } {
  const cleaned = stripEllipsis(title);
  const match = /^(.*?)\s+(?:vs?\.?|versus|v\/s)\s+(.*)$/i.exec(cleaned);
  if (!match) return { petitioner: cleaned || null, respondent: null };

  const petitioner = match[1].trim();
  const respondent = match[2].trim();
  return { petitioner: petitioner || null, respondent: respondent || null };
}

/**
 * The High Court an advocate practises in, inferred from the state on their
 * profile.
 *
 * Deliberately a lookup rather than string matching on the court name: several
 * High Courts are not named after their state (Bihar is served by Patna, Punjab
 * and Haryana share one, the North-Eastern states share Gauhati), so "does the
 * court name contain the state name" is wrong for exactly the advocates most
 * likely to notice.
 */
const HIGH_COURT_BY_STATE: Record<string, string> = {
  'andaman and nicobar islands': 'calcutta high court',
  'andhra pradesh': 'andhra pradesh high court',
  'arunachal pradesh': 'gauhati high court',
  assam: 'gauhati high court',
  bihar: 'patna high court',
  chandigarh: 'punjab & haryana high court',
  chhattisgarh: 'chhattisgarh high court',
  'dadra and nagar haveli and daman and diu': 'bombay high court',
  delhi: 'delhi high court',
  goa: 'bombay high court',
  gujarat: 'gujarat high court',
  haryana: 'punjab & haryana high court',
  'himachal pradesh': 'himachal pradesh high court',
  'jammu and kashmir': 'jammu & kashmir high court',
  jharkhand: 'jharkhand high court',
  karnataka: 'karnataka high court',
  kerala: 'kerala high court',
  ladakh: 'jammu & kashmir high court',
  lakshadweep: 'kerala high court',
  'madhya pradesh': 'madhya pradesh high court',
  maharashtra: 'bombay high court',
  manipur: 'manipur high court',
  meghalaya: 'meghalaya high court',
  mizoram: 'gauhati high court',
  nagaland: 'gauhati high court',
  odisha: 'orissa high court',
  orissa: 'orissa high court',
  puducherry: 'madras high court',
  punjab: 'punjab & haryana high court',
  rajasthan: 'rajasthan high court',
  sikkim: 'sikkim high court',
  'tamil nadu': 'madras high court',
  telangana: 'telangana high court',
  tripura: 'tripura high court',
  'uttar pradesh': 'allahabad high court',
  uttarakhand: 'uttarakhand high court',
  'west bengal': 'calcutta high court',
};

export function homeHighCourt(state: string | null | undefined): string | null {
  if (!state) return null;
  return HIGH_COURT_BY_STATE[state.trim().toLowerCase()] ?? null;
}

/**
 * Float up to `max` judgments from the advocate's own High Court to the top.
 *
 * Their home court binds them; everything else is persuasive at best. Sorting
 * purely by date buries the one authority they can actually cite as binding
 * under three from other states.
 *
 * A *stable partition*, not a re-sort: within both groups the existing
 * newest-first order is preserved, and the cap stops a court with many hits
 * from crowding out the genuinely recent authority the advocate also needs.
 */
export function prioritiseHomeCourt(
  rows: PrecedentRow[],
  state: string | null | undefined,
  max = 3,
): PrecedentRow[] {
  const home = homeHighCourt(state);
  if (!home) return rows;

  const promoted: PrecedentRow[] = [];
  const rest: PrecedentRow[] = [];

  for (const row of rows) {
    const court = row.court_name?.toLowerCase() ?? '';
    if (promoted.length < max && court.includes(home)) promoted.push(row);
    else rest.push(row);
  }

  return [...promoted, ...rest];
}

/** "Karnataka High Court", for saying so on the page. */
export function homeCourtName(state: string | null | undefined): string | null {
  const court = homeHighCourt(state);
  return court ? court.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null;
}

/**
 * Kanoon's name for the advocate's High Court - "karnataka", "punjab",
 * "allahabad,lucknow" - or null for a court Kanoon does not document.
 */
export function homeCourtSlug(state: string | null | undefined): string | null {
  const court = homeHighCourt(state);
  return court ? courtFilter(court) : null;
}

/**
 * The extra searches a topic question gets: the advocate's High Court, and
 * the Supreme Court.
 *
 * None for a pasted citation or a named case - that is one judgment, wherever
 * it was decided. None when the advocate named a court themselves: "Patna
 * High Court judgments on bail" asked for Patna, and adding Karnataka to it
 * would be answering a different question.
 */
export function priorityQueries(
  intent: ClassifiedIntent,
  state: string | null | undefined,
): { home: string | null; supreme: string } | null {
  if (extractCitations(intent.rawText)[0] || extractCaseName(intent.rawText)) return null;
  if (courtFilter(intent.rawText)) return null;

  const base = provisionPhrase(intent) ?? withoutLengthRequest(intent.searchQuery).trim();
  if (!base) return null;

  const slug = homeCourtSlug(state);
  return {
    home: slug ? `${base} doctypes:${slug}` : null,
    supreme: `${base} doctypes:supremecourt`,
  };
}

/**
 * The order an advocate reads authority in: their own High Court first, then
 * the Supreme Court, then everything else - newest first within each, by the
 * DATE OF JUDGMENT on the card.
 *
 * Their High Court binds them and the Supreme Court binds everyone; the rest
 * is persuasive. A single newest-first list mixes the three and leaves the
 * advocate to sort them.
 *
 * ## Why each group has a share rather than the whole page
 *
 * Ten results, and the home court alone can fill them. Four from it, three
 * from the Supreme Court and three from elsewhere is the default split, and
 * any share a group cannot fill passes to the others in the same order - so a
 * court with nothing on the question costs no space, and a page is never
 * short while anything is left to show.
 *
 * A judgment found by more than one search appears once, in its highest group.
 */
export function arrangeByCourt(
  sources: { home: PrecedentRow[]; supreme: PrecedentRow[]; general: PrecedentRow[] },
  state: string | null | undefined,
  max: number,
): PrecedentRow[] {
  const homeName = homeHighCourt(state);
  const homeSlug = homeCourtSlug(state);

  const isHome = (row: PrecedentRow): boolean => {
    const court = (row.court_name ?? '').toLowerCase();
    if (!court || !homeName) return false;
    // Kanoon spells some courts its own way - "Chattisgarh", "Punjab-Haryana" -
    // so the court's search slug is compared as well as its name.
    return court.includes(homeName) || (homeSlug !== null && courtFilter(court) === homeSlug);
  };
  const isSupreme = (row: PrecedentRow): boolean => /\bsupreme court\b/i.test(row.court_name ?? '');

  const home: PrecedentRow[] = [];
  const supreme: PrecedentRow[] = [];
  const rest: PrecedentRow[] = [];
  const seen = new Set<string>();

  const place = (row: PrecedentRow, group: PrecedentRow[]): void => {
    if (seen.has(row.judgment_id)) return;
    seen.add(row.judgment_id);
    group.push(row);
  };

  // Every judgment goes where its own court puts it, whichever search found
  // it. The court-restricted searches are trusted only for a row that names no
  // court - a scope that leaks would otherwise put a stranger's judgment first.
  const sort = (row: PrecedentRow, scope: PrecedentRow[] | null): PrecedentRow[] =>
    isHome(row) ? home : isSupreme(row) ? supreme : !row.court_name && scope ? scope : rest;
  for (const row of sources.home) place(row, sort(row, home));
  for (const row of sources.supreme) place(row, sort(row, supreme));
  for (const row of sources.general) place(row, sort(row, null));

  const groups = [home, supreme, rest].map(byJudgmentDate);
  const shares = [Math.ceil(max * 0.4), Math.ceil(max * 0.3), max];
  const taken = groups.map((group, i) => Math.min(group.length, shares[i]));

  // Hand what a group could not use to the others, in order.
  let spare = max - taken.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < groups.length && spare > 0; i++) {
    const more = Math.min(groups[i].length - taken[i], spare);
    if (more > 0) {
      taken[i] += more;
      spare -= more;
    }
  }

  // The total can exceed max only through the rest group's share, which is
  // bounded by what is left after the first two.
  const rows = groups.flatMap((group, i) => group.slice(0, taken[i]));
  return rows.slice(0, max);
}

/**
 * How the list is ordered, in words - so the advocate knows the first card is
 * first because of its court, and not because it is the newest.
 */
export function orderingNote(grouping: { homeCourt: string | null } | undefined): string {
  if (!grouping) return 'newest first';
  return grouping.homeCourt
    ? `${grouping.homeCourt} first, then the Supreme Court, then other courts — newest first within each`
    : 'Supreme Court first, then other courts — newest first within each';
}

/** Newest first by date of judgment; undated last. A copy, never in place. */
function byJudgmentDate(rows: PrecedentRow[]): PrecedentRow[] {
  const time = (row: PrecedentRow): number => {
    if (!row.judgment_date) return Number.NEGATIVE_INFINITY;
    const at = new Date(row.judgment_date).getTime();
    return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
  };
  return [...rows].sort((a, b) => time(b) - time(a));
}

function year(date: Date | null): string {
  if (!date) return 'date unknown';
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? 'date unknown' : String(d.getUTCFullYear());
}

function fullDate(date: Date | null): string | null {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Condense a passage to a readable synopsis.
 *
 * Cuts on a sentence boundary where one is available within range, because a
 * mid-clause truncation of a legal holding can invert its meaning - "the court
 * held that bail could not be granted where…" is a very different sentence from
 * its first eight words.
 */
export function synopsis(p: PrecedentRow, limit = 260): string {
  const source = (p.ratio_decidendi || p.headnote || p.best_excerpt || '').replace(/\s+/g, ' ').trim();
  if (!source) return 'No synopsis available for this judgment.';
  if (source.length <= limit) return source;

  const window = source.slice(0, limit);
  const lastStop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '));
  return lastStop > limit * 0.5 ? window.slice(0, lastStop + 1) : `${window.trimEnd()}…`;
}

/**
 * Output tokens for one summariser call: the words asked for, per entry, with
 * room for the JSON around them. About 1.5 tokens a word in English; 2 leaves
 * slack for names and Hinglish.
 */
export function summaryTokenBudget(entries: number, words?: number | null): number {
  const perEntry = (words ?? DEFAULT_SUMMARY_WORDS) * 2;
  return Math.min(8_000, 300 + entries * perEntry);
}

/** About 350 words: well past any length the prompt asks for. */
const GENERATED_SUMMARY_CEILING = 2_400;

/**
 * The line under SUMMARY, or nothing at all.
 *
 * ## Why this can return null
 *
 * The corpus supplies a headnote or a ratio for judgments we have ingested, and
 * either is a real statement of what the case decided. Indian Kanoon supplies
 * neither. What it gives is `headline` - a snippet with the query terms
 * highlighted - and for a judgment where those terms appear only in the
 * metadata, that snippet is the document's own header:
 *
 *   "The State Of Bihar vs Imteyaz Alam @ Ansari on 11 September, 2024
 *    Author: Ashutosh Kumar"
 *
 * Printing that after the words LEGAL PRINCIPLE is worse than printing nothing.
 * It is not wrong the way a hallucination is wrong - every word is true - but it
 * claims to be the holding of the case and is actually the title, the date and
 * the judge, all three of which are already on the card immediately above it.
 * An advocate reads it, learns nothing, and concludes the product is broken.
 *
 * So: a real principle, or no line.
 */
export function legalPrinciple(p: PrecedentRow, limit = 200): string | null {
  // Ingested judgments carry the real thing; none of the rescue below applies.
  const authored = (p.ratio_decidendi || p.headnote || '').replace(/\s+/g, ' ').trim();
  if (authored) return stripEllipsis(synopsis({ ...p, best_excerpt: authored }, limit));

  // Written by the model from this row's own extract, and only where the row
  // states no principle of its own - see PrecedentsService.withPrinciples().
  // Ranked below the court's words and above our own salvage attempt.
  //
  // Not held to `limit`. That cut every one at 200 characters - about thirty
  // words - so a summary written to the length the advocate asked for arrived
  // with its second half missing. The model was given the length; the ceiling
  // here only guards against one that ignored it.
  const generated = (p.generated_principle || '').replace(/\s+/g, ' ').trim();
  if (generated) return stripEllipsis(synopsis({ ...p, best_excerpt: generated }, GENERATED_SUMMARY_CEILING));

  // The summariser read the extract and said it states no principle. Printing
  // that extract anyway - which is what the salvage below does - shows the
  // advocate the exact text a reader has already rejected, labelled as the
  // holding. "Not available" is the honest end of this chain.
  if (p.principle_declined) return null;

  const excerpt = (p.best_excerpt || '').replace(/\s+/g, ' ').trim();
  if (!excerpt) return null;
  if (isDocumentHeader(excerpt, p.case_title)) return null;

  const trimmed = stripEllipsis(synopsis(p, limit));
  // A handful of words is a fragment, not a principle. The threshold is low on
  // purpose - the aim is to catch residue, not to judge brevity.
  return trimmed.replace(/[^A-Za-z]/g, '').length >= 40 ? trimmed : null;
}

/**
 * Is this snippet just the judgment's own header?
 *
 * Two independent signals, either sufficient, because Kanoon's header format
 * varies with how much of the title it kept:
 *
 *   - the snippet opens with the case title it sits beneath, or
 *   - stripping the "on <date>" and "Author: <name>" furniture leaves almost
 *     nothing behind
 */
function isDocumentHeader(excerpt: string, caseTitle: string): boolean {
  const norm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, '');

  const title = norm(stripEllipsis(caseTitle));
  // 24 characters is enough to identify the case and short enough to survive
  // Kanoon truncating long party names.
  if (title.length >= 24 && norm(excerpt).startsWith(title.slice(0, 24))) return true;

  const residue = excerpt
    .replace(/on\s+\d{1,2}\s+\w+,?\s+\d{4}/gi, '')
    .replace(/author\s*:\s*[^.,;]{0,60}/gi, '')
    .replace(/bench\s*:\s*[^.,;]{0,60}/gi, '')
    .replace(/[^A-Za-z]/g, '');

  return residue.length < 40;
}

/**
 * Render one page of precedents as a WhatsApp message.
 *
 * WhatsApp hard-truncates around 4096 characters, so the list is paged rather
 * than sent whole - five judgments with synopses is already close to the limit.
 * `offset` is the index into the (date-sorted) full result set.
 */
export function formatPrecedentPage(
  all: PrecedentRow[],
  offset: number,
  pageSize: number,
  query: string,
  opts: {
    lexicalOnly?: boolean;
    source?: 'local' | 'kanoon';
    namedCase?: { name: string; found: boolean };
    grouping?: { homeCourt: string | null };
  } = {},
): string {
  if (all.length === 0 && opts.namedCase && !opts.namedCase.found) {
    return [
      `*No judgment found: "${opts.namedCase.name}"*`,
      '',
      "It is not in Ley Legal's sources. Check the party names or the citation, or describe the point of law instead.",
    ].join('\n');
  }

  if (all.length === 0) {
    return [
      `*No precedents found*`,
      '',
      `I could not find any judgment in the corpus matching _"${query}"_.`,
      '',
      'Try rephrasing with the legal issue rather than the facts — for example ' +
        '_"anticipatory bail in NDPS commercial quantity"_ rather than _"my client was caught with drugs"_.',
    ].join('\n');
  }

  const page = all.slice(offset, offset + pageSize);
  const shownTo = offset + page.length;

  /*
   * A failed name lookup must not wear the successful search's heading.
   *
   * "Case law - 10 precedents" over ten judgments that are not the one asked
   * for is the whole complaint: nothing in that reply tells the advocate the
   * named case is absent, so the first result reads as the answer.
   *
   * The closest names are still worth showing - titles get misremembered, and
   * the right case is often two words away - but they are labelled as what they
   * are. And the sentence stops short of "no such case": absence from the index
   * is not absence from the reports, and that is not a claim this can make.
   */
  const named = opts.namedCase;

  const header =
    named && !named.found
      ? [
          `*No judgment found named "${named.name}"*`,
          '',
          'I could not find that case. It may be reported under a slightly ' +
            'different cause title, or not be in the searchable record.',
          '',
          `*Closest matches by name* — showing ${offset + 1}–${shownTo} of ${all.length}.`,
        ]
      : named
        ? [
            `*${named.name}*`,
            '',
            all.length === 1
              ? 'One judgment matches that name.'
              : `${all.length} judgments match that name — showing ${offset + 1}–${shownTo}.`,
          ]
        : [
            `*Case law — ${all.length} precedent${all.length === 1 ? '' : 's'}*`,
            `_${query}_`,
            '',
            `Showing ${offset + 1}–${shownTo} of ${all.length}, ${orderingNote(opts.grouping)}.`,
          ];

  if (opts.lexicalOnly) {
    // Say so rather than quietly returning worse results.
    header.push('_Note: semantic search is off, so these are keyword matches only._');
  }

  /*
   * Every label, on every card, in the order the output format names them.
   *
   * This dropped empty labels for a while, on the reasoning that Indian Kanoon
   * supplies no citation for most judgments and three dead lines per result push
   * the informative ones off a phone screen. That pressure is real and it lost
   * to the requirement: the format names seven fields and says each precedent
   * must include them, so a card that silently omits three is not a tidier card,
   * it is a different one. An advocate scanning for EQUIVALENT CITATIONS cannot
   * tell "this judgment has none" from "this build stopped printing them".
   *
   * The pressure is answered where it belongs instead. LEGAL PRINCIPLE - the
   * line carrying most of the information on a card - is now written from the
   * judgment's own extract rather than left blank, so the fields that stay
   * empty are the ones that are genuinely empty at the source.
   */
  const line = (label: string, value: string | null | undefined): string =>
    `${label}: ${value && value.trim() ? value.trim() : NOT_AVAILABLE}`;

  const entries = page.map((p, i) => {
    const n = offset + i + 1;
    const { petitioner, respondent } = splitParties(p.case_title);

    const bench =
      p.bench?.length
        ? p.bench.join(', ')
        : p.bench_strength && p.bench_strength > 1
          ? `${p.bench_strength}-judge bench`
          : NOT_AVAILABLE;

    const principle = legalPrinciple(p);

    /*
     * The equivalents are the *other* citations, not the best one.
     *
     * This line used to print bestCitation(), which prefers the neutral
     * citation - the same string CASE NO. had already printed one line above.
     * So a judgment with both kinds showed its neutral citation twice and its
     * reporter citation not at all, which is the one an advocate needs to pull
     * the judgment out of a law report.
     */
    const equivalents = (p.reporter_citations ?? []).filter(
      (citation) => citation && citation !== p.neutral_citation,
    );

    return [
      `*${n}. ${stripEllipsis(p.case_title)}*`,
      line('CASE NO.', p.neutral_citation),
      line('PETITIONER', petitioner),
      line('RESPONDENT', respondent),
      line('DATE OF JUDGMENT', fullDate(p.judgment_date)),
      line('BENCH', bench),
      line('EQUIVALENT CITATIONS', equivalents.join('; ')),
      line('COURT', p.court_name),
      /*
       * No link, and no naming of where the result came from.
       *
       * A READ: line pointing at indiankanoon.org was added here on the
       * reasoning that three of the seven fields come back empty and the card
       * was otherwise a dead end. That was the wrong trade and the instruction
       * is explicit: this product never sends an advocate to another site. A
       * link out is an admission that the answer is elsewhere, printed on every
       * card, next to a competitor's name.
       *
       * The empty fields are a reason to fill them, not a reason to hand the
       * advocate off. Same rule in VAKEEL_PERSONA for the generated replies.
       */
      '',
      // "Not available" rather than the document's own header standing in for a
      // holding. Every word of that header is true and it is not what the case
      // decided, which is the one thing this line claims to be.
      line('SUMMARY', principle),
      // Only ever present on a judgment asked for by name - see withSummary.
      // Below the short summary rather than above it, because that is the line
      // an advocate reads first and this is what they read next.
      ...(p.generated_summary ? ['', `FULL SUMMARY: ${p.generated_summary}`] : []),
    ].join(NEWLINE);
  });

  const footer: string[] = [];
  if (shownTo < all.length) {
    footer.push('', `_${all.length - shownTo} more — reply *more* to continue._`);
  } else if (all.length > pageSize) {
    // Naming the ceiling matters: without it, "End of results" reads as "there
    // is no further authority on this", which is a very different claim.
    footer.push('', `_That is all ${all.length} precedents for this search._`);
  }

  footer.push('', CAVEAT, '', RETURN_TO_MENU);

  return [...header, '', entries.join('\n\n────────\n\n'), ...footer].join('\n');
}
