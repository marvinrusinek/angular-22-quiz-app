import { toActiveQuestionDto, toInterviewResultDto } from '../src/interview/session.dto';
import type { SessionQuestionSnapshot } from '../src/interview/session.types';
import type { FrozenInterviewResult } from '../src/interview/result.types';

/**
 * `session.dto.ts` mapping functions, tested directly as pure functions —
 * this is the ONE hop `session-repository.test.ts` cannot reach (it proves
 * persistence/hydration at the repository layer, not the DTO mapping that
 * runs on top of it).
 */

const SNIPPET = { language: 'typescript' as const, code: 'const x = 1;', filename: 'x.ts' };

function questionSnapshot(overrides: Partial<SessionQuestionSnapshot> = {}): SessionQuestionSnapshot {
  return {
    position: 0,
    questionId: 'rxjs:q:0',
    sourceQuizId: 'rxjs',
    questionText: 'Q?',
    type: 'single',
    explanation: 'Because.',
    options: [{ optionId: 101, text: 'A', displayOrder: 0, isCorrect: true }],
    flagged: false,
    ...overrides
  };
}

describe('toActiveQuestionDto — code snippet', () => {
  it('is absent when the question has none', () => {
    const dto = toActiveQuestionDto(questionSnapshot());
    expect(dto.codeSnippet).toBeUndefined();
    expect('codeSnippet' in dto).toBe(false);
  });

  it('is included, field-by-field, when present', () => {
    const dto = toActiveQuestionDto(questionSnapshot({ codeSnippet: SNIPPET }));
    expect(dto.codeSnippet).toEqual(SNIPPET);
  });

  it('never leaks correctness merely because a snippet is present', () => {
    const dto = toActiveQuestionDto(questionSnapshot({ codeSnippet: SNIPPET }));
    expect(JSON.stringify(dto)).not.toContain('isCorrect');
    expect(JSON.stringify(dto)).not.toContain('explanation');
  });
});

describe('toInterviewResultDto — code snippet on the review', () => {
  function frozenResult(review: FrozenInterviewResult['review']): FrozenInterviewResult {
    return {
      sessionId: 'is_1', status: 'submitted', submittedAt: 1_700_000_000_000, submittedByExpiry: false,
      total: review.length, answered: 0, unanswered: review.length, correct: 0, incorrect: 0, percentage: 0,
      durationSeconds: 900, timeUsedSeconds: 0, timeRemainingSeconds: 900,
      config: { mode: 'custom', topicIds: ['rxjs'], questionCount: review.length },
      performance: { byTopic: [] },
      review
    };
  }

  const reviewQuestion = (overrides: Partial<FrozenInterviewResult['review'][number]> = {}) => ({
    questionId: 'rxjs:q:0', sourceQuizId: 'rxjs', questionText: 'Q?', type: 'single' as const,
    options: [{ optionId: 101, text: 'A' }],
    selectedOptionIds: [], correctOptionIds: [101], explanation: 'Because.', flagged: false,
    ...overrides
  });

  it('is absent when the frozen question has none', () => {
    const dto = toInterviewResultDto(frozenResult([reviewQuestion()]));
    expect(dto.review[0]!.codeSnippet).toBeUndefined();
  });

  it('is included when present on the frozen review question', () => {
    const dto = toInterviewResultDto(frozenResult([reviewQuestion({ codeSnippet: SNIPPET })]));
    expect(dto.review[0]!.codeSnippet).toEqual(SNIPPET);
  });
});
