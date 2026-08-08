import { computed, inject, Service, OnDestroy, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Subject, Subscription, timer } from 'rxjs';
import { finalize, takeUntil, tap } from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { readSessionJson } from '../../../utils/session-storage';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { swallow } from '../../../utils/error-logging';

interface StopTimerAttemptOptions {
  questionIndex?: number,
  optionsSnapshot?: Option[],
  onBeforeStop?: () => void,
  onStop?: (elapsedMs?: number) => void  // allow elapsed to be delivered
}

@Service()
export class TimerService implements OnDestroy {
  timePerQuestion = 30;
  completionTime = Number(sessionStorage.getItem('completionTime')) || 0;
  elapsedTimes: number[] = readSessionJson<number[]>('elapsedTimes', []);

  isTimerRunning = false;  // tracks whether the timer is currently running
  isTimerStoppedForCurrentQuestion = false;
  stoppedForQuestion = new Set<number>();

  // Signals
  private isStop = new Subject<void>();

  // Signal-first sources of truth
  readonly elapsedTimeSig = signal<number>(0);
  public elapsedTime$ = toObservable(this.elapsedTimeSig);

  private static _initTimerType(): 'countdown' | 'stopwatch' {
    try {
      return localStorage.getItem('timerType') === 'stopwatch'
        ? 'stopwatch' : 'countdown';
    } catch {
      return 'countdown';
    }
  }
  readonly timerTypeSig = signal<'countdown' | 'stopwatch'>(TimerService._initTimerType());
  public timerType$ = toObservable(this.timerTypeSig);
  /** Derived from timerTypeSig — single source of truth. */
  readonly isCountdown = computed(() => this.timerTypeSig() === 'countdown');

  readonly stopSig = signal<number>(0);
  public stop$ = toObservable(this.stopSig);

  private timerSubscription: Subscription | null = null;
  private stopTimerSignalSubscription: Subscription | null = null;

  private expiredSubject = new Subject<void>();
  public expired$ = this.expiredSubject.asObservable();

  private _authoritativeStop = false;
  private hasExpiredForRun = false;
  /** Signal version â€” read this in OnPush templates so Angular auto-tracks it. */
  public readonly expiredForQuestionIndexSig = signal(-1);

  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);

  constructor() {
    this.setupTimer();
    this.listenForCorrectSelections();
  }

  private setupTimer(): void {
    this.stopTimerSignalSubscription =
      this.selectedOptionService.stopTimer$.subscribe(() => {
        if (!this.isTimerRunning) return;
        this.stopTimer(undefined, { force: true });
      });
  }

  // NOTE: this service is providedIn: 'root', so ngOnDestroy only runs at app
  // teardown — by which point the page is going away regardless. It is kept as a
  // correctness backstop (and for any future non-root provision), NOT because it
  // reclaims anything meaningful today. Per-question teardown is handled by
  // stopTimer() and takeUntil(this.isStop).
  ngOnDestroy(): void {
    this.timerSubscription?.unsubscribe();
    this.stopTimerSignalSubscription?.unsubscribe();
  }

  private listenForCorrectSelections(): void {
    this.stopTimerSignalSubscription =
      this.selectedOptionService.stopTimer$.subscribe(() => {
        if (!this.isTimerRunning) return;
        this.handleStopTimerSignal();
      });
  }

  private handleStopTimerSignal(): void {
    if (!this.isTimerRunning) return;

    const activeQuestionIndex = this.normalizeQuestionIndex(
      this.quizService?.currentQuestionIndex
    );
    if (activeQuestionIndex < 0) {
      this.stopTimer(undefined, { force: true });
      return;
    }

    // Must grant authority before calling attemptStopTimerForQuestion
    this._authoritativeStop = true;

    const stopped = this.attemptStopTimerForQuestion({
      questionIndex: activeQuestionIndex,
      onStop: (elapsed?: number) => {
        if (elapsed != null && activeQuestionIndex != null) {
          this.elapsedTimes[activeQuestionIndex] = elapsed;
          this.saveTimerState();
        }
      }
    });

    if (!stopped) this.stopTimer(undefined, { force: true });
  }

  setTimerType(type: 'countdown' | 'stopwatch'): void {
    if (this.timerTypeSig() === type) return;

    this.timerTypeSig.set(type);
    try {
      localStorage.setItem('timerType', type);
    } catch {
      // ignore storage failures
    }
  }

  /**
   * Display index → the local-clock instant this question's signed deadline
   * expires, as authorized by its question receipt.
   *
   * Deliberately plain data: the deadline is PUSHED in by QuestionTimingService
   * once the receipt lands, so this service never has to know that receipts, or
   * an API, exist. Without an entry here `restartForQuestion` starts nothing —
   * a countdown that no server agreed to cannot authorize a timeout reveal, and
   * an unsigned one is exactly how the client used to time out ~30s early.
   */
  private readonly _deadlineByQuestion = new Map<number, number>();

  /** Records the signed deadline for a question. Does not start anything. */
  public setAuthorizedDeadline(questionIndex: number, deadlineMs: number): void {
    if (questionIndex == null || questionIndex < 0) return;
    this._deadlineByQuestion.set(questionIndex, deadlineMs);
  }

  /** True once this question has a signed deadline to count down to. */
  public hasAuthorizedDeadline(questionIndex: number): boolean {
    return this._deadlineByQuestion.has(questionIndex);
  }

  /** New attempt / new quiz: yesterday's deadlines authorize nothing. */
  public clearAuthorizedDeadlines(): void {
    this._deadlineByQuestion.clear();
  }

  /**
   * Count down to a signed deadline rather than to a locally-invented 30s.
   *
   * The remaining time is whatever is genuinely left, so a revisit resumes
   * where it was instead of restarting — the tick loop still counts elapsed
   * upward, it just starts partway in.
   */
  public startTimerUntil(deadlineMs: number): void {
    const remainingSeconds = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));

    if (remainingSeconds <= 0) {
      this.expireImmediately();
      return;
    }

    const alreadyElapsed = Math.max(0, this.timePerQuestion - remainingSeconds);
    this.startTimer(this.timePerQuestion, this.isCountdown(), true, alreadyElapsed);
  }

  /**
   * A question returned to after its deadline passed. It does not get a fresh
   * countdown — it is already over, so announce that and let the normal
   * authorized timeout path run.
   */
  private expireImmediately(): void {
    if (this.timerSubscription) {
      this.timerSubscription.unsubscribe();
      this.timerSubscription = null;
    }
    this.isTimerRunning = false;
    this.elapsedTimeSig.set(this.timePerQuestion);
    this.hasExpiredForRun = true;
    this.expiredForQuestionIndexSig.set(this.quizService.currentQuestionIndex);
    this.expiredSubject.next();
  }

  // Starts the timer
  startTimer(
    duration: number = this.timePerQuestion,
    isCountdown: boolean = true,
    forceRestart: boolean = false,
    startAtElapsedSeconds: number = 0
  ): void {
    if (this.isTimerStoppedForCurrentQuestion && !forceRestart) return;

    // Anti-thrash: ignore any (re)start that happens within 5s of a previous
    // start, regardless of running state. The init chain repeatedly fires
    // stop+start; suppressing the duplicates lets the tick stream survive.
    const nowMs = Date.now();
    // Once expired for this question, refuse all further starts until
    // restartForQuestion is called for a new question.
    if (this.hasExpiredForRun) return;
    
    if (this._lastStartedAtMs > 0 && (nowMs - this._lastStartedAtMs) < this.timePerQuestion * 1000) {
      // Re-arm running flag in case a rogue stop slipped through
      if (!this.isTimerRunning && this.timerSubscription) {
        this.isTimerRunning = true;
      }
      return;
    }

    if (this.isTimerRunning) {
      if (!forceRestart) return;  // prevent restarting an already running timer
      this.stopTimer(undefined, { force: true });
    }
    this._lastStartedAtMs = nowMs;

    if (forceRestart) this.isTimerStoppedForCurrentQuestion = false;

    this.isTimerRunning = true;  // mark timer as running
    this.hasExpiredForRun = false;

    // Show initial value immediately. Non-zero when resuming a question whose
    // signed deadline is already partly spent.
    const offset = Math.max(0, Math.min(duration, startAtElapsedSeconds));
    this.elapsedTimeSig.set(offset);

    // Start ticking after 1s so the initial value stays visible for a second
    const timer$ = timer(1000, 1000).pipe(
      tap((tick) => {
        // Tick starts at 0 after 1s â†’ elapsed = tick + 1 (1,2,3,â€¦)
        const elapsed = offset + tick + 1;

        this.elapsedTimeSig.set(elapsed);

        // If reached the duration, emit expiration once (stop only for countdown)
        if (elapsed >= duration && !this.hasExpiredForRun) {
          this.hasExpiredForRun = true;
          this.expiredForQuestionIndexSig.set(this.quizService.currentQuestionIndex);
          this.expiredSubject.next();
          if (isCountdown) this.stopTimer(undefined, { force: true });
        }
      }),
      takeUntil(this.isStop),
      finalize(() => {
        this.isTimerRunning = false;
      })
    );

    this.timerSubscription = timer$.subscribe();
  }

  // Stops the timer
  stopTimer(
    callback?: (elapsedTime: number) => void,
    options: { force?: boolean; bypassAntiThrash?: boolean } = {}
  ): void {
    // Authoritative Stop Guard: Blocks rogue direct calls
    if (!options.force && !this._authoritativeStop) return;

    // Reset authority immediately to prevent re-entry / double stop paths
    this._authoritativeStop = false;

    void options;  // prevent unused-parameter warning (intentional)

    // Capture the live elapsed for the current question BEFORE any early-return
    // below (anti-thrash / not-running). This is the central, path-agnostic
    // capture: whichever flow stops the timer on a correct answer records the
    // seconds taken, so a frozen revisit shows the right seconds-remaining.
    if (this.isTimerRunning) {
      const stopIdx = this.normalizeQuestionIndex(this.quizService?.currentQuestionIndex);
      const curElapsed = this.elapsedTimeSig();
      if (stopIdx >= 0 && typeof curElapsed === 'number' && curElapsed > 0 && !(this.elapsedTimes[stopIdx] > 0)) {
        this.elapsedTimes[stopIdx] = curElapsed;
      }
    }

    if (!this.isTimerRunning) return;

    // Anti-thrash: ignore stops fired immediately after a fresh start
    // (init-chain churn). Only honor stops once the timer has had a chance
    // to actually tick, OR if expiry has been reached.
    const sinceStart = Date.now() - this._lastStartedAtMs;
    if (sinceStart < this.timePerQuestion * 1000 && !this.hasExpiredForRun && !options.bypassAntiThrash) {
      return;
    }

    // End the ticking subscription
    if (this.timerSubscription) {
      this.timerSubscription.unsubscribe();
      this.timerSubscription = null;
    }

    this.isTimerRunning = false;  // mark the timer as stopped
    this.isTimerStoppedForCurrentQuestion = true;  // prevent restart for current question
    this.stopSig.update(v => v + 1);  // emit stop signal to stop the timer
    this.isStop.next();

    if (callback) callback(this.elapsedTimeSig());
  }

  // Resets the timer
  resetTimer(): void {

    // Anti-thrash: ignore resets after a start is in flight or after expiry,
    // until restartForQuestion explicitly clears the flags for a new question.
    if (this.hasExpiredForRun) return;

    const sinceStart = Date.now() - this._lastStartedAtMs;
    if (this._lastStartedAtMs > 0 && sinceStart < this.timePerQuestion * 1000) {
      return;
    }

    if (this.isTimerRunning) this.stopTimer(undefined, { force: true });

    this.isTimerRunning = false;
    this.isTimerStoppedForCurrentQuestion = false;  // allow restart for the new question
    this.hasExpiredForRun = false;

    this.elapsedTimeSig.set(0);  // reset elapsed time for observers
  }

  public attemptStopTimerForQuestion(
    options: StopTimerAttemptOptions = {}
  ): boolean {
    // Guard: NOTHING may stop the timer without authority
    if (!this._authoritativeStop) return false;

    const questionIndex = this.normalizeQuestionIndex(
      typeof options.questionIndex === 'number'
        ? options.questionIndex
        : this.quizService?.currentQuestionIndex
    );

    if (questionIndex == null || questionIndex < 0) return false;

    // If we get here, all correct answers are selected.
    // Mark this question as stopped FIRST so subsequent restartForQuestion
    // re-emits bail out, regardless of whether the underlying stopTimer
    // path runs (it may early-return when the timer isn't running, or be
    // rejected by anti-thrash without bypass).
    this.selectedOptionService.stopTimerEmitted = true;
    this.isTimerStoppedForCurrentQuestion = true;
    this.stoppedForQuestion.add(questionIndex);

    // If the timer isn't running, nothing to stop
    if (!this.isTimerRunning) {
      return true;  // return true since the answer is correct, even if timer isn't running
    }

    // Fire sound (or any UX) BEFORE stopping so teardown doesn't stop it
    try {
      options.onBeforeStop?.();
    } catch (err: unknown) { swallow('timer.service.ts', err); }

    try {
      // Stop the timer with force AND bypass anti-thrash. Anti-thrash
      // exists to absorb init-chain churn; an explicit stop after a
      // correct-answer click is intentional and must not be ignored
      // even if the click lands within the original start window.
      this.stopTimer(options.onStop, { force: true, bypassAntiThrash: true });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stops the timer if the answer conditions are met.
   *
   * Single-answer â†’ stop when the clicked option is correct.
   * Multiple-answer â†’ stop when all correct answers are selected.
   */
  public async stopTimerIfApplicable(
    question: QuizQuestion,
    questionIndex: number,
    selectedOptionsFromQQC: Array<SelectedOption | Option> | null
  ): Promise<void> {
    try {
      // Basic validation
      if (this.isTimerStoppedForCurrentQuestion) return;
      if (!question || !Array.isArray(question.options)) return;

      const normalizedIndex = this.normalizeQuestionIndex(questionIndex);
      if (normalizedIndex < 0) return;

      // Determine correct answers
      const correctOptions = question.options.filter((opt) => opt.correct);
      const correctOptionIds = correctOptions.map((opt) => String(opt.optionId));
      const isMultiple = correctOptionIds.length > 1;

      // Build SELECTED set
      //  - For MULTIPLE: prefer SelectedOptionService
      //  - For SINGLE: use QQC payload
      let selectedOptionsFinal: Array<SelectedOption | Option> = [];

      if (isMultiple) {
        // pull from SelectedOptionService for this question
        const fromStore =
          this.selectedOptionService?.getSelectedOptionsForQuestion(
            normalizedIndex
          ) ?? [];

        if (fromStore.length > 0) {
          selectedOptionsFinal = fromStore;
        } else {
          selectedOptionsFinal = selectedOptionsFromQQC ?? [];
        }
      } else {
        // single-answer: payload is fine
        selectedOptionsFinal = selectedOptionsFromQQC ?? [];
      }

      const selectedIds = selectedOptionsFinal.map((o) =>
        String((o as any).optionId ?? '')
      );

      let shouldStop = false;

      // MULTIPLE-ANSWER LOGIC (match computeCorrectness)
      if (isMultiple) {
        const selectedSet = new Set(selectedIds);

        const selectedCorrectCount = correctOptionIds.filter((id) =>
          selectedSet.has(id)
        ).length;

        // Exact match: all and only correct options selected
        shouldStop =
          correctOptionIds.length > 0 &&
          selectedCorrectCount === correctOptionIds.length;
      }

      // Single-answer logic
      else {
        const firstSelected = selectedOptionsFinal[0] as any;
        const isCorrect = isOptionCorrect(firstSelected);
        shouldStop = isCorrect;
      }

      // Stop timer if conditions met
      if (!shouldStop) return;

      const stopped = this.attemptStopTimerForQuestion({
        questionIndex: normalizedIndex,
        onStop: (elapsed?: number) => {
          if (elapsed != null) {
            this.elapsedTimes[normalizedIndex] = elapsed;
            this.saveTimerState();
          }
        }
      });

      if (!stopped) this.stopTimer(undefined, { force: true });
    } catch {
      // stopTimerIfApplicable failed
    }
  }

  public stopTimerForQuestion(questionIndex: number): void {
    const idx = this.normalizeQuestionIndex(questionIndex);
    if (idx < 0) return;

    // Prevent double-stops
    if (this.isTimerStoppedForCurrentQuestion) return;

    // Authoritative Stop â€” grant authority immediately before stopping
    this._authoritativeStop = true;

    const stopped = this.attemptStopTimerForQuestion({
      questionIndex: idx,
      onStop: (elapsed?: number) => {
        if (elapsed != null) {
          this.elapsedTimes[idx] = elapsed;
          this.saveTimerState();
        }
      }
    });

    if (!stopped) {
      // Force is allowed, but stopTimer() will still clear authority
      this.stopTimer(undefined, { force: true });
    }
  }

  /**
   * Convenience: stop, reset, clear flags, and start a fresh timer for a question.
   * Consolidates the 4-step pattern used across QuizComponent navigation paths.
   */
  private _runningForQuestion: number | null = null;
  private _lastStartedAtMs = 0;

  public restartForQuestion(questionIndex: number): void {
    // Block re-entry if this question is already running, expired, or
    // was already stopped via a correct-answer click. Without the
    // stoppedForQuestion check, a downstream re-emit of the same
    // question payload would clear _lastStartedAtMs and fully restart
    // the timer from 0 on an already-answered question.
    if (
      this._runningForQuestion === questionIndex &&
      (this.isTimerRunning || this.hasExpiredForRun || this.stoppedForQuestion.has(questionIndex))
    ) {
      return;
    }

    // Correctly-answered questions don't re-run their timer — freeze at the
    // recorded seconds-remaining instead. Gate ONLY on the durable dot-status
    // (a selection-based check falsely fires for unanswered questions that
    // hold stale selections, freezing them at a bogus value).
    if (this.selectedOptionService?.clickConfirmedDotStatus?.get?.(questionIndex) === 'correct') {
      this.freezeAtRecordedTime(questionIndex);
      return;
    }

    // An already-timed-out question stays expired: a spurious restart for the
    // SAME question must not wipe its expiry — that erased the timeout FET on
    // every question after the first (the FET only shows while
    // expiredForQuestionIndexSig === the displayed index). Mirrors the
    // answered-correct freeze/return guard above.
    if (this.expiredForQuestionIndexSig() === questionIndex) {
      return;
    }

    this._runningForQuestion = questionIndex;
    // Clear expiry/start guards so this fresh question can run
    this.hasExpiredForRun = false;
    this.expiredForQuestionIndexSig.set(-1);
    this._lastStartedAtMs = 0;
    this.stopTimer?.(undefined, { force: true });
    this.resetTimer();
    this.resetTimerFlagsFor(questionIndex);

    // No signed deadline yet — show 0 and wait. QuestionTimingService calls
    // back the moment the receipt lands. Starting a local 30s here instead is
    // what used to make the client time out before the server's deadline, so
    // the reveal it triggered was rejected as `incomplete`.
    const deadlineMs = this._deadlineByQuestion.get(questionIndex);
    if (deadlineMs == null) return;

    this.startTimerUntil(deadlineMs);
  }

  // Freeze the timer at the time recorded when the question was answered, so a
  // revisited answered question shows the (frozen) time taken rather than a
  // fresh countdown. Falls back to 0-remaining (elapsed = full) when no time
  // was captured (e.g. after a hard refresh that clears in-memory elapsedTimes).
  public freezeAtRecordedTime(questionIndex: number): void {
    if (questionIndex == null || questionIndex < 0) return;

    // Tear down any active tick subscription DIRECTLY — stopTimer's authority
    // and anti-thrash guards can no-op here (e.g. right after a fresh start),
    // which would leave the countdown ticking past the frozen value.
    if (this.timerSubscription) {
      this.timerSubscription.unsubscribe();
      this.timerSubscription = null;
    }
    this.isTimerRunning = false;
    this.isTimerStoppedForCurrentQuestion = true;  // prevent non-forced restart
    this.hasExpiredForRun = false;
    this._runningForQuestion = questionIndex;
    this.stoppedForQuestion.add(questionIndex);

    // Only paint the recorded seconds-remaining when we actually have a
    // positive recorded time AND this freeze is for the question currently on
    // screen. The displayed elapsed is a single global signal, so a stale-index
    // freeze (e.g. a loader restart firing with a lagging currentQuestionIndex)
    // would otherwise clobber the displayed question's frozen time with another
    // question's value. No bogus 0:00 fallback — leave the display untouched
    // when nothing was captured (the timer is still stopped either way).
    const activeIdx = this.normalizeQuestionIndex(this.quizService?.currentQuestionIndex);
    const taken = this.elapsedTimes[questionIndex];
    if (questionIndex === activeIdx && typeof taken === 'number' && taken > 0) {
      this.elapsedTimeSig.set(taken);
    }
  }

  // Record the live elapsed for a question that was just answered, so its
  // frozen revisit shows the correct seconds-remaining. Covers the LAST
  // question (and any) where the capture-on-leave path never runs. Only sets
  // when we have a positive live elapsed and nothing better was already
  // captured (so a real stop-capture isn't overwritten).
  public recordElapsedForAnsweredQuestion(questionIndex: number): void {
    if (questionIndex == null || questionIndex < 0) return;
    const current = this.elapsedTimeSig();
    if (typeof current === 'number' && current > 0 && !(this.elapsedTimes[questionIndex] > 0)) {
      this.elapsedTimes[questionIndex] = current;
      this.saveTimerState();
    }
  }

  public resetTimerFlagsFor(questionIndex: number): void {
    if (questionIndex == null || questionIndex < 0) return;

    this.isTimerStoppedForCurrentQuestion = false;

    if (this.selectedOptionService) {
      this.selectedOptionService.stopTimerEmitted = false;
    }

    this.stoppedForQuestion.delete(questionIndex);
  }

  public async requestStopEvaluationFromClick(
    questionIndex: number,
    _selectedOption: SelectedOption | null
  ): Promise<void> {
    const normalizedIndex = this.normalizeQuestionIndex(questionIndex);
    const q = this.quizService?.questions?.[normalizedIndex];
    if (!q) return;

    // Always convert SelectedOption â†’ SelectedOption[]
    const selectedOptionsArray =
      this.selectedOptionService.getSelectedOptionsForQuestion(normalizedIndex);

    // Now fully valid call
    await this.stopTimerIfApplicable(q, normalizedIndex, selectedOptionsArray);
  }

  public calculateTotalElapsedTime(elapsedTimes: number[]): number {
    if (!elapsedTimes || !Array.isArray(elapsedTimes)) return 0;

    try {
      const total = elapsedTimes.reduce((acc: number, cur: number) => {
        // Ensure both values are valid numbers
        const a = typeof acc === 'number' ? acc : 0;
        const c = typeof cur === 'number' ? cur : 0;
        return a + c;
      }, 0);

      this.completionTime = total;
      this.saveTimerState();
      return total;
    } catch {
      return 0;
    }
  }

  private durableCompletionTimeKey(quizId: string): string {
    return 'quizElapsedTime:' + quizId;
  }

  /**
   * Durably records the elapsed time for a quiz (localStorage, keyed by quizId).
   * Unlike the sessionStorage timer state — cleared when the user leaves Results
   * — this survives so a later revisit can show the real elapsed time. Called by
   * the statistics view on the fresh Results page with the SAME value it
   * displays and the SAME quizId it later reads with, so the round-trip can't
   * drift. Only positive totals are written, so a revisit never clobbers it.
   */
  public setDurableCompletionTime(quizId: string, total: number): void {
    if (!quizId || !(total > 0)) return;
    try {
      localStorage.setItem(this.durableCompletionTimeKey(quizId), String(total));
    } catch { /* ignore */ }
  }

  /** Reads the durably-stored elapsed time for a quiz (0 if none/invalid). */
  public getDurableCompletionTime(quizId: string): number {
    if (!quizId) return 0;
    try {
      const n = Number(localStorage.getItem(this.durableCompletionTimeKey(quizId)));
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  /** Clears the durable elapsed time for a quiz (on restart / fresh start). */
  public clearDurableCompletionTime(quizId: string): void {
    if (!quizId) return;
    try {
      localStorage.removeItem(this.durableCompletionTimeKey(quizId));
    } catch { /* ignore */ }
  }

  private normalizeQuestionIndex(index: number | null | undefined): number {
    if (!Number.isFinite(index as number)) return -1;

    const normalized = Math.trunc(index as number);
    const questions = this.quizService?.questions;

    if (!Array.isArray(questions) || questions.length === 0) return normalized;
    if (questions[normalized] != null) return normalized;

    const potentialOneBased = normalized - 1;
    if (
      potentialOneBased >= 0 &&
      potentialOneBased < questions.length &&
      questions[potentialOneBased] != null
    ) {
      return potentialOneBased;
    }

    return Math.min(Math.max(normalized, 0), questions.length - 1);
  }

  public allowAuthoritativeStop(): void {
    this._authoritativeStop = true;
  }

  private saveTimerState(): void {
    try {
      sessionStorage.setItem('elapsedTimes', JSON.stringify(this.elapsedTimes));
      sessionStorage.setItem('completionTime', String(this.completionTime));
    } catch {
      // ignore
    }
  }

  public clearTimerState(): void {
    this.elapsedTimes = [];
    this.completionTime = 0;
    try {
      sessionStorage.removeItem('elapsedTimes');
      sessionStorage.removeItem('completionTime');
    } catch {
      // ignore
    }
  }
}