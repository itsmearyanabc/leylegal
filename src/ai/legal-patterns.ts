/**
 * Pattern matching for Indian legal text.
 *
 * Used in two places with opposite goals:
 *  - on the way IN, to pull structure out of what an advocate typed
 *  - on the way OUT, to find every citation the model produced so the guardrail
 *    can check each one against the corpus
 *
 * The output direction is the one that matters for safety: a citation format
 * missed here is a citation that never gets verified, so these patterns err
 * towards over-matching. A false positive costs one wasted corpus lookup.
 */

/**
 * CNR (Case Number Record): 16 characters.
 *   4 letters   state + district code   e.g. DLCT
 *   2 alnum     court establishment     e.g. 01
 *   6 digits    case number             e.g. 000123
 *   4 digits    year                    e.g. 2024
 *
 * Advocates paste these with hyphens and spaces, so normalise before matching.
 */
const CNR_PATTERN = /\b([A-Z]{4}[A-Z0-9]{2})[\s\-_/]?(\d{6})[\s\-_/]?(\d{4})\b/;

export function extractCnr(text: string): string | null {
  // Matched against the original text with optional separators, rather than
  // against a separator-stripped copy. Stripping first glues the CNR to
  // surrounding words ("CNR: DLCT01/000123/2024 please" -> "...2024PLEASE"),
  // which destroys the trailing word boundary and the match with it.
  const match = CNR_PATTERN.exec(text.toUpperCase());
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

export function isValidCnr(cnr: string): boolean {
  const normalised = cnr.toUpperCase().replace(/[\s\-_/]/g, '');
  if (normalised.length !== 16) return false;
  if (!/^[A-Z]{4}[A-Z0-9]{2}\d{10}$/.test(normalised)) return false;

  // Year sanity check: eCourts data starts in the 1950s, and a case filed in
  // the future is a typo.
  const year = Number(normalised.slice(12, 16));
  return year >= 1950 && year <= new Date().getFullYear() + 1;
}

/**
 * Acts we can resolve provision references against.
 *
 * CPC was missing, which made every civil-procedure question unrecognisable:
 * "order 32 CPC" extracted no act, no provision, and fell through to the
 * classifier as free text - which sent a question about a procedural rule to a
 * case-law search. The list was assembled from the criminal side of practice
 * and never revisited, and civil litigation is most of the work.
 */
export const KNOWN_ACTS = ['IPC', 'BNS', 'CRPC', 'BNSS', 'IEA', 'BSA', 'CPC', 'COI'] as const;
export type ActCode = (typeof KNOWN_ACTS)[number];

const ACT_ALIASES: Record<string, ActCode> = {
  ipc: 'IPC',
  'indian penal code': 'IPC',
  'penal code': 'IPC',
  bns: 'BNS',
  'bharatiya nyaya sanhita': 'BNS',
  'nyaya sanhita': 'BNS',
  crpc: 'CRPC',
  'cr.p.c': 'CRPC',
  'criminal procedure code': 'CRPC',
  'code of criminal procedure': 'CRPC',
  bnss: 'BNSS',
  'bharatiya nagarik suraksha sanhita': 'BNSS',
  'nagarik suraksha sanhita': 'BNSS',
  iea: 'IEA',
  'evidence act': 'IEA',
  'indian evidence act': 'IEA',
  bsa: 'BSA',
  'bharatiya sakshya adhiniyam': 'BSA',
  'sakshya adhiniyam': 'BSA',
  cpc: 'CPC',
  'civil procedure code': 'CPC',
  'code of civil procedure': 'CPC',
  coi: 'COI',
  constitution: 'COI',
  'constitution of india': 'COI',
  'indian constitution': 'COI',
  samvidhan: 'COI',
  'संविधान': 'COI',
};

export function normaliseActCode(raw: string | null | undefined): ActCode | null {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[.,]/g, '').trim();
  return ACT_ALIASES[key] ?? (KNOWN_ACTS.includes(key.toUpperCase() as ActCode) ? (key.toUpperCase() as ActCode) : null);
}

/**
 * Pull a section number out of free text.
 *
 * Handles the forms that actually turn up: "section 302", "sec 302", "s.302",
 * "u/s 302", "302 IPC", "under section 498A of the IPC". Sub-sections like
 * "156(3)" are kept intact because they change the meaning entirely.
 */
export function extractSectionReference(text: string): { section: string | null; act: ActCode | null } {
  // `crpc` and the criminal codes are listed before `cpc`, and `code of
  // criminal procedure` before `code of civil procedure`, because the regex
  // engine takes the first alternative that matches at a position - and "CrPC"
  // read as "CPC" would answer a criminal question with civil procedure.
  const actMatch =
    /\b(ipc|bns|crpc|cr\.?p\.?c|bnss|iea|bsa|cpc|indian penal code|penal code|bharatiya nyaya sanhita|nyaya sanhita|code of criminal procedure|criminal procedure code|bharatiya nagarik suraksha sanhita|evidence act|indian evidence act|bharatiya sakshya adhiniyam|code of civil procedure|civil procedure code|constitution of india|indian constitution|constitution|संविधान)\b/i.exec(
      text,
    );

  const act = normaliseActCode(actMatch?.[1]);

  // The suffix letter of "498A" must be ADJACENT to the digits. Allowing
  // whitespace before it makes "section 302 IPC" parse as section "302I",
  // swallowing the first letter of the act name - which then fails every
  // lookup, silently.
  const explicit = /\b(?:u\/s|under\s+section|section|sec|s|dhara|dhaara)\.?\s*(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)/i.exec(text);
  if (explicit?.[1]) {
    return { section: explicit[1].replace(/\s+/g, '').toUpperCase(), act };
  }

  /*
   * "धारा 174" - the Hindi word for section. No \b: JavaScript's word boundary
   * does not see Devanagari letters.
   *
   * Without this "BNSS की धारा 174 पुराने CrPC की कौन सी धारा थी?" carried no
   * section at all, the router guessed, and the reply was written from memory:
   * "BNSS 174 was CrPC 154" - it was CrPC 155 (live tests of 4 and 7 October:
   * M-CRPC-010, M-CRPC-031, M-IEA-024, M-REV-011).
   */
  const hindi = /(?:धारा|दफ़ा|दफा)\s*(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)/i.exec(text);
  if (hindi?.[1]) {
    return { section: hindi[1].replace(/\s+/g, '').toUpperCase(), act };
  }

  // "302 IPC" - number immediately before the act name.
  const trailing = /\b(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)\s+(?:ipc|bns|crpc|bnss|iea|bsa)\b/i.exec(text);
  if (trailing?.[1]) {
    return { section: trailing[1].replace(/\s+/g, '').toUpperCase(), act };
  }

  // "BNS 103" - act name immediately before the number. Common in Hinglish
  // ("BNS 103 explain karo") and missed entirely by the two patterns above.
  const leading = /\b(?:ipc|bns|crpc|bnss|iea|bsa)\b\s*(?:section|sec|s)?\.?\s*(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)/i.exec(
    text,
  );
  if (leading?.[1]) {
    return { section: leading[1].replace(/\s+/g, '').toUpperCase(), act };
  }

  return { section: null, act };
}

/** Every act a message names, by any of its names ("CrPC", "Bharatiya Nagarik Suraksha Sanhita", "BNSS"). */
export function namedActs(text: string): Set<ActCode> {
  const names =
    /\b(ipc|bns|crpc|cr\.?p\.?c|bnss|iea|bsa|cpc|indian penal code|penal code|bharatiya nyaya sanhita|nyaya sanhita|code of criminal procedure|criminal procedure code|bharatiya nagarik suraksha sanhita|evidence act|indian evidence act|bharatiya sakshya adhiniyam|code of civil procedure|civil procedure code|constitution of india|indian constitution|constitution|संविधान)\b/gi;
  const acts = new Set<ActCode>();
  for (const m of text.matchAll(names)) {
    const act = normaliseActCode(m[1]);
    if (act) acts.add(act);
  }
  return acts;
}

/**
 * The 2023 recodification pairs: each old code and the code that replaced it.
 */
const RECODIFICATION_PAIRS: [ActCode, ActCode][] = [['IPC', 'BNS'], ['CRPC', 'BNSS'], ['IEA', 'BSA']];
const PAIR_CODE_NAMES =
  'ipc|bns|crpc|cr\\.?p\\.?c|bnss|iea|bsa|indian penal code|bharatiya nyaya sanhita|code of criminal procedure|criminal procedure code|bharatiya nagarik suraksha sanhita|indian evidence act|evidence act|bharatiya sakshya adhiniyam';
const SECTION_NUMBER = /\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?/;
/** What may stand between a code and its number: "IPC 302", "IPC section 302", "CrPC की धारा 133", "IPC ki dhara 302". */
const CODE_TO_NUMBER = /^\s*(?:(?:की|का|के|ki|ka|ke)\s+)?(?:section|sec|s|dhara|dhaara|धारा)?\.?\s*$/i;

/**
 * The provision a question about the recodification is actually about.
 *
 * "CrPC 125 maintenance - which section in BNSS?" names both codes, and the
 * router model read it as "BNSS 125" - a real section (security for keeping
 * the peace), so the answer would be confident and wrong. When a message names
 * both codes of a pair and a section number belongs to only one of them, that
 * one is the provision to look up; its row and the official correspondence
 * give the other side. Works in both directions ("BNSS 144 in CrPC?").
 *
 * A number belongs to the code written just before it ("CrPC 125", "CrPC
 * section 125") or just after it ("125 CrPC", "section 125 of the CrPC"); one
 * between two codes ("IPC 302 BNS mein") belongs to the one before. When both
 * codes carry a number ("IPC 302 vs BNS 103") nothing is decided here.
 */
export function recodifiedReference(text: string): { act: ActCode; section: string } | null {
  const codes = [...text.matchAll(new RegExp(`\\b(${PAIR_CODE_NAMES})\\b`, 'gi'))]
    .map((m) => ({ act: normaliseActCode(m[1]), start: m.index!, end: m.index! + m[0].length }))
    .filter((c): c is { act: ActCode; start: number; end: number } => c.act !== null);
  if (codes.length < 2) return null;

  const numbered = new Map<ActCode, string>();
  for (const m of text.matchAll(new RegExp(`\\b(${SECTION_NUMBER.source})(?![\\w(])`, 'gi'))) {
    const start = m.index!;
    const end = start + m[0].length;
    // Each side checks the code is on that side: a slice whose end comes before
    // its start is "", which reads as no gap at all - and "2023 mein 420 IPC"
    // gave the IPC section 2023, from any code named later in the question.
    // "CrPC की धारा 133", "IPC ki dhara 302": the Hindi possessive and the Hindi
    // word for section sit between the code and its number.
    const before = codes.find((c) => c.end <= start && CODE_TO_NUMBER.test(text.slice(c.end, start)));
    const after = codes.find((c) => c.start >= end && /^\s+(?:of\s+(?:the\s+)?)?$/i.test(text.slice(end, c.start)));
    const owner = before ?? after;
    if (owner && !numbered.has(owner.act)) {
      numbered.set(owner.act, m[1].replace(/\s+/g, '').toUpperCase());
    }
  }

  const mentioned = new Set(codes.map((c) => c.act));
  for (const [oldAct, newAct] of RECODIFICATION_PAIRS) {
    if (!mentioned.has(oldAct) || !mentioned.has(newAct)) continue;
    const oldSection = numbered.get(oldAct);
    const newSection = numbered.get(newAct);
    if (oldSection && !newSection) return { act: oldAct, section: oldSection };
    if (newSection && !oldSection) return { act: newAct, section: newSection };
  }
  return null;
}

/**
 * A reference to an Order (and optionally a Rule) of the Civil Procedure Code.
 *
 * ## Why this is separate from a section number
 *
 * The CPC is not organised into sections the way the IPC is. Its substantive
 * body has sections, but the procedure practitioners actually cite lives in the
 * First Schedule, as Orders divided into Rules - "Order 32", "Order 37 Rule 3".
 * An advocate asking about civil procedure names an Order, and the section
 * matcher has no concept of one, so the whole question read as free text.
 *
 * Returned as a display string rather than a number because "Order 37 Rule 3"
 * is one reference, not two, and splitting it loses which rule of which order.
 *
 * Deliberately not matched without a following number: "order" is an ordinary
 * English word and appears in "interim order", "order sheet" and "order of the
 * court", none of which is a citation.
 */
export function extractOrderReference(text: string): string | null {
  /*
   * The numeral must end on a word boundary, and a Roman one must be at least
   * two characters.
   *
   * Without either, "interim order in a bail matter" reads the "i" of "in" as
   * Roman one, and answers a bail question with Order 1 of the CPC. The cost of
   * the second rule is that "Order I" written in Roman is missed; in practice it
   * is written "Order 1", and a missed reference degrades to an ordinary search
   * while a false one sends the advocate somewhere unrelated.
   */
  const match =
    /\bo(?:rder)?\.?\s*([IVXLC]{2,}|\d{1,3})\b\s*(?:,?\s*r(?:ule)?\.?\s*(\d{1,3}[A-Z]?))?/i.exec(
      text,
    );
  if (!match) return null;

  // Roman numerals appear on the older reports; normalised so "Order XXXII" and
  // "Order 32" are the same reference to everything downstream.
  const order = fromRoman(match[1]);
  if (!order || order < 1 || order > 51) return null;

  return match[2] ? `Order ${order} Rule ${match[2].toUpperCase()}` : `Order ${order}`;
}

/**
 * A reference to an Article of the Constitution.
 *
 * ## Why this needed its own extractor, like Orders did
 *
 * Constitutional provisions are Articles, and nothing recognised one - so
 * "Article 226" reached the classifier as free text and came back a case-law
 * search, which is the same failure "order 32 CPC" had and for the same reason:
 * the reference was invisible, so a model guessed.
 *
 * Article 226 and Article 32 are two of the most-asked provisions in Indian
 * practice. They are also the kind an advocate quotes by number and expects to
 * be understood without spelling out where it comes from, which is why the act
 * is inferred rather than required.
 *
 * Bounded at 395, the last Article of the original text. The letter suffix
 * carries the amendments - 21A, 300A, 243ZG - and is preserved as typed.
 *
 * Like {@link extractOrderReference}, never matched without a number after it:
 * "article" is an ordinary English word, and "the articles of association" is
 * not a constitutional question.
 */
export function extractArticleReference(text: string): string | null {
  // The amendment suffix must be adjacent to the number - "21A", never "21 A".
  // With a gap allowed, the case-insensitive flag lets the next English word
  // become the suffix, and "article 226 in a writ petition" reads as 226IN.
  const match = /\bart(?:icle)?\.?\s*(\d{1,3})([A-Z]{1,3})?\b/i.exec(text);
  if (!match) return null;

  const article = Number(match[1]);
  if (article < 1 || article > 395) return null;

  return match[2] ? `Article ${article}${match[2].toUpperCase()}` : `Article ${article}`;
}

/** A decimal string, or a Roman numeral, as a number. Null when neither. */
function fromRoman(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);

  const digits: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  const upper = value.toUpperCase();
  if (!/^[IVXLC]+$/.test(upper)) return null;

  let total = 0;
  for (let i = 0; i < upper.length; i++) {
    const here = digits[upper[i]];
    const next = digits[upper[i + 1]] ?? 0;
    total += here < next ? -here : here;
  }
  return total;
}

/**
 * Every case-citation format we recognise.
 *
 * Order matters only for readability; matches are deduplicated by the caller.
 */
const CITATION_PATTERNS: RegExp[] = [
  // Neutral citations: 2024 INSC 452, 2023 DHC 1234
  /\b(\d{4}\s+(?:INSC|SCC\s+OnLine\s+[A-Z][a-z]*|[A-Z]{2,5})\s+\d+)\b/g,
  // AIR 2018 SC 1234
  /\b(AIR\s+\d{4}\s+[A-Z]{2,4}\s+\d+)\b/gi,
  // (2018) 5 SCC 1
  /(\(\d{4}\)\s*\d+\s*SCC\s*\d+)/gi,
  // 2018 (5) SCC 1  /  2018 (2) Crimes 45
  /\b(\d{4}\s*\(\d+\)\s*[A-Z][A-Za-z]*\s*\d+)\b/g,
  // (2020) 7 SCC 1 style with reporter variants
  /(\(\d{4}\)\s*\d+\s*[A-Z]{2,6}\s*\d+)/g,
  /*
   * 1992 Supp (1) SCC 335 - the SCC's supplementary volumes, and Kanoon's way
   * of printing them, 1992 SCC (SUPP) 1 335.
   *
   * None of the patterns above reads "Supp", so "1992 Supp (1) SCC 335 - which
   * judgment?" was not a citation at all: it went to a topic search and came
   * back as "10 authorities on 1992 Supp (1) SCC 335", Indra Sawhney first, for
   * two credits - Bhajan Lal was not in the list (live test, 7 Oct, J-CL-10).
   */
  /(\(?\d{4}\)?\s+Supp\.?\s*\(?\s*\d+\s*\)?\s*SCC\s+\d+|\d{4}\s+SCC\s*\(\s*Supp\.?\s*\)\s*\d+\s+\d+)/gi,
];

/** Extract case citations from model output, deduplicated and trimmed. */
export function extractCitations(text: string): string[] {
  const found = new Set<string>();

  for (const pattern of CITATION_PATTERNS) {
    // Fresh lastIndex each pass: these are module-level /g regexes and would
    // otherwise resume mid-string on the next call.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const citation = match[1]?.replace(/\s+/g, ' ').trim();
      if (citation && citation.length >= 8) found.add(citation);
    }
  }

  const candidates = [...found];

  // The patterns overlap by design (over-matching is safer than missing a
  // citation), which means "AIR 2018 SC 1234" also yields the fragment
  // "2018 SC 1234" via the neutral-citation pattern. Left in, that fragment is
  // verified separately, found not to exist, and struck from the answer -
  // corrupting the valid citation it came from. Keep only maximal matches.
  return candidates.filter(
    (candidate) => !candidates.some((other) => other !== candidate && other.includes(candidate)),
  );
}

/**
 * Extract statutory references from model output as normalised 'ACT SECTION'
 * strings, ready for verify_statute_refs().
 */
// "Section 302 IPC" / "Section 302 of the IPC" / "Sections 302 IPC and ..."
// `sections?` matters: an answer listing several provisions almost always
// writes the plural, and requiring the singular missed all of them.
// The suffix letter is adjacent to the digits for the same reason as in
// extractSectionReference - otherwise "302 IPC" becomes section "302I".
const STATUTE_FORWARD =
  /\b(?:u\/s|under\s+sections?|sections?|secs?|s|orders?|o|articles?|arts?)\.?\s*(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)\s*(?:of\s+(?:the\s+)?)?\b(IPC|BNS|CrPC|BNSS|IEA|BSA|CPC|COI)\b/gi;
// "IPC Section 302" / "IPC 302"
const STATUTE_BACKWARD =
  /\b(IPC|BNS|CrPC|BNSS|IEA|BSA|CPC|COI)\b\s*(sections?|secs?|s|orders?|o|articles?|arts?)?\.?\s*(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)/gi;
// Bare "302 IPC" with no section keyword at all. Needed for the second and
// later items in a list - "Sections 302 IPC and 498A IPC" carries the keyword
// only once, so without this every provision after the first goes unverified.
const STATUTE_BARE =
  /\b(\d+[A-Z]?(?:\s*\(\s*\d+\s*\))?)\s+(?:of\s+(?:the\s+)?)?(IPC|BNS|CrPC|BNSS|IEA|BSA|CPC|COI)\b/gi;

/** A fresh copy of a /g pattern, so no caller resumes another's lastIndex. */
const fresh = (pattern: RegExp): RegExp => new RegExp(pattern.source, pattern.flags);

/**
 * Text that ends in a code's name - "IPC ", "IPC Section " - so the number
 * after it is that code's.
 *
 * "IPC 326B BNS mein Section 124 ke saath correspond karta hai" was read as
 * IPC 326B and as BNS 326B; BNS 326B does not exist, was struck, and the
 * answer said "IPC[unverified] mein Section 124" (live test, 8 Oct, M-IPC-029).
 */
const ENDS_IN_CODE = /\b(?:IPC|BNS|CrPC|BNSS|IEA|BSA|CPC|COI)\s*(?:sections?|secs?|s)?\.?\s*$/i;

export function extractStatuteRefs(text: string): string[] {
  const refs = new Set<string>();
  const forward = fresh(STATUTE_FORWARD);
  const backward = fresh(STATUTE_BACKWARD);
  const bare = fresh(STATUTE_BARE);

  let match: RegExpExecArray | null;

  while ((match = forward.exec(text)) !== null) {
    // "IPC Section 326B BNS mein ..." - the number is the IPC's.
    if (ENDS_IN_CODE.test(text.slice(0, match.index + match[0].indexOf(match[1])))) continue;
    refs.add(`${match[2].toUpperCase()} ${match[1].replace(/\s+/g, '').toUpperCase()}`);
  }
  // A year straight after a code with no "section" between them is the Act's
  // year: "a new provision under the BNS 2023" was struck as section 2023 of
  // the BNS and printed as "under [unverified]" (audit re-run, NS4).
  const year = /^(18|19|20)\d\d$/;
  while ((match = backward.exec(text)) !== null) {
    if (!match[2] && year.test(match[3])) continue;
    refs.add(`${match[1].toUpperCase()} ${match[3].replace(/\s+/g, '').toUpperCase()}`);
  }
  while ((match = bare.exec(text)) !== null) {
    if (year.test(match[1])) continue;
    // "IPC 326B BNS mein ..." - the number is the IPC's (ENDS_IN_CODE).
    if (ENDS_IN_CODE.test(text.slice(0, match.index))) continue;
    refs.add(`${match[2].toUpperCase()} ${match[1].replace(/\s+/g, '').toUpperCase()}`);
  }

  return [...refs];
}

/**
 * Where in the text every case citation and statutory reference sits - the
 * same patterns extractCitations and extractStatuteRefs read, by position.
 *
 * For an answer shown while it is still being written (draft-release.ts): a
 * line is shown only when no reference runs across its end, so no reference
 * is ever shown before the whole of it has been checked.
 */
export function referenceSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const pattern of [...CITATION_PATTERNS, STATUTE_FORWARD, STATUTE_BACKWARD, STATUTE_BARE]) {
    const copy = fresh(pattern);
    let match: RegExpExecArray | null;
    while ((match = copy.exec(text)) !== null) {
      spans.push({ start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) copy.lastIndex += 1;
    }
  }
  return spans;
}

/**
 * Query-side synonym expansion.
 *
 * The architecture spec puts this in an Elasticsearch synonym filter. Postgres'
 * equivalent is a thesaurus dictionary, which needs a file on the database
 * server's filesystem - not possible on managed Supabase. Expanding at query
 * time gets the same recall benefit with no infrastructure, at the cost of a
 * slightly longer tsquery.
 */
const SYNONYM_GROUPS: string[][] = [
  ['bail', 'interim bail', 'anticipatory bail', 'regular bail'],
  ['fir', 'first information report'],
  /*
   * One group per act, deliberately - these used to be two groups of four,
   * pairing each old code with the one that replaced it.
   *
   * That treats "IPC" and "BNS" as synonyms, and they are not: they are two
   * different statutes, and the whole point of naming one is to exclude the
   * other. Asking about BNS 103 had "ipc" and "indian penal code" appended to
   * the lexical query, which then outranked everything - the corpus is almost
   * entirely IPC - and the answer came back about the IPC. The reported
   * symptom was "not able to search BNS, still talking about IPC".
   *
   * The correspondence between them is real and is not a synonym relationship.
   * It lives on the row, in corresponding_act/corresponding_section, and
   * migration 0017 is what searches it.
   */
  ['ipc', 'indian penal code'],
  ['bns', 'bharatiya nyaya sanhita'],
  ['crpc', 'code of criminal procedure'],
  ['bnss', 'bharatiya nagarik suraksha sanhita'],
  ['quash', 'quashing', 'quashment'],
  ['acquittal', 'acquitted', 'acquit'],
  ['conviction', 'convicted', 'convict'],
  ['ndps', 'narcotic drugs and psychotropic substances'],
  ['maintenance', 'alimony', 'interim maintenance'],
  ['injunction', 'stay order', 'restraint order'],
  ['cheque bounce', 'dishonour of cheque', 'section 138', 'negotiable instruments act'],
  ['custody', 'judicial custody', 'police remand'],
  ['dowry', 'dowry death', 'dowry harassment'],
  ['chargesheet', 'charge sheet', 'final report'],
];

/**
 * Append synonyms for any group the query touches.
 *
 * Deliberately additive and capped: the goal is recall on the lexical arm of
 * the hybrid search, and an unbounded expansion starts pulling in noise that
 * outranks the actual answer.
 */
export function expandQuery(query: string, maxExtraTerms = 6): string {
  const lower = query.toLowerCase();
  const additions: string[] = [];

  for (const group of SYNONYM_GROUPS) {
    const hit = group.find((term) => lower.includes(term));
    if (!hit) continue;
    for (const term of group) {
      if (term !== hit && !lower.includes(term) && additions.length < maxExtraTerms) {
        additions.push(term);
      }
    }
  }

  return additions.length > 0 ? `${query} ${additions.join(' ')}` : query;
}

/**
 * An Act named in the question that is not one of the codes - "the
 * Negotiable Instruments Act", "Hindu Marriage Act, 1955" - or null.
 *
 * Written in title case it is taken as it stands; in lower case only after
 * "of / under / in the" and with at least two words before "act", so that
 * "the guilty act" is not read as the name of an Act.
 */
export function namedOtherAct(text: string): string | null {
  const titled = /\b((?:[A-Z][A-Za-z&'-]*\.?\s+){1,8}Act)\b(,?\s*\d{4})?/.exec(text);
  const lower = /\b(?:of|under|in)\s+the\s+((?:[a-z]+\s+){2,6}act)\b(,?\s*\d{4})?/i.exec(text);
  const found = titled ?? lower;
  if (!found) return null;
  // "What Act applies?", "Under which Act..." - words of the question, not of a name.
  const words = found[1].trim().split(/\s+/);
  while (words.length > 1 && NOT_A_NAME.has(words[0].toLowerCase().replace(/\.$/, ''))) words.shift();
  if (words.length < 2) return null;
  return `${words.join(' ')}${found[2] ? `, ${found[2].replace(/\D/g, '')}` : ''}`;
}

const NOT_A_NAME = new Set([
  'what', 'which', 'whose', 'is', 'was', 'does', 'do', 'under', 'of', 'in', 'for', 'any', 'this', 'that', 'each',
  'every', 'same', 'said', 'the', 'a', 'an', 'section', 'sec', 'article', 'order', 'rule', 'new', 'old',
]);

/**
 * The criminal codes a question about a subject is looked up in: the three
 * 2023 codes, whichever of the six it named.
 *
 * Advocates say "BNS" for the new criminal law as a whole. "जमानत के लिए कौन
 * सी section? BNS में" searched the BNS alone for bail, found only BNS 269
 * (failing to appear on a bail bond) - bail is BNSS 478 to 483.
 */
export const NEW_CRIMINAL_CODES: readonly ActCode[] = ['BNS', 'BNSS', 'BSA'];

/**
 * Words advocates use that the enacted text does not. Each is how the Act
 * itself says it, checked against the Gazette text (0021).
 */
const STATUTORY_WORDING: ReadonlyArray<[RegExp, string]> = [
  [/\banticipatory\s+bail\b|अग्रिम\s+जमानत/gi, ' bail apprehending arrest '],
  [/\bdefault\s+bail\b/gi, ' investigation cannot be completed '],
  [/\bquash(?:ing|ed)?\b(?:\s+(?:of\s+)?(?:an?\s+|the\s+)?(?:fir|f\.i\.r\.?))?/gi, ' inherent powers '],
  [/\bzero\s+fir\b/gi, ' information cognizable cases '],
  // BNS 103(2): "a group of five or more persons acting in concert commits
  // murder on the ground of race, caste or community ..." - the Act never
  // says "lynching", and "Which BNS section covers mob lynching?" was answered
  // "BNS Section 101" from memory (live test, 4 Oct, X5).
  [/\bmob\s+lynch(?:ing|ed|ings)?\b|\blynch(?:ing|ed|ings)\b/gi, ' group five persons acting concert murder '],
  // An FIR named in passing - "my client is named in an FIR" - is not the
  // subject: read as "information cognizable" it put BNSS 173 above theft in
  // a question about theft and bail (live test, 4 Oct, X34). The FIR section
  // itself is among the facts every answer is given (prompts.ts).
  [/\bfir\b|\bf\.i\.r\b\.?|एफआईआर/gi, ' '],
  /*
   * BNS 106(2): "causes death of any person by rash and negligent driving of
   * vehicle ... and escapes without reporting it to a police officer or a
   * Magistrate". The Act never says "hit and run", and "Hit and run ke liye naya
   * section kaunsa hai BNS mein?" was answered "Corpus mein hit and run ke liye
   * koi specific section nahi mil raha" for two credits (live test, 7 Oct, O-04).
   */
  [/\bhit[\s-]*(?:and|&|n)[\s-]*run\b/gi, ' negligent driving escapes reporting '],
  /*
   * BSA 26(a): "When the statement is made by a person as to the cause of his
   * death, or as to any of the circumstances of the transaction which resulted
   * in his death". "Which BSA section deals with dying declarations?" found BNS
   * 236 and 237 (false declarations) and was answered "The corpus doesn't cover
   * that BSA section" for two credits (live test, 7 Oct, N-12).
   */
  [/\bdying\s+declarations?\b|मृत्यु(?:कालीन|\s*पूर्व)\s*(?:कथन|बयान)/gi, ' statement cause death circumstances transaction '],
  // "saza" / "सजा" is how the question asks for the punishment; the Acts say punished.
  [/\bsaza+\b|\bsazaa\b|सज़ा|सजा/gi, ' punishment '],
  [/जमानत|\b(?:zamanat|jamanat)\b/gi, ' bail '],
  [/हत्या|\bhatya\b/gi, ' murder '],
  [/चोरी|\bchori\b/gi, ' theft '],
  [/धोखाधड़ी|\bdhokhadhadi\b/gi, ' cheating '],
  [/बलात्कार|\bbalatkar\b/gi, ' rape '],
  [/दहेज|\bdahej\b/gi, ' dowry '],
];

/** Act names, and the words of a question that are about asking, not the subject. */
const ACT_NAMES =
  /\b(?:indian\s+penal\s+code|penal\s+code|code\s+of\s+criminal\s+procedure|criminal\s+procedure\s+code|indian\s+evidence\s+act|evidence\s+act|bharatiya\s+nyaya\s+sanhita|nyaya\s+sanhita|bharatiya\s+nagarik\s+suraksha\s+sanhita|nagarik\s+suraksha\s+sanhita|bharatiya\s+sakshya\s+adhiniyam|sakshya\s+adhiniyam|code\s+of\s+civil\s+procedure|civil\s+procedure\s+code|constitution(?:\s+of\s+india)?)\b/gi;
const NOT_THE_SUBJECT = new Set([
  'ipc', 'bns', 'bnss', 'bsa', 'crpc', 'iea', 'cpc', 'coi', 'section', 'sections', 'sec', 'provision', 'provisions',
  'dhara', 'act', 'code', 'sanhita', 'adhiniyam', 'equivalent', 'equivalents', 'corresponding', 'counterpart',
  'counterparts', 'new', 'old', 'law', 'laws', 'under', 'which', 'what', 'kaun', 'kaunsi', 'kaunsa', 'si', 'sa',
  'kya', 'hai', 'mein', 'me', 'ka', 'ki', 'ke', 'liye', 'the', 'a', 'an', 'for', 'of', 'in', 'on', 'and', 'or',
  'any', 'is', 'are', 'was', 'were', 'there', 'deal', 'deals', 'dealing', 'cover', 'covers', 'apply', 'applies',
  'applicable', 'offence', 'offences', 'number', 'tell', 'please', 'explain', 'about', 'with', 'it',
  // "provisions relating to bail" found BNSS 232 alone - committal, which
  // mentions "the provisions of this Sanhita relating to bail" in passing
  // (audit re-run, S4). The connecting words are not the subject either.
  'to', 'by', 'from', 'as', 'at', 'be', 'related', 'relating', 'relate', 'regarding', 'concerning', 'pertaining', 'governing', 'governs', 'mentioned',
  'konsi', 'konsa', 'kaunse', 'batao', 'bataiye', 'hota', 'hoti', 'lagti', 'lagta', 'lagu', 'hain',
  // Verbs of asking, and the advocate's own framing ("my client", "theft ka
  // case") - "makes" matched "... to make certain report" (live test, X9).
  'case', 'cases', 'make', 'makes', 'made', 'allow', 'allows', 'allowed', 'require', 'requires', 'provide', 'provides',
  'say', 'says', 'mean', 'means', 'happen', 'happens', 'get', 'gets', 'give', 'gives', 'registered', 'client', 'clients',
  'my', 'mera', 'meri', 'mere', 'aur', 'kis', 'ya', 'tha', 'thi', 'hua', 'hui', 'karna', 'chahiye', 'kaise', 'milti',
  'milta', 'milegi', 'sakta', 'sakti', 'par', 'se', 'ko', 'bhi', 'ab', 'naamit', 'lagega', 'law',
  // "naya section" is the new code, not the subject: left in, every word of
  // "negligent driving escapes reporting naya" had to match and nothing did.
  'naya', 'nayi', 'naye', 'purana', 'purani', 'purane', 'kitni', 'kitna', 'kitne', 'hui', 'hua',
]);

/**
 * Hinglish: Hindi written in Latin script - "IPC 309 attempt to suicide ka BNS
 * mein kya hua?". The router reports its language as "en", and the reply came
 * back in English (live tests of 4 and 7 October, M-IPC-026, O-02). Two
 * different Hindi function words, in a message with no Devanagari, or the word
 * "Hinglish" itself.
 */
const HINGLISH_WORDS = new Set([
  'hai', 'hain', 'kya', 'ka', 'ki', 'ke', 'mein', 'kaun', 'kaunsa', 'kaunsi', 'konsa', 'konsi', 'kitni', 'kitna',
  'tha', 'thi', 'naya', 'nayi', 'purana', 'purani', 'ko', 'liye', 'hota', 'hoti', 'batao', 'bataiye', 'saza',
  'aur', 'nahi', 'kaise', 'karo', 'karna', 'chahiye', 'milti', 'milta', 'kab', 'kahan', 'gaya', 'hoga',
]);

export function isHinglish(text: string): boolean {
  if (/[ऀ-ॿ]/.test(text)) return false;
  if (/\bhinglish\b/i.test(text)) return true;
  const words = new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => HINGLISH_WORDS.has(w)));
  return words.size >= 2;
}

/**
 * The words a provision on this subject would contain, for the full-text
 * search - "" when the question has none.
 *
 * Every word of the query must appear in a section for it to match, so the
 * router's sentence "BNS section for organised crime and IPC equivalent"
 * matched nothing, and the answer came from memory: "the BNS (Bihar and
 * Maharashtra Special) Act". "organised crime" finds BNS 111.
 */
export function topicQuery(text: string): string {
  let t = ` ${text} `;
  for (const [pattern, wording] of STATUTORY_WORDING) t = t.replace(pattern, wording);
  return t
    .toLowerCase()
    .replace(ACT_NAMES, ' ')
    // The Acts spell it "organised"; the English stemmer keeps the two apart.
    .replace(/([a-z]{4,})iz(e|ed|es|ing|ation|ations)\b/g, '$1is$2')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !NOT_THE_SUBJECT.has(w))
    .join(' ');
}
