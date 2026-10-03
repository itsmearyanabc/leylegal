/**
 * "Rajesh Kumar Mittal vs State of Bihar" is a case, not a topic.
 *
 * ## The failure this exists to stop
 *
 * An advocate asked for that case, by name, in the Patna High Court. What came
 * back was headed "Case law - 10 precedents" and the first result was *Sunil
 * Bharti Mittal vs The State Of Bihar*. Nothing about that reply was flagged as
 * uncertain: ten unrelated judgments, presented as authority, in the confident
 * format the product uses for a topic search that worked.
 *
 * The retrieval did nothing wrong on its own terms. It was handed free text and
 * ranked by relevance, and "Mittal" plus "State of Bihar" genuinely is the best
 * lexical match available when the named case is not in the result set. The
 * mistake is one level up: a request for *one named judgment* and a request for
 * *authorities on a question* are different questions, and only one of them is
 * answered by "here are ten relevant cases, newest first".
 *
 * ## What this module decides, and what it does not
 *
 * It decides two things, both purely from text: whether the advocate named a
 * case, and how well a given judgment title matches the name they gave. It does
 * not fetch, rank, or format anything - the caller does that, so this stays
 * testable without a network or a corpus.
 *
 * It deliberately does **not** try to decide whether a case exists. Absence
 * from Kanoon's index is not absence from the law reports, and a bot that says
 * "no such case" on that basis would be wrong in a way an advocate cannot
 * check. What the caller says instead is "I could not find a judgment by that
 * name", which is true and is a different claim.
 */

import { withoutLengthRequest } from './summary-length';

export interface CaseName {
  /** The party before the "vs". */
  petitioner: string;
  /** The party after it. */
  respondent: string;
  /**
   * The court the advocate named, as they wrote it - "Patna High court".
   *
   * Stripped out of the parties, and kept rather than discarded, because it
   * still narrows the search - but as a `doctypes:` restriction resolved from
   * it, never as words in the query. Leaving "Patna High Court" in the text
   * being matched puts three tokens into it that every judgment of that court
   * also contains, which crowds out the parties. See namedCaseQuery.
   */
  court?: string;
}

/**
 * Words that carry no identifying force in a case title.
 *
 * "State", "Union of India" and "Ors" appear in a large fraction of Indian
 * judgments, so matching on them matches almost everything - which is exactly
 * how *Sunil Bharti Mittal vs The State Of Bihar* came first for a query about
 * a different Mittal. They are kept for display and ignored for scoring.
 */
const NOISE = new Set([
  'the', 'of', 'and', 'a', 'an', 'in', 'at', 'on', 'v', 'vs', 'versus',
  'ors', 'ors.', 'anr', 'anr.', 'others', 'another', 'etc',
  'state', 'states', 'union', 'india', 'govt', 'government',
  'ltd', 'ltd.', 'limited', 'pvt', 'pvt.', 'private', 'co', 'co.', 'company',
  'm/s', 'ms', 'mr', 'mrs', 'shri', 'smt', 'sri',
]);

/**
 * Everything an advocate puts in front of a case name that is not part of it.
 *
 * `law` is in the noun list and `for|on|about` in the preposition list because
 * of a real reply: "case law for Rajesh Kumar Mittal vs ..." lost only the word
 * "case", and the petitioner came out as "law for Rajesh Kumar Mittal". Both
 * halves are repeated so the whole phrase goes, not just its first word.
 */
const LEAD_IN =
  /^(?:(?:the\s+)?(?:case|judgment|judgement|matter|decision|order|citation|ruling|law)\s+)+(?:(?:of|in|for|on|about|titled|named|regarding|re)\s+)*/i;

/**
 * "Give me a summary of X vs Y", "X vs Y ka summary do".
 *
 * Asking for a summary is how advocates ask about one named case, and the
 * request was being read as part of it: the petitioner came out as "give me
 * summary of Rajesh Kumar Mittal", which scores 0.5 against the real title and
 * reported the case as not found. Both anchored, so a summary word in the
 * middle of a name is left alone.
 */
const SUMMARY_LEAD_IN =
  /^(?:(?:please|pls|plz|kindly|can|could|would|you|what|whats|what's|is|give|send|share|provide|show|tell|write|get|me|us|a|an|the|short|brief|detailed|quick|full|complete)\s+)*(?:summary|summarise|summarize|synopsis|gist)\s+(?:(?:of|for|on|about|regarding)\s+)?/i;

const SUMMARY_TAIL =
  /[\s,.;:-]+(?:(?:ka|ki|ke|kaa|with|and|give|me|a|short|brief|detailed|full)\s+)*(?:summary|summarise|summarize|synopsis|gist)(?:\s+(?:do|de|dedo|dijiye|batao|bataiye|chahiye|karo|kijiye|likho|please|pls|plz))*[\s.?!]*$/i;

function withoutSummaryRequest(text: string): string {
  return withoutLengthRequest(text).replace(SUMMARY_LEAD_IN, '').replace(SUMMARY_TAIL, '');
}

/**
 * The date Kanoon puts in its own titles, which advocates paste back verbatim.
 *
 * Every Kanoon result is titled "X vs Y on 18 January, 2005", so the fastest
 * way for somebody to ask about one is to copy that line - and the respondent
 * then came out as "State Of Bihar on 18 January", which is quoted back in the
 * heading and diluted the score with two tokens that identify nothing.
 */
const TRAILING_DATE = /\s+on\s+\d{1,2}\s+[A-Za-z]+,?\s*(?:(?:19|20)\d{2})?\s*$/i;

/**
 * A court named as context for the search, not as a party.
 *
 * The first version required punctuation in front of it, which caught
 * "... vs State of Bihar . Patna High court" and missed "... vs State of Bihar
 * in Patna High Court" - and the second is the ordinary way to write it.
 *
 * A case genuinely brought *against* a court - a writ on the administrative
 * side - loses its respondent here and the whole extraction returns null, so
 * the query falls back to an ordinary topic search. That is the right way for
 * this to fail: a topic search on a cause title still finds the case, while a
 * name lookup with an empty respondent could not.
 */
const TRAILING_COURT =
  /[\s.,;]+(?:(?:in|from|at|before|of|by)\s+)?(?:the\s+)?[A-Za-z]*\s*\b(?:high\s+court|supreme\s+court|apex\s+court|tribunal|district\s+court|sessions\s+court)\b.*$/i;

/**
 * The separator, in the forms that appear in practice.
 *
 * `v.` and `vs.` are the reported forms; `versus` is written out in cause
 * titles; `vs` unpunctuated is what people type on a phone. Requiring word
 * boundaries on both sides keeps it from firing inside a word - without them,
 * "Ms" and "Advs" both contain a match.
 */
const SEPARATOR = /\s+(?:vs?\.?|versus)\s+/i;

/**
 * Pull a case name out of a message, or null when there is not one.
 *
 * Null is the common answer and the right one for most queries: "anticipatory
 * bail after chargesheet" names no case and must go on being answered as a
 * topic search.
 */
export function extractCaseName(text: string): CaseName | null {
  if (!text) return null;

  const withoutLeadIn = withoutSummaryRequest(text.trim())
    .trim()
    .replace(LEAD_IN, '')
    .replace(/[.,;]?\s*\(?\b(19|20)\d{2}\)?\s*$/, '');

  const parts = withoutLeadIn.split(SEPARATOR);
  if (parts.length !== 2) return null;

  /*
   * Trailing court, date and request words - "... . Patna High court", "...
   * (2017)", "... still good law?" - are looked for after the separator only.
   *
   * Searched across the whole question, a court named *before* the parties -
   * "Summarise the Supreme Court judgment in Ritu Malhotra v. Bar Council of
   * Bihar" - matched and took everything after it, the parties included, so
   * no case name was found at all. A leading space keeps "X vs Delhi High
   * Court" a court through and through, as before.
   */
  const tail = ` ${parts[1]}`;
  const courtMatch = TRAILING_COURT.exec(tail);
  const respondentText = trimRequestTail(
    tail
      .replace(TRAILING_COURT, '')
      .replace(TRAILING_DATE, '')
      // Again, for "X vs Y summary (2017)", where the year was behind the
      // summary word the first pass looked for.
      .replace(SUMMARY_TAIL, ''),
  );

  const petitioner = tidyParty(trimRequestHead(parts[0]));
  const respondent = tidyParty(respondentText);
  if (!petitioner || !respondent) return null;
  const headCourt = HEAD_COURT.exec(parts[0]);

  // A separator with a whole sentence on one side is not a cause title. "Is
  // bail granted when the accused vs the complainant have settled" is a
  // question, and answering it with a case-name lookup would be worse than
  // answering it as a topic.
  if (words(petitioner).length > 8 || words(respondent).length > 8) return null;

  const court = courtMatch
    ? courtMatch[0].replace(/^[\s.,;]+/, '').trim()
    : headCourt
      ? headCourt[0].trim()
      : undefined;
  return court ? { petitioner, respondent, court } : { petitioner, respondent };
}

/**
 * The words of a request, which run into the petitioner's name.
 *
 * "Give the full SCC citation of Arnesh Kumar v. State of Bihar" read the
 * petitioner as "Give the full SCC citation of Arnesh Kumar", which no title
 * matches - so the most cited arrest judgment in the country came back as not
 * found, and four unrelated ones were listed in its place.
 */
const REQUEST_WORDS = new Set([
  'give', 'tell', 'show', 'share', 'send', 'provide', 'explain', 'find', 'get', 'me', 'us', 'the', 'a', 'an',
  'full', 'complete', 'summary', 'summarise', 'summarize', 'citation', 'cite', 'scc', 'air', 'holding', 'ratio',
  'judgment', 'judgement', 'decision', 'case', 'order', 'status', 'details', 'detail', 'facts', 'supreme', 'high',
  'court', 'apex', 'please', 'kindly', 'what', 'whats', 'is', 'was', 'latest', 'leading', 'landmark', 'key',
  'its', 'of', 'in', 'on', 'about', 'for', 'regarding', 're',
]);

/** A court named before the parties - "the Supreme Court judgment in X v. Y". */
const HEAD_COURT = /\b(?:supreme|apex|high|district|sessions)\s+court\b|\btribunal\b/i;

/**
 * The petitioner without the request in front of it.
 *
 * Cut at the last "of / in / on / about / for / regarding" before which every
 * word is a request word - "Give the full SCC citation of" - and never where a
 * name word comes first: "State of Bihar" keeps its "of". Then a leading
 * question word: "Is ADM Jabalpur" is ADM Jabalpur.
 */
function trimRequestHead(head: string): string {
  let out = head.trim();
  for (const match of out.matchAll(/\b(?:of|in|on|about|for|regarding)\s+/gi)) {
    const before = out.slice(0, match.index).trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (before.length > 0 && before.every((word) => REQUEST_WORDS.has(word.replace(/[^a-z']/g, '')))) {
      out = out.slice((match.index ?? 0) + match[0].length);
      return trimRequestHead(out);
    }
  }
  return out.replace(/^(?:(?:is|was|were|whether|does|did|has|had|what|which|please|kindly|the)\s+)+/i, '');
}

/**
 * The respondent without the request behind it - "... and its key holding",
 * "... still good law?", "... judgment ka ratio kya hai?" - or a citation:
 * "Ramesh Kumar Yadav, (2021) 4 SCC 999" is Ramesh Kumar Yadav.
 */
function trimRequestTail(tail: string): string {
  return tail
    .replace(/[,;]?\s*(?:\(\d{4}\)|\[\d{4}\]|\d{4})\s+\d+\s+[A-Z][A-Za-z.]*\s+\d+.*$/, '')
    .replace(/[,;]?\s*AIR\s+\d{4}\s+[A-Z][A-Za-z.]*\s+\d+.*$/i, '')
    .replace(/[,;]?\s*\d{4}\s+INSC\s+\d+.*$/i, '')
    .replace(
      /\s+(?:and\s+(?:its|the|his|her|their)\b|still\b|judg(?:e)?ments?\b|ka\b|ki\b|ke\b|ratio\b|kya\b|holding\b|good\s+law\b|case\s+law\b|decided\b|summary\b|citation\b|on\s+(?:the\s+)?(?:question|issue|point)\b).*$/i,
      '',
    )
    .replace(/[?!]+\s*$/, '')
    .trim();
}

/**
 * How well a judgment title matches the name the advocate gave: 0 to 1.
 *
 * ## Why the two halves are not weighted equally
 *
 * The petitioner is what identifies an Indian case. The respondent is very
 * often the State, and "vs State of Bihar" is shared by tens of thousands of
 * judgments - so a respondent match is nearly free and must not be able to
 * carry a result on its own. Scoring them equally is what let a title agreeing
 * on *only* the common half rank first.
 *
 * The distinctive tokens are what count on both sides. Once "the", "state",
 * "of" and "ors" are removed, "Rajesh Kumar Mittal" contributes {rajesh,
 * kumar, mittal} and "Sunil Bharti Mittal" matches one of the three.
 */
export function caseNameScore(name: CaseName, title: string): number {
  const parts = title.split(SEPARATOR);
  const titlePetitioner = signal(parts[0] ?? '');
  const titleRespondent = signal(parts[1] ?? '');

  const wantPetitioner = signal(name.petitioner);
  const wantRespondent = signal(name.respondent);

  // No distinctive tokens on either side of the request - "State vs State".
  // Nothing to match on, so nothing is claimed.
  if (wantPetitioner.length === 0 && wantRespondent.length === 0) return 0;

  const petitioner = overlap(wantPetitioner, titlePetitioner);
  const respondent = overlap(wantRespondent, titleRespondent);

  // When the request has no distinctive petitioner, the respondent is all there
  // is and carries the score alone; otherwise it is worth a quarter.
  if (wantPetitioner.length === 0) return respondent;
  if (wantRespondent.length === 0) return petitioner;
  return petitioner * 0.75 + respondent * 0.25;
}

/**
 * The score at which a title is the case that was asked for.
 *
 * Set from the failure it exists to catch. *Sunil Bharti Mittal vs The State Of
 * Bihar* scores 0.33 x 0.75 + 1 x 0.25 = 0.5 against "Rajesh Kumar Mittal vs
 * State of Bihar" - one shared surname and the universal respondent - so the
 * bar has to sit above that. A genuine match, differing only in "The" and
 * capitalisation, scores 1.
 *
 * Deliberately not higher than 0.7: an advocate types "Mittal vs State of
 * Bihar" from memory more often than they type the full cause title, and that
 * abbreviation scores 1 against the real case and must still be found.
 */
export const CASE_NAME_MATCH = 0.7;

/**
 * Offices a cause title spells out and an advocate abbreviates - or the other
 * way round. "ADM Jabalpur v. Shivkant Shukla" is titled "Additional District
 * Magistrate, Jabalpur vs Shivakant Shukla" on Indian Kanoon, and was reported
 * as not found (audit re-run, P7).
 */
const ABBREVIATIONS: Record<string, string[]> = {
  adm: ['additional', 'district', 'magistrate'],
  sdm: ['sub', 'divisional', 'magistrate'],
  dm: ['district', 'magistrate'],
  cit: ['commissioner', 'income', 'tax'],
  addl: ['additional'],
  commr: ['commissioner'],
  dy: ['deputy'],
};

/** Distinctive tokens: lowercased, punctuation gone, abbreviations spelt out, noise words dropped. */
function signal(value: string): string[] {
  return words(value)
    .flatMap((word) => ABBREVIATIONS[word.replace(/[.]/g, '')] ?? [word])
    .filter((word) => !NOISE.has(word) && word.length > 1);
}

/**
 * The words of a cause title that survive Kanoon's shortening of it, for a last
 * title search: the start of the petitioner, abbreviations spelt out, and the
 * respondent's last name. Null when that is no narrower than the full title.
 *
 * Kanoon cuts a long party to its first words: ADM Jabalpur is titled
 * "Additional District Magistrate, ... vs Shivakant Shukla", so "Jabalpur" is
 * not in the title, and "Shivkant" is spelt differently. "title: additional
 * district magistrate shukla" finds it (checked on indiankanoon.org, 4 Oct 2026).
 */
export function looseTitle(name: CaseName): string | null {
  const petitioner = signal(name.petitioner).slice(0, 3);
  const respondent = signal(name.respondent).slice(-1);
  const words = [...petitioner, ...respondent];
  return words.length >= 2 ? words.join(' ') : null;
}

/**
 * The same name, allowing one transliteration difference: a vowel or a doubled
 * letter written in one and not the other - "Shivkant" and "Shivakant",
 * "Mital" and "Mittal". Never a changed letter: "Rajesh" is not "Ramesh".
 */
function sameName(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (short.length < 4 || long.length !== short.length + 1) return false;
  for (let i = 0; i < long.length; i++) {
    if (long.slice(0, i) + long.slice(i + 1) !== short) continue;
    const dropped = long[i];
    if ('aeiou'.includes(dropped) || long[i - 1] === dropped || long[i + 1] === dropped) return true;
  }
  return false;
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** What fraction of the wanted tokens appear in the candidate. */
function overlap(wanted: string[], found: string[]): number {
  if (wanted.length === 0) return 0;
  const hits = wanted.filter((word) => found.some((other) => sameName(word, other))).length;
  return hits / wanted.length;
}

/** Strip the decorations around a party name without altering the name. */
function tidyParty(value: string): string {
  return value
    .replace(/[.,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
