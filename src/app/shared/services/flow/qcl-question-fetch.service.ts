import { Service, inject } from '@angular/core';
import { firstValueFrom, Observable, of } from 'rxjs';
import { catchError, map, take } from 'rxjs/operators';

import { SK_SAVED_QUESTION_INDEX } from '../../constants/session-keys';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuestionPayload } from '../../models/QuestionPayload.model';
import { Quiz } from '../../models/Quiz.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { FetchQuestionResult, RouteChangeQuestionResult, RouteQuestionResult } 
  from './quiz-content-loader.service';
import { QqcQuestionLoaderService } from '../features/qqc/qqc-question-loader.service';
import { QuizDataService } from '../data/quizdata.service';
import { QuizDotStatusService } from './quiz-dot-status.service';
import { QuizQuestionDataService } from './quiz-question-data.service';
import { QuizService } from '../data/quiz.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { SelectionMessageService } from '../features/selection-message/selection-message.service';

/**
 * Handles question fetching, loading, and API data retrieval.
 * Extracted from QuizContentLoaderService.
 */
@Service()
export class QclQuestionFetchService {
  // ── injects ─────────────────────────────────────────────────────
  private dotStatusService = inject(QuizDotStatusService);
  private explanationTextService = inject(ExplanationTextService);
  private quizDataService = inject(QuizDataService);
  private quizQuestionDataService = inject(QuizQuestionDataService);
  private quizQuestionLoaderService = inject(QqcQuestionLoaderService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);

  // ── public methods ──────────────────────────────────────────────
  async loadQuestionFromRouteChange(params: {
    quizId: string;
    index: number;
  }): Promise<RouteChangeQuestionResult> {
    const { quizId, index } = params;
    const empty: RouteChangeQuestionResult = {
      success: false,
      question: null,
      options: [],
      explanation: '',
      totalQuestions: 0,
      hasValidSelections: false
    };

    // S6n: resolve the question collection from QuizService's own,
    // API-sourced state (populated by QuizDataService#prepareQuizSession,
    // itself backed by the safe question API — see quiz-session-manager
    // .service.ts#applySessionQuestions) rather than the client-bank-backed
    // QuizDataService#getQuiz()/quizzes$. quizzes$ is only ever populated by
    // ensureQuizzesLoaded()/loadQuizzes() — once a caller (e.g. Introduction)
    // stops priming the full bank, that observable never emits, and the old
    // `await firstValueFrom(getQuiz(quizId)...)` here hung forever on EVERY
    // route change, permanently blocking every Next-navigation's question/
    // options load (proven live: the resolved instrumentation entry never
    // fired for any of 3 navigations in a row).
    //
    // During normal in-quiz navigation the quiz doesn't change, so the
    // already-populated in-session collection is authoritative and no fetch
    // is needed at all. A genuine quiz switch (deep-link to a different
    // quiz's question) is the only case requiring a fresh, safe fetch —
    // prepareQuizSession is the same API-backed path Introduction/quiz start
    // already use, so this introduces no new data source.
    const isSameQuiz = this.quizService.quizId === quizId
      || this.quizService.getCurrentQuizId() === quizId;

    let baseQuestions: QuizQuestion[] = isSameQuiz ? (this.quizService.questions ?? []) : [];
    if (baseQuestions.length === 0) {
      baseQuestions = await firstValueFrom(
        this.quizDataService.prepareQuizSession(quizId).pipe(take(1))
      ).catch(() => [] as QuizQuestion[]);
    }
    if (!baseQuestions.length) return empty;

    this.quizQuestionLoaderService.activeQuizId = quizId;
    const totalQ = baseQuestions.length;
    this.quizQuestionLoaderService.totalQuestions = totalQ;

    const shuffledSnapshot = this.quizService.isShuffleEnabled()
      ? [...(this.quizService.shuffledQuestions ?? [])] : null;

    await this.quizQuestionLoaderService.loadQuestionAndOptions(index);
    await this.quizQuestionLoaderService.loadQA(index);

    if (shuffledSnapshot && shuffledSnapshot.length > 0
        && (!this.quizService.shuffledQuestions || this.quizService.shuffledQuestions.length === 0)) {
      this.quizService.shuffledQuestions = shuffledSnapshot;
    }

    const shouldUseShuffled =
      this.quizService.isShuffleEnabled() &&
      this.quizService.shuffledQuestions?.length > 0;
    const effectiveQuestions = shouldUseShuffled
      ? this.quizService.shuffledQuestions : baseQuestions;
    const question = effectiveQuestions?.[index] ?? null;
    if (!question) return empty;

    this.quizQuestionLoaderService.resetHeadlineStreams(index);
    this.quizService.updateCurrentQuestion(question);

    const options = question.options ?? [];
    const explanation = question.explanation ?? '';

    const optionIdSet = new Set(
      options.map((opt) => opt.optionId).filter((id): id is number => typeof id === 'number')
    );
    const validSelections =
      (this.selectedOptionService.getSelectedOptionsForQuestion(index) ?? [])
        .filter((opt) => optionIdSet.has(opt.optionId ?? -1));

    return {
      success: true,
      question,
      options,
      explanation,
      totalQuestions: totalQ,
      hasValidSelections: validSelections.length > 0
    };
  }

  async fetchAndPrepareQuestion(
    params: {
      questionIndex: number;
      totalQuestions: number;
      quizId: string;
    },
    restoreSessionSelections: (questionIndex: number) => void
  ): Promise<FetchQuestionResult> {
    const { questionIndex, totalQuestions, quizId } = params;
    const empty = this.emptyFetchResult();

    try {
      if (isNaN(questionIndex) || questionIndex < 0 || questionIndex >= totalQuestions) return empty;

      restoreSessionSelections(questionIndex);

      const fetched = await this.fetchQuestionAndOptions(questionIndex);
      if (!fetched) return empty;

      return await this.prepareQuestion(quizId, questionIndex, fetched.fetchedQuestion, fetched.fetchedOptions);
    } catch {
      return empty;
    }
  }

  /**
   * Prepare the fetched question: reset FET flags, build/clone options, resolve
   * answered state + display, build/emit the question, resolve the explanation,
   * set it current, re-check answeredness, and assemble the success result.
   * Extracted verbatim.
   */
  private async prepareQuestion(quizId: string, questionIndex: number, fetchedQuestion: any, fetchedOptions: any[]): Promise<FetchQuestionResult> {
    this.explanationTextService.setResetComplete(false);
    this.explanationTextService.setShouldDisplayExplanation(false);

    const trimmedText = (fetchedQuestion?.questionText ?? '').trim() || 'No question available';
    const { finalOptions, clonedOptions } = this.buildPreparedOptions(fetchedOptions);

    const isAnswered = this.resolveIsAnswered(quizId, questionIndex, clonedOptions);
    this.quizStateService.setDisplayState({
      mode: isAnswered ? 'explanation' : 'question',
      answered: isAnswered
    });

    const question = this.buildQuestion(fetchedQuestion, clonedOptions);
    const currentQuestion = { ...question };
    this.emitPreparedQuestion(currentQuestion, clonedOptions, questionIndex);

    const explanationText = await this.resolvePreparedExplanation(isAnswered, fetchedQuestion, finalOptions, questionIndex);

    this.quizService.setCurrentQuestion(currentQuestion);
    this.quizService.setCurrentQuestionIndex(questionIndex);
    this.quizStateService.updateCurrentQuestion(currentQuestion);

    await this.applyAnswerednessCheck(questionIndex);

    const questionPayload: QuestionPayload = { question: currentQuestion, options: clonedOptions, explanation: explanationText };

    return {
      success: true, question, currentQuestion, trimmedText, clonedOptions,
      finalOptions, explanationText, isAnswered, questionPayload, shouldStartTimer: !isAnswered
    };
  }

  /** Fetch the question details + current options in parallel; null if either is missing/empty. */
  private async fetchQuestionAndOptions(questionIndex: number): Promise<{ fetchedQuestion: any; fetchedOptions: any[] } | null> {
    const [fetchedQuestion, fetchedOptions] = await Promise.all([
      this.quizQuestionDataService.fetchQuestionDetails(questionIndex),
      firstValueFrom(this.quizService.getCurrentOptions(questionIndex).pipe(take(1)))
    ]);
    if (
      !fetchedQuestion ||
      !fetchedQuestion.questionText?.trim() ||
      !Array.isArray(fetchedOptions) ||
      fetchedOptions.length === 0
    ) return null;
    return { fetchedQuestion, fetchedOptions };
  }

  /** The empty/failure result shape. */
  private emptyFetchResult(): FetchQuestionResult {
    return {
      success: false,
      question: null,
      currentQuestion: null,
      trimmedText: '',
      clonedOptions: [],
      finalOptions: [],
      explanationText: '',
      isAnswered: false,
      questionPayload: null,
      shouldStartTimer: false
    };
  }

  /** Hydrate fetched options (ids/correct/feedback), assign active states, and clone. Extracted verbatim. */
  private buildPreparedOptions(fetchedOptions: any[]): { finalOptions: any[]; clonedOptions: any[] } {
    const hydratedOptions = fetchedOptions.map((opt, idx) => ({
      ...opt,
      optionId: opt.optionId ?? idx,
      correct: opt.correct ?? false,
      feedback: opt.feedback ?? `The correct options are: ${opt.text}`
    }));
    const finalOptions = this.quizService.quizOptions.assignOptionActiveStates(hydratedOptions, false);
    const clonedOptions = structuredClone?.(finalOptions) ?? JSON.parse(JSON.stringify(finalOptions));
    return { finalOptions, clonedOptions };
  }

  /**
   * Determine answered state from valid persisted selections, clearing a stale
   * answered flag when none survive, and sync the answered flags. Extracted verbatim.
   */
  private resolveIsAnswered(quizId: string, questionIndex: number, clonedOptions: any[]): boolean {
    const quizIdForState = quizId || this.quizService.quizId || 'default-quiz';
    const questionState = this.quizStateService.getQuestionState(quizIdForState, questionIndex);
    const optionIdSet = new Set(
      clonedOptions
        .map((opt: Option) => opt.optionId)
        .filter((id: any): id is number => typeof id === 'number')
    );
    const selectedOptions = this.selectedOptionService.getSelectedOptionsForQuestion(questionIndex);
    const validSelections = (selectedOptions ?? []).filter((opt) => optionIdSet.has(opt.optionId ?? -1));

    // A timed-out question counts as answered even when no selection survives,
    // so the Next button stays enabled and its FET persists on tab return.
    // Single-answer timeouts have no selection, so the selection-only check
    // below would otherwise clear their answered/explanation state.
    if (this.dotStatusService?.timedOutFetForced?.has(questionIndex) === true) {
      this.quizStateService.setAnswered(true);
      this.selectedOptionService.setAnswered(true, true);
      return true;
    }

    const isAnswered = validSelections.length > 0;
    if (!isAnswered && questionState?.isAnswered) {
      this.quizStateService.setQuestionState(quizIdForState, questionIndex, {
        ...questionState,
        isAnswered: false,
        explanationDisplayed: false
      });
      this.selectedOptionService.clearSelectionsForQuestion(questionIndex);
      this.selectedOptionService.setAnswered(false, true);
    }

    if (isAnswered) {
      this.quizStateService.setAnswered(true);
      this.selectedOptionService.setAnswered(true, true);
    } else {
      this.quizStateService.setAnswered(false);
      this.selectedOptionService.setAnswered(false, true);
    }
    return isAnswered;
  }

  /** Assemble the prepared QuizQuestion from the fetched data + cloned options. */
  private buildQuestion(fetchedQuestion: any, clonedOptions: any[]): QuizQuestion {
    return {
      questionText: fetchedQuestion.questionText,
      explanation: fetchedQuestion.explanation ?? '',
      options: clonedOptions,
      type: fetchedQuestion.type ?? QuestionType.SingleAnswer
    };
  }

  /** Emit the prepared question + options to the quiz service and payload signal. */
  private emitPreparedQuestion(currentQuestion: QuizQuestion, clonedOptions: any[], questionIndex: number): void {
    this.quizService.emitQuestionAndOptions(currentQuestion, clonedOptions, questionIndex);
    this.quizService.questionPayloadSig.set({
      question: currentQuestion,
      options: clonedOptions,
      explanation: currentQuestion.explanation ?? ''
    });
  }

  /**
   * When answered: format + store the FET and set explanation display state.
   * When not: force the baseline and push the selection message. Extracted verbatim.
   */
  private async resolvePreparedExplanation(isAnswered: boolean, fetchedQuestion: any, finalOptions: any[], questionIndex: number): Promise<string> {
    if (!isAnswered) {
      this.selectionMessageService.forceBaseline(questionIndex);
      await this.selectionMessageService.setSelectionMessage(false);
      return '';
    }
    const correctIndices = this.explanationTextService.getCorrectOptionIndices(fetchedQuestion, finalOptions, questionIndex);
    const rawExplanation = fetchedQuestion.explanation?.trim() || 'No explanation available';
    const explanationText = this.explanationTextService.formatExplanation(fetchedQuestion, correctIndices, rawExplanation);
    this.explanationTextService.storeFormattedExplanation(questionIndex, explanationText, fetchedQuestion, finalOptions, true);
    this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
    return explanationText;
  }

  /**
   * Fresh-start-at-Q1 (no selections/answers) resets the score; otherwise
   * re-check whether the question was answered correctly. Extracted verbatim.
   */
  private async applyAnswerednessCheck(questionIndex: number): Promise<void> {
    const liveSelections = this.selectedOptionService.getSelectedOptionsForQuestion(questionIndex) ?? [];
    const hasUserAnswersForQuestion =
      Array.isArray(this.quizService.userAnswers?.[questionIndex]) &&
      this.quizService.userAnswers[questionIndex].length > 0;
    const savedIndexRaw = localStorage.getItem(SK_SAVED_QUESTION_INDEX);
    const isFreshStartAtQ1 =
      questionIndex === 0 &&
      this.quizService.questionCorrectness.size === 0 &&
      (savedIndexRaw == null || String(savedIndexRaw).trim() === '0');

    if (isFreshStartAtQ1 && liveSelections.length === 0 && !hasUserAnswersForQuestion) {
      this.quizService.questionCorrectness.delete(questionIndex);
      this.quizService.sendCorrectCountToResults(0);
    } else {
      await this.quizService.checkIfAnsweredCorrectly(questionIndex, false);
    }
  }

  async loadQuestionByRoute(params: {
    routeIndex: number;
    quiz: any;
    quizId: string;
    totalQuestions: number;
  }): Promise<RouteQuestionResult> {
    const { routeIndex, quiz, totalQuestions } = params;
    const empty: RouteQuestionResult = {
      success: false,
      question: null,
      questionText: '',
      optionsWithIds: [],
      questionIndex: 0,
      totalCount: 0
    };

    if (!quiz || !quiz.questions) return empty;

    if (isNaN(routeIndex) || routeIndex < 1 || routeIndex > quiz.questions.length) {
      return { ...empty, questionIndex: -1 };
    }

    const questionIndex = routeIndex - 1;

    if (questionIndex < 0 || questionIndex >= quiz.questions.length) {
      return empty;
    }

    this.quizService.setCurrentQuestionIndex(questionIndex);

    const totalCount = totalQuestions > 0 ? totalQuestions : (quiz.questions?.length || 0);
    if (totalCount > 0 && questionIndex >= 0) {
      this.quizService.updateBadgeText(questionIndex + 1, totalCount);
    }

    const question = await firstValueFrom(this.quizService.getQuestionByIndex(questionIndex));
    if (!question) return empty;

    this.quizQuestionDataService.forceRegenerateExplanation(question, questionIndex);

    const questionText = question.questionText?.trim() ?? 'No question available';

    const optionsWithIds = this.quizService.quizOptions.assignOptionIds(
      question.options || [],
      questionIndex
    ).map((option, index) => ({
      ...option,
      feedback: 'Loading feedback...',
      showIcon: option.showIcon ?? false,
      active: option.active ?? true,
      selected: option.selected ?? false,
      correct: !!option.correct,
      optionId:
        typeof option.optionId === 'number' && !isNaN(option.optionId)
          ? option.optionId
          : index + 1
    }));

    return {
      success: true,
      question,
      questionText,
      optionsWithIds,
      questionIndex,
      totalCount
    };
  }

  async fetchQuestionFromAPI(
    quizId: string,
    questionIndex: number
  ): Promise<QuizQuestion | null> {
    if (!quizId || quizId.trim() === '') return null;

    try {
      const result = await firstValueFrom(
        of(
          this.quizDataService.fetchQuestionAndOptionsFromAPI(
            quizId,
            questionIndex
          )
        )
      );

      if (!result) return null;

      const [question, options] = result ?? [null, null];
      if (!question) return null;

      return {
        ...question,
        options: options?.map((option: Option) => ({
          ...option,
          correct: option.correct ?? false
        })) ?? question.options
      };
    } catch {
      return null;
    }
  }

  async loadQuizDataFromService(quizId: string): Promise<{
    quiz: Quiz;
    questions: QuizQuestion[];
  } | null> {
    try {
      const questions = await this.quizService.fetchQuizQuestions(quizId);
      if (!questions || questions.length === 0) return null;

      // S6o: same fix as loadQuestionFromRouteChange (S6n) — the Quiz metadata
      // this call previously re-fetched via the client-bank-backed getQuiz()/
      // quizzes$ is already in memory, set by whoever started the quiz
      // (Introduction, Quiz Selection). getQuiz() never emits once nothing
      // primes the full bank, so this used to hang forever on every quiz load
      // (confirmed live: S6n's E2E suite exercises this exact path with an
      // empty bank on every run and it never completed, yet nothing depended
      // on its result — an orphaned, harmless-but-wasteful hung promise).
      const quiz = this.quizService.getActiveQuiz();
      if (!quiz) return null;

      return { quiz, questions };
    } catch {
      return null;
    }
  }

  fetchAndSubscribeQuestionAndOptions(quizId: string, questionIndex: number): void {
    if (document.hidden) return;
    if (!quizId || quizId.trim() === '') return;
    if (questionIndex < 0) return;

    this.quizDataService.getQuestionAndOptions(quizId, questionIndex)
      .pipe(
        map((data: any): [QuizQuestion | null, Option[] | null] => {
          return Array.isArray(data)
            ? (data as [QuizQuestion | null, Option[] | null])
            : [null, null];
        }),
        catchError(
          (): Observable<[QuizQuestion | null, Option[] | null]> => {
            return of<[QuizQuestion | null, Option[] | null]>([null, null]);
          }
        )
      )
      .subscribe({
        next: ([question, options]: [QuizQuestion | null, Option[] | null]) => {
          if (question && options) {
            this.quizStateService.updateCurrentQuizState(of(question));
          }
        },
        error: () => { }
      });
  }
}