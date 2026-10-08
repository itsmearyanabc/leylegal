import { ADVICE_REPLY, PRACTICE_REPLY, productReply, TRACKING_REPLY } from './intent.service';

/**
 * Requests for something Ley Legal does not do, and questions about Ley Legal
 * itself: a fixed reply, free (intent.service.ts, productReply).
 *
 * Live test of 8 October 2026: each of the three below was answered by the
 * model and charged two credits.
 */
describe('a request Ley Legal has a fixed answer for', () => {
  it.each([
    // S-MT-05: practice questions are "Planned" on the homepage, not live.
    ['Give me 10 MCQs on BNSS for judiciary prelims.', PRACTICE_REPLY],
    ['quiz me on the BSA', PRACTICE_REPLY],
    ['Make 5 multiple-choice questions on bail', PRACTICE_REPLY],
    ['BNS ke practice questions do', PRACTICE_REPLY],
    // C-19
    ['Track all my cases automatically', TRACKING_REPLY],
    ['Can you monitor my pending matters?', TRACKING_REPLY],
    ['Send me alerts for my next hearing dates', TRACKING_REPLY],
    // B-13
    ['Is your answer legal advice?', ADVICE_REPLY],
    ['Is Ley Legal legal advice?', ADVICE_REPLY],
  ])('%p', (question, reply) => {
    expect(productReply(question)).toBe(reply);
  });

  it.each([
    // Legal questions that only mention the words.
    'Can the police track my phone in criminal cases?',
    'How do I track the status of my case?',
    'What is the punishment for giving legal advice without enrolment?',
    'Is a quizmaster liable for defamation?',
    'Practice and procedure for filing a caveat under Section 148A CPC',
    'Supreme Court guidelines on arrest and detention to prevent custodial violence',
    'Is the two-finger test permissible in rape cases?',
    'CNR DLCT010012342024 — what\'s the status and which Arbitration Act section governs interim relief?',
  ])('is not given to %p', (question) => {
    expect(productReply(question)).toBeNull();
  });

  it('says what Ley Legal does instead, and nothing it does not do', () => {
    expect(PRACTICE_REPLY).toContain('not live');
    expect(TRACKING_REPLY).toContain('16-character CNR');
    expect(ADVICE_REPLY.startsWith('No.')).toBe(true);
  });
});
