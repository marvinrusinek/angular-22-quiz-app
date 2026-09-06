import {
  toQuestionViewModel,
  toResultViewModel,
  toReviewQuestionViewModel,
  toSessionViewModel
} from './interview-api.mappers';
import { isMultiSelectQuestion } from '../../models/interview/interview-view-models';
import {
  normalizeBaseUrl,
  resolveApiBaseUrl,
  DEV_API_BASE_URL,
  PROD_API_BASE_URL
} from '../../tokens/api-base-url.token';
import type {
  ActiveInterviewSessionDto,
  InterviewResultDto,
  InterviewReviewQuestionDto
} from '../../models/api/interview-api.dto';

const session: ActiveInterviewSessionDto = {
  sessionId: 'is_x',
  status: 'active',
  createdAt: '2026-08-02T10:00:00.000Z',
  expiresAt: '2026-08-02T10:15:00.000Z',
  durationSeconds: 900,
  remainingSeconds: 880,
  config: { mode: 'preset', presetId: 'junior', topicIds: ['rxjs', 'signals'], questionCount: 3 },
  questions: [
    {
      questionId: 'rxjs:q:2', sourceQuizId: 'rxjs', questionText: 'Q A', type: 'single',
      options: [{ optionId: 304, text: 'd' }, { optionId: 301, text: 'a' }, { optionId: 303, text: 'c' }],
      flagged: false
    },
    {
      questionId: 'signals:q:0', sourceQuizId: 'signals', questionText: 'Q B', type: 'multiple',
      options: [{ optionId: 101, text: 'x' }, { optionId: 102, text: 'y' }],
      flagged: true
    },
    {
      questionId: 'signals:q:4', sourceQuizId: 'signals', questionText: 'Q C', type: 'trueFalse',
      options: [{ optionId: 501, text: 'True' }, { optionId: 502, text: 'False' }],
      flagged: false
    }
  ],
  answers: [{ questionId: 'signals:q:0', selectedOptionIds: [101, 102] }]
};

describe('API base URL', () => {
  it('uses the local backend in dev mode', () => {
    expect(resolveApiBaseUrl(true)).toBe(DEV_API_BASE_URL);
  });

  /**
   * It used to throw here. That was wrong: this runs in an injection factory,
   * so it took down every component injecting InterviewApiService and the
   * /interview route rendered nothing at all on GitHub Pages. Resolution is now
   * total; the call site fails closed. See api-base-url.token.spec.ts.
   */
  it('resolves the CONFIGURED origin in production, and never throws', () => {
    // Asserted against the constant rather than a literal, so this holds both
    // before and after a backend host is configured.
    expect(() => resolveApiBaseUrl(false)).not.toThrow();
    expect(resolveApiBaseUrl(false)).toBe(PROD_API_BASE_URL);
  });

  it('strips trailing slashes so callers can append a path', () => {
    expect(normalizeBaseUrl('http://x/api/')).toBe('http://x/api');
    expect(normalizeBaseUrl('http://x/api///')).toBe('http://x/api');
    expect(normalizeBaseUrl('http://x/api')).toBe('http://x/api');
  });
});

describe('question mapping', () => {
  it('preserves the delivered option ORDER — never re-sorted', () => {
    const vm = toQuestionViewModel(session.questions[0]!);
    expect(vm.options.map((o) => o.optionId)).toEqual([304, 301, 303]);
  });

  it('exposes only optionId and text', () => {
    const vm = toQuestionViewModel(session.questions[0]!);
    for (const option of vm.options) {
      expect(Object.keys(option).sort()).toEqual(['optionId', 'text']);
    }
  });

  it('carries the explicit type', () => {
    expect(toQuestionViewModel(session.questions[1]!).type).toBe('multiple');
    expect(toQuestionViewModel(session.questions[2]!).type).toBe('trueFalse');
  });

  it('multi-select is decided by TYPE, with no correctness available', () => {
    const single = toQuestionViewModel(session.questions[0]!);
    const multiple = toQuestionViewModel(session.questions[1]!);
    const trueFalse = toQuestionViewModel(session.questions[2]!);

    expect(isMultiSelectQuestion(multiple)).toBe(true);
    expect(isMultiSelectQuestion(single)).toBe(false);
    // trueFalse is single-selection.
    expect(isMultiSelectQuestion(trueFalse)).toBe(false);

    // The determination cannot be using correctness, because none exists.
    expect(JSON.stringify(multiple)).not.toContain('correct');
  });

  it('is absent when the question has none', () => {
    const vm = toQuestionViewModel(session.questions[0]!);
    expect(vm.codeSnippet).toBeUndefined();
    expect('codeSnippet' in vm).toBe(false);
  });

  it('carries codeSnippet through, as a NEW object', () => {
    const snippet = { language: 'typescript' as const, code: 'const x = 1;', filename: 'x.ts' };
    const vm = toQuestionViewModel({ ...session.questions[0]!, codeSnippet: snippet });
    expect(vm.codeSnippet).toEqual(snippet);
    expect(vm.codeSnippet).not.toBe(snippet);
  });
});

describe('session mapping', () => {
  it('preserves question order and parses server timestamps', () => {
    const vm = toSessionViewModel(session);
    expect(vm.questions.map((q) => q.questionId)).toEqual(['rxjs:q:2', 'signals:q:0', 'signals:q:4']);
    expect(vm.createdAtMs).toBe(Date.parse('2026-08-02T10:00:00.000Z'));
    expect(vm.expiresAtMs).toBe(Date.parse('2026-08-02T10:15:00.000Z'));
    expect(vm.remainingSeconds).toBe(880);
  });

  it('indexes saved answers by questionId', () => {
    const vm = toSessionViewModel(session);
    expect(vm.answers.get('signals:q:0')).toEqual([101, 102]);
    expect(vm.answers.has('rxjs:q:2')).toBe(false);
  });

  it('indexes Mark-for-Review flags by questionId — only TRUE entries', () => {
    const vm = toSessionViewModel(session);
    expect(vm.flags.get('signals:q:0')).toBe(true);
    expect(vm.flags.has('rxjs:q:2')).toBe(false);
    expect(vm.flags.has('signals:q:4')).toBe(false);
  });

  it('keeps preset metadata', () => {
    const vm = toSessionViewModel(session);
    expect(vm.config.mode).toBe('preset');
    expect(vm.config.presetId).toBe('junior');
  });

  it('produces NEW objects — mutating the view model cannot affect the DTO', () => {
    const vm = toSessionViewModel(session);
    (vm.config.topicIds as string[]).push('tampered');
    expect(session.config.topicIds).toEqual(['rxjs', 'signals']);
  });
});

describe('review mapping', () => {
  const question = (overrides: Partial<InterviewReviewQuestionDto> = {}): InterviewReviewQuestionDto => ({
    questionId: 'rxjs:q:0', sourceQuizId: 'rxjs', questionText: 'Which is correct?',
    type: 'multiple',
    options: [{ optionId: 101, text: 'a' }, { optionId: 102, text: 'b' }, { optionId: 103, text: 'c' }],
    selectedOptionIds: [101, 103], correctOptionIds: [101, 103], explanation: 'Because.',
    flagged: false,
    ...overrides
  });

  it('carries the flagged note through untouched', () => {
    expect(toReviewQuestionViewModel(question({ flagged: true })).flagged).toBe(true);
    expect(toReviewQuestionViewModel(question({ flagged: false })).flagged).toBe(false);
  });

  it('carries the code snippet through, or leaves it absent', () => {
    expect(toReviewQuestionViewModel(question()).codeSnippet).toBeUndefined();

    const snippet = { language: 'typescript' as const, code: 'const x = 1;' };
    expect(toReviewQuestionViewModel(question({ codeSnippet: snippet })).codeSnippet).toEqual(snippet);
  });

  it('derives isCorrect by EXACT SET equality, order-independent', () => {
    expect(toReviewQuestionViewModel(question({ selectedOptionIds: [103, 101] })).isCorrect).toBe(true);
  });

  it.each([
    ['missing one correct', [101], false],
    ['one extra incorrect', [101, 102, 103], false],
    ['unanswered', [], false],
    ['exact', [101, 103], true]
  ])('%s', (_label, selected, expected) => {
    expect(toReviewQuestionViewModel(question({ selectedOptionIds: selected })).isCorrect).toBe(expected);
  });

  it('tracks answered separately from correct', () => {
    const wrong = toReviewQuestionViewModel(question({ selectedOptionIds: [102] }));
    expect(wrong.isAnswered).toBe(true);
    expect(wrong.isCorrect).toBe(false);

    const skipped = toReviewQuestionViewModel(question({ selectedOptionIds: [] }));
    expect(skipped.isAnswered).toBe(false);
  });

  it('releases correctOptionIds and the explanation — post-submission only', () => {
    const vm = toReviewQuestionViewModel(question());
    expect(vm.correctOptionIds).toEqual([101, 103]);
    expect(vm.explanation).toBe('Because.');
  });
});

describe('result mapping', () => {
  const dto: InterviewResultDto = {
    sessionId: 'is_x', status: 'submitted', submittedAt: '2026-08-02T10:05:00.000Z',
    submittedByExpiry: true,
    total: 3, answered: 2, unanswered: 1, correct: 1, incorrect: 1, percentage: 33,
    durationSeconds: 900, timeUsedSeconds: 900, timeRemainingSeconds: 0,
    config: { mode: 'preset', presetId: 'junior', topicIds: ['rxjs'], questionCount: 3 },
    performance: {
      byTopic: [
        { topicId: 'rxjs', title: 'RxJS', correct: 1, incorrect: 1, unanswered: 1, total: 3, percentage: 33 }
      ]
    },
    review: []
  };

  it('COPIES totals and percentage rather than recalculating', () => {
    const vm = toResultViewModel(dto);
    expect(vm).toMatchObject({
      total: 3, answered: 2, unanswered: 1, correct: 1, incorrect: 1, percentage: 33
    });
    // 1/3 would round to 33 anyway; the point is that it is copied, so a
    // backend rule change can never silently diverge here.
    expect(vm.percentage).toBe(dto.percentage);
  });

  it('preserves the FROZEN topic title, not a local lookup', () => {
    expect(toResultViewModel(dto).byTopic[0]!.title).toBe('RxJS');
  });

  it('preserves unanswered counts per topic', () => {
    expect(toResultViewModel(dto).byTopic[0]!.unanswered).toBe(1);
  });

  it('carries the expiry flag and timing', () => {
    const vm = toResultViewModel(dto);
    expect(vm.submittedByExpiry).toBe(true);
    expect(vm.timeUsedSeconds).toBe(900);
    expect(vm.durationSeconds).toBe(900);
    expect(vm.submittedAtMs).toBe(Date.parse('2026-08-02T10:05:00.000Z'));
  });
});
