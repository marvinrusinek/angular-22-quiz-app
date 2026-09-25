import { Quiz } from '@shared/models/Quiz.model';

/**
 * THE single definition of an "eligible Interview Mode topic": a catalogue quiz
 * that can actually be selected and practiced in Interview Mode — it has a real
 * quizId and at least one question. Anything with no questions can never be
 * practiced, so it must not inflate a readiness coverage denominator, and it
 * must not appear as a selectable topic in the builder.
 *
 * Shared by the Interview Builder (which topics to offer) and the Readiness
 * score (the coverage denominator), so the two can never drift apart.
 */
export function isEligibleInterviewTopic(quiz: Quiz | null | undefined): boolean {
  return (
    !!quiz &&
    typeof quiz.quizId === 'string' &&
    quiz.quizId.length > 0 &&
    (quiz.questions?.length ?? 0) > 0
  );
}

/** Eligible Interview Mode topic ids (Mixed pool), deduplicated, in order. */
export function eligibleInterviewTopicIds(quizzes: readonly Quiz[] | null | undefined): string[] {
  if (!Array.isArray(quizzes)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const quiz of quizzes) {
    if (isEligibleInterviewTopic(quiz) && !seen.has(quiz.quizId)) {
      seen.add(quiz.quizId);
      ids.push(quiz.quizId);
    }
  }
  return ids;
}
