import { withCaseRows } from '../../ecourts/case-status.rows';
import { APP_JS } from './app.js';

/**
 * The website's case-status card, run as the browser runs it.
 *
 * It used to draw its own rows from the raw record, and drifted from WhatsApp's:
 * other labels, empty rows dropped, and no disposed-case rule - so a client saw
 * "Next hearing 2024-03-12" on a case disposed that day. It now draws the rows
 * the server sends (case-status.rows.ts), which WhatsApp prints too.
 *
 * The script is a template literal, so nothing in `nest build` looks inside it.
 * The card's functions are lifted out and run against a minimal document.
 */
interface FakeNode {
  tag: string;
  className: string;
  textContent: string;
  children: FakeNode[];
  style: Record<string, string>;
  firstChild: FakeNode | null;
  appendChild(child: FakeNode): FakeNode;
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode;
}

function fakeDocument() {
  return {
    createElement(tag: string): FakeNode {
      const node: FakeNode = {
        tag, className: '', textContent: '', children: [], style: {},
        get firstChild() { return node.children[0] ?? null; },
        appendChild(child) { node.children.push(child); return child; },
        insertBefore(child, before) {
          const at = before ? node.children.indexOf(before) : -1;
          if (at < 0) node.children.push(child); else node.children.splice(at, 0, child);
          return child;
        },
      };
      return node;
    },
  };
}

function lift(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in app.js`);
  return APP_JS.slice(start, APP_JS.indexOf('\n}\n', start) + 3);
}

const renderCaseStatus = new Function(
  'document',
  [
    APP_JS.slice(APP_JS.indexOf('const el = '), APP_JS.indexOf('};\n', APP_JS.indexOf('const el = ')) + 3),
    lift('precedentCaveat'),
    lift('renderCaseStatus'),
    'return renderCaseStatus;',
  ].join('\n'),
)(fakeDocument()) as (data: unknown) => FakeNode;

const text = (node: FakeNode): string => [node.textContent, ...node.children.map(text)].join(' ');
const find = (node: FakeNode, tag: string): FakeNode[] =>
  [...(node.tag === tag ? [node] : []), ...node.children.flatMap((c) => find(c, tag))];

/** The card the client reported: disposed 2024-03-12, with that day still under "next hearing". */
const reported = {
  kind: 'caseStatus',
  cnr: 'DLCT010012342024',
  caseNumber: 'Unrecognized case type 79/2024',
  filingNumber: '831/2024',
  cnrCaseNumber: '0012342024',
  statusLabel: 'Disposed',
  decisionDate: '2024-03-12',
  disposalNature: 'DISPOSED',
  fir: null,
  recordUpdated: '2026-07-06',
  caseType: 'Unrecognized case type',
  filingDate: '2024-01-27',
  registrationDate: '2024-01-29',
  firstHearingDate: '2024-01-29',
  court: 'District & Sessions Judge, Central, Tis Hazari Court, Delhi',
  judge: 'DISTRICT JUDGE (COMMERCIAL COURT) - 08, CENTRAL, THC',
  petitioner: 'Idfc First Bank',
  respondent: 'Aditya Bhatia 6897',
  petitionerAdvocate: 'MAYANK MAHAJAN',
  respondentAdvocate: null,
  stage: 'Misc./ Appearance',
  nextHearingDate: '2024-03-12',
  lastHearingDate: '2024-03-12',
  status: 'DISPOSED',
  mocked: false,
};

describe('the website case card', () => {
  const card = renderCaseStatus(withCaseRows(reported, '2026-10-02'));
  const pairs = (() => {
    const dts = find(card, 'dt').map((n) => n.textContent);
    const dds = find(card, 'dd').map((n) => n.textContent);
    return dts.map((label, i) => [label, dds[i]]);
  })();
  const value = (label: string) => pairs.find(([l]) => l === label)?.[1];

  it('prints the rows the server sent, labelled as on WhatsApp, in order', () => {
    expect(pairs.map(([label]) => label)).toEqual([
      'Case Type', 'Filing Number', 'Filing Date', 'Registration Number', 'Registration Date',
      'CNR Number', 'CNR Case Number', 'First Hearing Date', 'Last Hearing Date', 'Next Hearing Date',
      'Case Status', 'Disposal Date', 'Stage of Case', 'Court', 'Judge',
      'Petitioner and Advocate', 'Respondent and Advocate',
    ]);
  });

  it('does not show a disposed case\'s past next hearing as a date', () => {
    expect(value('Next Hearing Date')).toBe('Not available');
  });

  it('shows neither "DISPOSED" as the nature of disposal nor the provider placeholder', () => {
    expect(value('Nature of Disposal')).toBeUndefined();
    expect(text(card)).not.toMatch(/unrecogni/i);
    expect(value('Registration Number')).toBe('79/2024');
  });

  it('greys "Not available" so it does not read as data', () => {
    const next = find(card, 'dd').find((n) => n.textContent === 'Not available');
    expect(next?.className).toBe('na');
  });

  it('ends with how fresh the record is, and the caveat', () => {
    expect(text(card)).toContain('Record last updated from eCourts: 2026-07-06');
    expect(text(card)).toContain('This is a research aid. Verify from original sources before court use. Not legal advice.');
  });

  it('draws nothing from the raw record itself', () => {
    const source = lift('renderCaseStatus');
    expect(source).not.toContain('data.nextHearingDate');
    expect(source).not.toContain('data.disposalNature');
  });
});

/** The 8 October fixes, as the browser draws them. */
describe('notes and links added on 8 October', () => {
  it('says under the card which part of the message it did not answer (C-15)', () => {
    const note = 'Your message also asked: "which Arbitration Act section governs interim relief?" This reply covers only the case status - send that question on its own and Ley Legal will answer it.';
    const card = renderCaseStatus(withCaseRows({ ...reported, note }, '2026-10-02'));
    expect(text(card)).toContain(note);
  });

  it('adds nothing under a plain card', () => {
    expect(text(renderCaseStatus(withCaseRows(reported, '2026-10-02')))).not.toContain('Your message also asked');
  });

  const renderSources = new Function(
    'document',
    [
      APP_JS.slice(APP_JS.indexOf('const el = '), APP_JS.indexOf('};\n', APP_JS.indexOf('const el = ')) + 3),
      lift('renderSources'),
      'return renderSources;',
    ].join('\n'),
  )(fakeDocument()) as (sources: unknown[]) => FakeNode;

  it('links a judgment found on Indian Kanoon to it (point-of-law answers)', () => {
    const list = renderSources([
      { caseTitle: 'Narinder Singh & Ors vs State Of Punjab & Anr', citation: '2014 (6) SCC 466', court: 'Supreme Court of India', url: 'https://indiankanoon.org/doc/100001/' },
      { caseTitle: 'A corpus passage', citation: null, court: null, paragraph: 4 },
    ]);
    const links = find(list, 'a') as (FakeNode & { href?: string; rel?: string })[];
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('https://indiankanoon.org/doc/100001/');
    expect(links[0].rel).toBe('noopener noreferrer');
    expect(links[0].textContent).toBe('Narinder Singh & Ors vs State Of Punjab & Anr — 2014 (6) SCC 466 — Supreme Court of India');
  });

  it('links nothing that is not an Indian Kanoon page', () => {
    const list = renderSources([{ caseTitle: 'X vs Y', url: 'javascript:alert(1)' }]);
    expect(find(list, 'a')).toHaveLength(0);
  });
});
