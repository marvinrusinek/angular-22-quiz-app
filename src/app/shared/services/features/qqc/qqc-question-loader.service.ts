import { inject, Service } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SharedOptionConfig } from '../../../models/SharedOptionConfig.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { QqcQlFetchService } from './qqc-ql-fetch.service';
import { QqcQlOptionBuildService } from './qqc-ql-option-build.service';
import { QqcQlStreamService } from './qqc-ql-stream.service';
import { QuizService } from '../../data/quiz.service';
import { allCorrectSelectedFromVerdict, questionTextForDisplayIndex } from '../verdict/authorized-correctness';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../selection-message/selection-message.service';
import { TimerService } from '../timer/timer.service';

/**
 * Manages question loading pipeline, quiz data fetching, and question initialization for QQC.
 * Delegates to 2 extracted sub-services; retains load-pipeline orchestration inline.
 */
@Service()
export class QqcQuestionLoaderService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly fetch = inject(QqcQlFetchService);
  private readonly nextButtonStateService = inject(NextButtonStateService);
  private readonly questionVerdictService = inject(QuestionVerdictService);
  private readonly optionBuild = inject(QqcQlOptionBuildService);
  private readonly qql = inject(QqcQlStreamService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly selectionMessageService = inject(SelectionMessageService);
  private readonly timerService = inject(TimerService);

  // ─── Pass-through: QqcQlStreamService ───────

  // Properties
  get activeQuizId(): string { return this.qql.activeQuizId; }
  set activeQuizId(v: string) { this.qql.activeQuizId = v; }

  get totalQuestions(): number { return this.qql.totalQuestions; }
  set totalQuestions(v: number) { this.qql.totalQuestions = v; }

  get currentQuestion(): QuizQuestion | null { return this.qql.currentQuestion; }
  set currentQuestion(v: QuizQuestion | null) { this.qql.currentQuestion = v; }

  get pendingOptions(): Option[] | null { return this.qql.pendingOptions; }
  set pendingOptions(v: Option[] | null) { this.qql.pendingOptions = v; }

  get hasOptionsLoaded(): boolean { return this.qql.hasOptionsLoaded; }
  set hasOptionsLoaded(v: boolean) { this.qql.hasOptionsLoaded = v; }

  get shouldRenderOptions(): boolean { return this.qql.shouldRenderOptions; }
  set shouldRenderOptions(v: boolean) { this.qql.shouldRenderOptions = v; }

  get hasContentLoaded(): boolean { return this.qql.hasContentLoaded; }
  set hasContentLoaded(v: boolean) { this.qql.hasContentLoaded = v; }

  // Freeze/timing state (used by navigation service)
  get _frozen(): boolean { return this.qql._frozen; }
  set _frozen(v: boolean) { this.qql._frozen = v; }

  get _isVisualFrozen(): boolean { return this.qql._isVisualFrozen; }
  set _isVisualFrozen(v: boolean) { this.qql._isVisualFrozen = v; }

  get _renderFreezeUntil(): number { return this.qql._renderFreezeUntil; }
  set _renderFreezeUntil(v: number) { this.qql._renderFreezeUntil = v; }

  get _quietZoneUntil(): number { return this.qql._quietZoneUntil; }
  set _quietZoneUntil(v: number) { this.qql._quietZoneUntil = v; }

  get _lastNavTime(): number { return this.qql._lastNavTime; }
  set _lastNavTime(v: number) { this.qql._lastNavTime = v; }

  get _lastQuestionText(): string { return this.qql._lastQuestionText; }
  set _lastQuestionText(v: string) { this.qql._lastQuestionText = v; }

  get _lastRenderedIndex(): number { return this.qql._lastRenderedIndex; }
  set _lastRenderedIndex(v: number) { this.qql._lastRenderedIndex = v; }

  // Signals / Observables
  get questionToDisplay$() { return this.qql.questionToDisplay$; }
  get questionToDisplaySig() { return this.qql.questionToDisplaySig; }
  get optionsToDisplaySig() { return this.qql.optionsToDisplaySig; }
  get optionsToDisplay$() { return this.qql.optionsToDisplay$; }
  get optionsSig() { return this.qql.optionsSig; }
  get optionsStream$() { return this.qql.optionsStream$; }
  get options$() { return this.qql.options$; }
  get quietZoneUntilSig() { return this.qql.quietZoneUntilSig; }
  get quietZoneUntil$() { return this.qql.quietZoneUntil$; }
  get isLoadingSig() { return this.qql.isLoadingSig; }
  get isLoading$() { return this.qql.isLoading$; }

  // Methods
  resetUI(): void { this.qql.resetUI(); }
  clearQA(): void { this.qql.clearQA(); }
  resetHeadlineStreams(index?: number): void {
    this.qql.resetHeadlineStreams(index);
  }
  async loadQuestionAndOptions(index: number): Promise<boolean> {
    return this.qql.loadQuestionAndOptions(index);
  }
  async loadQA(index: number): Promise<boolean> {
    return this.qql.loadQA(index);
  }
  async loadQuestionContents(questionIndex: number): Promise<void> {
    return this.qql.loadQuestionContents(questionIndex);
  }
  emitQuestionTextSafely(text: string, index: number): void {
    this.qql.emitQuestionTextSafely(text, index);
  }
  freezeQuestionStream(durationMs?: number): void {
    this.qql.freezeQuestionStream(durationMs);
  }
  unfreezeQuestionStream(): void {
    this.qql.unfreezeQuestionStream();
  }
  clearQuestionTextBeforeNavigation(): void {
    this.qql.clearQuestionTextBeforeNavigation();
  }
  isNavBarrierActive(): boolean {
    return this.qql.isNavBarrierActive();
  }
  waitForDomStable(extra?: number): Promise<void> {
    return this.qql.waitForDomStable(extra);
  }
  setQuestionDetails(questionText: string, options: Option[], explanationText: string): void {
    this.qql.setQuestionDetails(questionText, options, explanationText);
  }
  resetQuestionState(index?: number): void {
    this.qql.resetQuestionState(index);
  }
  resetQuestionLocksForIndex(index: number): void {
    this.qql.resetQuestionLocksForIndex(index);
  }

  // ─── Fetch (delegated) ───────────────────────────────────────

  async loadQuizData(quizId: string | null | undefined): Promise<QuizQuestion[] | null> {
    return this.fetch.loadQuizData(quizId);
  }

  async ensureQuestionsLoaded(
    questionsArray: QuizQuestion[],
    quizId: string | null | undefined
  ): Promise<{ loaded: boolean; questions: QuizQuestion[] | null }> {
    return this.fetch.ensureQuestionsLoaded(questionsArray, quizId);
  }

  async fetchQuestionsIfNeeded(
    questionsArray: QuizQuestion[] | null
  ): Promise<QuizQuestion[]> {
    return this.fetch.fetchQuestionsIfNeeded(questionsArray);
  }

  checkEndOfQuiz(params: {
    currentQuestionIndex: number;
    questionsArray: QuizQuestion[];
    quizId: string;
  }): { shouldRedirect: boolean; trueTotal: number } {
    return this.fetch.checkEndOfQuiz(params);
  }

  canRenderQuestionInstantly(
    questionsArray: QuizQuestion[],
    index: number
  ): boolean {
    return this.fetch.canRenderQuestionInstantly(questionsArray, index);
  }

  async initializeComponentState(params: {
    questionsArray: QuizQuestion[];
    currentQuestionIndex: number;
  }): Promise<{
    questionsArray: QuizQuestion[];
    currentQuestionIndex: number;
    currentQuestion: QuizQuestion;
  } | null> {
    return this.fetch.initializeComponentState(params);
  }

  async fetchAndProcessQuizQuestions(params: {
    quizId: string;
    prepareQuestion: (quizId: string, question: QuizQuestion, index: number) => Promise<void>;
  }): Promise<QuizQuestion[]> {
    return this.fetch.fetchAndProcessQuizQuestions(params);
  }

  async ensureQuestionIsFullyLoaded(
    index: number,
    questionsArray: QuizQuestion[],
    quizId: string | null | undefined
  ): Promise<void> {
    return this.fetch.ensureQuestionIsFullyLoaded(index, questionsArray, quizId);
  }

  async loadCurrentQuestion(params: {
    currentQuestionIndex: number;
    questionsArray: QuizQuestion[];
    quizId: string | null | undefined;
  }): Promise<{
    success: boolean;
    currentQuestion: QuizQuestion | null;
    optionsToDisplay: Option[];
    questions: QuizQuestion[];
  }> {
    return this.fetch.loadCurrentQuestion(params);
  }

  async waitForQuestionData(params: {
    currentQuestionIndex: number;
    quizId: string;
  }): Promise<{
    currentQuestion: QuizQuestion | null;
    optionsToDisplay: Option[];
    currentQuestionIndex: number;
  }> {
    return this.fetch.waitForQuestionData(params);
  }

  async performQuizDataAndRoutingInit(params: {
    quizId: string | null | undefined;
  }): Promise<{
    questions: QuizQuestion[];
    quiz: any;
  } | null> {
    return this.fetch.performQuizDataAndRoutingInit(params);
  }

  // ─── Option Build (delegated) ────────────────────────────────

  buildFreshOptions(
    question: QuizQuestion,
    currentQuestionIndex: number
  ): Option[] {
    return this.optionBuild.buildFreshOptions(question, currentQuestionIndex);
  }

  enrichOptionsForDisplay(question: QuizQuestion): Option[] {
    return this.optionBuild.enrichOptionsForDisplay(question);
  }

  computeQuestionSignature(question: QuizQuestion): string {
    return this.optionBuild.computeQuestionSignature(question);
  }

  populateOptionsToDisplay(
    currentQuestion: QuizQuestion | null,
    currentOptionsToDisplay: Option[],
    lastSignature: string | null
  ): { options: Option[]; signature: string | null } {
    return this.optionBuild.populateOptionsToDisplay(currentQuestion, currentOptionsToDisplay, lastSignature);
  }

  buildOptionBindings(
    clonedOptions: Option[],
    isMultipleAnswer: boolean
  ): OptionBindings[] {
    return this.optionBuild.buildOptionBindings(clonedOptions, isMultipleAnswer);
  }

  buildSharedOptionConfig(params: {
    question: QuizQuestion;
    clonedOptions: Option[];
    isMultipleAnswer: boolean;
    currentQuestionIndex: number;
    defaultConfig?: SharedOptionConfig | null;
  }): SharedOptionConfig {
    return this.optionBuild.buildSharedOptionConfig(params);
  }

  prepareOptionsForQuestion(params: {
    question: QuizQuestion;
    currentOptionsLength: number;
  }): {
    enrichedOptions: Option[];
    shouldClearFirst: boolean;
  } {
    return this.optionBuild.prepareOptionsForQuestion(params);
  }

  configureDynamicInstance(params: {
    instance: any;
    componentRef?: any;
    question: any;
    options: Option[];
    isMultipleAnswer: boolean;
    currentQuestionIndex: number;
    navigatingBackwards: boolean;
    defaultConfig: any;
    onOptionClicked: (...args: any[]) => any;
  }): {
    clonedOptions: Option[];
    questionData: any;
    sharedOptionConfig: SharedOptionConfig | null;
  } {
    return this.optionBuild.configureDynamicInstance(params);
  }

  buildInitialData(
    question: QuizQuestion,
    options: Option[]
  ): {
    questionText: string;
    explanationText: string;
    correctAnswersText: string;
    options: Option[];
  } {
    return this.optionBuild.buildInitialData(question, options);
  }

  // ─── Remaining inline: load pipeline orchestration ───────────

  /**
   * Prepares reset state before loading a new question.
   */
  prepareQuestionLoadReset(params: {
    currentQuestionIndex: number;
    shouldPreserveVisualState: boolean;
    shouldKeepExplanationVisible: boolean;
  }): {
    shouldResetSelections: boolean;
    shouldStartLoading: boolean;
  } {
    const { shouldPreserveVisualState, shouldKeepExplanationVisible } = params;

    return {
      shouldResetSelections: !shouldKeepExplanationVisible,
      shouldStartLoading: !shouldPreserveVisualState
    };
  }

  /**
   * Purges all selection/lock state for a fresh question load.
   */
  purgeSelectionState(): void {
    this.selectedOptionService.resetAllStates?.();
    this.selectedOptionService.selectedOptionsMap?.clear?.();
    (this.selectedOptionService as any)._lockedOptionsMap?.clear?.();
  }

  /**
   * Resets explanation-related state for a new question load.
   */
  resetExplanationForLoad(): void {
    this.explanationTextService.setShouldDisplayExplanation(false);
    this.explanationTextService.setIsExplanationTextDisplayed(false);
    this.explanationTextService.setExplanationText('');
  }

  /**
   * Computes the pre-load reset flags for a question load.
   */
  computePreLoadResetActions(params: {
    shouldPreserveVisualState: boolean;
    shouldKeepExplanationVisible: boolean;
  }): {
    shouldResetSelections: boolean;
    shouldResetExplanation: boolean;
    shouldStartLoading: boolean;
    shouldSetAnsweredTrue: boolean;
  } {
    return {
      shouldResetSelections: !params.shouldKeepExplanationVisible,
      shouldResetExplanation: !params.shouldKeepExplanationVisible,
      shouldStartLoading: !params.shouldPreserveVisualState,
      shouldSetAnsweredTrue: params.shouldKeepExplanationVisible
    };
  }

  /**
   * Post-options-load state reset.
   */
  computePostOptionsLoadState(): {
    lastLoggedIndex: number;
    lastExplanationShownIndex: number;
    explanationInFlight: boolean;
  } {
    return {
      lastLoggedIndex: -1,
      lastExplanationShownIndex: -1,
      explanationInFlight: false
    };
  }

  /**
   * Prepares core component state for a new question: clones question,
   * builds fresh options, and computes question text.
   */
  prepareComponentStateForQuestion(params: {
    potentialQuestion: QuizQuestion;
    currentQuestionIndex: number;
    questionsArray: QuizQuestion[];
  }): {
    currentQuestion: QuizQuestion;
    optionsToDisplay: Option[];
    questionToDisplay: string;
    hasSharedRefs: boolean;
  } {
    // 1Purge all previous state before touching new data
    this.purgeSelectionState();

    // Defensive clone of question data
    const currentQuestion = { ...params.potentialQuestion };

    // Deep clone options to guarantee new references
    const optionsToDisplay = this.optionBuild.buildFreshOptions(params.potentialQuestion, params.currentQuestionIndex);

    // Verify no shared references
    let hasSharedRefs = false;
    if (params.questionsArray?.[params.currentQuestionIndex - 1]?.options) {
      const prev = params.questionsArray[params.currentQuestionIndex - 1].options;
      const curr = optionsToDisplay;
      hasSharedRefs = prev.some((p, i) => p === curr[i]);
    }

    // Compute question text
    const questionToDisplay = currentQuestion.questionText?.trim() || '';

    return { currentQuestion, optionsToDisplay, questionToDisplay, hasSharedRefs };
  }

  /**
   * Performs pre-load reset: sets explanation locks, resets selection/button state.
   */
  performPreLoadReset(params: {
    shouldPreserveVisualState: boolean;
    shouldKeepExplanationVisible: boolean;
    currentQuestionIndex: number;
  }): void {
    // Absolute Lock: prevent stale FET display
    this.resetExplanationForLoad();

    if (params.shouldPreserveVisualState) {
      this.quizStateService.setLoading(false);
      this.quizStateService.setAnswerSelected(false);
    } else {
      this.quizStateService.setLoading(true);
      this.quizStateService.setAnswerSelected(false);
    }

    // Reset selection and button state before processing question
    if (!params.shouldKeepExplanationVisible) {
      this.selectedOptionService.clearSelectionsForQuestion(params.currentQuestionIndex);
      this.selectedOptionService.setAnswered(false);

      // A DURABLY-COMPLETE QUESTION MUST NOT STRAND NEXT DISABLED.
      //
      // `shouldKeepExplanationVisible` decides a PRESENTATION choice (should
      // the FET stay showing) — false here on a revisit/re-entry is correct
      // (see heading-inputs.ts's own revisit guard). But Next-button
      // enablement is a COMPLETION fact, not a presentation one, and
      // `reset()` used to run unconditionally in this branch, disabling Next
      // for a question that IS genuinely finished — this branch runs on
      // every navigation-triggered reset, restart included, where the local
      // selection mirror this used to lean on has just been (correctly)
      // wiped. Checking the durable verdict directly answers the real
      // question instead: is THIS question actually complete?
      const verdict = this.questionVerdictService.verdictFor(
        this.quizService.quizId ?? '',
        questionTextForDisplayIndex(this.quizService, params.currentQuestionIndex) ?? ''
      );
      if (allCorrectSelectedFromVerdict(verdict) === true) {
        this.nextButtonStateService.setNextButtonState(true);
      } else {
        this.nextButtonStateService.reset();
      }
    } else {
      this.selectedOptionService.setAnswered(true, true);
      this.nextButtonStateService.setNextButtonState(true);
    }
  }

  /**
   * Performs the post-load state reset when explanation should NOT be preserved.
   */
  performPostResetExplanationClear(): {
    displayState: { mode: 'question' | 'explanation'; answered: boolean };
    forceQuestionDisplay: boolean;
    readyForExplanationDisplay: boolean;
    isExplanationReady: boolean;
    isExplanationLocked: boolean;
    currentExplanationText: string;
    feedbackText: string;
  } {
    this.explanationTextService.resetExplanationState();
    this.explanationTextService.setExplanationText('');
    this.explanationTextService.setIsExplanationTextDisplayed(false);

    return {
      displayState: { mode: 'question', answered: false },
      forceQuestionDisplay: true,
      readyForExplanationDisplay: false,
      isExplanationReady: false,
      isExplanationLocked: true,
      currentExplanationText: '',
      feedbackText: ''
    };
  }

  /**
   * Emits the baseline selection message once options are fully ready after loading.
   */
  emitBaselineSelectionMessage(params: {
    optionsToDisplay: Option[];
    currentQuestionIndex: number;
    questions: QuizQuestion[];
  }): void {
    queueMicrotask(() => {
      requestAnimationFrame(async () => {
        if (params.optionsToDisplay?.length > 0) {
          const q = params.questions[params.currentQuestionIndex];
          if (q) {
            const totalCorrect = q.options.filter(o => !!o.correct).length;
            // Push the baseline immediately
            await this.selectionMessageService.enforceBaselineAtInit(params.currentQuestionIndex, q.type!, totalCorrect);
          }
        }
      });
    });
  }

  /**
   * Performs the post-binding microtask for loadOptionsForQuestion.
   */
  performPostOptionsBindingSetup(params: {
    generateOptionBindings: () => void;
    markForCheck: () => void;
    currentQuestionIndex: number;
    emitPassiveNow: (idx: number) => void;
  }): {
    lastLoggedIndex: number;
    lastExplanationShownIndex: number;
    explanationInFlight: boolean;
    pendingPassiveRaf: number;
  } {
    params.generateOptionBindings();
    params.markForCheck();

    // UI is now interactive
    this.quizStateService.setLoading(false);
    this.quizStateService.setInteractionReady(true);

    // Reset click dedupe and explanation flight state
    const resetState = this.computePostOptionsLoadState();

    // Start with Next disabled for ALL questions until first selection
    this.quizStateService.setAnswerSelected(false);
    this.nextButtonStateService.setNextButtonState(false);

    // Emit the passive message from the same array the UI just rendered
    const pendingPassiveRaf = requestAnimationFrame(
      () => params.emitPassiveNow(params.currentQuestionIndex)
    );

    return {
      ...resetState,
      pendingPassiveRaf
    };
  }

  /**
   * Performs the post-view-init question setup.
   */
  async performAfterViewInitQuestionSetup(params: {
    questionsArray: QuizQuestion[];
    currentQuestionIndex: number;
    getFormattedExplanation: (question: QuizQuestion, index: number) => Promise<{ explanation: string }>;
    updateExplanationUI: (index: number, explanationText: string) => void;
  }): Promise<QuizQuestion | null> {
    const { questionsArray, currentQuestionIndex: index } = params;

    // Wait until questions are available
    if (!questionsArray || questionsArray.length <= index) {
      return null;  // caller should retry
    }

    const question = questionsArray[index];
    if (question) {
      this.quizService.setCurrentQuestion(question);

      setTimeout(async () => {
        const formatted = await params.getFormattedExplanation(question, index);
        const explanationText = formatted?.explanation || question.explanation || 'No explanation available';
        params.updateExplanationUI(index, explanationText);
      }, 50);

      return question;
    } else {
      return null;
    }
  }

  /**
   * Handles the core of loadQuestion after the reset/explanation-clear phase.
   */
  async performLoadQuestionPostReset(params: {
    currentQuestionIndex: number;
    questionsArray: QuizQuestion[];
    quizId: string | null | undefined;
    signal?: AbortSignal;
    questions?: QuizQuestion[];
  }): Promise<{
    success: boolean;
    shouldRedirect: boolean;
    questionsArray: QuizQuestion[];
    currentQuestion: QuizQuestion;
    optionsToDisplay: Option[];
    questionToDisplay: string;
  } | null> {
    // Fetch questions if not already available
    const questionsArray = await this.fetch.fetchQuestionsIfNeeded(params.questionsArray);

    // Set totalQuestions before selection messages are computed
    if (questionsArray?.length > 0) {
      this.quizService.totalQuestions.set(questionsArray.length);
    }

    if (questionsArray.length === 0) return null;

    // Check end of quiz
    const { shouldRedirect } = this.fetch.checkEndOfQuiz({
      currentQuestionIndex: params.currentQuestionIndex,
      questionsArray,
      quizId: params.quizId!
    });

    if (shouldRedirect) {
      return {
        success: false,
        shouldRedirect: true,
        questionsArray,
        currentQuestion: null as any,
        optionsToDisplay: [], 
        questionToDisplay: ''
      };
    }

    // Validate current index
    if (params.currentQuestionIndex < 0 || params.currentQuestionIndex >= questionsArray.length) {
      throw new Error(`Invalid question index: ${params.currentQuestionIndex}`);
    }

    const potentialQuestion = questionsArray[params.currentQuestionIndex];
    if (!potentialQuestion) {
      throw new Error(`No question found for index ${params.currentQuestionIndex}`);
    }

    if (params.signal?.aborted) {
      this.timerService.stopTimer(undefined, { force: true });
      return null;
    }

    // Prepare core state
    const preparedState = this.prepareComponentStateForQuestion({
      potentialQuestion,
      currentQuestionIndex: params.currentQuestionIndex,
      questionsArray
    });

    // Emit to quiz service signal
    this.quizService.questionPayloadSig.set({
      question: preparedState.currentQuestion!,
      options: preparedState.optionsToDisplay,
      explanation: ''
    });

    this.quizService.nextQuestionSig.set(preparedState.currentQuestion);
    this.quizService.nextOptionsSig.set(preparedState.optionsToDisplay);

    // Emit baseline selection message
    this.emitBaselineSelectionMessage({
      optionsToDisplay: preparedState.optionsToDisplay,
      currentQuestionIndex: params.currentQuestionIndex,
      questions: params.questions ?? questionsArray
    });

    if (params.signal?.aborted) {
      this.timerService.stopTimer(undefined, { force: true });
      return null;
    }

    // Start the timer AFTER all setup is complete to avoid races where
    // an aborted prior load tears down the freshly-started timer.
    this.timerService.restartForQuestion(params.currentQuestionIndex);

    return {
      success: true,
      shouldRedirect: false,
      questionsArray,
      currentQuestion: preparedState.currentQuestion!,
      optionsToDisplay: preparedState.optionsToDisplay,
      questionToDisplay: preparedState.questionToDisplay
    };
  }

  /**
   * Handles the route change update within setupRouteChangeHandler.
   */
  async performRouteChangeUpdate(params: {
    zeroBasedIndex: number;
    questionsArray: QuizQuestion[];
    loadQuestion: () => Promise<boolean>;
    isAnyOptionSelected: (idx: number) => Promise<boolean>;
    updateExplanationText: (idx: number) => Promise<string>;
    shouldDisplayExplanation: boolean;
    questionForm: any;
  }): Promise<{
    loaded: boolean;
    currentQuestion: QuizQuestion | null;
    optionsToDisplay: Option[];
  } | null> {
    this.quizService.setCurrentQuestionIndex(params.zeroBasedIndex);

    const loaded = await params.loadQuestion();
    if (!loaded) return null;

    if (params.questionForm) params.questionForm.patchValue({ answer: '' });

    // When shuffle is active, use shuffledQuestions as the authoritative source.
    // params.questionsArray may contain unshuffled data, causing Q&A mismatch.
    const shuffled = this.quizService.shuffledQuestions;
    const effectiveQuestions = this.quizService.isShuffleEnabled() && shuffled?.length > 0
      ? shuffled : params.questionsArray;
    const currentQuestion = effectiveQuestions?.[params.zeroBasedIndex] ?? null;
    if (!currentQuestion) return null;

    const optionsToDisplay = (currentQuestion.options ?? []).map((opt: Option) => ({
      ...opt,
      active: true,
      feedback: undefined,
      showIcon: false
    }));

    const isAnswered = await params.isAnyOptionSelected(params.zeroBasedIndex);
    if (isAnswered) await params.updateExplanationText(params.zeroBasedIndex);

    return {
      loaded: true,
      currentQuestion,
      optionsToDisplay
    };
  }
}