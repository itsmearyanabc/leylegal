import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLawSection } from './statute.parser';

/**
 * Reading one provision from an Indian Kanoon legislation document. Fixtures
 * are the documents as Kanoon served them on 2026-10-01, trimmed to the
 * document block (the API's `doc` field carries the same markup).
 */
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', `${name}.html`), 'utf8');

describe('reading a provision from Kanoon', () => {
  it('reads NI Act 138: title, text, proviso, clauses and Explanation', () => {
    const parsed = parseLawSection(fixture('law-ni-act-138'), '138');
    if (!parsed.ok) throw new Error(parsed.reason);

    expect(parsed.section.title).toBe('Dishonour of cheque for insufficiency, etc., of funds in the account');
    const lines = parsed.section.text.split('\n');
    expect(lines[0]).toMatch(/^138\. Where any cheque drawn by a person on an account maintained by him/);
    expect(lines).toContain('Provided that nothing contained in this section shall apply unless—');
    expect(lines.filter((l) => /^\([abc]\) /.test(l))).toHaveLength(3);
    expect(lines[lines.length - 1]).toMatch(/^Explanation\.— For the purposes of this section, “debt or other liability” means/);
  });

  it('reads IPC 415 with its nine illustrations, each a line', () => {
    const parsed = parseLawSection(fixture('law-ipc-415'), '415');
    if (!parsed.ok) throw new Error(parsed.reason);

    expect(parsed.section.title).toBe('Cheating');
    expect(parsed.section.text).toMatch(/^415\. Whoever, by deceiving any person, fraudulently or dishonestly induces/);
    expect(parsed.section.text.split('\n').filter((l) => /^\([a-i]\) A/.test(l))).toHaveLength(9);
  });

  it('keeps Kanoon commentary and its reference links out of Article 21', () => {
    const parsed = parseLawSection(fixture('law-constitution-article-21'), '21');
    if (!parsed.ok) throw new Error(parsed.reason);

    expect(parsed.section.title).toBe('Protection of life and personal liberty');
    expect(parsed.section.text).toBe(
      '21. No person shall be deprived of his life or personal liberty except according to procedure established by law.',
    );
    expect(parsed.section.text).not.toMatch(/Editorial|References|Wikipedia|landmark judgments/i);
  });

  it('refuses a document for a different number, letter included', () => {
    expect(parseLawSection(fixture('law-ni-act-138'), '138A')).toEqual({ ok: false, reason: 'heading is 138, asked for 138A' });
    expect(parseLawSection(fixture('law-ipc-415'), '41')).toMatchObject({ ok: false });
  });

  it('refuses a document without the provision markup rather than guessing at it', () => {
    expect(parseLawSection('<div class="judgments"><p>Some judgment text</p></div>', '1')).toEqual({ ok: false, reason: 'no akn-section markup' });
    expect(parseLawSection('<section class="akn-section"><h3>5. Title</h3><span class="akn-p">cut off', '5')).toMatchObject({
      ok: false,
      reason: 'section block not closed',
    });
  });

  it('refuses when commentary reaches the text by some other markup', () => {
    const html = '<section class="akn-section"><h3>9. Title.—</h3><span class="akn-p">Editorial Comment - this is not law.</span></section>';
    expect(parseLawSection(html, '9')).toEqual({ ok: false, reason: 'commentary in text' });
  });

  it('decodes entities and keeps internal cross-references as text', () => {
    const html =
      '<section class="akn-section"><h3>7. Penalty &amp; costs.&#8212;</h3>' +
      '<span class="akn-p">Subject to <a href="/doc/123/">section 5</a>, the fine &mdash; &#x20B9;100.</span></section>';
    const parsed = parseLawSection(html, '7');
    expect(parsed).toEqual({ ok: true, section: { number: '7', title: 'Penalty & costs', text: '7. Subject to section 5, the fine — ₹100.' } });
  });
});
