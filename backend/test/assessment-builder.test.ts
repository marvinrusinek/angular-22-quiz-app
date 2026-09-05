import {
  allocate,
  assertSnapshotValid,
  buildInterviewAssessment,
  validateBuildRequest
} from '../src/interview/assessment.builder';
import { isAllOfTheAbove } from '../src/interview/all-of-the-above';
import {
  fixedRandomSource,
  InvalidRandomSourceError,
  seededRandomSource,
  shuffleArrayInPlace,
  shuffledCopy
} from '../src/interview/assessment.random';
import { AssessmentBuildError } from '../src/interview/assessment.types';
import { createQuizRepository, type QuizRepository } from '../src/quiz/quiz.repository';
import { syntheticBankRepository } from './helpers/fixtures';

/**
 * PARITY REFERENCE
 * Angular source: src/app/shared/services/features/assessment/assessment-builder.service.ts
 * Angular specs:  .../assessment-builder.service.spec.ts, assessment-builder-practice.service.spec.ts
 * Shuffle:        src/app/shared/utils/array-utils.ts
 * AOTA:           src/app/shared/utils/all-of-the-above.ts
 */

const repo = () => syntheticBankRepository();
const seeded = () => seededRandomSource(20260801);

function config(overrides: Partial<Parameters<typeof buildInterviewAssessment>[0]> = {}) {
  return {
    difficulty: 'mixed' as const,
    topicIds: ['fixture-widgets', 'fixture-gadgets', 'fixture-gizmos'],
    questionCount: 20 as const,
    durationSeconds: 1800,
    ...overrides
  };
}

describe('shuffle parity with ArrayUtils.shuffleArray', () => {
  it('MUTATES IN PLACE and returns the same reference', () => {
    const array = [1, 2, 3];
    const result = shuffleArrayInPlace(array, seededRandomSource(1));
    expect(result).toBe(array);
  });

  it('CONSUMES length draws — including the no-op at i === 0', () => {
    // Angular's loop runs `i >= 0`, so a 3-item shuffle draws 3 times, not 2.
    // Getting this wrong desynchronises every later draw under a seeded source.
    let draws = 0;
    const counting = { next: () => { draws++; return 0.5; } };
    shuffleArrayInPlace([1, 2, 3], counting);
    expect(draws).toBe(3);

    draws = 0;
    shuffleArrayInPlace([1], counting);
    expect(draws).toBe(1);
  });

  it('handles empty and single-item arrays', () => {
    expect(shuffleArrayInPlace([], seededRandomSource(1))).toEqual([]);
    expect(shuffleArrayInPlace([7], seededRandomSource(1))).toEqual([7]);
  });

  it('produces a known order for a FIXED random sequence', () => {
    // i=3 -> j=floor(0.0*4)=0 : swap 3,0 -> [d,b,c,a]
    // i=2 -> j=floor(0.5*3)=1 : swap 2,1 -> [d,c,b,a]
    // i=1 -> j=floor(0.0*2)=0 : swap 1,0 -> [c,d,b,a]
    // i=0 -> j=0              : no-op
    const result = shuffleArrayInPlace(
      ['a', 'b', 'c', 'd'],
      fixedRandomSource([0.0, 0.5, 0.0, 0.0])
    );
    expect(result).toEqual(['c', 'd', 'b', 'a']);
  });

  it('shuffledCopy leaves the input untouched', () => {
    const source = [1, 2, 3, 4];
    const copy = shuffledCopy(source, seededRandomSource(9));
    expect(source).toEqual([1, 2, 3, 4]);
    expect(copy).not.toBe(source);
  });

  it('REJECTS an out-of-range random value', () => {
    for (const bad of [1, 1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => shuffleArrayInPlace([1, 2, 3], { next: () => bad }))
        .toThrow(InvalidRandomSourceError);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = shuffledCopy([1, 2, 3, 4, 5, 6, 7, 8], seededRandomSource(42));
    const b = shuffledCopy([1, 2, 3, 4, 5, 6, 7, 8], seededRandomSource(42));
    expect(a).toEqual(b);
  });
});

describe('allocate() parity', () => {
  const uncapped = (ids: string[], each = 1000) => new Map(ids.map((id) => [id, each]));

  it('20 across 3 topics -> 7, 7, 6 (remainder to the FIRST topics)', () => {
    const result = allocate(['a', 'b', 'c'], uncapped(['a', 'b', 'c']), 20);
    expect([...result.values()]).toEqual([7, 7, 6]);
  });

  it('10 across 3 topics -> 4, 3, 3', () => {
    expect([...allocate(['a', 'b', 'c'], uncapped(['a', 'b', 'c']), 10).values()])
      .toEqual([4, 3, 3]);
  });

  it('7 across 2 topics -> 4, 3', () => {
    expect([...allocate(['a', 'b'], uncapped(['a', 'b']), 7).values()]).toEqual([4, 3]);
  });

  it('20 across 6 topics -> 4,4,3,3,3,3', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect([...allocate(ids, uncapped(ids), 20).values()]).toEqual([4, 4, 3, 3, 3, 3]);
  });

  it('splits evenly when there is no remainder', () => {
    expect([...allocate(['a', 'b'], uncapped(['a', 'b']), 10).values()]).toEqual([5, 5]);
  });

  it('REDISTRIBUTES when one topic cannot meet its share', () => {
    // 'b' can only supply 2 of its 7; the shortfall moves to topics with spare.
    const capacity = new Map([['a', 100], ['b', 2], ['c', 100]]);
    const result = allocate(['a', 'b', 'c'], capacity, 20);
    expect(result.get('b')).toBe(2);
    expect([...result.values()].reduce((x, y) => x + y, 0)).toBe(20);
  });

  it('redistributes round-robin, not all to one topic', () => {
    const capacity = new Map([['a', 100], ['b', 0], ['c', 100]]);
    const result = allocate(['a', 'b', 'c'], capacity, 20);
    expect(result.get('b')).toBe(0);
    // 7 + 6 base, then 7 leftovers dealt a,c,a,c,… → 11 and 9.
    expect(result.get('a')).toBe(11);
    expect(result.get('c')).toBe(9);
  });

  it('stops when total capacity is exhausted (caller checks availability first)', () => {
    const capacity = new Map([['a', 3], ['b', 2]]);
    const result = allocate(['a', 'b'], capacity, 20);
    expect([...result.values()].reduce((x, y) => x + y, 0)).toBe(5);
  });
});

describe('configuration validation', () => {
  it('accepts a valid configuration and derives the duration', () => {
    const result = validateBuildRequest(
      { difficulty: 'mixed', topicIds: ['fixture-widgets', 'fixture-gadgets'], questionCount: 10 },
      repo()
    );
    expect(result.questionCount).toBe(10);
    expect(result.durationSeconds).toBe(15 * 60);
  });

  it.each([[10, 900], [20, 1800], [30, 2700]])(
    'count %i maps to %i seconds — parity with DURATION_SECONDS_BY_COUNT',
    (count, seconds) => {
      const result = validateBuildRequest(
        { difficulty: 'mixed', topicIds: ['fixture-widgets', 'fixture-gadgets', 'fixture-gizmos', 'fixture-doohickeys'], questionCount: count },
        repo()
      );
      expect(result.durationSeconds).toBe(seconds);
    }
  );

  it('NORMALIZES difficulty casing at this one boundary', () => {
    const result = validateBuildRequest(
      { difficulty: '  MIXED  ', topicIds: ['fixture-widgets'], questionCount: 10 },
      repo()
    );
    expect(result.difficulty).toBe('mixed');
  });

  it.each([
    ['missing difficulty', { topicIds: ['fixture-widgets'], questionCount: 10 }],
    ['unsupported difficulty', { difficulty: 'expert', topicIds: ['fixture-widgets'], questionCount: 10 }],
    ['missing topics', { difficulty: 'mixed', questionCount: 10 }],
    ['empty topics', { difficulty: 'mixed', topicIds: [], questionCount: 10 }],
    ['non-string topic', { difficulty: 'mixed', topicIds: [7], questionCount: 10 }],
    ['duplicate topics', { difficulty: 'mixed', topicIds: ['fixture-widgets', 'fixture-widgets'], questionCount: 10 }],
    ['non-integer count', { difficulty: 'mixed', topicIds: ['fixture-widgets'], questionCount: 10.5 }],
    ['unsupported count', { difficulty: 'mixed', topicIds: ['fixture-widgets'], questionCount: 15 }],
    ['count too small', { difficulty: 'mixed', topicIds: ['fixture-widgets'], questionCount: 1 }],
    ['count too large', { difficulty: 'mixed', topicIds: ['fixture-widgets'], questionCount: 40 }]
  ])('rejects %s', (_label, request) => {
    expect(() => validateBuildRequest(request, repo())).toThrow(AssessmentBuildError);
  });

  it('REJECTS an unknown topic instead of silently ignoring it (Angular divergence)', () => {
    try {
      validateBuildRequest(
        { difficulty: 'mixed', topicIds: ['fixture-widgets', 'not-a-topic'], questionCount: 10 },
        repo()
      );
      throw new Error('expected failure');
    } catch (err) {
      expect((err as AssessmentBuildError).code).toBe('UNKNOWN_TOPIC');
    }
  });

  it('REJECTS a topic outside the requested difficulty (Angular divergence)', () => {
    const repository = repo();
    const advanced = repository.getQuizMetadata().find((q) => q.difficulty === 'advanced')!;
    try {
      validateBuildRequest(
        { difficulty: 'beginner', topicIds: [advanced.quizId], questionCount: 10 },
        repository
      );
      throw new Error('expected failure');
    } catch (err) {
      expect((err as AssessmentBuildError).code).toBe('TOPIC_DIFFICULTY_MISMATCH');
    }
  });

  it('allows any topic under "mixed"', () => {
    const repository = repo();
    const ids = repository.getQuizMetadata().slice(0, 4).map((q) => q.quizId);
    expect(() => validateBuildRequest(
      { difficulty: 'mixed', topicIds: ids, questionCount: 20 }, repository
    )).not.toThrow();
  });

  it('reports INSUFFICIENT_QUESTIONS with counts but no content', () => {
    try {
      // 'fixture-doohickeys' holds 6 questions; 20 cannot be satisfied.
      validateBuildRequest(
        { difficulty: 'mixed', topicIds: ['fixture-doohickeys'], questionCount: 20 }, repo()
      );
      throw new Error('expected failure');
    } catch (err) {
      const error = err as AssessmentBuildError;
      expect(error.code).toBe('INSUFFICIENT_QUESTIONS');
      expect(error.message).toMatch(/only 6 questions available for 20 requested/);
      expect(error.message).not.toMatch(/\?|correct|explanation/i);
    }
  });
});

describe('building an assessment', () => {
  it('returns exactly the requested number of questions', () => {
    const snapshot = buildInterviewAssessment(config(), repo(), seeded());
    expect(snapshot.questions).toHaveLength(20);
    expect(snapshot.durationSeconds).toBe(1800);
  });

  it('contains NO duplicate questions', () => {
    const snapshot = buildInterviewAssessment(config(), repo(), seeded());
    const ids = snapshot.questions.map((q) => q.questionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('draws only from the selected topics, balanced 7/7/6', () => {
    const snapshot = buildInterviewAssessment(config(), repo(), seeded());
    const counts = new Map<string, number>();
    for (const question of snapshot.questions) {
      counts.set(question.sourceQuizId, (counts.get(question.sourceQuizId) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(['fixture-gadgets', 'fixture-gizmos', 'fixture-widgets']);
    expect([...counts.values()].sort((a, b) => b - a)).toEqual([7, 7, 6]);
  });

  it('gives CONTIGUOUS question positions', () => {
    const snapshot = buildInterviewAssessment(config(), repo(), seeded());
    expect(snapshot.questions.map((q) => q.position)).toEqual([...Array(20).keys()]);
  });

  it('gives CONTIGUOUS option display orders while preserving option ids', () => {
    const repository = repo();
    const snapshot = buildInterviewAssessment(config(), repository, seeded());

    for (const question of snapshot.questions) {
      expect(question.options.map((o) => o.displayOrder))
        .toEqual([...Array(question.options.length).keys()]);

      // Option ids must match the SOURCE question's ids, order aside.
      const source = repository.getQuestionById(question.questionId)!;
      expect([...question.options.map((o) => o.optionId)].sort((a, b) => a - b))
        .toEqual([...source.options.map((o) => o.optionId)].sort((a, b) => a - b));
    }
  });

  it('is DETERMINISTIC under the same seed and differs under another', () => {
    const first = buildInterviewAssessment(config(), repo(), seededRandomSource(7));
    const second = buildInterviewAssessment(config(), repo(), seededRandomSource(7));
    const other = buildInterviewAssessment(config(), repo(), seededRandomSource(8));

    expect(first.questions.map((q) => q.questionId)).toEqual(second.questions.map((q) => q.questionId));
    expect(first.questions.map((q) => q.questionId)).not.toEqual(other.questions.map((q) => q.questionId));
  });

  it('shuffles option order — not every question keeps source order', () => {
    const repository = repo();
    const snapshot = buildInterviewAssessment(config(), repository, seededRandomSource(3));

    const reordered = snapshot.questions.filter((question) => {
      const source = repository.getQuestionById(question.questionId)!;
      return question.options.map((o) => o.optionId).join() !== source.options.map((o) => o.optionId).join();
    });
    expect(reordered.length).toBeGreaterThan(0);
  });

  it('carries the repository-derived question type', () => {
    const repository = repo();
    const snapshot = buildInterviewAssessment(config(), repository, seeded());
    for (const question of snapshot.questions) {
      expect(question.questionType).toBe(repository.getQuestionById(question.questionId)!.type);
    }
  });

  it('preserves multiple-answer and single-selection invariants after shuffling', () => {
    const snapshot = buildInterviewAssessment(config(), repo(), seeded());
    for (const question of snapshot.questions) {
      const correct = question.options.filter((o) => o.isCorrect).length;
      if (question.questionType === 'multiple') expect(correct).toBeGreaterThan(1);
      else expect(correct).toBe(1);
    }
  });

  it('handles a full 30-question build across many topics', () => {
    const repository = repo();
    const ids = repository.getQuizMetadata().slice(0, 6).map((q) => q.quizId);
    const validated = validateBuildRequest(
      { difficulty: 'mixed', topicIds: ids, questionCount: 30 }, repository
    );
    const snapshot = buildInterviewAssessment(validated, repository, seeded());
    expect(snapshot.questions).toHaveLength(30);
    expect(new Set(snapshot.questions.map((q) => q.questionId)).size).toBe(30);
  });

  it('handles a topic with FEWER questions than its share', () => {
    const repository = repo();
    // 'fixture-doohickeys' has 6; asking 20 across it + two larger topics forces redistribution.
    const validated = validateBuildRequest(
      { difficulty: 'mixed', topicIds: ['fixture-doohickeys', 'fixture-widgets', 'fixture-gadgets'], questionCount: 20 },
      repository
    );
    const snapshot = buildInterviewAssessment(validated, repository, seeded());
    expect(snapshot.questions).toHaveLength(20);
    expect(new Set(snapshot.questions.map((q) => q.questionId)).size).toBe(20);
  });
});

describe('"All of the above" handling', () => {
  it('normalizes like the Angular helper', () => {
    for (const text of [
      'All of the above', 'all of the above', 'ALL OF THE ABOVE',
      'All of the above.', 'All of the above!', 'All   of the   above',
      '  All of the above  ', '<b>All of the above</b>', 'All&nbsp;of the above'
    ]) {
      expect(isAllOfTheAbove(text)).toBe(true);
    }
    for (const text of ['All of the below', 'None of the above', '', null, undefined, 'above all']) {
      expect(isAllOfTheAbove(text)).toBe(false);
    }
  });

  function aotaRepo(optionTexts: string[], correctIndex = 0): QuizRepository {
    return createQuizRepository({
      source: {
        quizzes: [{
          quizId: 'aota', milestone: 'AOTA', summary: '', image: '', difficulty: 'beginner',
          questions: Array.from({ length: 10 }, (_unused, q) => ({
            questionText: `Question ${q}?`,
            explanation: 'Because.',
            options: optionTexts.map((text, i) =>
              i === correctIndex ? { text, correct: true } : { text }
            )
          }))
        }]
      }
    });
  }

  function buildAota(repository: QuizRepository, seed = 5) {
    const validated = validateBuildRequest(
      { difficulty: 'mixed', topicIds: ['aota'], questionCount: 10 }, repository
    );
    return buildInterviewAssessment(validated, repository, seededRandomSource(seed));
  }

  it.each([
    ['first', ['All of the above', 'B', 'C', 'D']],
    ['middle', ['A', 'B', 'All of the above', 'D']],
    ['already last', ['A', 'B', 'C', 'All of the above']],
    ['with punctuation', ['A', 'All of the above.', 'C', 'D']],
    ['with casing variation', ['A', 'ALL OF THE ABOVE', 'C', 'D']]
  ])('pins it last when it starts %s', (_label, texts) => {
    const snapshot = buildAota(aotaRepo(texts));
    for (const question of snapshot.questions) {
      const last = question.options[question.options.length - 1]!;
      expect(isAllOfTheAbove(last.optionText)).toBe(true);
    }
  });

  it('pins by TEXT, not correctness — a WRONG all-of-the-above is still last', () => {
    // correctIndex 1 ⇒ "All of the above" at index 0 is incorrect.
    const snapshot = buildAota(aotaRepo(['All of the above', 'B', 'C', 'D'], 1));
    for (const question of snapshot.questions) {
      const last = question.options[question.options.length - 1]!;
      expect(isAllOfTheAbove(last.optionText)).toBe(true);
      expect(last.isCorrect).toBe(false);
    }
  });

  it('works on a MULTIPLE-answer question', () => {
    const repository = createQuizRepository({
      source: {
        quizzes: [{
          quizId: 'aota', milestone: 'AOTA', summary: '', image: '',
          questions: Array.from({ length: 10 }, (_unused, q) => ({
            questionText: `Multi ${q}?`,
            explanation: 'Because.',
            options: [
              { text: 'A', correct: true }, { text: 'B', correct: true },
              { text: 'All of the above' }, { text: 'D' }
            ]
          }))
        }]
      }
    });
    const snapshot = buildAota(repository);
    for (const question of snapshot.questions) {
      expect(question.questionType).toBe('multiple');
      expect(isAllOfTheAbove(question.options[question.options.length - 1]!.optionText)).toBe(true);
    }
  });

  it('leaves ordering alone when NO option matches', () => {
    const snapshot = buildAota(aotaRepo(['A', 'B', 'C', 'D']));
    for (const question of snapshot.questions) {
      expect(question.options.map((o) => o.displayOrder))
        .toEqual([...Array(question.options.length).keys()]);
    }
  });
});

describe('source immutability', () => {
  it('mutating the generated snapshot does not touch the repository', () => {
    const repository = repo();
    const snapshot = buildInterviewAssessment(config(), repository, seeded());
    const target = snapshot.questions[0]!;
    const sourceBefore = repository.getQuestionById(target.questionId)!;
    const originalText = sourceBefore.questionText;
    const originalOrder = sourceBefore.options.map((o) => o.optionId);

    try {
      (target as { questionText: string }).questionText = 'TAMPERED';
      (target.options as unknown as { optionText: string }[])[0]!.optionText = 'TAMPERED';
    } catch { /* frozen inputs may throw */ }

    const sourceAfter = repository.getQuestionById(target.questionId)!;
    expect(sourceAfter.questionText).toBe(originalText);
    expect(sourceAfter.options.map((o) => o.optionId)).toEqual(originalOrder);
  });

  it('a SECOND build starts from original source order, not the first shuffle', () => {
    const repository = repo();
    const before = repository.getQuizById('fixture-widgets')!.questions.map((q) => q.questionId);

    buildInterviewAssessment(config(), repository, seededRandomSource(1));
    const afterFirst = repository.getQuizById('fixture-widgets')!.questions.map((q) => q.questionId);
    expect(afterFirst).toEqual(before);

    // Same seed ⇒ identical result, which can only hold if the source was not
    // permuted by the first build.
    const a = buildInterviewAssessment(config(), repository, seededRandomSource(11));
    const b = buildInterviewAssessment(config(), repository, seededRandomSource(11));
    expect(a.questions.map((q) => q.questionId)).toEqual(b.questions.map((q) => q.questionId));
    expect(repository.getQuizById('fixture-widgets')!.questions.map((q) => q.questionId)).toEqual(before);
  });

  it('option arrays in the repository keep their source order', () => {
    const repository = repo();
    const before = repository.getQuestionById('fixture-widgets:q:0')!.options.map((o) => o.optionId);
    buildInterviewAssessment(config(), repository, seeded());
    expect(repository.getQuestionById('fixture-widgets:q:0')!.options.map((o) => o.optionId)).toEqual(before);
  });
});

describe('identical wording across topics', () => {
  it('treats same-text questions in DIFFERENT quizzes as distinct', () => {
    // Deduplication is by questionId, never by normalized text — two topics may
    // legitimately ask the same thing, and both are eligible.
    // The SAME five wordings appear in BOTH quizzes. Duplicate text within one
    // quiz is rejected by Stage 2 validation (it would make the app's remaining
    // text-based lookups ambiguous); across quizzes it is legitimate.
    const SHARED_TEXTS = [
      'What is change detection?',
      'What is a signal?',
      'What is dependency injection?',
      'What is a pipe?',
      'What is a directive?'
    ];

    const repository = createQuizRepository({
      source: {
        quizzes: ['alpha', 'beta'].map((quizId) => ({
          quizId, milestone: quizId, summary: '', image: '',
          questions: SHARED_TEXTS.map((questionText) => ({
            questionText,
            explanation: 'Because.',
            options: [{ text: 'A', correct: true }, { text: 'B' }]
          }))
        }))
      }
    });

    const validated = validateBuildRequest(
      { difficulty: 'mixed', topicIds: ['alpha', 'beta'], questionCount: 10 }, repository
    );
    const snapshot = buildInterviewAssessment(validated, repository, seeded());

    expect(snapshot.questions).toHaveLength(10);
    // Ten DISTINCT ids drawn from only five distinct wordings: every wording
    // appears twice, once per topic, and both copies are kept.
    expect(new Set(snapshot.questions.map((q) => q.questionId)).size).toBe(10);
    expect(new Set(snapshot.questions.map((q) => q.questionText)).size).toBe(5);

    for (const text of SHARED_TEXTS) {
      const matches = snapshot.questions.filter((q) => q.questionText === text);
      expect(matches).toHaveLength(2);
      expect(new Set(matches.map((q) => q.sourceQuizId))).toEqual(new Set(['alpha', 'beta']));
    }
  });
});

describe('snapshot invariant gate', () => {
  const base = () => buildInterviewAssessment(config(), repo(), seeded());

  it('accepts a well-formed snapshot', () => {
    expect(() => assertSnapshotValid(base())).not.toThrow();
  });

  it.each([
    ['non-contiguous positions', (s: ReturnType<typeof base>) => {
      (s.questions[1] as { position: number }).position = 5;
    }],
    ['a duplicate question', (s: ReturnType<typeof base>) => {
      (s.questions[1] as { questionId: string }).questionId = s.questions[0]!.questionId;
    }],
    ['blank question text', (s: ReturnType<typeof base>) => {
      (s.questions[0] as { questionText: string }).questionText = '  ';
    }],
    ['a blank explanation', (s: ReturnType<typeof base>) => {
      (s.questions[0] as { explanation: string }).explanation = '';
    }],
    ['non-contiguous display order', (s: ReturnType<typeof base>) => {
      (s.questions[0]!.options[0] as { displayOrder: number }).displayOrder = 9;
    }],
    ['a wrong correct-count for single', (s: ReturnType<typeof base>) => {
      const single = s.questions.find((q) => q.questionType !== 'multiple')!;
      (single.options as unknown as { isCorrect: boolean }[]).forEach((o) => { o.isCorrect = true; });
    }]
  ])('REJECTS %s', (_label, corrupt) => {
    const snapshot = base();
    corrupt(snapshot);
    expect(() => assertSnapshotValid(snapshot)).toThrow(AssessmentBuildError);
  });

  it('rejection messages carry positions, never content', () => {
    const snapshot = base();
    (snapshot.questions[0] as { questionText: string }).questionText = '   ';
    try {
      assertSnapshotValid(snapshot);
      throw new Error('expected failure');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/question 0/);
      expect(message).not.toContain(snapshot.questions[1]!.questionText);
    }
  });
});
