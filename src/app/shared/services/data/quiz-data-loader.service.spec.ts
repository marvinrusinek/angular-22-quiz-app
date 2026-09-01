import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuizDataLoaderService } from './quiz-data-loader.service';
import { setQuizDataCache } from '../../quiz-data-cache';

/**
 * S5a CUTOVER: NO PRISTINE CLIENT ANSWER BANK IS LOADED.
 *
 * `quizInitialState` used to be populated from `getQuizData()` — a deep clone
 * of the bundled `quiz.json` answer key — both at construction and again on
 * every `initializeData()` call. Correctness now comes exclusively from the
 * backend-authorized `/check` verdict, so nothing in this app should ever
 * populate `quizInitialState` again.
 *
 * These tests seed the quiz-data cache with real content (the same module
 * `getQuizData()` reads from) specifically to prove the negative: even when
 * the bank genuinely has data available, `quizInitialState` does not pick it
 * up. Against the pre-S5a implementation
 * (`quizInitialState: Quiz[] = structuredClone(getQuizData())`), these tests
 * would FAIL — `quizInitialState` would come back non-empty.
 */

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

const SEEDED_QUIZ = {
  quizId: 'seeded-quiz',
  milestone: 'Seeded',
  summary: 'Seeded quiz for the S5a cutover test',
  image: '',
  questions: [{
    questionText: 'Seeded question',
    options: [{ text: 'A', correct: true }, { text: 'B', correct: false }]
  }]
};

let service: QuizDataLoaderService;

beforeEach(() => {
  setQuizDataCache([SEEDED_QUIZ as any], []);

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });
  service = TestBed.inject(QuizDataLoaderService);
});

afterEach(() => {
  setQuizDataCache([], []);
});

describe('QuizDataLoaderService — quizInitialState stays empty (S5a permanent cutover)', () => {
  it('starts empty at construction even though the quiz-data cache has real content', () => {
    expect(service.quizInitialState).toEqual([]);
  });

  it('stays empty after initializeData(), which used to repopulate it from getQuizData()', () => {
    service.initializeData('seeded-quiz');

    expect(service.quizInitialState).toEqual([]);
  });

  // S6p: the `quizData` field this block used to also assert on (a bank-clone
  // "catalog/content listing" kept deliberately separate from
  // quizInitialState) has been removed entirely — a full inventory found zero
  // production readers of it (initializeData() never used its content beyond
  // .length, and its only two consumers, getCurrentQuiz()/findQuizByQuizId(),
  // had zero callers anywhere). See Stage 14 S6p for the full trace.
});
