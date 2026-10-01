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

/** Acts numbered in sections, in the order an advocate would look for a lost number. */
const SECTION_ACTS: ActCode[] = ['BNS', 'BNSS', 'BSA', 'IPC', 'CRPC', 'IEA', 'CPC'];

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

  const article = /^article\s+(\d+)/i.exec(text);
  const section = /^(?:section\s+)?(\d+)/i.exec(text);
  const match = range.unit === 'Article' ? article ?? section : section;
  if (!match || (range.unit !== 'Article' && article)) return null;

  const n = Number(match[1]);
  if (n >= 1 && n <= range.last) return null;

  const name = FULL_NAMES[act] ?? act;
  const lines = [
    `*${range.unit} ${n} of the ${name}* does not exist. The ${SHORT_NAMES[act] ?? name} has ${range.last} ${range.unit.toLowerCase()}s, so its numbering ends at ${range.unit} ${range.last}.`,
  ];

  if (range.unit === 'Section' && n >= 1) {
    const elsewhere = SECTION_ACTS.filter((other) => other !== act && n <= (LAST_PROVISION[other]?.last ?? 0));
    if (elsewhere.length) {
      lines.push(
        `Section ${n} does exist in the ${elsewhere.map((other) => SHORT_NAMES[other]).join(', ')} - if you meant one of those, ask about it by name, for example *Section ${n} ${SHORT_NAMES[elsewhere[0]]}*.`,
      );
    }
  }

  lines.push('If you are working from an old IPC or CrPC number, ask for that section and its BNS or BNSS equivalent.');
  return lines.join('\n\n');
}
