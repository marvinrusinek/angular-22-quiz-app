/**
 * Unit coverage for QuizService's deterministic, dependency-light surface
 * (added 2026-06-27 per the CODE_REVIEW roadmap — a top-LOC service whose
 * existing specs cover display-order, pristine helpers, resolve-active-index,
 * load-bearing fields, and sync-BS invariants, but not the plain state/query
 * methods below). Scope here: active-quiz + quiz-id state, status hard-lock,
 * answered query, answer accumulation, selection params, shuffle flag, the
 * correct-answers string, and the userAnswers writer. The async scoring/
 * evaluation/data-loading paths (which delegate to sub-services) are isolated
 * via spies and otherwise left to their own specs + the e2e net.
 */
// jsdom lacks structuredClone in some versions; QuizService field initializers
// call it at import time, so polyfill before importing the service.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: any) => JSON.parse(JSON.stringify(v));
}

import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { Option, Quiz, QuizStatus } from '@shared/models';


import { SK_USER_ANSWERS } from '@shared/constants/session-keys';

import { QuizService } from './quiz.service';

describe('QuizService core state + query methods', () => {
  let service: QuizService;

  const quiz = (id: string, n: number): Quiz => ({
    quizId: id,
    questions: Array.from({ length: n }, (_, i) => ({ questionText: `Q${i + 1}` }))
  } as Quiz);

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    service = TestBed.inject(QuizService);
    jest.spyOn(service, 'isShuffleEnabled').mockReturnValue(false);
  });

  // ── active quiz / quiz id ───────────────────────────────────────
  describe('active quiz + quiz id', () => {
    it('setActiveQuiz populates id, questions and totalQuestions', () => {
      const q = quiz('typescript', 3);
      service.setActiveQuiz(q);

      expect(service.getActiveQuiz()).toBe(q);
      expect(service.getCurrentQuizId()).toBe('typescript');
      expect(service.questions.length).toBe(3);
      expect(service.totalQuestions()).toBe(3);
    });

    it('setQuizId clears stale questions when the id actually changes', () => {
      service.setActiveQuiz(quiz('typescript', 3));
      service.setQuizId('angular');

      expect(service.getCurrentQuizId()).toBe('angular');
      expect(service.questions.length).toBe(0);
    });

    it('setQuizId keeps questions when the id is unchanged', () => {
      service.setActiveQuiz(quiz('typescript', 2));
      service.setQuizId('typescript');

      expect(service.questions.length).toBe(2);
    });
  });

  // ── quiz status hard-lock ───────────────────────────────────────
  describe('setQuizStatus', () => {
    it('updates status normally', () => {
      service.setQuizStatus(QuizStatus.STARTED);
      expect(service.status).toBe(QuizStatus.STARTED);
    });

    it('refuses to revert a completed quiz back to CONTINUE', () => {
      service.quizCompleted = true;
      service.setQuizStatus(QuizStatus.COMPLETED);
      service.setQuizStatus(QuizStatus.CONTINUE);
      expect(service.status).toBe(QuizStatus.COMPLETED);
    });
  });

  // ── isAnswered ──────────────────────────────────────────────────
  describe('isAnswered', () => {
    it('emits true when the question has selections, false otherwise', (done) => {
      service.selectedOptionsMap.set(0, [{ optionId: 1 } as any]);
      service.isAnswered(0).subscribe((a) => {
        expect(a).toBe(true);
        service.isAnswered(1).subscribe((b) => {
          expect(b).toBe(false);
          done();
        });
      });
    });
  });

  // ── updateAnswersForOption ──────────────────────────────────────
  describe('updateAnswersForOption', () => {
    beforeEach(() => {
      service.answers = [];
      service.userAnswers = [];
      service.currentQuestionIndex = 0;
    });

    it('accumulates distinct options and mirrors ids into userAnswers', () => {
      service.updateAnswersForOption({ optionId: 5 } as Option);
      service.updateAnswersForOption({ optionId: 7 } as Option);

      expect(service.answers.map(a => a.optionId)).toEqual([5, 7]);
      expect(service.userAnswers[0]).toEqual([5, 7]);
    });

    it('does not duplicate an already-selected option', () => {
      service.updateAnswersForOption({ optionId: 5 } as Option);
      service.updateAnswersForOption({ optionId: 5 } as Option);

      expect(service.answers.length).toBe(1);
      expect(service.userAnswers[0]).toEqual([5]);
    });

    it('omits options without an id from the userAnswers id list', () => {
      service.updateAnswersForOption({ optionId: 5 } as Option);
      service.updateAnswersForOption({ text: 'no id' } as Option);

      expect(service.userAnswers[0]).toEqual([5]);
    });
  });

  // ── returnQuizSelectionParams ───────────────────────────────────
  describe('returnQuizSelectionParams', () => {
    it('snapshots the current selection fields', () => {
      service.startedQuizId = 'a';
      service.continueQuizId = 'b';
      service.completedQuizId = 'c';
      service.quizCompleted = true;
      service.status = QuizStatus.COMPLETED;

      expect(service.returnQuizSelectionParams()).toEqual({
        startedQuizId: 'a',
        continueQuizId: 'b',
        completedQuizId: 'c',
        quizCompleted: true,
        status: QuizStatus.COMPLETED
      });
    });
  });

  // ── shuffle flag ────────────────────────────────────────────────
  describe('shuffle flag', () => {
    it('setCheckedShuffle toggles the flag and persists it', () => {
      (service.isShuffleEnabled as jest.Mock).mockRestore();

      service.setCheckedShuffle(true);
      expect(service.isShuffleEnabled()).toBe(true);
      expect(localStorage.getItem('checkedShuffle')).toBe('true');

      service.setCheckedShuffle(false);
      expect(service.isShuffleEnabled()).toBe(false);
      expect(localStorage.getItem('checkedShuffle')).toBe('false');
    });
  });

  // ── getCorrectAnswersAsString ───────────────────────────────────
  describe('getCorrectAnswersAsString', () => {
    it('joins answer ids with commas within a question and semicolons between', () => {
      service.correctAnswers = new Map<string, number[]>([
        ['q1', [1, 2]],
        ['q2', [3]]
      ]);
      expect(service.getCorrectAnswersAsString()).toBe('1,2;3');
    });

    it('returns an empty string when there are no correct answers', () => {
      service.correctAnswers = new Map();
      expect(service.getCorrectAnswersAsString()).toBe('');
    });
  });

  // ── updateUserAnswer ────────────────────────────────────────────
  describe('updateUserAnswer', () => {
    it('writes the answer ids to userAnswers + localStorage and re-checks correctness', () => {
      service.userAnswers = [];
      const checkSpy = jest.spyOn(service, 'checkIfAnsweredCorrectly').mockResolvedValue(true);
      jest.spyOn(service.answerEvaluation, 'resolveAnswerOptions').mockReturnValue([]);

      service.updateUserAnswer(2, [9]);

      expect(service.userAnswers[2]).toEqual([9]);
      expect(JSON.parse(localStorage.getItem(SK_USER_ANSWERS) ?? '[]')[2]).toEqual([9]);
      expect(checkSpy).toHaveBeenCalledWith(2, false);
    });
  });
});
