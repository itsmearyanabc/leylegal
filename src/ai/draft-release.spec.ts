import { DRAFT_LOOKAHEAD, DraftReleaser, releasableEnd } from './draft-release';
import { GuardrailsService } from './guardrails.service';
import { ClassifiedIntent } from './intent.service';

/**
 * Showing an answer while it is written, and never anything unchecked.
 *
 * The answers are real - leylegal.in, 4 October 2026: X3 and X1 from the
 * latency benchmark, NS5 from the audit re-run. NS5 as published reads "...in
 * _Arnesh Kumar v. State of Bihar_ [unverified]": the model had cited the
 * judgment, the check found no such citation in the corpus (production's
 * judgment tables are empty) and struck it. Arnesh Kumar is reported at
 * (2014) 8 SCC 273, which is put back here as the model wrote it.
 */
const X3 =
  "*SECTION:* CrPC Section 167, mapped to BNSS Section 187.\n\n*SUMMARY:* CrPC 167, now BNSS 187, allows a Magistrate to authorize detention when an investigation isn't finished within 24 hours. If detention exceeds 60 or 90 days depending on the offence's seriousness, the accused must be released on bail unless they cannot furnish it.\n\n*KEY ELEMENTS:*  \n- Detention for investigation: Max 90 days (grave offences), 60 days (other offences).  \n- Cognizable: Yes  \n- Bailable: If maximum period expires without charge sheet.  \n- Compoundable: No  \n- Judicial oversight required for detention extension.\n\n*PRACTICAL USE:* Advocates use this to argue for the release of clients on 'default bail' when the police fail to file a charge sheet within the stipulated period, thus enforcing timely investigations.";
const X1 =
  '*SECTION:* Section 376 of the Indian Penal Code (IPC), mapped to BNS Section 64 and BNS Section 65(1).\n\n*SUMMARY:* IPC Section 376, dealing with the punishment for rape, is now under BNS Sections 64 and 65(1). It prescribes rigorous imprisonment for not less than ten years, extendable to life, along with a fine.\n\n*KEY ELEMENTS:*\n- Offence of rape.\n- Punishment: Rigorous imprisonment not less than 10 years, extendable to life, with a fine.\n- Cognizable, non-bailable, non-compoundable.\n- Triable by Court of Session.\n\n*PRACTICAL USE:* Advocates use this section in cases related to charges of rape to understand applicable penalties and the non-bailability of the offence. It’s essential in the prosecution and defense strategies in such cases.';
const NS5_WRITTEN =
  "*SECTION:* CrPC Section 41A (Notice of appearance before police officer), corresponds to BNSS Section 35.\n\n*SUMMARY:* This provision requires police to issue a notice for appearance when arrest isn't necessary. The person must comply with the notice, and if they do, they shouldn't be arrested unless necessary reasons are recorded. This section was upheld by the Supreme Court in _Arnesh Kumar v. State of Bihar_ (2014) 8 SCC 273.\n\n*KEY ELEMENTS:*\n- Police to issue notice, not arrest directly.\n- Compliance prevents arrest unless officers record reasons.\n- Applies when no immediate arrest is required.\n\n*PRACTICAL USE:* Advocates use this to challenge unnecessary arrests and ensure clients comply with police processes without arrest.";
const NOTE = "\n\n_One or more references could not be verified against Ley Legal's database of statutes and judgments and were removed._";

/** The checker over a corpus as production's is: every section in these answers held, no judgment ingested. */
function guardrails() {
  const corpus = {
    verifyCitations: jest.fn(async (citations: string[]) => citations.map((citation) => ({ citation, found: false }))),
    verifyStatuteRefs: jest.fn(async (refs: string[]) => refs.map((ref) => ({ ref, found: true }))),
  };
  return { checker: new GuardrailsService(corpus as never), corpus };
}

const intent = { actCode: 'CRPC', sectionNumber: '41A' } as ClassifiedIntent;
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Writes `text` into a releaser `size` characters at a time; returns every draft shown. */
async function streamed(text: string, size: number, checker: GuardrailsService): Promise<string[]> {
  const shown: string[] = [];
  const releaser = new DraftReleaser((prefix, known) => checker.verifiedDraft(prefix, intent, known), (draft) => shown.push(draft));
  for (let i = size; i < text.length + size; i += size) {
    releaser.offer(text.slice(0, i));
    await settle();
  }
  await releaser.close();
  return shown;
}

describe('which lines may be shown', () => {
  it('shows nothing until a line has been finished and followed', () => {
    expect(releasableEnd(X3.slice(0, 40))).toBe(0);
    const firstBreak = X3.indexOf('\n');
    expect(releasableEnd(X3.slice(0, firstBreak + DRAFT_LOOKAHEAD))).toBe(0);

    const end = releasableEnd(X3.slice(0, firstBreak + 1 + DRAFT_LOOKAHEAD + 1));
    expect(X3.slice(0, end)).toBe('*SECTION:* CrPC Section 167, mapped to BNSS Section 187.\n\n');
  });

  it('holds a line back while a reference runs on past its end, then shows both lines together', () => {
    // X3 with a line break inside "BNSS Section 187": with the text cut just
    // after that break, the reference runs across the line end, so the line
    // waits; once the rest of it is written, the two lines go out as one.
    const broken = X3.replace('BNSS Section 187.', 'BNSS Section\n187.');
    const inside = broken.indexOf('Section\n187') + 'Section'.length;

    expect(releasableEnd(broken.slice(0, inside + 1 + DRAFT_LOOKAHEAD + 1))).toBe(0);
    const later = releasableEnd(broken.slice(0, broken.indexOf('*SUMMARY:*') + 30));
    expect(broken.slice(0, later)).toContain('BNSS Section\n187.');
  });
});

describe('an answer shown while it is written', () => {
  it.each([
    ['X3', X3],
    ['X1', X1],
  ])('shows %s line by line, each draft the beginning of the finished answer', async (_id, text) => {
    const { checker } = guardrails();

    const shown = await streamed(text, 9, checker);
    const finished = (await checker.verify(text, [], intent)).text;

    expect(shown.length).toBeGreaterThan(2);
    for (const draft of shown) expect(finished.startsWith(draft)).toBe(true);
    expect(shown[shown.length - 1].length).toBeLessThan(finished.length);
  });

  it('never shows a citation the check removes - it is struck before the line is shown', async () => {
    const { checker } = guardrails();

    const shown = await streamed(NS5_WRITTEN, 7, checker);
    const finished = (await checker.verify(NS5_WRITTEN, [], intent)).text;

    expect(finished).toContain('_Arnesh Kumar v. State of Bihar_ [unverified].');
    expect(finished.endsWith(NOTE)).toBe(true);
    for (const draft of shown) {
      expect(draft).not.toContain('8 SCC 273');
      expect(finished.startsWith(draft)).toBe(true);
    }
    expect(shown.some((draft) => draft.includes('[unverified]'))).toBe(true);
  });

  it('checks a draft exactly as the finished answer is checked', async () => {
    const { checker } = guardrails();

    const draft = await checker.verifiedDraft(NS5_WRITTEN, intent, new Map());
    const finished = await checker.verify(NS5_WRITTEN, [], intent);

    expect(draft + NOTE).toBe(finished.text);
  });

  it('looks each reference up once, however many drafts it is in', async () => {
    const { checker, corpus } = guardrails();

    await streamed(X3, 5, checker);

    const asked = corpus.verifyStatuteRefs.mock.calls.flatMap((call) => call[0]);
    expect(asked.length).toBe(new Set(asked).size);
  });

  it('shows nothing more once a lookup fails', async () => {
    const shown: string[] = [];
    let calls = 0;
    const releaser = new DraftReleaser(
      async (prefix) => {
        calls += 1;
        if (calls === 2) throw new Error('connection reset');
        return prefix;
      },
      (draft) => shown.push(draft),
    );
    for (let i = 9; i < X3.length + 9; i += 9) {
      releaser.offer(X3.slice(0, i));
      await settle();
    }
    await releaser.close();

    expect(shown).toHaveLength(1);
  });

  it('withdraws what it showed when the writing starts over', async () => {
    const shown: string[] = [];
    const releaser = new DraftReleaser(async (prefix) => prefix, (draft) => shown.push(draft));
    releaser.offer(X3);
    await settle();
    releaser.offer('');
    await releaser.close();

    expect(shown[shown.length - 1]).toBe('');
  });

  it('shows nothing after it is closed, so no draft follows the answer', async () => {
    const shown: string[] = [];
    let release: () => void = () => undefined;
    const releaser = new DraftReleaser(
      (prefix) => new Promise<string>((resolve) => (release = () => resolve(prefix))),
      (draft) => shown.push(draft),
    );
    releaser.offer(X3);
    const closing = releaser.close();
    release();
    await closing;

    expect(shown).toEqual([]);
  });
});
