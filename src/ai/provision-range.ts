import { ActCode } from './legal-patterns';

/**
 * Whether a numbered provision can exist at all - answered from how far each
 * Act's numbering runs, before anything is searched or generated.
 *
 * "BNS Section 520 kya hai?" went to the unverified-provision prompt (the
 * corpus has no row for it), whose instruction for an unrecognised reference
 * is to say so and stop. The model did exactly that - "I am not sure what
 * Section 520 covers" - when the true answer is short and certain: the BNS
 * ends at Section 358. An advocate who mistyped, or who is reading a BNSS
 * number as a BNS one, needs to hear that, not a shrug.
 *
 * Only the last number matters. Inserted provisions (IPC 498A, CrPC 41A,
 * Evidence Act 65B, Article 21A) sit inside the range, so a lettered number is
 * judged by its numeric part, and nothing inside the range is ever refused
 * here - whether such a section exists is left to the corpus and the model.
 * The one exception: the 2023 codes have no lettered sections at all.
 */
const LAST_PROVISION: Partial<Record<ActCode, { last: number; unit: 'Section' | 'Order' | 'Article' }>> = {
  IPC: { last: 511, unit: 'Section' },
  BNS: { last: 358, unit: 'Section' },
  CRPC: { last: 484, unit: 'Section' },
  BNSS: { last: 531, unit: 'Section' },
  IEA: { last: 167, unit: 'Section' },
  BSA: { last: 170, unit: 'Section' },
  CPC: { last: 158, unit: 'Section' },
  COI: { last: 395, unit: 'Article' },
};

/** The CPC's First Schedule runs from Order I to Order LI. */
const CPC_LAST_ORDER = 51;

const SHORT_NAMES: Partial<Record<ActCode, string>> = {
  IPC: 'IPC', BNS: 'BNS', CRPC: 'CrPC', BNSS: 'BNSS', IEA: 'Evidence Act', BSA: 'BSA', CPC: 'CPC',
};

const FULL_NAMES: Partial<Record<ActCode, string>> = {
  IPC: 'Indian Penal Code (IPC)',
  BNS: 'Bharatiya Nyaya Sanhita (BNS)',
  CRPC: 'Code of Criminal Procedure (CrPC)',
  BNSS: 'Bharatiya Nagarik Suraksha Sanhita (BNSS)',
  IEA: 'Indian Evidence Act (IEA)',
  BSA: 'Bharatiya Sakshya Adhiniyam (BSA)',
  CPC: 'Civil Procedure Code (CPC)',
  COI: 'Constitution of India',
};

/** The code each 2023 code replaced. */
const OLD_CODE: Partial<Record<ActCode, ActCode>> = { BNS: 'IPC', BNSS: 'CRPC', BSA: 'IEA' };

/** Acts numbered in sections, in the order an advocate would look for a lost number. */
const SECTION_ACTS: ActCode[] = ['BNS', 'BNSS', 'BSA', 'IPC', 'CRPC', 'IEA', 'CPC'];

/**
 * Sections inside an Act's range that were repealed long before the Act itself,
 * so "Section N does exist in the IPC" would be false for them.
 *
 * "What is Section 490 of the CrPC?" was answered "Section 490 does exist in
 * the BNSS, IPC" (live test, 4 Oct, T-16). IPC 490 and 492 were repealed by the
 * Workmen's Breach of Contract (Repealing) Act, 1925; IPC 161 to 165A by the
 * Prevention of Corruption Act, 1988 (section 31). Only repeals that are
 * certain are listed - this list only ever removes a claim, never adds one.
 */
const REPEALED: Partial<Record<ActCode, ReadonlySet<number>>> = {
  IPC: new Set([161, 162, 163, 164, 165, 490, 492]),
};

/**
 * A ready answer when the provision cannot exist, else null.
 *
 * `provision` is the classifier's section_number: "520", "498A", "Order 52",
 * "Order 37 Rule 3", "Article 396". Anything not in one of those shapes is not
 * judged here.
 */
export function nonexistentProvision(act: ActCode | null, provision: string | null): string | null {
  if (!act || !provision) return null;
  const range = LAST_PROVISION[act];
  if (!range) return null;

  const text = provision.trim();

  const order = /^order\s+(\d+)\b/i.exec(text);
  if (order) {
    if (act !== 'CPC') return null;
    const n = Number(order[1]);
    if (n >= 1 && n <= CPC_LAST_ORDER) return null;
    return `*Order ${n} of the Civil Procedure Code (CPC)* does not exist. The First Schedule of the CPC runs from Order I to Order LI (51), so there is no Order ${n}.\n\nCheck the number - Order and Rule numbers are easy to transpose.`;
  }

  const article = /^article\s+(\d+)([A-Z]{0,3})/i.exec(text);
  const section = /^(?:section\s+)?(\d+)([A-Z]{0,3})/i.exec(text);
  const match = range.unit === 'Article' ? article ?? section : section;
  if (!match || (range.unit !== 'Article' && article)) return null;

  const n = Number(match[1]);
  /*
   * The number as typed, letter and all. "FIR is under BNS 498A" was answered
   * "Section 498 of the BNS does not exist" (live test, 7 Oct, T-08) - the
   * advocate never asked about 498, and 498 is a different IPC section
   * (enticing a married woman) from the 498A they meant.
   */
  const label = `${n}${(match[2] ?? '').toUpperCase()}`;
  const lettered = label !== String(n);

  /*
   * A lettered number in a 2023 code.
   *
   * The BNS, BNSS and BSA number every section 1 to N, with no inserted
   * "304B" or "41A": 0021_official_statute_text.sql loads all of them from the
   * Gazette and the official correspondence tables, and not one base number
   * there has a letter. "Patna High Court judgments on dowry death conviction
   * under Section 304B" was searched on Kanoon as Section 304B of the BNS and
   * found one stray writ petition (live test, 6 Oct, X30). It is the IPC's.
   * The last line is replaced by the official mapping where there is one
   * (rag.service.ts, oldCodeMapping): IPC 304B is BNS 80.
   */
  const oldCode = OLD_CODE[act];
  if (range.unit === 'Section' && lettered && oldCode && n >= 1 && n <= range.last) {
    return [
      `*Section ${label} of the ${FULL_NAMES[act] ?? act}* does not exist. The ${SHORT_NAMES[act]} numbers its sections 1 to ${range.last}, with no lettered sections - numbers like ${label} come from the ${SHORT_NAMES[oldCode]}.`,
      OLD_NUMBER_HINT,
    ].join('\n\n');
  }

  if (n >= 1 && n <= range.last) return null;

  const name = FULL_NAMES[act] ?? act;
  const lines = [
    `*${range.unit} ${label} of the ${name}* does not exist. The ${SHORT_NAMES[act] ?? name} has ${range.last} ${range.unit.toLowerCase()}s, so its numbering ends at ${range.unit} ${range.last}.`,
  ];

  // Where else the number exists is known from the ranges only for a plain
  // number: whether 498A exists in the BNSS cannot be read off "531 sections"
  // (it does not). A lettered number gets the official mapping instead, added
  // by the caller from the correspondence table (rag.service.ts).
  if (range.unit === 'Section' && n >= 1 && !lettered) {
    const elsewhere = SECTION_ACTS.filter(
      (other) => other !== act && n <= (LAST_PROVISION[other]?.last ?? 0) && !REPEALED[other]?.has(n),
    );
    if (elsewhere.length) {
      lines.push(
        `Section ${n} does exist in the ${elsewhere.map((other) => SHORT_NAMES[other]).join(', ')} - if you meant one of those, ask about it by name, for example *Section ${n} ${SHORT_NAMES[elsewhere[0]]}*.`,
      );
    }
  }

  lines.push(OLD_NUMBER_HINT);
  return lines.join('\n\n');
}

/** The last line of every "does not exist" reply - replaced by the mapping itself when there is one (rag.service.ts). */
export const OLD_NUMBER_HINT = 'If you are working from an old IPC or CrPC number, ask for that section and its BNS or BNSS equivalent.';
