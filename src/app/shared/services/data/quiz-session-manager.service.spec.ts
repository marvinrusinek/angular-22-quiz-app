import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuizSessionManagerService, QuizSessionState } from './quiz-session-manager.service';
import { QuizDataLoaderService } from './quiz-data-loader.service';
import { QuizQuestion } from '../../models/QuizQuestion.model';

/**
 * RESTART MUST NOT DEPEND ON THE PRISTINE BANK (pre-S5a).
 *
 * `resetQuestions()` used to rebuild the restarted question list from
 * `state.quizInitialState` — the bundled `quiz.json` answer-key snapshot.
 * Under a true S5a cutover that array is never populated, so Restart Quiz
 * would silently produce zero questions.
 *
 * The fix sources content from `QuizDataLoaderService.getCanonicalQuestions`,
 * the same content-only `/questions` API cache already populated by the time
 * a player reaches Results. These tests would FAIL against the old
 * `state.quizInitialState.find(...)` implementation whenever
 * `quizInitialState` is empty, because the canonical cache is the only
 * remaining source of the questions.
 */

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

let service: QuizSessionManagerService;
let dataLoader: QuizDataLoaderService;

const CANONICAL_QUESTIONS: QuizQuestion[] = [
  { questionText: 'Q1', options: [{ text: 'A' }, { text: 'B' }] as any },
  { questionText: 'Q2', options: [{ text: 'C' }, { text: 'D' }] as any }
];

function makeState(overrides: Partial<QuizSessionState> = {}): QuizSessionState {
  const setCurrentQuestionIndex = jest.fn();
  return {
    quizId: 'dependency-injection',
    quizInitialState: [],
    quizData: null,
    activeQuiz: null,
    selectedQuiz: null,
    questions: [{ questionText: 'stale', options: [] }] as any,
    setCurrentQuestionIndex,
    ...overrides
  } as unknown as QuizSessionState;
}

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });
  service = TestBed.inject(QuizSessionManagerService);
  dataLoader = TestBed.inject(QuizDataLoaderService);
});

describe('resetQuestions — content sourced from the canonical API cache, not quizInitialState', () => {
  it('rebuilds the question list from the canonical cache when quizInitialState is empty', () => {
    dataLoader.setCanonicalQuestions(
      'dependency-injection',
      CANONICAL_QUESTIONS,
      (q) => structuredClone(q),
      (t) => (t ?? '').trim().toLowerCase()
    );

    const state = makeState();
    service.resetQuestions(state);

    expect(state.questions.length).toBe(2);
    expect(state.questions[0].questionText).toBe('Q1');
    expect(state.setCurrentQuestionIndex).toHaveBeenCalledWith(0);
  });

  it('does not read quizInitialState even when it is populated with different content', () => {
    dataLoader.setCanonicalQuestions(
      'dependency-injection',
      CANONICAL_QUESTIONS,
      (q) => structuredClone(q),
      (t) => (t ?? '').trim().toLowerCase()
    );

    const state = makeState({
      quizInitialState: [{
        quizId: 'dependency-injection',
        milestone: '', summary: '', image: '',
        questions: [{ questionText: 'FROM PRISTINE BANK', options: [] }]
      } as any]
    });
    service.resetQuestions(state);

    expect(state.questions.map((q) => q.questionText)).not.toContain('FROM PRISTINE BANK');
    expect(state.questions[0].questionText).toBe('Q1');
  });

  it('produces zero questions gracefully (no crash) when the canonical cache has nothing for this quiz', () => {
    const state = makeState({ quizId: 'never-loaded-quiz' });
    service.resetQuestions(state);

    expect(state.questions).toEqual([]);
    expect(state.quizData).toBeNull();
  });

  it('carries known quiz metadata from activeQuiz rather than inventing it', () => {
    dataLoader.setCanonicalQuestions(
      'dependency-injection',
      CANONICAL_QUESTIONS,
      (q) => structuredClone(q),
      (t) => (t ?? '').trim().toLowerCase()
    );

    const state = makeState({
      activeQuiz: {
        quizId: 'dependency-injection', milestone: 'DI', summary: 'Dependency Injection', image: 'di.png'
      } as any
    });
    service.resetQuestions(state);

    expect(state.quizData?.[0]?.summary).toBe('Dependency Injection');
    expect(state.quizData?.[0]?.questions?.length).toBe(2);
  });
});
