import { BadRequestError } from '../domain/errors.js';

/**
 * Answers are matched to questions by exact text, so an answer to a question
 * the brief never asked would be stored and then silently ignored. Rejecting it
 * stops a typo from looking like a saved decision.
 */
export function validateAnswers(
  asked: readonly string[],
  answers: readonly { question: string }[],
): void {
  const known = new Set(asked);
  const unknown = answers.map((a) => a.question).filter((q) => !known.has(q));
  if (unknown.length > 0) {
    throw new BadRequestError('No such open question on this brief', { unknown, asked: [...asked] });
  }
}
