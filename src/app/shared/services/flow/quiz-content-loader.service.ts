import { Service, inject } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuestionPayload } from '../../models/QuestionPayload.model';
import { Quiz } from '../../models/Quiz.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { SK_DOT_CONFIRMED } from '../../constants/session-keys';

import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { QclFetGateService } from './qcl-fet-gate.service';
import { QclQuestionFetchService } from './qcl-question-fetch.service';
import { QclSessionRestoreService } from './qcl-session-restore.service';
import { TopicQuizTypeRegistry } from '../api/topic-quiz-type-registry.service';
import { QuizService } from '../data/quiz.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';

import { bannerCorrectCount } from '../../utils/question-type-authority';
import { isOptionCorrect } from '../../utils/is-option-correct';
import { swallow } from '../../utils/error-logging';

/**
 * Result from fetchAndSetQuestionData preparation.
 */
export interface FetchQuestionResult {
  success: boolean;
  question: QuizQuestion | null;
  currentQuestion: QuizQuestion | null;
  trimmedText: string;
  clonedOptions: Option[];
  finalOptions: Option[];
  explanationText: string;
  isAnswered: boolean;
  questionPayload: QuestionPayload | null;
  shouldStartTimer: boolean;
}

/**
 * Result from loadQuestionByRouteIndex preparation.
 */
export interface RouteQuestionResult {
  success: boolean;
  question: QuizQuestion | null;
  questionText: string;
  optionsWithIds: Option[];
  questionIndex: number;
  totalCount: number;
}

/**
 * Result from syncQuestionSnapshotFromSession.
 */
export interface SessionSnapshotResult {
  isEmpty: boolean;
  normalizedIndex: number;
  question: QuizQuestion | null;
  trimmedQuestionText: string;
  normalizedOptions: Option[];
  trimmedExplanation: string;
}

/**
 * Result from updateQuestionStateAndExplanation.
 */
export interface QuestionStateResult {
  handled: boolean;
  explanationText: string;
  showExplanation: boolean;
  shouldLockExplanation: boolean;
  shouldDisableExplanation: boolean;
}

/**
 * Result from loadQuestionFromRouteChange.
 */
export interface RouteChangeQuestionResult {
  success: boolean;
  question: QuizQuestion | null;
  options: Option[];
  explanation: string;
  totalQuestions: number;
  hasValidSelections: boolean;
}

/**
 * Handles heavy data-fetching and preparation logic for quiz questions.
 * Delegates to 3 extracted sub-services; retains shared utilities inline.
 */
@Service()
export class QuizContentLoaderService {
  // ── injects ─────────────────────────────────────────────────────
  private explanationTextService = inject(ExplanationTextService);
  private fetGate = inject(QclFetGateService);
  private questionFetch = inject(QclQuestionFetchService);
  private quizService = inject(QuizService);
  private topicQuizTypeRegistry = inject(TopicQuizTypeRegistry);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private sessionRestore = inject(QclSessionRestoreService);

  // ── public methods ──────────────────────────────────────────────
  // ─── FET Gate (delegated) ───

  lockAndPurgeFet(adjustedIndex: number): void {
    this.fetGate.lockAndPurgeFet(adjustedIndex);
  }

  resetDisplayExplanationText(currentQuestionIndex: number): void {
    this.fetGate.resetDisplayExplanationText(currentQuestionIndex);
  }

  unlockFetGateAfterRender(
    adjustedIndex: number,
    getCurrentIndex: () => number,
    markForCheck: () => void
  ): void {
    this.fetGate.unlockFetGateAfterRender(adjustedIndex, getCurrentIndex, markForCheck);
  }

  prepareExplanationForQuestion(params: {
    qIdx: number;
    questionsArray: QuizQuestion[];
    quiz: any;
    currentQuestionIndex: number;
    currentQuestion: QuizQuestion | null;
  }): { explanationHtml: string; question: QuizQuestion | null } {
    return this.fetGate.prepareExplanationForQuestion(params);
  }

  async evaluateQuestionStateAndExplanation(params: {
    quizId: string;
    questionIndex: number;
  }): Promise<QuestionStateResult> {
    return this.fetGate.evaluateQuestionStateAndExplanation(params);
  }

  resetFetStateForInit(): void {
    this.fetGate.resetFetStateForInit();
  }

  seedFirstQuestionText(): void {
    this.fetGate.seedFirstQuestionText();
  }

  resolveExplanationChange(
    explanation: string | any,
    index: number | undefined,
    currentExplanation: string
  ): { text: string; index: number | undefined } | null {
    return this.fetGate.resolveExplanationChange(explanation, index, currentExplanation);
  }

  // ─── Question Fetch (delegated) ───

  async loadQuestionFromRouteChange(params: {
    quizId: string;
    index: number;
  }): Promise<RouteChangeQuestionResult> {
    return this.questionFetch.loadQuestionFromRouteChange(params);
  }

  async fetchAndPrepareQuestion(params: {
    questionIndex: number;
    totalQuestions: number;
    quizId: string;
  }): Promise<FetchQuestionResult> {
    return this.questionFetch.fetchAndPrepareQuestion(
      params,
      (idx) => this.sessionRestore.restoreSessionSelections(idx)
    );
  }

  async loadQuestionByRoute(params: {
    routeIndex: number;
    quiz: any;
    quizId: string;
    totalQuestions: number;
  }): Promise<RouteQuestionResult> {
    return this.questionFetch.loadQuestionByRoute(params);
  }

  async fetchQuestionFromAPI(
    quizId: string,
    questionIndex: number
  ): Promise<QuizQuestion | null> {
    return this.questionFetch.fetchQuestionFromAPI(quizId, questionIndex);
  }

  async loadQuizDataFromService(quizId: string): Promise<{
    quiz: Quiz;
    questions: QuizQuestion[];
  } | null> {
    return this.questionFetch.loadQuizDataFromService(quizId);
  }

  fetchAndSubscribeQuestionAndOptions(quizId: string, questionIndex: number): void {
    this.questionFetch.fetchAndSubscribeQuestionAndOptions(quizId, questionIndex);
  }

  // ─── Session Restore (delegated) ───

  syncQuestionSnapshot(params: {
    hydratedQuestions: QuizQuestion[];
    currentQuestionIndex: number;
    previousIndex: number | null;
    serviceCurrentIndex: number | undefined;
  }): SessionSnapshotResult {
    return this.sessionRestore.syncQuestionSnapshot(params);
  }

  restoreSelectionState(currentQuestionIndex: number): void {
    this.sessionRestore.restoreSelectionState(currentQuestionIndex);
  }

  restoreSelectedOptionsFromSession(optionsToDisplay: Option[]): void {
    this.sessionRestore.restoreSelectedOptionsFromSession(optionsToDisplay);
  }

  hydrateQuestionsFromSession(params: {
    questions: QuizQuestion[];
    quiz: Quiz | null;
    selectedQuiz: Quiz | null;
  }): {
    hydratedQuestions: QuizQuestion[];
    quizQuestions: QuizQuestion[] | null;
    selectedQuizQuestions: QuizQuestion[] | null;
  } {
    return this.sessionRestore.hydrateQuestionsFromSession(params);
  }

  async prepareQuizSession(params: {
    quizId: string;
    applyQuestionsFromSession: (questions: QuizQuestion[]) => void;
  }): Promise<void> {
    return this.sessionRestore.prepareQuizSession(params);
  }

  // ─── Remaining inline utilities ───

  clearAllOptionStates(): void {
    try {
      for (const q of this.quizService.questions ?? []) {
        for (const o of q.options ?? []) {
          o.selected = false;
          o.highlight = false;
          o.showFeedback = false;
          o.showIcon = false;
        }
      }
    } catch (err: unknown) { swallow('quiz-content-loader.service.ts', err); }
  }

  enableAllOptionPointerEvents(): void {
    for (const btn of Array.from(
      document.querySelectorAll('.option-button,.mat-radio-button,.mat-checkbox')
    )) {
      (btn as HTMLElement).style.pointerEvents = 'auto';
    }
  }

  handleQuestionIndexTransition(params: {
    idx: number;
    prevIdx: number | null;
    quizId: string;
    questionsArray: QuizQuestion[];
  }): { question: QuizQuestion | null; isNavigation: boolean } {
    const { idx, prevIdx, quizId } = params;
    const ets = this.explanationTextService;

    if (prevIdx !== null && prevIdx !== idx) {
      if (ets.latestExplanationIndex === prevIdx) {
        ets.latestExplanation = '';
        ets.latestExplanationIndex = null;
        ets.formattedExplanationSig.set('');
        ets.shouldDisplayExplanationSig.set(false);
        ets.setIsExplanationTextDisplayed(false);
      }
    }

    const qState =
      quizId && Number.isFinite(idx)
        ? this.quizStateService.getQuestionState?.(quizId, idx)
        : null;
    if (qState) {
      qState.explanationDisplayed = false;
      qState.explanationText = '';
    }

    ets._activeIndex = idx;
    ets.latestExplanationIndex = idx;
    ets._fetLocked = false;

    const question = this.quizService.questions?.[idx]
      ?? params.questionsArray[idx] ?? null;
    if (question) {
      this.quizStateService.updateCurrentQuestion(question);
      this.quizService.updateCurrentQuestion(question);
    }

    const isNavigation = prevIdx !== null && prevIdx !== idx;
    if (isNavigation) {
      this.quizStateService.setDisplayState({
        mode: 'question',
        answered: false
      });
    }

    return { question, isNavigation };
  }

  emitCorrectAnswersBanner(index: number, getNumberOfCorrectAnswersText: (numCorrect: number, totalOpts: number) => string): void {
    const fresh = this.quizService.questions?.[index];
    if (!fresh || !Array.isArray(fresh.options)) return;

    const isMulti =
      fresh.type === QuestionType.MultipleAnswer ||
      fresh.options.filter((o: Option) => isOptionCorrect(o)).length > 1;
    (fresh as any).isMulti = isMulti;

    // THE COUNT IS DECLARED, NOT TALLIED. Counting the local `correct` flags
    // here made the banner an answer-key read. `GET /questions` declares it;
    // null means nobody has, and the banner is then omitted rather than guessed.
    const bannerCount = bannerCorrectCount(isMulti, this.topicQuizTypeRegistry, fresh.questionText);
    const totalOpts = fresh.options.length;
    const banner = bannerCount !== null
      ? getNumberOfCorrectAnswersText(bannerCount, totalOpts)
      : '';

    this.quizService.updateCorrectAnswersText(banner);
  }

  snapshotLeavingQuestion(params: {
    leavingIdx: number;
    leavingDotClass: string;
    quizId: string;
    getScoringKey: (idx: number) => number;
  }): void {
    const { leavingIdx, leavingDotClass, quizId } = params;
    const leavingStatus: 'correct' | 'wrong' | null =
      leavingDotClass.includes('correct') ? 'correct' :
      leavingDotClass.includes('wrong') ? 'wrong' : null;

    if (leavingStatus) {
      // NOTE: the score is credited ONLY on the completing click (option-ui-sync
      // checkAndScoreMultiAnswer, which now folds in the cross-visit uiSelectedTexts
      // so revisit-completion credits on the click as well). We deliberately do NOT
      // credit the score here on navigation — crediting on leave made the score tick
      // up "between questions", which is not wanted. Only the display dot status
      // below is persisted on leave.
      try {
        const key = `dot_status_${quizId}_${leavingIdx}`;
        localStorage.setItem(key, leavingStatus);
      } catch (err: unknown) { swallow('quiz-content-loader.service.ts', err); }
      this.selectedOptionService.clickConfirmedDotStatus.set(leavingIdx, leavingStatus);
      try { 
        sessionStorage.setItem(SK_DOT_CONFIRMED + leavingIdx, leavingStatus);
      } catch (err: unknown) { swallow('quiz-content-loader.service.ts', err); }
    }
  }

  createNormalizedQuestionPayload$(): Observable<QuestionPayload> {
    const fallbackQuestion: QuizQuestion = {
      questionText: 'No question available',
      type: QuestionType.SingleAnswer,
      explanation: '',
      options: []
    };

    const fallbackPayload: QuestionPayload = {
      question: fallbackQuestion,
      options: [],
      explanation: ''
    };

    return this.quizService.questionPayload$.pipe(
      map((payload) => {
        const baseQuestion = payload?.question ?? fallbackQuestion;
        const safeOptions = Array.isArray(payload?.options)
          ? payload.options.map((option: Option) => ({
            ...option,
            correct: option.correct ?? false
          }))
          : [];

        const explanation = (
          payload?.explanation ??
          baseQuestion.explanation ??
          ''
        ).trim();

        const normalizedQuestion: QuizQuestion = {
          ...baseQuestion,
          options: safeOptions,
          explanation
        };

        return {
          question: normalizedQuestion,
          options: safeOptions,
          explanation
        } as QuestionPayload;
      }),
      catchError(() => {
        return of(fallbackPayload);
      })
    );
  }

  processSelectedAnswer(params: {
    optionIndex: number;
    question: QuizQuestion | null;
    optionsToDisplay: Option[];
    currentQuestionIndex: number;
    answers: Option[];
  }): {
    option: Option | null;
    answers: Option[];
    answerIds: number[];
  } {
    const option =
      params.question?.options?.[params.optionIndex] ?? params.optionsToDisplay?.[params.optionIndex];
    if (!option) return { option: null, answers: params.answers, answerIds: [] };

    const correctAnswers = params.question?.options.filter((opt: Option) => opt.correct) ?? [];
    let answers = [...params.answers];

    if (correctAnswers.length > 1) {
      if (!answers.includes(option)) {
        answers.push(option);
      }
    } else {
      answers = [option];
    }

    const answerIds = answers
      .map((ans: Option) => ans.optionId)
      .filter((id): id is number => typeof id === 'number');
    this.quizService.answers = [...answers];
    this.quizService.updateUserAnswer(params.currentQuestionIndex, answerIds);
    void this.quizService.checkIfAnsweredCorrectly(params.currentQuestionIndex, false);

    return { option, answers, answerIds };
  }

  initializeFetForQuizData(quizData: Quiz): void {
    const isShuffled = this.quizService.isShuffleEnabled();

    this.quizService.setSelectedQuiz(quizData);

    if (!isShuffled) {
      this.explanationTextService.initializeExplanationTexts(
        (quizData.questions ?? []).map((q: QuizQuestion) => q.explanation)
      );
    }
  }

  initializeFetForShuffledQuiz(): void {
    if (!this.quizService.isShuffleEnabled()) return;

    const shuffledQuestions = this.quizService.questions ?? [];
    if (shuffledQuestions.length > 0) {
      this.explanationTextService.initializeExplanationTexts(
        shuffledQuestions.map((q: QuizQuestion) => q.explanation)
      );
    }
  }
}