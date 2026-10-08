/**
 * Telling whether two citations name the same report, and asking Indian Kanoon
 * for one in the form it stores.
 *
 * ## Why (live tests of 4 and 7 October 2026)
 *
 * Every citation-only question that Kanoon should have answered came back
 * "No judgment found": "(2014) 2 SCC 1", "(1997) 1 SCC 416", "(2017) 10 SCC 1",
 * "(2021) 2 SCC 324", "AIR 1962 SC 605" (J-CL-02, 03, 05, 07, 09). Only the web
 * fallback saved them, for a credit each and with details it made up. Three
 * separate faults, each enough on its own:
 *
 * 1. **The query was in the advocate's format, not Kanoon's.** On Kanoon's own
 *    search, `cite: 2014 (2) SCC 1` returns Lalita Kumari first; `cite: (2014)
 *    2 SCC 1` - what was sent - returns 20,230 judgments that cite it, from the
 *    Allahabad High Court down, and not Lalita Kumari (checked 7 Oct).
 * 2. **The match ran before the judgment's citations were read.** A search
 *    result carries one citation, the first Kanoon lists - for Lalita Kumari
 *    "AIR 2014 SUPREME COURT 187"; "2014 (2) SCC 1" is nineteenth on the
 *    document's own list. The comparison was made against the first only.
 * 3. **AIR was compared letter for letter.** Kanoon writes "AIR 1962 SUPREME
 *    COURT 605"; advocates write "AIR 1962 SC 605".
 *
 * Nothing here invents a citation. It only decides whether a citation an
 * advocate typed is one Kanoon itself prints on a judgment.
 */

interface Parsed {
  key: string;
  /** How Kanoon prints it, most likely first - for its `cite:` operator. */
  kanoon: string[];
}

function parse(citation: string): Parsed | null {
  const s = citation
    .toUpperCase()
    .replace(/SUPREME\s+COURT/g, 'SC')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 1992 Supp (1) SCC 335  /  (1992) Supp 1 SCC 335  /  Kanoon: 1992 SCC (SUPP) 1 335
  const supp =
    /^\(?\s*(\d{4})\s*\)?\s*SUPP\s*\(?\s*(\d{1,2})\s*\)?\s*SCC\s+(\d+)$/.exec(s) ??
    /^\(?\s*(\d{4})\s*\)?\s*SCC\s*\(\s*SUPP\s*\)\s*\(?\s*(\d{1,2})\s*\)?\s+(\d+)$/.exec(s);
  if (supp) {
    const [, year, volume, page] = supp;
    return { key: `SCC-SUPP:${year}:${Number(volume)}:${Number(page)}`, kanoon: [`${year} SCC (SUPP) ${Number(volume)} ${Number(page)}`] };
  }

  // (2014) 2 SCC 1  /  2014 (2) SCC 1  /  2014 2 SCC 1 - never SCC (Cri), a different report.
  const scc = /^\(?\s*(\d{4})\s*\)?\s*\(?\s*(\d{1,3})\s*\)?\s*SCC\s+(\d+)$/.exec(s);
  if (scc) {
    const [, year, volume, page] = scc;
    return { key: `SCC:${year}:${Number(volume)}:${Number(page)}`, kanoon: [`${year} (${Number(volume)}) SCC ${Number(page)}`] };
  }

  // AIR 1962 SC 605  /  AIR 1962 SUPREME COURT 605
  const air = /^AIR\s*(\d{4})\s+([A-Z]+(?:\s+[A-Z]+)?)\s+(\d+)$/.exec(s);
  if (air) {
    const [, year, court, page] = air;
    const where = court.replace(/\s+/g, '');
    return {
      key: `AIR:${year}:${where}:${Number(page)}`,
      kanoon: where === 'SC' ? [`AIR ${year} SUPREME COURT ${Number(page)}`, `${year} AIR ${Number(page)}`] : [`AIR ${year} ${court} ${Number(page)}`],
    };
  }

  // 2024 INSC 452
  const insc = /^(\d{4})\s+INSC\s+(\d+)$/.exec(s);
  if (insc) return { key: `INSC:${insc[1]}:${Number(insc[2])}`, kanoon: [`${insc[1]} INSC ${Number(insc[2])}`] };

  return null;
}

/** A comparison key: equal for two spellings of one report, and only then. */
export function canonicalCitation(citation: string): string {
  return parse(citation)?.key ?? citation.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function sameCitation(a: string, b: string): boolean {
  return canonicalCitation(a) === canonicalCitation(b);
}

/**
 * The `cite:` operands worth sending, in order: Kanoon's own spelling first,
 * then the advocate's, without repeats.
 */
export function kanoonCitationForms(citation: string): string[] {
  const typed = citation.replace(/\s+/g, ' ').trim();
  const forms = [...(parse(citation)?.kanoon ?? []), typed];
  const seen = new Set<string>();
  return forms.filter((form) => {
    const key = form.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The question assumes a rule that holds always or never.
 *
 * "Give me five Supreme Court judgments ... holding that bail must always be
 * granted in Section 420 cases" was answered with ten real judgments and not a
 * word about the premise (live test, 7 Oct, J-FK-15). No search can find a
 * judgment for a rule that does not exist, and a list under that question reads
 * as if it had. The list is still shown - it is real - with this said above it.
 */
export function assumesAbsoluteRule(text: string): boolean {
  return /\b(?:always|never|in\s+(?:all|every)\s+cases?|automatically|invariably)\b|हमेशा|कभी\s+नहीं/i.test(text);
}

export const ABSOLUTE_RULE_NOTE =
  'Your question asks for a rule that applies always (or never). These judgments were found by subject, not because ' +
  'they lay down such a rule - read what each one actually holds before citing it.';
