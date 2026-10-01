/**
 * What to say to a case-status question that carries no CNR.
 *
 * ## Why
 *
 * "Check the status of CNR 831/2024" - the filing number, copied off the case
 * card just above it - was sent to eCourts as a CNR, charged, refunded, and
 * answered "No case found for CNR 831/2024. Check the 16-character number": as
 * though the case did not exist. Case status is looked up by CNR alone, and a
 * filing or registration number is not one - every court numbers its own
 * cases, so the same "831/2024" is a different case in another court.
 *
 * So the reply says what was sent, what is needed and where to find it, and
 * costs nothing. When the number is one of a case already looked up in the
 * same chat, it names that case's CNR - it does not look the case up on that
 * assumption, because the same number in another court is another case.
 */

/** A case card shown earlier in the chat - the fields a number could be. */
export interface EarlierCase {
  cnr: string;
  filingNumber: string | null;
  /** The registration number as printed - "Writ Petition (Civil) 138/2024". */
  caseNumber: string | null;
  petitioner: string | null;
  respondent: string | null;
}

export interface CaseNumberMatch {
  case: EarlierCase;
  which: 'filing' | 'registration';
}

/** The CNR format, written out once for every reply that asks for one. */
export const CNR_EXAMPLE = 'DLCT010001232024';

/** "831/2024" (or "831 / 2024", "0831/2024") in what was typed, normalised; null if none. */
export function caseNumberIn(text: string): string | null {
  const m = /(?<![\d/])(\d{1,7})\s*\/\s*((?:19|20)\d{2})(?![\d/])/.exec(text);
  return m ? `${Number(m[1])}/${m[2]}` : null;
}

/** The case in this chat that number belongs to, when exactly one does. */
export function matchEarlierCase(typed: string, cases: EarlierCase[]): CaseNumberMatch | null {
  const matches = new Map<string, CaseNumberMatch>();
  for (const c of cases) {
    if (c.filingNumber && caseNumberIn(c.filingNumber) === typed) matches.set(c.cnr, { case: c, which: 'filing' });
    else if (c.caseNumber && caseNumberIn(c.caseNumber) === typed) matches.set(c.cnr, { case: c, which: 'registration' });
  }
  // Two cases in one chat sharing the number: naming either would be a guess.
  return matches.size === 1 ? [...matches.values()][0] : null;
}

export function cnrNeededReply(typed: string | null, match: CaseNumberMatch | null): string {
  const free = 'No credits were charged.';

  if (typed && match) {
    const parties = [match.case.petitioner, match.case.respondent].filter(Boolean).join(' vs ');
    return [
      `*${typed}* is not a CNR - it is the ${match.which} number of *${match.case.cnr}*${parties ? ` (${parties})` : ''}, the case looked up earlier in this chat.`,
      '',
      `To check that case again, send *${match.case.cnr}*. Other courts use the same ${match.which} numbers for their own cases, so a case can only be looked up by its CNR.`,
      '',
      free,
    ].join('\n');
  }

  const how = `The CNR is the 16-character number printed on the case papers and on the eCourts page for the case - for example *${CNR_EXAMPLE}*. Send it and I'll fetch the status, next hearing date, judge and parties.`;
  if (typed) {
    return [
      `*${typed}* is not a CNR, so I can't look it up. It looks like a filing or registration number, and other courts use the same numbers for their own cases.`,
      '',
      how,
      '',
      free,
    ].join('\n');
  }
  return [`To check a case, I need its CNR. ${how}`, '', free].join('\n');
}
