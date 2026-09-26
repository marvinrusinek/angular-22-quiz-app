import { Quiz } from '@shared/models';
import { eligibleInterviewTopicIds, isEligibleInterviewTopic } from './interview-topics';

function quiz(quizId: string, questionCount: number): Quiz {
  return {
    quizId,
    milestone: quizId,
    questions: Array.from({ length: questionCount }, () => ({}) as never)
  } as unknown as Quiz;
}

describe('interview-topics eligibility', () => {
  it('a quiz is eligible only with an id and at least one question', () => {
    expect(isEligibleInterviewTopic(quiz('forms', 5))).toBe(true);
    expect(isEligibleInterviewTopic(quiz('empty', 0))).toBe(false);      // no questions → not practiceable
    expect(isEligibleInterviewTopic({ quizId: '', milestone: 'x' } as unknown as Quiz)).toBe(false);
    expect(isEligibleInterviewTopic(null)).toBe(false);
    expect(isEligibleInterviewTopic(undefined)).toBe(false);
  });

  it('excludes zero-question quizzes from the eligible id list (coverage denominator)', () => {
    const ids = eligibleInterviewTopicIds([quiz('a', 3), quiz('b', 0), quiz('c', 1)]);
    expect(ids).toEqual(['a', 'c']);   // 'b' has no questions
  });

  it('de-duplicates and tolerates bad input', () => {
    expect(eligibleInterviewTopicIds([quiz('a', 1), quiz('a', 2)])).toEqual(['a']);
    expect(eligibleInterviewTopicIds(null)).toEqual([]);
    expect(eligibleInterviewTopicIds(undefined)).toEqual([]);
  });
});
