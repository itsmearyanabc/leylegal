import { MAX_SUMMARY_WORDS, requestedWordCount, withoutLengthRequest } from './summary-length';
import { buildPrincipleSummaryPrompt } from './prompts';
import { summaryTokenBudget } from './precedents.service';

describe('reading the length an advocate asked for', () => {
  it.each([
    ['summary of X vs Y in 100 words', 100],
    ['X vs Y summary 100 words me do', 100],
    ['give a 100-word summary of X vs Y', 100],
    ['judgments on bail, within 150 words only', 150],
    ['X vs Y ka summary 60 shabdon mein', 60],
    ['X vs Y का सारांश 100 शब्दों में', 100],
    ['summary in 50 WORDS', 50],
  ])('%s -> %i', (text, words) => {
    expect(requestedWordCount(text)).toBe(words);
  });

  it.each([
    'judgments on section 100 IPC',
    'anticipatory bail after chargesheet',
    'Rajesh Kumar Mittal vs State of Bihar (2017)',
    'order 32 cpc',
    '',
  ])('finds none in %p', (text) => {
    expect(requestedWordCount(text)).toBeNull();
  });

  it('is capped where the extract runs out', () => {
    expect(requestedWordCount('summary in 2000 words')).toBe(MAX_SUMMARY_WORDS);
  });

  it('ignores a length too short to be a summary', () => {
    expect(requestedWordCount('in 2 words')).toBeNull();
  });
});

describe('taking the length out of what gets searched', () => {
  it('leaves the question and drops the instruction', () => {
    expect(withoutLengthRequest('judgments on cheque bounce in 100 words')).toBe(
      'judgments on cheque bounce',
    );
    expect(withoutLengthRequest('Mittal vs State of Bihar 100 words me')).toBe('Mittal vs State of Bihar');
  });

  it('does not touch a section number', () => {
    expect(withoutLengthRequest('judgments on section 100 IPC')).toBe('judgments on section 100 IPC');
  });
});

describe('the summary prompt', () => {
  it('asks for the facts and the principle, not the principle alone', () => {
    const prompt = buildPrincipleSummaryPrompt();
    expect(prompt).toContain('what the dispute or proceeding was about');
    expect(prompt).toContain('the legal principle the court decided or held');
    expect(prompt).toContain('"NONE"');
  });

  it('carries the requested length as a number, never the message', () => {
    const prompt = buildPrincipleSummaryPrompt(100);
    expect(prompt).toContain('about 100 words');
    expect(prompt).not.toContain('at most 80 words');
  });

  it('is budgeted so ten entries at 100 words do not truncate the JSON', () => {
    // A truncated reply fails to parse and loses every entry, not just the last.
    expect(summaryTokenBudget(10, 100)).toBeGreaterThanOrEqual(10 * 100 * 1.5);
    expect(summaryTokenBudget(10, null)).toBeGreaterThan(900);
  });
});
