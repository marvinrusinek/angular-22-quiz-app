import { Service, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute, ActivatedRouteSnapshot, Router } from '@angular/router';
import { firstValueFrom, Observable, of, Subject } from 'rxjs';
import { catchError, take } from 'rxjs/operators';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { NextButtonStateService } from '../state/next-button-state.service';
import { OptionLockStateService } from '../state/option-lock-state.service';
import { QqcQuestionLoaderService } from '../features/qqc/qqc-question-loader.service';
import { QuizDataService } from '../data/quizdata.service';
import { QuizQuestionManagerService } from '../flow/quizquestionmgr.service';
import { QuizService } from '../data/quiz.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { TimerService } from '../features/timer/timer.service';
import { SK_CORRECT_ANSWERS_COUNT, SK_SAVED_QUESTION_INDEX, SK_SELECTED_OPTIONS_MAP, SK_USER_ANSWERS } from '../../constants/session-keys';

import { swallow } from '../../utils/error-logging';

@Service()
export class QuizNavigationService {
  // ── injects ─────────────────────────────────────────────────────
  private activatedRoute = inject(ActivatedRoute);
  private explanationTextService = inject(ExplanationTextService);
  private nextButtonStateService = inject(NextButtonStateService);
  private optionLockState = inject(OptionLockStateService);
  private quizDataService = inject(QuizDataService);
  private quizQuestionLoaderService = inject(QqcQuestionLoaderService);
  private quizQuestionManagerService = inject(QuizQuestionManagerService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private router = inject(Router);
  private selectedOptionService = inject(SelectedOptionService);
  private timerService = inject(TimerService);

  // ── signals ─────────────────────────────────────────────────────
  /** Signal-first source of truth for backward-navigation state */
  readonly isNavigatingToPreviousSig = signal<boolean>(false);
  private readonly isNavigatingToPrevious$ = toObservable(this.isNavigatingToPreviousSig);

  // ── properties ──────────────────────────────────────────────────
  private quizId = '';

  isNavigating = false;
  quizCompleted = false;

  private navigationSuccessSubject = new Subject<void>();
  navigationSuccess$ = this.navigationSuccessSubject.asObservable();

  private navigatingBackSubject = new Subject<boolean>();
  navigatingBack$ = this.navigatingBackSubject.asObservable();

  private navigationToQuestionSubject = new Subject<{
    question: QuizQuestion,
    options: Option[]
  }>();
  public navigationToQuestion$ =
    this.navigationToQuestionSubject.asObservable();

  private explanationResetSubject = new Subject<void>();
  explanationReset$ = this.explanationResetSubject.asObservable();

  private resetUIForNewQuestionSubject = new Subject<void>();
  resetUIForNewQuestion$ = this.resetUIForNewQuestionSubject.asObservable();

  private renderResetSubject = new Subject<void>();
  renderReset$ = this.renderResetSubject.asObservable();

  // ── public methods ──────────────────────────────────────────────

  public async advanceToNextQuestion(): Promise<boolean> {
    if (this.isNavigating) return false;

    // Record elapsed time for current question before navigating
    const currentIndex = this.quizService.getCurrentQuestionIndex();
    if (currentIndex >= 0) {
      // Get elapsed time from the timer's current value if not already stored
      const currentElapsed = this.timerService.elapsedTimeSig() ?? 0;
      if (!this.timerService.elapsedTimes[currentIndex] && currentElapsed > 0) {
        this.timerService.elapsedTimes[currentIndex] = currentElapsed;
      }
    }

    try { this.resetExplanationAndState(); } catch (err: unknown) {
      console.error('QuizNavigationService.advanceToNextQuestion explanation reset failed:', err);
    }

    return await this.navigateWithOffset(1);  // defer navigation until state is clean
  }

  public async advanceToPreviousQuestion(): Promise<boolean> {
    // Signal backward navigation so display pipeline suppresses FET
    this.isNavigatingToPreviousSig.set(true);

    try {
      // Do not wipe everything; only clear transient display flags if necessary
      this.quizStateService.setLoading(false);

      // Clear only ephemeral fields (no deep reset)
      (this as any).displayExplanation = false;
      (this as any).explanationToDisplay = '';
      this.explanationTextService.setShouldDisplayExplanation(false);
    } catch (err: unknown) { swallow('quiz-navigation.service.ts', err); }

    const result = await this.navigateWithOffset(-1);

    // The flag is NOT reset on a timer — it stays set so the revisited question
    // keeps its question text until the user actually answers again (cleared via
    // setIsNavigatingToPrevious(false) on a genuine option selection). The old
    // ~500ms reset is what let the FET watchdog re-assert the FET "a second
    // later" on revisit.

    return result;
  }

  private async navigateWithOffset(offset: number): Promise<boolean> {
    const currentRouteIndex = this.readQuestionIndexFromRouterSnapshot();
    
    const targetRouteIndex = currentRouteIndex + offset;

    // Simple Bounds Safety (only check min)
    if (targetRouteIndex < 1) return false;

    return this.navigateToQuestion(targetRouteIndex - 1);
  }

  public async navigateToQuestion(index: number): Promise<boolean> {
    // Suppress the FET / explanation on EVERY navigation. This is exactly what
    // advanceToPreviousQuestion did, which is why ArrowLeft/Previous showed the
    // question text while a dot (which calls navigateToQuestion directly) showed
    // the FET. Doing it here — the common funnel for Prev/Next buttons, dots and
    // both arrow keys — makes all navigation methods behave identically: the
    // heading reverts to question text on revisit. The FET belongs to the live
    // answer view only; selections/scoring state is untouched.
    try {
      // Set the same backward-nav flag advanceToPreviousQuestion sets — the
      // displayText pipeline reads it (resolveDisplayText) to render question
      // text instead of the FET. Setting it here for EVERY navigation is what
      // makes dots and Next behave like ArrowLeft/Previous.
      this.isNavigatingToPreviousSig.set(true);
      (this as any).displayExplanation = false;
      (this as any).explanationToDisplay = '';
      this.explanationTextService.setShouldDisplayExplanation(false);
      // Arriving at a question is a fresh visit: drop any "interacted this visit"
      // mark for it so a previously-answered question shows its question text on
      // return (re-set only when the user clicks again this visit).
      this.quizStateService.clearInteractedThisVisit(index);
    } catch (err: unknown) { swallow('quiz-navigation.service.ts', err); }

    // HARD reset render state before route change
    this.resetRenderStateBeforeNavigation(index);

    try {
      return await this.performNavigation(index);
    } catch (err: unknown) {
      console.error('QuizNavigationService.navigateToQuestion navigation failed:', err);
      return false;
    } finally {
      this.isNavigating = false;
      this.quizStateService.setNavigating(false);
      this.quizStateService.setLoading(false);
      // The nav flag is intentionally NOT reset here — it stays set so the
      // revisited question keeps its question text until the user answers again
      // (cleared in setIsNavigatingToPrevious(false) on a genuine selection).
    }
  }

  // The navigation body: route, reset timer/state, fetch+emit, finalize.
  // Returns false on a failed router nav or fetch. Throws propagate to
  // navigateToQuestion's catch; its finally always clears the navigating flags.
  private async performNavigation(index: number): Promise<boolean> {
    // Snapshot the CURRENT (source) question's selections for revisit repaint,
    // BEFORE router nav updates the index and the selection stores are cleared.
    // Display-only — does NOT feed the selection stores the auto-reveal reads.
    this.captureRevisitDisplayForSource(index);

    // Set navigating state
    this.isNavigating = true;
    this.quizStateService.setNavigating(true);
    this.quizStateService.setLoading(true);

    // Perform Router Navigation
    const navSuccess = await this.performRouterNavigation(index);
    if (!navSuccess) return false;

    // Reset timer state before emitting the new index to avoid immediate expiry
    this.timerService.stopTimer(undefined, { force: true });
    this.timerService.resetTimer();
    this.timerService.resetTimerFlagsFor(index);

    this.clearStaleNavigationState(index);

    // Update Service State (Index) - Update AFTER router nav success
    this.quizService.setCurrentQuestionIndex(index);

    // Reset UI States for New Question
    this.resetExplanationAndState();
    this.selectedOptionService.setAnswered(false, true);

    // Clear all option selections when navigating to new question
    this.nextButtonStateService.reset();
    this.quizQuestionLoaderService.resetUI();

    // Fetch New Question Data
    const fresh = await this.fetchAndEmitQuestion(index);
    if (!fresh) return false;

    this.applyDestinationAnsweredState(index);

    // Finalize
    this.notifyNavigationSuccess();
    // Selection message is derived automatically via
    // SelectionMessageService.computedNavMessage (a computed signal that
    // re-fires whenever currentQuestionIndexSig changes). No imperative
    // push needed here — and the dot-nav path benefits the same way.

    return true;
  }

  // Clear stale selections on both source AND destination unless the
  // question is timer-locked (then preserve the timeout-revealed state).
  // Per user requirement: questions should be COMPLETELY CLEAN on
  // revisit, regardless of what was clicked first visit. The old
  // `_multiAnswerPerfect` union was previously used as a "preserve correct
  // state" gate but it was being set by buggy paths even on wrong-only clicks.
  // Snapshot the source (current) question's selected option texts into the
  // display-only revisit store so a later revisit can repaint the first-visit
  // colors. Runs at nav entry, before the index/selection stores change.
  private captureRevisitDisplayForSource(destIndex: number): void {
    try {
      const srcIdx = this.quizService.getCurrentQuestionIndex();
      if (srcIdx < 0 || srcIdx === destIndex) return;

      // Prefer the RELIABLE, auto-reveal-invisible uiSelectedTexts signal (live
      // bindings ∪ prior snapshot, kept current each CD by the shared-option
      // component). getSelectedOptionsForQuestion is flaky for multi-answer and
      // can momentarily return empty, which previously wiped the remembered set
      // and left a revisited question with no colors. Fall back to it only when
      // the signal hasn't been populated yet.
      // Union ALL available sources so the first-visit pick is captured even when
      // the uiSelectedTexts signal reads racy-empty. _selectionHistory is the
      // DETERMINISTIC source: written synchronously on every click and still
      // intact here (cleared only later, in clearStaleNavigationState).
      const texts = new Set<string>();
      const uiTexts = this.selectedOptionService.uiSelectedTextsForQuestion(srcIdx);
      if (uiTexts) for (const t of uiTexts) texts.add(t);
      for (const t of this.selectedOptionService.getSelectionHistoryTextsForQuestion(srcIdx)) texts.add(t);
      if (texts.size === 0) {
        const sel = this.selectedOptionService.getSelectedOptionsForQuestion(srcIdx) ?? [];
        for (const s of sel) {
          if (s && (s.selected || s.highlight || s.showIcon) && typeof s.text === 'string' && s.text.length > 0) {
            texts.add(s.text);
          }
        }
      }
      this.selectedOptionService.captureRevisitDisplay(srcIdx, [...texts]);
    } catch (err: unknown) { swallow('performNavigation revisit-display capture', err); }
  }

  private clearStaleNavigationState(index: number): void {
    const isResolved = (idx: number) => this.optionLockState.isQuestionLocked(idx);
    const sourceIdx = this.quizService.getCurrentQuestionIndex();

    // Whether a question was actually scored correct (questionCorrectness).
    // In shuffled mode questionCorrectness is keyed by ORIGINAL index (set by
    // scoreDirectly), so map display→original before checking.
    const _isScoredAt = (idx: number): boolean => {
      if (this.quizService.questionCorrectness?.get?.(idx) === true) return true;
      try {
        const qs: any = this.quizService;
        const isShuf = qs?.isShuffleEnabled?.() && qs?.shuffledQuestions?.length > 0;
        if (isShuf) {
          let eqId = qs?.quizId || '';
          if (!eqId) { try { eqId = localStorage.getItem('lastQuizId') || ''; } catch (err: unknown) { swallow('quiz-navigation.service.ts', err); } }
          if (eqId) {
            const origIdx = qs?.scoringService?.quizShuffleService?.toOriginalIndex?.(eqId, idx);
            if (typeof origIdx === 'number' && origIdx >= 0) {
              return this.quizService.questionCorrectness?.get?.(origIdx) === true;
            }
          }
        }
      } catch (err: unknown) { swallow('quiz-navigation.service.ts', err); /* ignore */ }
      return false;
    };

    // Clear stale selections on both source AND destination. Always run the full
    // clear (unlock options, wipe per-question sessionStorage, push the reactive
    // signal) so navigation state stays consistent — skipping it entirely leaves
    // options locked and freezes navigation. But for a question that was actually
    // scored correct, PRESERVE its _selectionHistory (preserveHistory=true) so
    // revisit can re-render its clicked-wrong option red (wasClickedIncorrectOn-
    // Revisit reads that history). Wrong-only questions clear it → clean revisit,
    // keeping the autoreveal "all incorrects selected" bug fixed.
    if (sourceIdx >= 0 && sourceIdx !== index && !isResolved(sourceIdx)) {
      this.selectedOptionService.clearSelectionsForQuestion(sourceIdx, _isScoredAt(sourceIdx));
    }
    if (!isResolved(index)) {
      this.selectedOptionService.clearSelectionsForQuestion(index, _isScoredAt(index));
    }

    // Wipe the answer state for the destination unless the question was
    // actually scored correct. For a genuinely perfectly-answered question we
    // WANT the flag preserved so revisit re-renders the green/gray highlight;
    // only buggy stale flags need wiping, and those won't have questionCorrectness.
    // The split states clear on exactly the same boundary as the union.
    const _wipeAt = (i: number) => {
      this.quizService.clearAnswerStateAt(i);
    };
    const _scoredDest = _isScoredAt(index);
    if (!_scoredDest) _wipeAt(index);
    if (sourceIdx >= 0 && sourceIdx !== index && !_isScoredAt(sourceIdx)) {
      _wipeAt(sourceIdx);
    }
  }

  private applyDestinationAnsweredState(index: number): void {
    // Correctly-answered destination on revisit: freeze the timer at the
    // recorded seconds-remaining. Gate ONLY on the durable dot-status — a
    // selection-based check falsely fires for unanswered questions holding
    // stale selections, flashing them to a bogus 0:00.
    if (this.selectedOptionService.clickConfirmedDotStatus?.get?.(index) === 'correct') {
      this.timerService.freezeAtRecordedTime(index);
    }

    // INDEX-MODEL REWRITE (Phase 2): deterministically re-derive the answered
    // state for the destination from the DURABLE per-display-index answered
    // flag (markQuestionAnswered, written by handleOptionClick on completion).
    // This flag survives the selection-store clear above, so it's the
    // authoritative "was this question answered" signal on revisit — replacing
    // the racy re-derivation stream that intermittently left Next disabled.
    // Only ENABLE (never disable) so a genuinely-unanswered destination is
    // unaffected.
    if (this.quizStateService.isQuestionAnswered(index)) {
      this.quizStateService.setAnswered(true);
      this.selectedOptionService.setAnswered(true, true);
    }
  }

  private async performRouterNavigation(index: number): Promise<boolean> {
    const quizId = this.resolveEffectiveQuizId();
    if (!quizId) return false;

    this.quizId = quizId;
    this.quizService.setQuizId(quizId);

    const routeUrl = `/quiz/question/${quizId}/${index + 1}`;
    const currentUrl = this.router.url;
    const currentIndex = this.quizService.getCurrentQuestionIndex();

    // Handle same-URL reload scenario
    if (currentIndex === index && currentUrl === routeUrl) {
      await this.router.navigateByUrl('/', { skipLocationChange: true });
    }

    const navSuccess = await this.router.navigateByUrl(routeUrl);
    return navSuccess;
  }

  private async fetchAndEmitQuestion(index: number): Promise<any> {
    const fresh = await firstValueFrom(
      this.quizService.getQuestionByIndex(index)
    );
    if (!fresh) return null;

    this.quizService.setCurrentQuestionIndex(index);

    // Reset FET caches
    try {
      const ets: any = this.explanationTextService;
      ets._activeIndex = index;
      ets.formattedExplanationSig.set('');
      ets.shouldDisplayExplanationSubject?.next(false);
      ets.isExplanationTextDisplayedSubject?.next(false);

      if (ets._byIndex) {
        for (const subj of ets._byIndex.values()) subj?.next?.('');
      }

      if (ets._gate) {
        for (const gate of ets._gate.values()) gate?.next?.(false);
      }
    } catch (err: unknown) {
      console.error('QuizNavigationService.fetchAndEmitQuestion FET cache reset failed:', err);
    }

    // Prepare text
    const isMulti =
      (fresh.type as any) === QuestionType.MultipleAnswer ||
      (Array.isArray(fresh.options) &&
        fresh.options.filter((o) => o.correct).length > 1);

    const trimmedQ = (fresh.questionText ?? '').trim();
    const explanationRaw = (fresh.explanation ?? '').trim();
    const numCorrect = (fresh.options ?? []).filter((o) => o.correct).length;
    const totalOpts = (fresh.options ?? []).length;

    const banner = isMulti
      ? this.quizQuestionManagerService.getNumberOfCorrectAnswersText(
        numCorrect,
        totalOpts
      )
      : '';

    // WAIT for DOM to stabilize before final emission
    const qqls = this.quizQuestionLoaderService;
    await qqls.waitForDomStable(32);

    qqls._frozen = false;
    qqls._isVisualFrozen = false;
    qqls._renderFreezeUntil = 0;
    qqls._quietZoneUntil = performance.now() - 1;
    qqls.quietZoneUntilSig?.set(qqls._quietZoneUntil);

    const ets: any = this.explanationTextService;
    ets._hardMuteUntil = performance.now() - 1;

    // Emit question and banner
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        try {
          qqls.emitQuestionTextSafely(trimmedQ, index);

          requestAnimationFrame(() => {
            this.quizService.updateCorrectAnswersText(banner);
          });

          resolve();
        } catch {
          qqls._frozen = false;
          qqls._isVisualFrozen = false;
          resolve();
        }
      });
    });

    return { fresh, explanationRaw };
  }

  public async resetUIAndNavigate(
    index: number,
    quizIdOverride?: string
  ): Promise<boolean> {
    try {
      const effectiveQuizId = this.resolveEffectiveQuizId(quizIdOverride);
      if (!effectiveQuizId) return false;

      if (quizIdOverride && this.quizService.quizId !== quizIdOverride) {
        this.quizService.setQuizId(quizIdOverride);
      }

      this.quizId = effectiveQuizId;

      // Fresh start guard: entering Q1 from intro/start should never reuse stale
      // same-tab score or selection state.
      if (index === 0) {
        this.quizService.resetScore();
        this.quizService.questionCorrectness.clear();
        this.quizService.selectedOptionsMap.clear();
        this.quizService.userAnswers = [];
        this.quizService.answers = [];
        this.selectedOptionService.resetSelectionState();
        this.selectedOptionService.clearAllSelectionsForQuiz(effectiveQuizId);

        try {
          localStorage.setItem(SK_SAVED_QUESTION_INDEX, '0');
          localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, '0');
          localStorage.removeItem('questionCorrectness');
          localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
          localStorage.removeItem(SK_USER_ANSWERS);
          sessionStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
        } catch (err: unknown) { swallow('quiz-navigation.service.ts', err); }
      }

      // Always ensure the quiz session is hydrated before attempting to access questions.
      await this.ensureSessionQuestions(effectiveQuizId);

      // Set question index in service so downstream subscribers know what we're targeting.
      this.quizService.setCurrentQuestionIndex(index);

      const question = await this.tryResolveQuestion(index);
      if (question) {
        this.quizService.setCurrentQuestion(question);

        const quiz = this.quizService.getActiveQuiz();
        const totalQuestions = quiz?.questions?.length ?? 0;
        if (totalQuestions > 0) {
          this.quizService.updateBadgeText(index + 1, totalQuestions);
        }
      }

      const routeUrl = `/quiz/question/${effectiveQuizId}/${index + 1}`;
      if (this.router.url === routeUrl) return true;

      const navSuccess = await this.router.navigateByUrl(routeUrl);
      return navSuccess;
    } catch (err: unknown) {
      console.error('QuizNavigationService.resetUIAndNavigate navigation failed:', err);
      return false;
    }
  }

  public resolveEffectiveQuizId(quizIdOverride?: string): string | null {
    if (quizIdOverride) {
      this.quizId = quizIdOverride;
      return quizIdOverride;
    }

    if (this.quizService.quizId) {
      this.quizId = this.quizService.quizId;
      return this.quizService.quizId;
    }

    if (this.quizId) return this.quizId;

    const routeQuizId = this.readQuizIdFromRouterSnapshot();
    if (routeQuizId) {
      this.quizId = routeQuizId;
      this.quizService.setQuizId(routeQuizId);
      return routeQuizId;
    }

    try {
      const stored = localStorage.getItem('quizId');
      if (stored) {
        this.quizId = stored;
        this.quizService.setQuizId(stored);
        return stored;
      }
    } catch (err) {
      swallow('quiz-navigation.service#1', err);
    }

    return null;
  }

  public async ensureSessionQuestions(quizId: string): Promise<void> {
    try {
      await firstValueFrom(
        this.quizDataService.prepareQuizSession(quizId).pipe(
          take(1),
          catchError(() => {
            return of([]);
          })
        )
      );
    } catch (err: unknown) {
      console.error('QuizNavigationService.ensureSessionQuestions session hydration failed:', err);
    }
  }

  public async tryResolveQuestion(index: number): Promise<QuizQuestion | null> {
    try {
      return await firstValueFrom(
        this.quizService.getQuestionByIndex(index).pipe(
          catchError(() => {
            return of(null);
          })
        )
      );
    } catch (err: unknown) {
      console.error('QuizNavigationService.tryResolveQuestion question resolution failed:', err);
      return null;
    }
  }

  private resetExplanationAndState(): void {
    // Immediately reset explanation-related state to avoid stale data
    this.explanationTextService.resetExplanationState();
    this.quizStateService.setDisplayState({
      mode: 'question',
      answered: false
    });

    // Clear the old Q&A state before starting navigation
    this.quizQuestionLoaderService.clearQA();
  }

  public notifyNavigationSuccess(): void {
    this.navigationSuccessSubject.next();
  }

  private readQuizIdFromRouterSnapshot(): string | null {
    const direct = this.activatedRoute.snapshot.paramMap.get('quizId');
    if (direct) return direct;

    let snapshot: ActivatedRouteSnapshot | null =
      this.router.routerState.snapshot.root;
    while (snapshot) {
      const value = snapshot.paramMap?.get('quizId');
      if (value) return value;
      snapshot = snapshot.firstChild ?? null;
    }

    return null;
  }

  private readQuestionIndexFromRouterSnapshot(): number {
    const fromActiveRoute = this.activatedRoute.snapshot.paramMap.get('questionIndex');
    const parsedFromActiveRoute = Number.parseInt(fromActiveRoute ?? '', 10);
    if (Number.isFinite(parsedFromActiveRoute) && parsedFromActiveRoute > 0) {
      return parsedFromActiveRoute;
    }

    let snapshot: ActivatedRouteSnapshot | null =
      this.router.routerState.snapshot.root;
    while (snapshot) {
      const value = snapshot.paramMap?.get('questionIndex');
      const parsed = Number.parseInt(value ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      snapshot = snapshot.firstChild ?? null;
    }

    // Last-resort fallback to service index (0-based -> 1-based)
    return (this.quizService.getCurrentQuestionIndex?.() ?? 0) + 1;
  }

  public resetRenderStateBeforeNavigation(_targetIndex: number): void {
    // Heading is rendered by the single-source headingHtml computed; the legacy
    // stamp-target-question-text + nav-lock MutationObserver (stampTargetQuestion
    // AndLock) are no longer needed and have been removed.
    this.resetExplanationDisplayState();
  }

  // Shut down explanation display state and reset to question mode immediately.
  private resetExplanationDisplayState(): void {
    this.explanationTextService.setShouldDisplayExplanation(false, {
      force: true
    });
    this.explanationTextService.setIsExplanationTextDisplayed(false);
    this.explanationTextService.closeAllGates();

    // Drop any lingering question text
    try {
      this.quizQuestionLoaderService?.questionToDisplaySig?.set('');
    } catch (err: unknown) { swallow('quiz-navigation.service.ts', err); }

    // Reset to question mode so next frame starts clean
    this.quizStateService.setDisplayState({
      mode: 'question',
      answered: false
    });
    this.quizStateService.setExplanationReady(false);
  }


  /**
   * Records elapsed time for the leaving question, stops the timer,
   * and navigates to results. Returns true if navigation was triggered.
   */
  recordElapsedAndGoToResults(currentQuestionIndex: number): void {
    const idx = this.quizService.getCurrentQuestionIndex?.() ?? currentQuestionIndex;
    const elapsed = this.timerService.elapsedTimeSig() ?? 0;
    if (idx != null && idx >= 0 && !this.timerService.elapsedTimes[idx] && elapsed > 0) {
      this.timerService.elapsedTimes[idx] = elapsed;
    }
    if (this.timerService.isTimerRunning) {
      this.timerService.stopTimer(() => {}, { force: true });
    }
    this.quizCompleted = true;
  }

  navigateToResults(): void {
    if (this.quizCompleted) return;

    // Ensure we have a robust quizId
    const targetQuizId = this.quizId 
      || this.resolveEffectiveQuizId() 
      || this.quizService.quizId;
    if (!targetQuizId) return;

    this.quizCompleted = true;

    // Use correct route path: /quiz/results/:quizId (not just results/)
    const routePath = `/quiz/results/${targetQuizId}`;

    this.router.navigateByUrl(routePath)
      .then((success) => {
        if (!success) {
          console.warn('Quiz navigation was cancelled:', {
            routePath,
            currentUrl: this.router.url
          });

          return;
        }
      })
      .catch((error) => {
        console.error('Quiz navigation failed:', {
          routePath,
          error
        });
      });
  }

  setIsNavigatingToPrevious(value: boolean): void {
    this.isNavigatingToPreviousSig.set(value);
  }

  getIsNavigatingToPrevious(): Observable<boolean> {
    return this.isNavigatingToPrevious$;
  }

  // Reset navigation state when switching quizzes
  resetForNewQuiz(): void {
    this.quizCompleted = false;
    this.isNavigating = false;
  }
}