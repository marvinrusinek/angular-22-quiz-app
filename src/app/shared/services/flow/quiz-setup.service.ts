import { Service, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { filter } from 'rxjs/operators';

import { FET_WRITE_RETRY_CASCADE_MS, FET_WRITE_RETRY_LONG_CASCADE_MS } from '../../constants/timing';

import { QuestionPayload } from '../../models/QuestionPayload.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { NextButtonStateService } from '../state/next-button-state.service';
import { QuizContentLoaderService } from './quiz-content-loader.service';
import { QuizDotStatusService } from './quiz-dot-status.service';
import { QuizNavigationService } from './quiz-navigation.service';
import { QuizOptionProcessingService } from './quiz-option-processing.service';
import { QuizPersistenceService } from '../state/quiz-persistence.service';
import { QuizResetService } from './quiz-reset.service';
import { QuizService } from '../data/quiz.service';
import { QuizSetupDataService } from './quiz-setup-data.service';
import { QuizSetupRouteService } from './quiz-setup-route.service';
import { QuizStateService } from '../state/quizstate.service';
import { QuizVisibilityRestoreService } from './quiz-visibility-restore.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { SelectionMessageService } from '../features/selection-message/selection-message.service';
import { SharedVisibilityService } from '../ui/shared-visibility.service';
import { TimerService } from '../features/timer/timer.service';

import type { QuizComponent } from '../../../containers/quiz/quiz.component';
import { SK_DISPLAY_MODE, SK_DOT_CONFIRMED, SK_SEL_Q, SK_SELECTED_OPTIONS_MAP } from '../../constants/session-keys';
import { removeSessionKey } from '../../utils/session-storage';

import { QUESTION_ROUTE_REGEX } from '../../constants/route-patterns';
import { isOptionCorrect } from '../../utils/is-option-correct';
import { reportError, swallow } from '../../utils/error-logging';
import { norm } from '../../utils/text-norm';
import { resolveIsMultiAnswer } from '../../utils/question-type-authority';

type Host = QuizComponent;

/**
 * Hosts orchestration / route / lifecycle logic extracted from QuizComponent.
 * Delegates to 2 extracted sub-services; retains lifecycle + option/explanation handlers inline.
 */
@Service()
export class QuizSetupService {
  // ── injects ─────────────────────────────────────────────────────
  private dataService = inject(QuizSetupDataService);
  private dotStatusService = inject(QuizDotStatusService);
  private explanationTextService = inject(ExplanationTextService);
  private nextButtonStateService = inject(NextButtonStateService);
  private quizContentLoaderService = inject(QuizContentLoaderService);

  private quizNavigationService = inject(QuizNavigationService);
  private quizOptionProcessingService = inject(QuizOptionProcessingService);
  private quizPersistence = inject(QuizPersistenceService);
  private quizResetService = inject(QuizResetService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private quizVisibilityRestoreService = inject(QuizVisibilityRestoreService);
  private router = inject(Router);
  private routeService = inject(QuizSetupRouteService);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);
  private sharedVisibilityService = inject(SharedVisibilityService);
  private timerService = inject(TimerService);

  // ── public methods ──────────────────────────────────────────────

  // ─── Route (delegated) ───────────────────────────────────────

  subscribeToRouteEvents(host: Host): void {
    this.routeService.subscribeToRouteEvents(
      host,
      (h: Host) => this.dataService.loadQuestions(h)
    );
  }

  fetchTotalQuestions(host: Host): void {
    this.routeService.fetchTotalQuestions(host);
  }

  subscribeToQuestionIndex(host: Host): void {
    this.routeService.subscribeToQuestionIndex(host);
  }

  subscribeToRouteParams(host: Host): void {
    this.routeService.subscribeToRouteParams(host);
  }

  fetchRouteParams(host: Host): void {
    // Original fetchRouteParams called this.loadQuizData(host) at the end.
    // The route sub-service sets host._pendingLoadQuizData instead;
    // we wire the actual call here.
    host.activatedRoute.params
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe((params: any) => {
        host.quizId.set(params['quizId'] ?? '');
        host.questionIndex.set(+params['questionIndex']);
        host.currentQuestionIndex.set(host.questionIndex() - 1);
        void this.dataService.loadQuizData(host);
      });
  }

  subscribeRouterAndInit(host: Host): void {
    this.routeService.subscribeRouterAndInit(host);
  }

  setupNavigation(host: Host): void {
    this.routeService.setupNavigation(host);
  }

  async updateContentBasedOnIndex(host: Host, index: number): Promise<void> {
    return this.routeService.updateContentBasedOnIndex(host, index);
  }

  async loadQuestionByRouteIndex(host: Host, routeIndex: number): Promise<void> {
    return this.routeService.loadQuestionByRouteIndex(host, routeIndex);
  }

  // ─── Data (delegated) ────────────────────────────────────────

  async loadQuestions(host: Host): Promise<void> {
    return this.dataService.loadQuestions(host);
  }

  async loadQuizData(host: Host): Promise<boolean> {
    return this.dataService.loadQuizData(host);
  }

  loadCurrentQuestion(host: Host): void {
    this.dataService.loadCurrentQuestion(host);
  }

  refreshQuestionOnReset(host: Host): void {
    this.dataService.refreshQuestionOnReset(host);
  }

  async getQuestion(host: Host): Promise<void | null> {
    return this.dataService.getQuestion(host);
  }

  applyQuestionsFromSession(host: Host, questions: QuizQuestion[]): void {
    this.dataService.applyQuestionsFromSession(host, questions);
  }

  resolveQuizData(host: Host): void {
    this.dataService.resolveQuizData(host);
  }

  initializeQuizFromRoute(host: Host): void {
    // Original initializeQuizFromRoute called this.setupNavigation(host) in subscribe.
    // The data sub-service sets host._pendingSetupNavigation instead;
    // we wire the actual call here via a wrapper.
    host.activatedRoute.data
      .pipe(
        takeUntilDestroyed(host.destroyRef),
        filter((data: any) => {
          if (!data.quizData) {
            void this.router.navigate(['/select']);
            return false;
          }
          host.quiz.set(data.quizData);
          this.quizContentLoaderService.resetFetStateForInit();
          return true;
        })
      )
      .subscribe(() => {
        this.setupNavigation(host);
        // Seed the question text against the question the URL is targeting,
        // not always questions[0]. Direct navigation to /question/.../3
        // would otherwise display Q1's text until a downstream emission
        // overrides it — visible to the user as a "Q1 then Q3" flash, or
        // worse, as Q1 stuck if the override never lands.
        const currentIdx = host.currentQuestionIndex();
        const seedIdx = Number.isFinite(currentIdx) && currentIdx >= 0
          ? currentIdx : 0;
        const trimmed = (this.quizService.questions?.[seedIdx]?.questionText ?? '').trim();
        if (trimmed) host.questionToDisplaySig.set(trimmed);
        this.quizContentLoaderService.seedFirstQuestionText();
        host.cdRef.markForCheck();
      });
  }

  initializeQuestionStreams(host: Host): void {
    this.dataService.initializeQuestionStreams(host);
  }

  loadQuizQuestionsForCurrentQuiz(host: Host): void {
    this.dataService.loadQuizQuestionsForCurrentQuiz(host);
  }

  createQuestionData(host: Host): void {
    this.dataService.createQuestionData(host);
  }

  async handleNavigationToQuestion(host: Host, questionIndex: number): Promise<void> {
    return this.dataService.handleNavigationToQuestion(host, questionIndex);
  }

  async updateQuestionStateAndExplanation(host: Host, questionIndex: number): Promise<void> {
    return this.dataService.updateQuestionStateAndExplanation(host, questionIndex);
  }

  selectedAnswer(host: Host, optionIndex: number): void {
    this.dataService.selectedAnswer(host, optionIndex);
  }

  // ─── Remaining inline: lifecycle + option/explanation handlers ───

  // ── Constructor wiring (subscriptions + observables) ──────────
  wireConstructor(host: Host): void {
    const qqc = host.quizQuestionComponent?.();
    if (qqc) qqc.renderReady.set(false);

    this.sharedVisibilityService.pageVisibility$.subscribe((isHidden: boolean) => {
      const needsRender = this.quizVisibilityRestoreService.handleVisibilityChange(isHidden, {
        currentQuestion: host.currentQuestion(),
        optionsToDisplay: host.optionsToDisplaySig(),
        explanationToDisplay: host.explanationToDisplay(),
        combinedQuestionData: host.combinedQuestionData,
        optionsToDisplaySig: host.optionsToDisplaySig
      });
      if (needsRender) {
        host.cdRef.markForCheck();
      }

      // When tab becomes visible, restore selection message for current question
      if (!isHidden) {
        const idx = host.currentQuestionIndex();
        const isAnswered = this.selectedOptionService.isQuestionAnswered(idx);
        if (!isAnswered) this.selectionMessageService.forceBaseline(idx);
        const question = this.quizService.questions?.[idx]
          ?? host.questionsArray()?.[idx] ?? null;
        if (question) {
          // Heading is rendered by the single-source headingHtml computed; the
          // setTimeout cascade that stamped question text into <h3> is no longer
          // needed (the computed renders the question from state).
        }
      }
    });

    host.subscriptions.add(
      this.quizService.quizReset$.subscribe(() => this.dataService.refreshQuestionOnReset(host))
    );

    host.subscriptions.add(
      this.quizService.questions$.subscribe((questions: QuizQuestion[]) => {
        const serviceQuizId = this.quizService.getCurrentQuizId();
        if (questions?.length && (!host.quizId() || serviceQuizId === host.quizId())) {
          const shuffled = this.quizService.shuffledQuestions;
          const effectiveQuestions =
            this.quizService.isShuffleEnabled() && shuffled?.length > 0
              ? shuffled : questions;
          host.questions.set(effectiveQuestions);
          host.questionsArray.set([...effectiveQuestions]);
          host.totalQuestions.set(effectiveQuestions.length);
          host.cdRef.markForCheck();
        }
      })
    );

    this.selectedOptionService.selectedOption$.subscribe((selections: any[]) => {
      const qIndex = selections?.[0]?.questionIndex ?? host.currentQuestionIndex();
      if (selections && selections.length > 0) host.markQuestionAnswered(qIndex);
      host.updateDotStatus(qIndex);
      host.cdRef.markForCheck();
    });

    this.quizService.currentQuestion$.subscribe({
      next: (newQuestion: QuizQuestion | null) => {
        if (!newQuestion) return;
        host.currentQuestion.set(null);
        setTimeout(() => { host.currentQuestion.set({ ...newQuestion }); }, 10);
      },
      error: () => { }
    });
  }

  // ── onOptionSelected ──────────────────────────────────────────
  async onOptionSelected(host: Host, option: any, isUserAction: boolean = true): Promise<void> {
    if (!isUserAction) return;
    const id = option?.optionId ?? option?.id ?? option?.displayOrder ?? -1;
    const now = Date.now();
    if (id !== -1 && id === (host._lastOptionId ?? -1) && (now - (host._lastClickTime ?? 0)) < 200) return;
    host._lastClickTime = now;
    host._lastOptionId = id;

    host._processingOptionClick = true;
    const idx = host.normalizeQuestionIndex(option?.questionIndex);

    const _isShuf = this.quizService?.isShuffleEnabled?.()
      && this.quizService?.shuffledQuestions?.length > 0;
    const authQ = _isShuf
      ? (this.quizService?.getQuestionsInDisplayOrder?.()?.[idx]
        ?? this.quizService?.shuffledQuestions?.[idx]
        ?? host.currentQuestion())
      : (this.quizService.questions?.[idx] ?? host.currentQuestion());
    const correctCount = (authQ?.options ?? []).filter(
      (o: any) => isOptionCorrect(o)
    ).length;
    // Declared type wins; the count is the REMOVE IN /questions CONTENT
    // CUTOVER fallback for questions the API has not typed yet.
    const isMultiAnswer = resolveIsMultiAnswer(
      authQ, correctCount > 1 || this.quizService.multipleAnswer
    );

    let clickedIsCorrectForFET = false;
    if (!isMultiAnswer) {
      try {
        const clickedText = norm(option?.text);
        if (clickedText) {
          const pq = this.quizService?.getPristineQuestionByText(authQ?.questionText);
          if (pq) {
            const mo = (pq.options ?? []).find((o: any) => norm(o?.text) === clickedText);
            if (mo) clickedIsCorrectForFET = isOptionCorrect(mo);
          }
        }
      } catch (err: unknown) { swallow('quiz-setup.service.ts', err); /* ignore */ }
    }
    if (!isMultiAnswer && clickedIsCorrectForFET) {
      this.showExplanationForQuestion(host, idx);
    }

    await this.quizOptionProcessingService.processOptionClick({
      option, idx, quizId: host.quizId(),
      currentQuestionIndex: host.currentQuestionIndex(),
      questionsArray: host.questionsArray(),
      currentQuestion: host.currentQuestion(),
      optionsToDisplay: host.optionsToDisplaySig(),
      liveSelections: host.getSelectionsForQuestion(idx),
      explanationToDisplay: host.explanationToDisplay()
    });

    // Always mark progress against the authoritative current-question
    // index from quizService — host.currentQuestionIndex and the derived
    // `idx` from option.questionIndex can both be stale on Q2+, leaving
    // markQuestionAnswered called with 0 on every question (already in
    // the set, early-returns, progress freezes).
    const liveQIdx = this.quizService?.currentQuestionIndex;
    const hostIdx = host.currentQuestionIndex();
    const progressIdx = Number.isFinite(liveQIdx)
      ? liveQIdx
      : (Number.isFinite(hostIdx) ? hostIdx : idx);
    host.markQuestionAnswered(progressIdx);
    host.updateDotStatus(idx);

    const confirmed = this.selectedOptionService.clickConfirmedDotStatus.get(idx);
    const dotStatus = confirmed || this.dotStatusService.dotStatusCache.get(idx);
    if (dotStatus === 'correct' || dotStatus === 'wrong') {
      this.quizPersistence.setPersistedDotStatus(host.quizId(), idx, dotStatus);
    }

    host.cdRef.markForCheck();
    host._processingOptionClick = false;

    setTimeout(() => {
      this.nextButtonStateService.evaluateNextButtonState(
        this.selectedOptionService.isAnsweredSig(),
        this.quizStateService.isLoadingSig(),
        this.quizStateService.isNavigatingSig()
      );
      host.updateDotStatus(idx);
      const delayedDotStatus = this.dotStatusService.dotStatusCache.get(idx);
      if (delayedDotStatus === 'correct' || delayedDotStatus === 'wrong') {
        this.quizPersistence.setPersistedDotStatus(host.quizId(), idx, delayedDotStatus);
      }
      host.cdRef.markForCheck();
    }, 150);
  }

  // ── advanceQuestion / restartQuiz ─────────────────────────────
  async advanceQuestion(host: Host, direction: 'next' | 'previous'): Promise<void> {
    const leavingIdx = host.currentQuestionIndex();
    this.quizContentLoaderService.snapshotLeavingQuestion({
      leavingIdx,
      leavingDotClass: host.getDotClass(leavingIdx),
      quizId: host.quizId(),
      getScoringKey: (idx: number) => this.dotStatusService.getScoringKey(host.quizId(), idx),
    });
    const leavingDotClass = host.getDotClass(leavingIdx);
    if (leavingDotClass.includes('correct')) this.quizPersistence.setPersistedDotStatus(host.quizId(), leavingIdx, 'correct');
    else if (leavingDotClass.includes('wrong')) this.quizPersistence.setPersistedDotStatus(host.quizId(), leavingIdx, 'wrong');
    host.animationStateSig.set('animationStarted');
    this.selectedOptionService.setAnswered(false);
    this.quizStateService.resetInteraction();
    if (direction === 'next') {
      const destIndex = host.currentQuestionIndex() + 1;
      // Only reset a genuinely FRESH destination to a blue/unanswered dot.
      // When advancing forward onto an already-answered question (revisit via
      // Next), preserve its dot status so it stays correct/wrong and its timer
      // stays frozen — deleting it here was re-arming the countdown.
      const destAlreadyAnswered =
        this.selectedOptionService.clickConfirmedDotStatus.has(destIndex);
      if (destIndex < host.totalQuestions() && !destAlreadyAnswered) {
        this.dotStatusService.clearForIndex(destIndex);
        this.selectedOptionService.lastClickedCorrectByQuestion.delete(destIndex);
        this.selectedOptionService.clickConfirmedDotStatus.delete(destIndex);
        this.quizPersistence.clearPersistedDotStatus(host.quizId(), destIndex);
        removeSessionKey(SK_DOT_CONFIRMED + destIndex);
      }
    }
    if (direction === 'next') {
      const destIdx = host.currentQuestionIndex() + 1;
      this.selectionMessageService.setOptionsSnapshot([]);
      this.selectionMessageService._singleAnswerCorrectLock.delete(destIdx);
      this.selectionMessageService._singleAnswerIncorrectLock.delete(destIdx);
      this.selectionMessageService.forceBaseline(destIdx);
      await this.quizNavigationService.advanceToNextQuestion();
      if (!this.selectedOptionService.isQuestionAnswered(destIdx)) {
        this.selectionMessageService.forceBaseline(destIdx);
        setTimeout(() => {
          if (!this.selectedOptionService.isQuestionAnswered(destIdx)) {
            this.selectionMessageService.forceBaseline(destIdx);
          }
        }, 100);
      }
    } else {
      await this.quizNavigationService.advanceToPreviousQuestion();
    }
    host.cdRef.markForCheck();
  }

  restartQuiz(host: Host): void {
    const totalQs = host.totalQuestions();
    this.quizResetService.performRestartServiceResets(host.quizId(), totalQs);
    this.dotStatusService.clearAllMaps();
    host.quizQuestionComponent?.()?.selectedIndices?.clear();
    this.timerService.stopTimer?.(undefined, { force: true });
    host.answeredQuestionIndices.clear();
    host.progressSig.set(0);
    this.quizPersistence.clearClickConfirmedDotStatus(totalQs);

    try {
      for (let i = 0; i < totalQs; i++) {
        sessionStorage.removeItem(SK_SEL_Q + i);
      }
      sessionStorage.removeItem('answeredQuestionIndices');
      sessionStorage.removeItem('quizProgress');
      sessionStorage.removeItem('quizProgressQuizId');
    } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
    try {
      this.quizStateService._hasUserInteracted?.clear?.();
      this.quizStateService._answeredQuestionIndices?.clear?.();
      this.quizStateService._clickedInSession?.clear?.();
      this.quizStateService.persistInteractionState?.();
    } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }

    this.router.navigate(['/quiz/question', host.quizId(), 1])
      .then(() => {
        host.currentQuestionIndex.set(0);
        this.quizResetService.applyPostRestartState(host.totalQuestions(), () => {
          host.sharedOptionComponent?.()?.generateOptionBindings();
          host.cdRef.markForCheck();
        });

        const question = this.quizService.questions?.[0]
          ?? host.questionsArray()?.[0]
          ?? null;
        if (question) {
          // Heading is rendered by the single-source headingHtml computed; the
          // setTimeout cascade that stamped question text into <h3> is no longer
          // needed (the computed renders the question from state).
        }
      })
      .catch((err: unknown) => reportError('restartQuiz navigation', err));
  }

subscribeToTimerExpiry(host: Host): void {
    this.timerService.expired$
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe(() => {
        const idx = host.currentQuestionIndex();
        // Use the authoritative committed-selection map, not
        // getSelectionsForQuestion(): for the current question that helper
        // reports every option as "active" (raw options carry no
        // selected:false flag), so it never reads as unanswered.
        const answered =
          (this.selectedOptionService.getSelectedOptionsForQuestion?.(idx) ?? []).length > 0;
        if (!answered) {
          this.dotStatusService.timerExpiredUnanswered.add(idx);
          host.cdRef.markForCheck();
        }
      });
  }

  setupQuiz(host: Host): void {
    this.resolveQuizData(host);
    this.initializeQuizFromRoute(host);
    this.initializeQuestionStreams(host);
    this.loadQuizQuestionsForCurrentQuiz(host);
    this.createQuestionData(host);
    void this.getQuestion(host);
    void this.handleNavigationToQuestion(host, host.currentQuestionIndex());
  }

  showExplanationForQuestion(host: Host, qIdx: number): void {
    const { explanationHtml } = this.quizContentLoaderService.prepareExplanationForQuestion({
      qIdx, questionsArray: host.questionsArray(), quiz: host.quiz(),
      currentQuestionIndex: host.currentQuestionIndex(), currentQuestion: host.currentQuestion(),
    });
    host.explanationToDisplay.set(explanationHtml);
    host.cdRef.markForCheck();
  }

  onExplanationChanged(host: Host, explanation: string | any, index?: number): void {
    const resolved = this.quizContentLoaderService.resolveExplanationChange(
      explanation, index, host.explanationToDisplay()
    );
    if (!resolved) return;

    const qIdx = resolved.index ?? this.quizService.getCurrentQuestionIndex?.() ?? 0;

    const rawQ = this.resolveDisplayQuestion(qIdx);
    const { correctCount, correctTexts } = this.resolveCorrectInfo(rawQ);
    // REMOVE IN /questions CONTENT CUTOVER: `correctCount > 1` is the fallback.
    const isMultiAnswer = resolveIsMultiAnswer(rawQ, correctCount > 1);

    // Single-answer: only show the FET once the question is scored correct.
    if (!isMultiAnswer && !this.resolveScoredCorrect(qIdx)) {
      return;
    }

    // Multi-answer: only show the FET once all correct are selected (or scored).
    if (isMultiAnswer && !this.isMultiAnswerReadyForExplanation(qIdx, correctTexts)) {
      return;
    }

    host.explanationToDisplay.set(resolved.text);
    this.explanationTextService.setExplanationText(resolved.text, { index: resolved.index });
    this.explanationTextService.setShouldDisplayExplanation(true);
  }

  // Resolve the display-order question (shuffle-aware) for an index.
  private resolveDisplayQuestion(qIdx: number): any {
    const _isShufEC = this.quizService?.isShuffleEnabled?.()
      && this.quizService?.shuffledQuestions?.length > 0;
    return _isShufEC
      ? (this.quizService?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? this.quizService?.shuffledQuestions?.[qIdx]
        ?? this.quizService?.questions?.[qIdx])
      : this.quizService?.questions?.[qIdx];
  }

  // Resolve correct count + texts from pristine quizInitialState, falling back
  // to the raw question's options.
  private resolveCorrectInfo(rawQ: any): { correctCount: number; correctTexts: string[] } {
    let correctCount = 0;
    let correctTexts: string[] = [];
    try {
      const pq = this.quizService?.getPristineQuestionByText(rawQ?.questionText);
      if (pq) {
        const pOpts = (pq.options ?? []).filter(
          (o: any) => isOptionCorrect(o)
        );
        correctCount = pOpts.length;
        correctTexts = pOpts.map((o: any) => norm(o?.text)).filter((t: string) => !!t);
      }
    } catch (err: unknown) { swallow('quiz-setup.service.ts', err); /* ignore */ }
    if (correctCount === 0) {
      const rawOpts: any[] = rawQ?.options ?? [];
      correctCount = rawOpts.filter(
        (o: any) => isOptionCorrect(o)
      ).length;
      correctTexts = rawOpts
        .filter((o: any) => isOptionCorrect(o))
        .map((o: any) => norm(o?.text))
        .filter((t: string) => !!t);
    }
    return { correctCount, correctTexts };
  }

  // Whether the question is scored correct (shuffle-aware) or FET-bypassed.
  private resolveScoredCorrect(qIdx: number): boolean {
    let scoredCorrect = false;
    try {
      const scoringSvc = this.quizService?.scoringService;
      const isShuf = this.quizService?.isShuffleEnabled?.() && this.quizService?.shuffledQuestions?.length > 0;
      if (isShuf && scoringSvc?.questionCorrectness) {
        let effectiveQuizId = this.quizService?.quizId || '';
        if (!effectiveQuizId) {
          try { effectiveQuizId = localStorage.getItem('lastQuizId') || ''; } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
        }
        if (effectiveQuizId) {
          const origIdx = scoringSvc.quizShuffleService?.toOriginalIndex?.(effectiveQuizId, qIdx);
          if (typeof origIdx === 'number' && origIdx >= 0) {
            scoredCorrect = scoringSvc.questionCorrectness.get(origIdx) === true;
          }
        }
      } else {
        scoredCorrect = scoringSvc?.questionCorrectness?.get(qIdx) === true;
      }
      if (!scoredCorrect) {
        scoredCorrect = this.explanationTextService.fetBypassForQuestion?.get(qIdx) === true;
      }
    } catch (err: unknown) { swallow('quiz-setup.service.ts', err); /* ignore */ }
    return scoredCorrect;
  }

  // Multi-answer FET gate: ready once all pristine-correct texts are selected,
  // or the question is otherwise scored correct.
  private isMultiAnswerReadyForExplanation(qIdx: number, correctTexts: string[]): boolean {
    const selections = this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
    const selTexts = new Set(
      selections
        .filter((s: any) => s?.selected !== false)
        .map((s: any) => norm(s?.text))
        .filter((t: string) => !!t)
    );
    const allCorrectSelected = correctTexts.length > 0
      && correctTexts.every((t: string) => selTexts.has(t));
    if (allCorrectSelected) return true;
    return this.resolveScoredCorrect(qIdx);
  }

  // ─── Lifecycle / event wrappers ──────────────────────────────

  private bridgeQuestionPayload(host: Host): void {
    this.quizService.questionPayload$
      .pipe(
        filter((p): p is QuestionPayload => !!p && !!p.question && Array.isArray(p.options) && p.options.length > 0)
      )
      .subscribe((payload) => {
        // URL-MISMATCH GUARD: when the user has navigated directly to
        // /question/.../5 but a stale or default-Q1 payload is emitted
        // afterwards, the original code would overwrite the freshly-
        // loaded Q5 view with Q1's question + options. Cross-check the
        // payload's questionText against the URL-derived question and
        // drop emissions that don't belong to the current page.
        try {
          const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
          if (m) {
            const urlIdx = Number(m[1]) - 1;
            const urlQuestion = this.quizService.questions?.[urlIdx];
            const urlText = norm(urlQuestion?.questionText);
            const payloadText = norm(payload.question?.questionText);
            if (urlText && payloadText && urlText !== payloadText) {
              return;  // skip stale payload that doesn't match the URL question
            }
          }
        } catch (err: unknown) { swallow('quiz-setup.service.ts', err); /* non-browser env */ }

        host.combinedQuestionData.set(payload);
        host.questionToDisplaySig.set(payload.question.questionText?.trim() ?? '');
        host.cdRef.markForCheck();
      });
  }

  async runOnInit(host: Host): Promise<void> {
    const quizId = await this.initializeQuizSession(host);
    if (!quizId) return;

    const freshFromResults = this.applyFreshStartHandling(host);

    this.fetchTotalQuestions(host);
    this.subscribeToQuestionIndex(host);
    this.bridgeQuestionPayload(host);

    await this.loadQuestions(host);
    host.isQuizLoaded.set(true);

    this.restoreAnsweredFromDotStatus(host);
    this.restoreSavedProgress(host, freshFromResults);
    this.applyInitialIndexAndTimer(host);

    this.wireRouteSubscriptions(host);

    host.quizInitializationService.initializeAnswerSync(host.destroyRef);
    host.resetQuestionState();
    this.applyAnsweredOnRefresh(host);

    if (freshFromResults) {
      this.scheduleFreshStartClear(host);
    }
  }

  // Wire questions stream + route events, resolve the quizId (null = abort),
  // then persist it and initialize the starting question index.
  private async initializeQuizSession(host: Host): Promise<string | null> {
    host.questions$ = this.quizService.questions$;
    this.subscribeToRouteEvents(host);

    const quizId = await host.initializeQuizId();
    if (!quizId) return null;
    host.quizId.set(quizId);

    try { localStorage.setItem('lastQuizId', quizId); } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }

    host.initializeQuestionIndex();
    return quizId;
  }

  // Consume the fresh-start flag, reset on fresh start, and clear stale progress.
  private applyFreshStartHandling(host: Host): boolean {
    const freshFromResults = this.readFreshFromResults();
    if (freshFromResults) {
      this.performFreshStartReset(host);
    }

    const cleared = this.quizResetService.clearStaleProgressAndDotStateForFreshStart(
      host.currentQuestionIndex(), host.quizId(), host.totalQuestions()
    );
    if (cleared) host.progressSig.set(0);
    return freshFromResults;
  }

  // Read-and-consume the one-shot "fresh start from results" session flag.
  private readFreshFromResults(): boolean {
    let freshFromResults = false;
    try {
      freshFromResults = sessionStorage.getItem('freshStartFromResults') === 'true';
      sessionStorage.removeItem('freshStartFromResults');
    } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
    return freshFromResults;
  }

  // Wire timer-expiry, quiz setup, and route-param subscriptions (post-load).
  private wireRouteSubscriptions(host: Host): void {
    this.subscribeToTimerExpiry(host);

    this.setupQuiz(host);
    this.fetchRouteParams(host);
    this.subscribeRouterAndInit(host);
    this.subscribeToRouteParams(host);
  }

  // Full reset of service + persisted + session state on a fresh start from results.
  private performFreshStartReset(host: Host): void {
    this.quizResetService.performRestartServiceResets(host.quizId(), host.totalQuestions() || 20);
    this.dotStatusService.clearAllMaps();
    this.quizPersistence.clearClickConfirmedDotStatus(host.totalQuestions() || 20);
    this.quizPersistence.clearAllPersistedDotStatus(host.quizId());
    this.selectedOptionService.lastClickedCorrectByQuestion.clear();
    this.selectedOptionService.clearRefreshBackup();
    this.selectedOptionService.clearState();
    host.answeredQuestionIndices.clear();
    host.progressSig.set(0);
    try {
      for (let i = 0; i < 100; i++) {
        sessionStorage.removeItem('quiz_selection_' + i);
        sessionStorage.removeItem(SK_DISPLAY_MODE + i);
        sessionStorage.removeItem('feedbackText_' + i);
      }
      sessionStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      sessionStorage.removeItem('rawSelectionsMap');
      sessionStorage.removeItem('answeredQuestionIndices');
      sessionStorage.removeItem('quizProgress');
      sessionStorage.removeItem('quizProgressQuizId');
    } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
  }

  // Seed answeredQuestionIndices / progress from confirmed dot status.
  private restoreAnsweredFromDotStatus(host: Host): void {
    for (const [idx, status] of this.selectedOptionService.clickConfirmedDotStatus) {
      if (status === 'correct' || status === 'wrong') {
        host.answeredQuestionIndices.add(idx);
      }
    }
    if (host.answeredQuestionIndices.size > 0) {
      host.progressSig.set(Math.round((host.answeredQuestionIndices.size / host.totalQuestions()) * 100));
    }
  }

  // Restore persisted progress/indices from sessionStorage (non-fresh start only).
  private restoreSavedProgress(host: Host, freshFromResults: boolean): void {
    if (host.progressSig() === 0 && !freshFromResults) {
      try {
        const savedQuizId = sessionStorage.getItem('quizProgressQuizId');
        const savedProgress = sessionStorage.getItem('quizProgress');
        if (savedQuizId === host.quizId() && savedProgress) {
          const parsed = parseInt(savedProgress, 10);
          if (!isNaN(parsed) && parsed > 0) {
            host.progressSig.set(parsed);
          }
          const savedIndices = sessionStorage.getItem('answeredQuestionIndices');
          if (savedIndices) {
            const indices: number[] = JSON.parse(savedIndices);
            for (const idx of indices) {
              host.answeredQuestionIndices.add(idx);
            }
          }
        }
      } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
    }
  }

  // Commit the initial index, refresh its dot, and start its timer if unanswered.
  private applyInitialIndexAndTimer(host: Host): void {
    const initialIndex = host.currentQuestionIndex() || 0;
    this.quizService.setCurrentQuestionIndex(initialIndex);
    host.updateDotStatus(initialIndex);

    if (!this.selectedOptionService.isQuestionAnswered(initialIndex)) {
      this.timerService.restartForQuestion(initialIndex);
      setTimeout(() => {
        if (!this.selectedOptionService.isQuestionAnswered(initialIndex)) {
          this.timerService.restartForQuestion(initialIndex);
        }
      }, 300);
    }
    Promise.resolve().then(() => host.cdRef.markForCheck());
  }

  // On refresh of an already-answered question, re-enable answered/Next state.
  private applyAnsweredOnRefresh(host: Host): void {
    const confirmedStatus = this.selectedOptionService.clickConfirmedDotStatus.get(host.currentQuestionIndex());
    const isAnsweredOnRefresh = confirmedStatus === 'correct' || confirmedStatus === 'wrong';
    if (isAnsweredOnRefresh) {
      setTimeout(() => {
        this.selectedOptionService.setAnswered(true, true);
        this.selectedOptionService.setNextButtonEnabled(true);
        this.nextButtonStateService.forceEnable(60000);
        host.cdRef.markForCheck();
      }, 100);
    }
  }

  // Deferred clear of answered/progress after a fresh start from results.
  private scheduleFreshStartClear(host: Host): void {
    setTimeout(() => {
      host.answeredQuestionIndices.clear();
      host.progressSig.set(0);
      host.cdRef.markForCheck();
    }, 150);
  }

  runOnDestroy(host: Host): void {
    try { host.subscriptions?.unsubscribe(); } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
    try { this.dotStatusService.dotStatusCache.clear(); } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
    try { this.dotStatusService.pendingDotStatusOverrides.clear(); } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
    try { this.dotStatusService.activeDotClickStatus.clear(); } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
    try { this.timerService.stopTimer(undefined, { force: true }); } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
    try { this.nextButtonStateService.cleanupNextButtonStateStream(); } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
    const tooltip = host.nextButtonTooltip?.();
    if (tooltip) {
      try {
        tooltip.disabled = true;
        tooltip.hide();
      } catch (err: unknown) { swallow('quiz-setup.service.ts', err); }
    }
  }

  async runAfterViewInit(host: Host): Promise<void> {
    setTimeout(() => host.checkScrollIndicator(), 500);
    void host.quizQuestionLoaderService.loadQuestionContents(host.currentQuestionIndex());

    if (host.quizQuestionLoaderService.pendingOptions?.length) {
      const opts = host.quizQuestionLoaderService.pendingOptions;
      host.quizQuestionLoaderService.pendingOptions = null;
      Promise.resolve().then(() => {
        const qqcLate = host.quizQuestionComponent?.();
        if (qqcLate && opts?.length) {
          qqcLate.optionsToDisplay.set([...opts]);
        }
      });
    }

  }

  async runOnGlobalKey(host: Host, event: KeyboardEvent): Promise<void> {
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    // Number keys 1–9 select the matching answer option. We click the
    // option's native input rather than re-implementing the selection
    // logic, so the keyboard path is identical to a mouse click and
    // can't drift from the (fragile) click pipeline.
    if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      this.selectOptionByKeyboard(Number(event.key) - 1, event);
      return;
    }

    const currentIdx = this.quizService.getCurrentQuestionIndex();

    switch (event.key) {
      case 'ArrowRight':
      case 'Enter': {
        if (host.shouldShowNextButton()) {
          // Advance only when the CURRENT question is genuinely answered — OR
          // its timer has expired (auto-advance is allowed even if unanswered).
          // nextButtonEnabled() alone isn't reliable: several navigation paths
          // force-enable it, which would let ArrowRight skip ahead on an
          // unanswered question. isQuestionAnswered() is durable (survives
          // navigate-back), so a revisited-but-answered question still advances.
          const answered =
            this.quizStateService.isQuestionAnswered(currentIdx) ||
            this.selectedOptionService.isQuestionAnswered(currentIdx);
          const timerExpired =
            this.timerService.expiredForQuestionIndexSig() === currentIdx;
          if ((!answered && !timerExpired) || !host.nextButtonEnabled()) return;
          event.preventDefault();
          await host.advanceToNextQuestion();
          return;
        }
        // Show Results is already self-gated by shouldShowResultsButton
        // (isCompletedInSession / _hasUserInteracted / timerExpiredUnanswered).
        if (host.shouldShowResultsButton) {
          event.preventDefault();
          host.advanceToResults();
          return;
        }
        break;
      }
      case 'ArrowLeft': {
        // Backward navigation is always allowed (matches the Previous button,
        // which has no selection gate) — unlike ArrowRight/Enter above, which
        // require an answer to advance.
        if (currentIdx > 0) {
          event.preventDefault();
          await host.advanceToPreviousQuestion();
        }
        break;
      }
    }
  }

  // Selects the option at displayIndex by clicking its native input,
  // mirroring a real mouse click through the existing pipeline.
  private selectOptionByKeyboard(displayIndex: number, event: KeyboardEvent): void {
    // Never hijack number keys while a dialog (e.g. restart confirm) is open.
    if (document.querySelector('.cdk-overlay-container .mat-mdc-dialog-container')) return;

    const rows = document.querySelectorAll<HTMLElement>('.options-group .option-row');
    const row = rows[displayIndex];
    if (!row) return;

    const input = row.querySelector<HTMLInputElement>('input');
    if (!input || input.disabled) return;

    event.preventDefault();
    input.click();
  }
}