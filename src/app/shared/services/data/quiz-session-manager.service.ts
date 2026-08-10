import { inject, Service, WritableSignal } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

import { QuizStatus } from '../../models/quiz-status.enum';

import { Option } from '../../models/Option.model';
import { Quiz } from '../../models/Quiz.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { SelectedOption } from '../../models/SelectedOption.model';

import { SK_DOT_CONFIRMED, SK_DISPLAY_MODE, SK_MULTI_PERFECT, SK_SAVED_QUESTION_INDEX, SK_SEL_Q, SK_SELECTED_OPTIONS_MAP, SK_SHUFFLED_QUESTIONS, SK_SHUFFLED_QUESTIONS_QUIZ_ID, SK_USER_ANSWERS } from '../../constants/session-keys';

import { QuizOptionsService } from './quiz-options.service';
import { QuizQuestionResolverService } from './quiz-question-resolver.service';
import { QuizScoringService } from './quiz-scoring.service';
import { swallow } from '../../utils/error-logging';

/**
 * Interface describing the QuizService state that the session manager
 * needs to read and mutate. Keeps the dependency loosely coupled.
 */
export interface QuizSessionState {
  quizId: string;
  currentQuestionIndex: number;
  quizCompleted: boolean;
  multipleAnswer: boolean;
  activeQuiz: Quiz | null;
  selectedQuiz: Quiz | null;
  quizData: Quiz[] | null;
  quizInitialState: Quiz[];
  shuffledQuestions: QuizQuestion[];
  answers: Option[];
  correctAnswers: Map<string, number[]>;
  userAnswers: any[];
  selectedOptionsMap: Map<number, SelectedOption[]>;
  correctCount: number;
  totalQuestions: WritableSignal<number>;

  // Subjects that need to be emitted to
  currentQuestionSig: WritableSignal<QuizQuestion | null>;
  currentQuestionIndexSig: WritableSignal<number>;
  currentQuestionIndexSubject: BehaviorSubject<number>;
  nextQuestionSig: WritableSignal<QuizQuestion | null>;
  nextOptionsSig: WritableSignal<Option[]>;
  currentOptionsSig: WritableSignal<Option[]>;
  optionsSource: Subject<Option[]>;
  questionPayloadSig: WritableSignal<any>;
  badgeTextSig: WritableSignal<string>;

  // Methods that need to be called
  get questions(): QuizQuestion[];
  set questions(val: QuizQuestion[]);
  get questionCorrectness(): Map<number, boolean>;
  set questionCorrectness(val: Map<number, boolean>);
  emitQuestionAndOptions(q: QuizQuestion, opts: Option[], idx?: number): void;
  updateCurrentQuestion(q: QuizQuestion): void;
  resetAll(): void;
  resetScore(): void;
  setQuizStatus(val: QuizStatus): void;
  setCurrentQuestionIndex(idx: number): void;
  isShuffleEnabled(): boolean;
}

/**
 * Manages quiz session lifecycle: applying session questions, handling
 * question transitions, and resetting state. Extracted from QuizService
 * to reduce its size.
 */
@Service()
export class QuizSessionManagerService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly optionsService = inject(QuizOptionsService);
  private readonly questionResolver = inject(QuizQuestionResolverService);
  private readonly scoringService = inject(QuizScoringService);

  /** Remove per-question sessionStorage keys (sel_Q*, displayMode_*, multi_perfect_*, dot_confirmed_*). */
  private clearPerQuestionSessionKeys(): void {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(SK_SEL_Q) || key?.startsWith(SK_DISPLAY_MODE) || key?.startsWith(SK_MULTI_PERFECT) || key?.startsWith(SK_DOT_CONFIRMED)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        sessionStorage.removeItem(key);
      }
    } catch (err: unknown) { swallow('quiz-session-manager.service.ts', err); /* ignore */ }
  }

  /**
   * Applies a set of session questions (typically shuffled) to the quiz state.
   * Sets up questions, indices, quiz data, and emits to all reactive subjects.
   */
  applySessionQuestions(
    state: QuizSessionState,
    quizId: string,
    questions: QuizQuestion[],
    questionsSig: WritableSignal<QuizQuestion[]>,
    quizResetSource: Subject<void>
  ): string | null {
    if (!quizId) return null;

    // Guard: Skip if questions already applied for this quiz
    if (
      state.shuffledQuestions &&
      state.shuffledQuestions.length > 0 &&
      state.quizId === quizId
    ) return null;

    // Set quizId first to enable guard for subsequent calls
    state.quizId = quizId;

    try {
      quizResetSource.next();
    } catch (err: unknown) {
      console.error('QuizSessionManagerService.applySessionQuestions quizReset emission failed:', err);
    }

    if (!Array.isArray(questions) || questions.length === 0) return null;

    const sanitizedQuestions = questions
      .map((question) => this.questionResolver.cloneQuestionForSession(question))
      .filter((question): question is QuizQuestion => !!question);

    if (sanitizedQuestions.length === 0) return null;

    state.shuffledQuestions = sanitizedQuestions;
    this.persistShuffledQuestions(state);
    state.questions = sanitizedQuestions;
    questionsSig.set(sanitizedQuestions);

    this.applyCurrentQuestionState(state, sanitizedQuestions);
    this.updateQuizDataForSession(state, quizId, sanitizedQuestions);

    questionsSig.set(sanitizedQuestions);

    return quizId;
  }

  private persistShuffledQuestions(state: QuizSessionState): void {
    try {
      localStorage.setItem(SK_SHUFFLED_QUESTIONS, JSON.stringify(state.shuffledQuestions));
      localStorage.setItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID, String(state.quizId ?? ''));
    } catch (err: unknown) {
      console.error('QuizSessionManagerService.applySessionQuestions shuffled questions persist failed:', err);
    }
  }

  // Bound the current index, publish it + the current question/options to the
  // reactive subjects (emit when options exist, else stage on the next* sigs).
  private applyCurrentQuestionState(
    state: QuizSessionState,
    sanitizedQuestions: QuizQuestion[]
  ): void {
    state.totalQuestions.set(sanitizedQuestions.length);

    const boundedIndex = Math.min(
      Math.max(state.currentQuestionIndex ?? 0, 0),
      sanitizedQuestions.length - 1
    );
    state.currentQuestionIndex = Number.isFinite(boundedIndex)
      ? boundedIndex : 0;

    state.currentQuestionIndexSig.set(state.currentQuestionIndex);
    state.currentQuestionIndexSubject.next(state.currentQuestionIndex);

    const currentQuestion =
      sanitizedQuestions[state.currentQuestionIndex] ?? null;
    state.currentQuestionSig.set(currentQuestion);

    const normalizedOptions = Array.isArray(currentQuestion?.options)
      ? [...currentQuestion.options] : [];

    if (currentQuestion) currentQuestion.options = normalizedOptions;

    if (currentQuestion && normalizedOptions.length > 0) {
      state.emitQuestionAndOptions(
        currentQuestion,
        normalizedOptions,
        state.currentQuestionIndex
      );
    } else {
      state.nextQuestionSig.set(currentQuestion);
      state.nextOptionsSig.set(normalizedOptions);
    }
  }

  // Compute correct answers and upsert this quiz into quizData / active /
  // selected with the sanitized questions.
  private updateQuizDataForSession(
    state: QuizSessionState,
    quizId: string,
    sanitizedQuestions: QuizQuestion[]
  ): void {
    const correctAnswersMap = this.optionsService.calculateCorrectAnswers(sanitizedQuestions);
    state.correctAnswers = correctAnswersMap;

    if (!Array.isArray(state.quizData)) state.quizData = [];

    const baseQuiz =
      state.quizData.find((quiz) => quiz.quizId === quizId) ||
      (Array.isArray(state.quizInitialState)
        ? state.quizInitialState.find((quiz) => quiz.quizId === quizId)
        : undefined) ||
      state.activeQuiz ||
      state.selectedQuiz ||
      ({ quizId } as Quiz);

    const updatedQuiz: Quiz = {
      ...baseQuiz,
      quizId,
      questions: sanitizedQuestions
    };

    const quizIndex = state.quizData.findIndex((quiz) => quiz.quizId === quizId);
    if (quizIndex >= 0) {
      state.quizData[quizIndex] = updatedQuiz;
    } else {
      state.quizData.push(updatedQuiz);
    }

    if (state.activeQuiz?.quizId === quizId || !state.activeQuiz) {
      state.activeQuiz = updatedQuiz;
    }

    if (state.selectedQuiz?.quizId === quizId || !state.selectedQuiz) {
      state.selectedQuiz = updatedQuiz;
    }
  }

  /**
   * Resets all quiz session state for starting a new run.
   * Clears in-memory flags and removes stored resume/index/session leftovers.
   */
  resetQuizSessionForNewRun(state: QuizSessionState, quizId: string): void {
    state.quizCompleted = false;
    state.currentQuestionIndex = 0;
    state.setQuizStatus(QuizStatus.STARTED);

    // CRITICAL: Reset the score to 0 for the new quiz run
    state.resetScore();

    // Remove any stored resume/index/session leftovers
    try {
      localStorage.removeItem('currentQuestionIndex');
      localStorage.removeItem(SK_SAVED_QUESTION_INDEX);
      localStorage.removeItem(SK_USER_ANSWERS);
      localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      localStorage.removeItem('answeredMap');
      localStorage.removeItem('currentQuestionType');

      // If you store per-quiz keys, also remove those patterns:
      localStorage.removeItem(`quizState_${quizId}`);
      localStorage.removeItem(`quizResumeIndex_${quizId}`);
    } catch (err: unknown) { swallow('quiz-session-manager.service.ts', err); }

    this.clearPerQuestionSessionKeys();
  }

  /**
   * Full session state reset: clears indices, subjects, scoring, and persistence.
   */
  resetQuizSessionState(state: QuizSessionState, quizResetSource: Subject<void>): void {
    state.resetScore();
    state.currentQuestionIndex = 0;
    state.currentQuestionIndexSig.set(0);
    state.currentQuestionIndexSubject.next(0);

    try {
      localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
      localStorage.removeItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID);
      localStorage.removeItem('selectedOptions');
    } catch (err: unknown) { swallow('quiz-session-manager.service.ts', err); }

    this.clearPerQuestionSessionKeys();

    // Clear shuffled questions to prevent stale data when switching quizzes
    state.shuffledQuestions = [];
    // Also clear regular questions for unshuffled mode
    state.questions = [];

    state.currentQuestionSig.set(null);
    state.nextQuestionSig.set(null);
    state.nextOptionsSig.set([]);
    state.currentOptionsSig.set([]);
    state.optionsSource.next([]);
    state.questionPayloadSig.set(null);
    this.scoringService.correctAnswersCountSig.set(0);
    state.userAnswers = [];
    try { localStorage.removeItem(SK_USER_ANSWERS); } catch (err: unknown) { swallow('quiz-session-manager.service.ts', err); }
    state.badgeTextSig.set('');
    state.resetScore();
    quizResetSource.next();
    state.questionCorrectness.clear();
  }

  /**
   * Wipes every per-run accumulator on the host quiz state and emits the
   * reset-source signal. The host (QuizService) handles the few internals
   * that aren't on QuizSessionState (dataLoader fetch promise,
   * questionsQuizId, the per-question answer-state maps).
   */
  resetAll(state: QuizSessionState, quizResetSource: Subject<void>): void {
    state.currentQuestionIndex = 0;
    state.questionCorrectness.clear();
    state.selectedOptionsMap.clear();
    state.userAnswers = [];
    state.answers = [];
    state.shuffledQuestions = [];
    state.questions = [];
    state.quizCompleted = false;

    try {
      localStorage.removeItem(SK_USER_ANSWERS);
      localStorage.removeItem('questionCorrectness');
      localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
      localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      localStorage.removeItem('highScore');
    } catch (err: unknown) { swallow('quiz-session-manager.service.ts', err); /* ignore */ }

    this.clearPerQuestionSessionKeys();

    quizResetSource.next();
  }

  /**
   * Restores the question array for the active quiz from quizInitialState
   * and rewinds to question index 0. Used when restarting an in-progress
   * quiz without leaving the route.
   */
  resetQuestions(state: QuizSessionState): void {
    const currentQuizData = state.quizInitialState.find(
      (quiz) => quiz.quizId === state.quizId
    );
    if (currentQuizData) {
      state.quizData = structuredClone([currentQuizData]);
      state.questions = currentQuizData.questions ?? [];
    } else {
      state.quizData = null;
      state.questions = [];
    }
    state.setCurrentQuestionIndex(0);
  }
}