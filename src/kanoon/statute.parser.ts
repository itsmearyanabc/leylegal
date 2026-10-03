/**
 * One provision's text, read from an Indian Kanoon legislation document.
 *
 * ## The markup (captured 2026-10-01, NI Act 138, IPC 415, Article 21)
 *
 *   <h2 class="doc_title">Section 138 in The Negotiable Instruments Act, 1881</h2>
 *   <section class="akn-section" id="section_138">
 *     <h3>138. Dishonour of cheque for insufficiency, etc., of funds in the account.—</h3>
 *     <span class="akn-intro"><span class="akn-p">Where any cheque ...</span>
 *       <span class="akn-p">Provided that ...</span></span>
 *     <section class="akn-paragraph"><span class="akn-num">(a)</span>
 *       <span class="akn-content"><span class="akn-p">...</span></span></section>
 *   </section>
 *
 * Kanoon also writes its own commentary into the same block, as
 * <span class="akn-remark" data-status="editorial"> - Article 21 carries a long
 * "Editorial Comment" on the right to life. That is not the law, and an
 * advocate reading it as the Article would be misled; it is removed, however
 * deeply nested. So is the "References" list after it: paragraphs that are
 * nothing but a link to another website (Wikipedia, Legal Service India).
 * Cross-references inside the law are relative Kanoon links and stay.
 *
 * ## Refusing rather than guessing
 *
 * A document without this markup is not read at all: without it there is no
 * telling law from commentary. The heading's number must equal the number
 * asked for, letter included - Kanoon's top hit for "CrPC 41A" is section 41.
 */
export interface LawSection {
  number: string;
  title: string;
  /** "138. Where any cheque ...", one paragraph per line, like the Gazette rows. */
  text: string;
}

export type LawParse = { ok: true; section: LawSection } | { ok: false; reason: string };

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', shy: '',
};

/**
 * Characters with no width. Kanoon's IPC carries soft hyphens from the printed
 * text - "estab­lished", "im­prisonment" in 124A (API, 2026-10-04) -
 * which split the word for full-text search and for the model. The joiners
 * U+200C/U+200D are left: Devanagari needs them.
 */
const INVISIBLE = /[­​⁠﻿]/g;

function decode(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[body.toLowerCase()] ?? whole;
    })
    .replace(INVISIBLE, '');
}

/** A paragraph that is only a marker - "(a)", "(2)", "(iv)" - belongs to the paragraph after it. */
const MARKER_ONLY = /^\(?(?:\d+[A-Z]?|[a-z]{1,3}|[ivxl]+)\)\.?$/i;
/** "Explanation.—" or "Exception 2.—" printed apart from its sentence. */
const LABEL_ONLY = /^(?:Explanation|Exception)(?:\s+(?:\d+|[IVX]+))?\s*\.?\s*[—–-]+$/;

export function parseLawSection(html: string, expectedNumber: string): LawParse {
  const open = /<section\b[^>]*class="[^"]*\bakn-section\b[^"]*"[^>]*>/i.exec(html);
  if (!open) return { ok: false, reason: 'no akn-section markup' };

  const tokens = /<(\/?)([a-zA-Z0-9]+)\b([^>]*)>|([^<]+)/g;
  tokens.lastIndex = open.index + open[0].length;

  let sectionDepth = 1;
  let remarkDepth = 0; // >0 while inside Kanoon's commentary
  let headingDepth = 0; // >0 while inside the section's own <h3>
  let externalLink = false; // inside <a href="https://..."> - a reference to another site
  let headingSeen = false;
  const heading: string[] = [];
  const body: string[] = [''];
  // Per paragraph: true until it holds any text outside an external link.
  const linkOnly: boolean[] = [true];

  for (let m = tokens.exec(html); m && sectionDepth > 0; m = tokens.exec(html)) {
    const [, closing, rawTag, attrs, text] = m;
    if (text !== undefined) {
      if (remarkDepth) continue;
      if (headingDepth) heading.push(text);
      else if (headingSeen) {
        body[body.length - 1] += text;
        if (!externalLink && text.trim()) linkOnly[linkOnly.length - 1] = false;
      }
      continue;
    }

    const tag = rawTag.toLowerCase();
    if (tag === 'section') sectionDepth += closing ? -1 : 1;
    if (tag === 'a') externalLink = !closing && /\bhref="https?:\/\//i.test(attrs);

    if (remarkDepth) {
      if (tag === 'span') remarkDepth += closing ? -1 : 1;
      continue;
    }
    if (!closing && tag === 'span' && /\bakn-remark\b/.test(attrs)) {
      remarkDepth = 1;
      continue;
    }

    if (tag === 'h3' && !headingSeen) {
      if (closing) {
        headingDepth = 0;
        headingSeen = true;
      } else {
        headingDepth = 1;
      }
      continue;
    }

    // Every paragraph-level element starts a new line.
    const starts =
      !closing &&
      ((tag === 'span' && /\bakn-(p|num)\b/.test(attrs)) || tag === 'section' || tag === 'p' || tag === 'br' || tag === 'div' || tag === 'li');
    if (starts) {
      body.push('');
      linkOnly.push(true);
    }
  }

  if (sectionDepth > 0) return { ok: false, reason: 'section block not closed' };

  const headingText = decode(heading.join(' ')).replace(/\s+/g, ' ').trim();
  const head = /^(\d+[A-Z]*)\.\s*(.+)$/.exec(headingText);
  if (!head) return { ok: false, reason: `heading not "N. Title": ${headingText.slice(0, 80)}` };

  const number = head[1].toUpperCase();
  if (number !== expectedNumber.trim().toUpperCase()) {
    return { ok: false, reason: `heading is ${number}, asked for ${expectedNumber}` };
  }
  const title = head[2].replace(/[\s.:—–-]+$/u, '').trim();
  if (!title) return { ok: false, reason: 'empty title' };

  const lines = body
    .map((line, i) => ({ text: decode(line).replace(/\s+/g, ' ').trim(), linkOnly: linkOnly[i] }))
    .filter((line) => line.text && !line.linkOnly)
    .map((line) => line.text);
  // The heading of the reference list removed above.
  while (lines.length && /^references:?$/i.test(lines[lines.length - 1])) lines.pop();

  const paragraphs: string[] = [];
  for (const line of lines) {
    const last = paragraphs[paragraphs.length - 1];
    if (last !== undefined && (MARKER_ONLY.test(last) || LABEL_ONLY.test(last))) paragraphs[paragraphs.length - 1] = `${last} ${line}`;
    else paragraphs.push(line);
  }
  if (paragraphs.length === 0) return { ok: false, reason: 'no text' };

  const text = `${number}. ${paragraphs.join('\n')}`;
  // Defence in depth: commentary that slipped past the markup is a refusal.
  if (/editorial comment/i.test(text)) return { ok: false, reason: 'commentary in text' };

  return { ok: true, section: { number, title, text } };
}
