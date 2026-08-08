import { inject, Service, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, Router } from '@angular/router';
import { firstValueFrom, forkJoin, lastValueFrom, of } from 'rxjs';
import { catchError, filter, take, timeout } from 'rxjs/operators';

import { QuestionType } from '../../../models/question-type.enum';

import { Option } from '../../../models/Option.model';
import { QAPayload } from '../../../models/QAPayload.model';
import { QuestionPayload } from '../../../models/QuestionPayload.model';
import { Quiz } from '../../../models/Quiz.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QuestionTimingService } from '../timer/question-timing.service';
import { QuizDataService } from '../../data/quizdata.service';
import { QuizDotStatusService } from '../../flow/quiz-dot-status.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { ResetBackgroundService } from '../../ui/reset-background.service';
import { ResetStateService } from '../../state/reset-state.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../selection-message/selection-message.service';
import { TimerService } from '../timer/timer.service';

import { declaredIsMultiAnswer } from '../../../utils/question-type-authority';
import { delay } from '../../../utils/delay';
import { swallow } from '../../../utils/error-logging';

/**
 * Manages reactive streams, DOM freeze/thaw, and legacy question-loading pipeline.
 * Absorbed from QuizQuestionLoaderService into the QQC sub-service layer.
 */
@Service()
export class QqcQlStreamService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly dotStatusService = inject(QuizDotStatusService);
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly resetBackgroundService = inject(ResetBackgroundService);
  private readonly resetStateService = inject(ResetStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly selectionMessageService = inject(SelectionMessageService);
  private readonly questionTimingService = inject(QuestionTimingService);
  private readonly timerService = inject(TimerService);
  private readonly router = inject(Router);

  question: QuizQuestion | null = null;
  questionData: QuizQuestion | null = null;
  questionPayload: QuestionPayload | null = null;
  currentQuestion: QuizQuestion | null = null;
  currentQuestionIndex = 0;
  currentQuestionAnswered = false;

  questionToDisplay = '';

  public readonly questionToDisplaySig = signal<string>('');
  public readonly questionToDisplay$ = toObservable(this.questionToDisplaySig);

  questionTextLoaded = false;
  questionInitialized = false;
  explanationToDisplay = '';

  public activeQuizId!: string;
  public totalQuestions = 0;

  showFeedbackForOption: { [key: number]: boolean } = {};

  selectedOptions: Option[] = [];
  optionsToDisplay: Option[] = [];
  readonly optionsToDisplaySig = signal<Option[]>([]);
  public optionsToDisplay$ = toObservable(this.optionsToDisplaySig);
  optionBindingsSrc: Option[] = [];
  public hasOptionsLoaded = false;
  public shouldRenderOptions = false;
  public pendingOptions: Option[] | null = null;

  public hasContentLoaded = false;
  public isLoading = false;
  isQuestionDisplayed = false;
  isNextButtonEnabled = false;
  isAnswered = false;

  shouldRenderQuestionComponent = false;
  resetComplete = false;

  private readonly questionTextSig = signal<string>('');
  private readonly questionPayloadReadySig = signal<boolean>(false);

  private readonly explanationTextSig = signal<string>('');

  isButtonEnabled = false;
  private readonly isButtonEnabledSig = signal<boolean>(false);

  readonly isLoadingSig = signal<boolean>(false);
  public readonly isLoading$ = toObservable(this.isLoadingSig);
  private currentLoadAbortCtl = new AbortController();

  private readonly qaSig = signal<QAPayload | null>(null);

  readonly optionsSig = signal<Option[]>([]);
  readonly optionsStream$ = toObservable(this.optionsSig);
  options$ = this.optionsStream$;

  lastQuizId: string | null = null;
  questionsArray: QuizQuestion[] = [];

  public _lastQuestionText = '';
  public _lastRenderedIndex = -1;
  public _lastNavTime = 0;

  public _renderFreezeUntil = 0;
  public _frozen = false;
  public _isVisualFrozen = false;
  private _freezeTimer: ReturnType<typeof setTimeout> | null = null;
  public _quietUntil = 0;
  public _quietZoneUntil = 0;
  private _navBarrier = false;

  readonly quietZoneUntilSig = signal<number>(0);
  public quietZoneUntil$ = toObservable(this.quietZoneUntilSig);

  constructor() {
    this.explanationTextService._loaderRef = this;
  }

  public async loadQuestionContents(questionIndex: number): Promise<void> {
    try {
      const quizId = this.quizService.getCurrentQuizId();
      if (!quizId) return;

      const hasCachedQuestion = this.quizService.quizDataLoader.hasCachedQuestion(
        quizId,
        questionIndex
      );

      if (!hasCachedQuestion) {
        this.hasContentLoaded = false;
        this.hasOptionsLoaded = false;
        this.shouldRenderOptions = false;
        this.isLoading = true;
        this.isQuestionDisplayed = false;
        this.isNextButtonEnabled = false;

        this.optionsToDisplay = [];
        this.explanationToDisplay = '';
        this.questionData = null;
      } else {
        this.isLoading = false;
      }

      try {
        type FetchedData = {
          question: QuizQuestion | null;
          options: Option[] | null;
          explanation: string | null;
        };

        const question$ = this.quizService
          .getQuestionByIndex(questionIndex)
          .pipe(take(1));
        const options$ = this.quizService
          .getCurrentOptions(questionIndex)
          .pipe(take(1));
        const explanation$ = this.explanationTextService.explanationsInitialized
          ? this.explanationTextService
            .getFormattedExplanationTextForQuestion(questionIndex)
            .pipe(take(1))
          : of('');

        const data: FetchedData = await lastValueFrom(
          forkJoin({
            question: question$,
            options: options$,
            explanation: explanation$
          }).pipe(
            catchError(() => {
              return of({
                question: null,
                options: [],
                explanation: ''
              } as FetchedData);
            })
          )
        );

        if (
          !data.question?.questionText?.trim() ||
          !Array.isArray(data.options) ||
          data.options.length === 0
        ) {
          this.isLoading = false;
          return;
        }

        this.optionsToDisplay = [...data.options];
        this.optionsToDisplaySig.set(this.optionsToDisplay);
        this.hasOptionsLoaded = true;

        this.questionData = data.question ?? ({} as QuizQuestion);
        this.explanationToDisplay = data.explanation ?? '';
        this.isQuestionDisplayed = true;

        this.isLoading = false;
      } catch {
        this.isLoading = false;
      }
    } catch {
      this.isLoading = false;
    }
  }

  async loadQuestionAndOptions(index: number): Promise<boolean> {
    if (!this.ensureRouteQuizId()) return false;

    const isCountValid = await this.ensureQuestionCount();
    const isIndexValid = this.validateIndex(index);

    if (!isCountValid || !isIndexValid) return false;

    await this.resetUiForNewQuestion(index);

    const { q, opts } = await this.fetchQuestionAndOptions(index);
    if (!q || !opts.length) return false;

    let cloned: Option[] = [];
    try {
      cloned = JSON.parse(JSON.stringify(opts));

      let i = 0;
      for (const opt of cloned) {
        opt.optionId = opt.optionId ?? i + 1;
        opt.selected = false;
        opt.highlight = false;
        opt.showIcon = false;
        opt.active = true;
        i++;
      }
    } catch {
      cloned =
        typeof structuredClone === 'function'
          ? structuredClone(opts)
          : [...opts.map((o) => ({ ...o }))];
    }

    this.explanationTextService._fetLocked = false;
    this.explanationTextService.setShouldDisplayExplanation(false);
    this.explanationTextService.setIsExplanationTextDisplayed(false);
    this.explanationTextService.setExplanationText('');

    this.currentQuestion = { ...q, options: cloned };
    this.optionsToDisplay = [...cloned];
    this.optionBindingsSrc = [...cloned];
    this.currentQuestionIndex = index;

    const explanation = q.explanation?.trim() || 'No explanation available';

    // Ask for this question's signed deadline before anything downstream can
    // render it. Idempotent per question, so arriving here after the direct
    // route already activated the same question replays the same deadline
    // rather than granting a second one.
    this.questionTimingService.activateQuestionTiming(
      this.activeQuizId, q.questionText, index
    );

    this.emitQaPayload(q, cloned, index, explanation);

    await this.postEmitUpdates(q, cloned, index);

    return true;
  }

  private ensureRouteQuizId(): boolean {
    const routeId = this.readRouteParam('quizId') ?? this.quizService.quizId;
    if (!routeId) return false;

    if (routeId !== this.lastQuizId) {
      this.questionsArray = [];
      this.lastQuizId = routeId;
    }
    this.activeQuizId = routeId;
    this.quizService.setQuizId(routeId);
    return true;
  }

  private async ensureQuestionCount(): Promise<boolean> {
    if (this.totalQuestions) return true;

    const qs = (await firstValueFrom(
      this.quizDataService.getQuestionsForQuiz(this.activeQuizId)
    )) as QuizQuestion[];
    this.totalQuestions = qs.length;
    this.questionsArray = qs;
    return qs.length > 0;
  }

  private validateIndex(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < this.totalQuestions;
  }

  private readRouteParam(param: string): string | null {
    let snapshot: ActivatedRouteSnapshot | null =
      this.router.routerState.snapshot.root;

    while (snapshot) {
      const value = snapshot.paramMap?.get(param);
      if (value != null) {
        return value;
      }
      snapshot = snapshot.firstChild ?? null;
    }

    return null;
  }

  private canServeQuestionFromCache(index: number): boolean {
    const activeQuizId = this.activeQuizId ?? this.quizService.quizId ?? null;

    if (
      activeQuizId &&
      this.quizService.quizDataLoader.hasCachedQuestion(activeQuizId, index)
    ) return true;

    if (
      !Array.isArray(this.questionsArray) ||
      this.questionsArray.length === 0
    ) return false;

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.questionsArray.length
    ) return false;

    const question = this.questionsArray[index];
    if (!question) return false;

    return Array.isArray(question.options) && question.options.length > 0;
  }

  private async resetUiForNewQuestion(index: number): Promise<void> {
    const canReuseCachedQuestion = this.canServeQuestionFromCache(index);

    this.resetQuestionState(index);

    this.quizStateService.setDisplayState({
      mode: 'question',
      answered: false
    });
    this.resetStateService.triggerResetState();
    this.explanationTextService.resetExplanationState();

    this.quizService.questionPayloadSig.set(null);
    this.questionPayloadReadySig.set(false);
    this.questionPayload = null;
    this.isLoading = !canReuseCachedQuestion;

    if (!canReuseCachedQuestion) {
      this.clearQA();
      this.resetQuestionDisplayState();
      this.questionTextSig.set('');
      this.questionToDisplaySig.set('');
      this.optionsSig.set([]);
      this.explanationTextSig.set('');
    }

    this.questionTextLoaded = false;
    this.hasOptionsLoaded = false;
    if (!canReuseCachedQuestion) {
      this.shouldRenderOptions = false;
    }

    this.explanationTextService.unlockExplanation();
    this.explanationTextService.forceResetBetweenQuestions();
    this.resetComplete = false;

    if (!canReuseCachedQuestion) {
      await delay(30);
    }

    if (this.selectedOptionService.isQuestionAnswered(index)) {
      this.quizStateService.setAnswered(true);
      this.selectedOptionService.setAnswered(true, true);
    }
  }

  private async fetchQuestionAndOptions(
    index: number
  ): Promise<{ q: QuizQuestion | null; opts: Option[] }> {
    const quizId =
      this.readRouteParam('quizId') ??
      this.activeQuizId ??
      this.quizService.quizId;
    if (!quizId) {
      return { q: null, opts: [] };
    }

    if (quizId !== this.lastQuizId) {
      this.questionsArray = [];
      this.lastQuizId = quizId;
    }

    if (this.quizService.isShuffleEnabled() && 
      this.quizService.shuffledQuestions?.length > 0
    ) {
      this.questionsArray = [...this.quizService.shuffledQuestions];
    } else {
      let questions = this.quizService.questions;

      if (!Array.isArray(questions) || questions.length === 0) {
        if (this.quizService.isShuffleEnabled()) {
          try {
            const fetched = await firstValueFrom(this.quizService.getAllQuestions().pipe(
              filter(q => Array.isArray(q) && q.length > 0),
              take(1),
              timeout(5000)
            ));

            if (this.quizService.shuffledQuestions?.length > 0) {
              this.questionsArray = [...this.quizService.shuffledQuestions];
            } else {
              this.questionsArray = [...(fetched as QuizQuestion[])];
            }
          } catch {
            this.questionsArray = await firstValueFrom(this.quizDataService.getQuestionsForQuiz(quizId));
            this.quizService.questions = [...this.questionsArray];
          }
        } else {
          this.questionsArray = await firstValueFrom(
            this.quizDataService.getQuestionsForQuiz(quizId)
          );
          this.quizService.questions = [...this.questionsArray];
        }
      }
    }

    this.activeQuizId = quizId;
    this.quizService.setQuizId(quizId);

    const q = await firstValueFrom(this.quizService.getQuestionByIndex(index));
    if (!q) {
      throw new Error(`No question found for index ${index}`);
    }

    const { question, options } = this.hydrateAndClone(q, index);

    if (this.quizService.questions?.length) {
      const fullQuiz: Quiz = await firstValueFrom(
        this.quizDataService.getQuiz(quizId).pipe(
          filter((quiz): quiz is Quiz => quiz !== null),
          take(1)
        )
      );

      this.quizService.setCurrentQuiz({
        ...fullQuiz,
        questions: this.quizService.questions
      });
    }

    return { q: question, opts: options };
  }

  private hydrateAndClone(
    q: QuizQuestion,
    _qIndex: number
  ): { question: QuizQuestion; options: Option[] } {
    const question: QuizQuestion = { ...q };
    const baseOpts: Option[] = Array.isArray(q?.options) ? q.options : [];

    const hydrated: Option[] = baseOpts.map((o: Option, i: number) => ({
      ...o,
      optionId: o.optionId ?? i,
      correct: !!o.correct,
      feedback: o.feedback ?? '',
      selected: false,
      highlight: false,
      showIcon: false,
      active: true
    }));

    const active: Option[] = this.quizService.quizOptions.assignOptionActiveStates(hydrated, false);

    const options: Option[] =
      typeof structuredClone === 'function'
        ? structuredClone(active)
        : JSON.parse(JSON.stringify(active));

    return { question, options };
  }

  private emitQaPayload(
    question: QuizQuestion,
    options: Option[],
    index: number,
    explanation: string
  ): void {
    const isAnswered = this.selectedOptionService.isQuestionAnswered(index);
    const explanationForPayload = isAnswered ? explanation : '';
    const optionsForPayload = [...options];
    const questionForPayload: QuizQuestion = {
      ...question,
      options: optionsForPayload,
      explanation: explanationForPayload
    };

    this.optionsSig.set(optionsForPayload);
    this.qaSig.set({
      quizId: this.quizService.quizId,
      index,
      heading: question.questionText.trim(),
      options: optionsForPayload,
      explanation: explanationForPayload,
      question: questionForPayload,
      selectionMessage: this.selectionMessageService.getCurrentMessage()
    });

    this.setQuestionDetails(
      question.questionText.trim(),
      optionsForPayload,
      explanationForPayload
    );
    this.currentQuestionIndex = index;
    this.shouldRenderQuestionComponent = true;

    this.quizService.setCurrentQuestion(question);
    this.quizStateService.updateCurrentQuestion(question);

    this.quizService.questionPayloadSig.set({
      question: questionForPayload,
      options: optionsForPayload,
      explanation: explanationForPayload
    });
  }

  private async postEmitUpdates(
    q: QuizQuestion,
    opts: Option[],
    idx: number
  ): Promise<void> {
    const optionIdSet = new Set(
      opts
        .map((opt) => opt.optionId)
        .filter((id): id is number => typeof id === 'number')
    );
    const selectedOptions =
      this.selectedOptionService.getSelectedOptionsForQuestion(idx);
    const validSelections = (selectedOptions ?? []).filter((opt: any) =>
      optionIdSet.has(opt.optionId ?? -1)
    );
    const quizIdForState = this.quizService.quizId ?? this.activeQuizId ?? 'default-quiz';
    const questionState = this.quizStateService.getQuestionState(quizIdForState, idx);

    let isAnswered = validSelections.length > 0;

    // A timed-out question counts as answered even when no selection survives,
    // so its FET shows and the timer is not restarted on tab return. Single-
    // answer timeouts have no selection, so the selection-only check below
    // would otherwise clear answered state and restart the timer.
    if (this.dotStatusService?.timedOutFetForced?.has(idx) === true) {
      isAnswered = true;
    }

    if (!isAnswered && questionState?.isAnswered) {
      this.quizStateService.setQuestionState(quizIdForState, idx, {
        ...questionState,
        isAnswered: false,
        explanationDisplayed: false
      });
      this.selectedOptionService.clearSelectionsForQuestion(idx);
      this.selectedOptionService.setAnswered(false, true);
    }

    if (isAnswered) {
      this.quizStateService.setAnswered(true);
      this.selectedOptionService.setAnswered(true, true);
    } else {
      this.quizStateService.setAnswered(false);
      this.selectedOptionService.setAnswered(false, true);
    }

    this.explanationTextService.setResetComplete(false);
    this.explanationTextService.setShouldDisplayExplanation(false);

    let explanationText = '';
    // Durable "answered correctly" signal (the same map that colors the dot
    // green) — survives navigation's selection-clearing, unlike isAnswered.
    const answeredCorrectly =
      this.selectedOptionService.clickConfirmedDotStatus?.get?.(idx) === 'correct';

    // Only the answered branches touch the timer here. An unanswered question's
    // countdown belongs to QuestionTimingService, which may already have
    // started it from the signed deadline — stopping and resetting it on the
    // way past would silently throw that away.
    if (isAnswered || answeredCorrectly) {
      this.timerService.stopTimer?.(undefined, { force: true });
      this.timerService.resetTimer();
      this.timerService.resetTimerFlagsFor(idx);
    }

    if (isAnswered) {
      explanationText = q.explanation?.trim() || 'No explanation available';
      this.explanationTextService.setExplanationTextForQuestionIndex(
        idx,
        explanationText
      );

      this.quizStateService.setDisplayState({
        mode: 'explanation',
        answered: true
      });
    }

    if (answeredCorrectly) {
      // Freeze the countdown at the seconds remaining when this question was
      // answered correctly (timePerQuestion − recorded elapsed).
      this.timerService.freezeAtRecordedTime(idx);
    } else if (isAnswered) {
      // Answered but not correct (e.g. wrong single-answer): keep stopped.
      this.timerService.isTimerRunning = false;
    }
    // Unanswered: QuestionTimingService owns the start, so there is nothing to
    // do. A local 30s start here would beat the signed deadline and time out
    // before the server's window opened.

    this.setQuestionDetails(q.questionText.trim(), opts, explanationText);

    this.currentQuestionIndex = idx;
    this.explanationToDisplay = explanationText;

    const payloadForBroadcast: QuestionPayload = {
      question: {
        ...q,
        options: [...opts],
        explanation: explanationText
      },
      options: [...opts],
      explanation: explanationText
    };
    this.questionPayload = payloadForBroadcast;
    this.shouldRenderQuestionComponent = true;
    this.questionPayloadReadySig.set(true);
    this.quizService.questionPayloadSig.set(payloadForBroadcast);

    this.quizService.setCurrentQuestion({ ...q, options: opts });
    this.quizStateService.updateCurrentQuestion({ ...q, options: opts });

    await this.loadQuestionContents(idx);
    await this.quizService.checkIfAnsweredCorrectly(idx, false);

    this.questionTextLoaded = true;
    this.hasOptionsLoaded = true;
    this.shouldRenderOptions = true;
    this.resetComplete = true;

    this.optionsSig.set([...opts]);
  }

  public setQuestionDetails(
    questionText: string,
    options: Option[],
    explanationText: string
  ): void {
    this.questionToDisplay =
      questionText?.trim() || 'No question text available';

    this.optionsToDisplay = Array.isArray(options) ? options : [];

    this.explanationToDisplay = explanationText.trim();

    this.questionTextSig.set(this.questionToDisplay);
    this.explanationTextSig.set(this.explanationToDisplay);
  }

  resetUI(): void {
    this.question = null;
    this.currentQuestion = null;
    this.optionsToDisplay = [];
    this.resetQuestionDisplayState();
    this.questionTextSig.set('');
    this.questionToDisplaySig.set('');
    this.optionsSig.set([]);
    this.explanationTextSig.set('');
    this.questionPayloadReadySig.set(false);
    this.questionPayload = null;

    this.showFeedbackForOption = {};

    this.resetBackgroundService.setShouldResetBackground(true);

    this.resetStateService.triggerResetFeedback();
    this.resetStateService.triggerResetState();

    this.selectedOptionService.clearOptions();

    this.explanationTextService.resetExplanationState();
  }

  public resetQuestionState(index: number = this.currentQuestionIndex): void {
    this.questionInitialized = false;
    this.isAnswered = false;
    this.selectedOptions = [];
    this.currentQuestionAnswered = false;
    this.isNextButtonEnabled = false;
    this.isButtonEnabled = false;
    this.isButtonEnabledSig.set(false);

    this.selectionMessageService['_singleAnswerIncorrectLock'].clear();
    this.selectionMessageService['_singleAnswerCorrectLock'].clear();
    this.selectionMessageService['_multiAnswerInProgressLock'].clear();
    this.selectionMessageService['_multiAnswerCompletionLock'].clear();
    this.selectionMessageService['_multiAnswerPreLock']?.clear();

    if (this.currentQuestion?.options?.length) {
      for (const option of this.currentQuestion.options) {
        option.selected = false;
        option.highlight = false;
        option.active = true;
        option.showIcon = false;
        option.feedback = undefined;
      }
    }

    this.selectedOptionService.stopTimerEmitted = false;

    this.seedSelectionBaseline(index);
  }

  public resetQuestionLocksForIndex(index: number): void {
    this.selectionMessageService['_singleAnswerIncorrectLock'].delete(index);
    this.selectionMessageService['_singleAnswerCorrectLock'].delete(index);
    this.selectionMessageService['_multiAnswerInProgressLock'].delete(index);
    this.selectionMessageService['_multiAnswerCompletionLock'].delete(index);
    this.selectionMessageService['_multiAnswerPreLock']?.delete(index);
    this.selectedOptionService.unlockAllOptionsForQuestion?.(index);
  }

  private seedSelectionBaseline(index: number | null | undefined): void {
    if (typeof index !== 'number' || !Number.isFinite(index)) return;

    const i0 = Math.trunc(index);
    if (i0 < 0) return;

    if (!Array.isArray(this.questionsArray) || i0 >= this.questionsArray.length)
      return;

    const question = this.questionsArray[i0];
    if (
      !question ||
      !Array.isArray(question.options) ||
      question.options.length === 0
    ) return;

    const options = question.options;
    const correctCount = options.reduce(
      (total, option) => (option?.correct ? total + 1 : total), 0
    );
    const totalCorrect = Math.max(correctCount, 1);

    let qType: QuestionType;
    switch (question.type) {
      case QuestionType.MultipleAnswer:
        qType = QuestionType.MultipleAnswer;
        break;
      case QuestionType.TrueFalse:
        qType = QuestionType.SingleAnswer;
        break;
      case QuestionType.SingleAnswer:
      default:
        qType = QuestionType.SingleAnswer;
        break;
    }

    // The switch above already mapped the question's DECLARED type (and folds
    // trueFalse into single-selection for the selection message, which only
    // cares about cardinality — the question keeps its own type). Only promote
    // to multiple from the count when nothing was declared, or the local flags
    // would override an explicit single.
    // REMOVE IN /questions CONTENT CUTOVER.
    if (declaredIsMultiAnswer(question) === null && correctCount > 1) {
      qType = QuestionType.MultipleAnswer;
    }
    this.selectionMessageService.enforceBaselineAtInit(i0, qType, totalCorrect);
  }

  private resetQuestionDisplayState(): void {
    this.questionToDisplay = '';
    this.explanationToDisplay = '';
    this.optionsToDisplay = [];
  }

  public async loadQA(index: number): Promise<boolean> {
    this.resetHeadlineStreams();

    this.currentLoadAbortCtl.abort();
    this.currentLoadAbortCtl = new AbortController();
    this.isLoadingSig.set(true);

    try {
      let allQuestions: QuizQuestion[];
      if (this.quizService.isShuffleEnabled() && this.quizService.shuffledQuestions?.length > 0) {
        allQuestions = this.quizService.shuffledQuestions;
      } else {
        allQuestions = (await firstValueFrom(
          this.quizDataService.getQuestionsForQuiz(this.activeQuizId),
        )) as QuizQuestion[];
      }

      const q: QuizQuestion | undefined = allQuestions[index];
      if (!q) return false;

      let opts = q.options ?? [];
      if (opts.length === 0) {
        opts = (allQuestions as QuizQuestion[])?.[index]?.options ?? [];
        if (opts.length === 0) return false;
      }

      const correctIndices = opts
        .map((o, i) => o.correct ? i + 1 : null)
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
      const correctLabel = correctIndices.length === 1
        ? `The correct answer is Option ${correctIndices[0]}.`
        : `The correct answers are Options ${correctIndices.slice(0, -1).join(', ')}${correctIndices.length > 2 ? ',' : ''} and ${correctIndices.slice(-1)}.`;

      const finalOpts = opts.map((o, i) => ({
        ...o,
        optionId: o.optionId ?? i + 1,
        active: o.active ?? true,
        showIcon: !!o.showIcon,
        selected: !!o.selected,
        correct: !!o.correct,
        feedback: o.feedback ?? correctLabel
      }));

      const safeQuestion: QuizQuestion = JSON.parse(
        JSON.stringify({
          ...q,
          options: finalOpts
        })
      );

      this.quizService.currentQuestionSig.set(safeQuestion);
      this.quizService.optionsSource.next(finalOpts);

      return true;
    } catch {
      return false;
    } finally {
      this.isLoadingSig.set(false);
    }
  }

  resetHeadlineStreams(index?: number): void {
    const activeIndex = this.quizService.getCurrentQuestionIndex();

    if (index != null && index !== activeIndex) return;

    this.questionToDisplaySig.set('');
    this.clearQA();
    this.quizStateService.setDisplayState({
      mode: 'question',
      answered: false
    });
  }

  clearQA(): void {
    this.qaSig.set({
      quizId: '',
      index: -1,
      heading: '',
      question: null as unknown as QuizQuestion,
      options: [],
      explanation: '',
      selectionMessage: ''
    });
  }

  public emitQuestionTextSafely(text: string, index: number): void {
    if (this.isNavBarrierActive()) return;

    const now = performance.now();
    if (now < (this._quietZoneUntil ?? 0)) return;

    if (this._frozen && now < (this._renderFreezeUntil ?? 0)) {
      return;
    }

    const activeIndex = this.quizService.getCurrentQuestionIndex();
    if (index !== activeIndex) return;

    const trimmed = (text ?? '').trim();
    if (!trimmed || trimmed === '?') return;

    if (now - (this._lastNavTime ?? 0) < 80) return;

    this._lastQuestionText = trimmed;
    this.questionToDisplaySig.set(trimmed);
  }

  public clearQuestionTextBeforeNavigation(): void {
    try {
      this._frozen = true;
      this.questionToDisplaySig.set('');
      this._lastQuestionText = '';
      this._lastRenderedIndex = -1;
    } catch (err: unknown) { swallow('qqc-ql-stream.service.ts clearQuestionTextBeforeNavigation', err); }
  }

  public freezeQuestionStream(durationMs = 120): void {
    if (this._isVisualFrozen) return;

    this._isVisualFrozen = true;
    this._frozen = true;

    const EXTENSION_MS = 40;
    this._renderFreezeUntil = performance.now() + durationMs + EXTENSION_MS;

    if (this._freezeTimer != null) clearTimeout(this._freezeTimer);
    this._freezeTimer = setTimeout(
      () => {
        this.unfreezeQuestionStream();
      },
      durationMs + EXTENSION_MS + 8
    );
  }

  public unfreezeQuestionStream(): void {
    const now = performance.now();

    const QUIET_WINDOW_MS = 120;

    if (now < this._renderFreezeUntil) {
      const delay = this._renderFreezeUntil - now;
      this._isVisualFrozen = true;

      if (this._freezeTimer != null) clearTimeout(this._freezeTimer);
      this._freezeTimer = setTimeout(() => {
        this._isVisualFrozen = false;
        this._frozen = false;
        this._quietUntil = performance.now() + QUIET_WINDOW_MS;
      }, delay + 12);

      return;
    }

    this._isVisualFrozen = false;
    this._frozen = false;
    this._quietUntil = now + QUIET_WINDOW_MS;
  }

  public isNavBarrierActive(): boolean {
    return this._navBarrier;
  }

  public waitForDomStable(extra = 32): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        setTimeout(resolve, extra);
      });
    });
  }
}