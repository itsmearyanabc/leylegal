/**
 * "Summary in 100 words" - how long the advocate asked the summary to be.
 *
 * ## Why this is parsed rather than handed to the model
 *
 * The summariser is a cheap model writing ten entries in one JSON reply, and
 * "the advocate asked: <their whole message>" is a vague instruction to give it
 * and an injection point besides. A number is neither. So the length is read
 * out of the message here and the prompt is told "about 100 words", which is
 * the only part of the message the summariser needs.
 *
 * ## Why it also has to be removed
 *
 * The same words reach the search. "Rajesh Kumar Mittal vs State of Bihar in
 * 100 words" made the respondent "State of Bihar in 100 words", and a Kanoon
 * query containing "100 words" scores judgments on those two tokens. A length
 * is an instruction about the reply, never part of the question.
 */

/** Above this the extract runs out long before the words do. */
export const MAX_SUMMARY_WORDS = 300;

/** What an entry runs to when nobody asked for a length. */
export const DEFAULT_SUMMARY_WORDS = 80;

const UNIT = String.raw`(?:words?|wrds?|shabd(?:o|on)?|शब्दों|शब्द)`;

/**
 * "in 100 words", "100 words me", "100-word", "within 150 words only",
 * "100 शब्दों में". The unit is required: a bare number is a section, a year or
 * a case number far more often than it is a length.
 */
const LENGTH_REQUEST = String.raw`(?:^|[\s,.;:(])(?:(?:in|within|under|upto|up to|about|around|approx|approximately|max|maximum|at most|not more than|less than|of)\s+)?(\d{1,4})\s*-?\s*${UNIT}(?![A-Za-z])(?:\s+(?:me|mein|mai|mei|में|only|max|maximum)(?![A-Za-z]))*\)?`;

/** The word count asked for, or null when the message names none. */
export function requestedWordCount(text: string | null | undefined): number | null {
  const match = text ? new RegExp(LENGTH_REQUEST, 'i').exec(text) : null;
  const words = match ? Number(match[1]) : NaN;
  // "in 2 words" is not a summary anyone can use; treat it as no request.
  if (!Number.isFinite(words) || words < 10) return null;
  return Math.min(words, MAX_SUMMARY_WORDS);
}

/** The message with any length instruction taken out. */
export function withoutLengthRequest(text: string): string {
  const stripped = text
    .replace(new RegExp(LENGTH_REQUEST, 'gi'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // A message that was nothing but a length is left alone - an empty query is
  // worse than a slightly noisy one.
  return stripped || text;
}
