import { inject, Service, Injector, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  BehaviorSubject, firstValueFrom, Observable, ReplaySubject, Subject
} from 'rxjs';
import {
  distinctUntilChanged, filter, map, take, timeout
} from 'rxjs/operators';

import { FET_UNLOCK_WATCHDOG_MS } from '../../../constants/timing';

import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationFormatterService } from './explanation-formatter.service';
import { ExplanationGateService } from './explanation-gate.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

/** Delay after rAF before unlocking FET in purgeAndDefer, allowing one paint frame plus this settle window. */
const FET_UNLOCK_SETTLE_DELAY_MS = 120;

export type FETPayload = { idx: number; text: string; token: number };

@Service()
export class ExplanationDisplayStateService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly formatter = inject(ExplanationFormatterService);
  private readonly gate = inject(ExplanationGateService);
  private readonly injector = inject(Injector);

  private readonly explanationTextSig = signal<string>('');
  explanationTexts: Record<number, string> = {};

  private readonly globalContextKey = 'global';
  private explanationByContext = new Map<string, string>();
  private shouldDisplayByContext = new Map<string, boolean>();
  private displayedByContext = new Map<string, boolean>();

  isExplanationTextDisplayedSig = signal<boolean>(false);
  isExplanationTextDisplayed$ = toObservable(this.isExplanationTextDisplayedSig);

  private readonly isExplanationDisplayedSig = signal<boolean>(false);

  shouldDisplayExplanationSig = signal<boolean>(false);
  shouldDisplayExplanation$ = toObservable(this.shouldDisplayExplanationSig);

  private explanationTrigger = new Subject<void>();

  private readonly resetCompleteSig = signal<boolean>(false);

  latestExplanation = '';

  private explanationLocked = false;
  private lockedContext: string | null = null;
  private lastExplanationSignature: string | null = null;
  private lastDisplaySignature: string | null = null;
  private lastDisplayedSignature: string | null = null;

  // Per-index storage moved to ExplanationGateService. These getters
  // preserve the previous public API so external callers (quiz-reset,
  // explanation-text, specs) keep working unchanged.
  public get _byIndex(): Map<number, BehaviorSubject<string | null>> {
    return this.gate._byIndex;
  }
  public get _gate(): Map<number, BehaviorSubject<boolean>> {
    return this.gate._gate;
  }
  private _activeIndexValue: number | null = 0;

  public readonly activeIndexSig = signal<number>(0);
  public readonly activeIndex$ = toObservable(this.activeIndexSig);

  private readonly _readyForExplanationSig = signal<boolean>(false);

  public _visibilityLocked = false;

  // Tracks whether the current question text has rendered at least once.
  public readonly questionRenderedSig = signal<boolean>(false);
  public questionRendered$ = toObservable(this.questionRenderedSig);

  // Track which indices currently have open gates (used for cleanup).
  // Backing storage lives on ExplanationGateService; this getter keeps the
  // public field-style access working for external consumers.
  public get _gatesByIndex(): Map<number, BehaviorSubject<boolean>> {
    return this.gate._gatesByIndex;
  }

  public _fetLocked: boolean | null = null;

  // Timestamp of the most recent navigation (from QuizNavigationService).
  public _lastNavTime = 0;

  public readonly quietZoneUntilSig = signal<number>(0);
  public quietZoneUntil$ = toObservable(this.quietZoneUntilSig);

  // Internal guards
  public _quietZoneUntil = 0;

  private _fetSubject = new ReplaySubject<FETPayload>(1);
  public fetPayload$: Observable<FETPayload> = this._fetSubject.asObservable();
  public _gateToken = 0;
  public _currentGateToken = 0;
  private _unlockRAFId: number | null = null;
  private _unlockTimeoutId: number | null = null;
  private _unlockWatchdogId: number | null = null;
  public latestExplanationIndex: number | null = -1;

  get _activeIndex(): number | null {
    return this._activeIndexValue;
  }
  set _activeIndex(value: number | null) {
    this._activeIndexValue = value;
    if (value !== null) this.activeIndexSig.set(value);
  }

  get shouldDisplayExplanationSnapshot(): boolean {
    return this.shouldDisplayExplanationSig() === true;
  }

  constructor() {
    // Always clear stale FET payloads when switching to a new question index.
    this.activeIndex$.pipe(
      distinctUntilChanged()
    ).subscribe((idx: number) => {
      this.latestExplanation = '';
      this.latestExplanationIndex = idx;
      this.formatter.formattedExplanationSig.set('');
      this.setShouldDisplayExplanation(false, { force: true });
      this.setIsExplanationTextDisplayed(false, { force: true });
      this._fetLocked = false;
    });
  }

  private _qss!: QuizStateService;
  private get qss(): QuizStateService {
    if (!this._qss) this._qss = this.injector.get(QuizStateService);
    return this._qss;
  }

  updateExplanationText(question: QuizQuestion): void {
    const explanation = question.explanation?.trim();

    // Guard: don't push placeholder text early
    if (!explanation || explanation === 'No explanation available') return;

    this.explanationTextSig.set(explanation);
  }

  getLatestExplanation(): string {
    return this.latestExplanation;
  }

  prepareExplanationText(question: QuizQuestion): string {
    return question.explanation || 'No explanation available';
  }

  public lockExplanation(context?: string): void {
    this.explanationLocked = true;
    this.lockedContext = this.normalizeContext(context);
  }

  public unlockExplanation(): void {
    this.explanationLocked = false;
    this.lockedContext = null;
  }

  public isExplanationLocked(): boolean {
    return this.explanationLocked;
  }

  public setExplanationText(
    explanation: string | null,
    options: { force?: boolean; context?: string; index?: number } = {}
  ): void {
    const trimmed = (explanation ?? '').trim();
    const contextKey = this.normalizeContext(options.context);
    const signature = `${contextKey}:::${trimmed}`;

    // Ensure we track WHICH question this explanation belongs to
    const targetIdx = options.index ?? this._activeIndexValue;
    this.latestExplanationIndex = targetIdx;

    if (this.multiAnswerGuardBlocks(trimmed, options, targetIdx)) return;
    if (this.shouldSkipWrite(trimmed, contextKey, signature, options)) return;

    const finalExplanation = this.commitExplanationState(trimmed, contextKey, signature, targetIdx);

    const qIdx = targetIdx !== null ? targetIdx : this._activeIndex;
    this.updateIndexedStorage(qIdx, finalExplanation);

    // Unified emission pipeline (Global)
    this.formatter.formattedExplanationSig.set(finalExplanation);

    // Ensure direct subject update for visibility-stable downstream
    this.explanationTextSig.set(finalExplanation);
  }

  // CENTRALIZED MULTI-ANSWER GUARD: block non-empty FET text from entering the
  // reactive pipeline for multi-answer questions that are not yet fully resolved
  // (prevents explanation reaching subscribeToDisplayText/writeQText too early).
  private multiAnswerGuardBlocks(
    trimmed: string,
    options: { force?: boolean },
    targetIdx: number | null | undefined
  ): boolean {
    if (!(trimmed && !options.force)) return false;
    try {
      const quizSvc = this.injector.get(QuizService, null);
      const selectedSvc = this.injector.get(SelectedOptionService, null);
      if (quizSvc && selectedSvc) {
        const activeIdx = targetIdx ?? quizSvc.getCurrentQuestionIndex?.() ?? 0;
        const rawQ: any = quizSvc?.questions?.[activeIdx];
        const rawOpts: any[] = rawQ?.options ?? [];
        const correctCount = rawOpts.filter(
          (o: any) => isOptionCorrect(o)
        ).length;
        if (correctCount > 1) {
          const correctTexts = rawOpts
            .filter((o: any) => isOptionCorrect(o))
            .map((o: any) => norm(o?.text))
            .filter((t: string) => !!t);
          const selections = selectedSvc.getSelectedOptionsForQuestion(activeIdx) ?? [];
          const selTexts = new Set(
            selections
              .filter((s: any) => s?.selected !== false)
              .map((s: any) => norm(s?.text))
              .filter((t: string) => !!t)
          );
          const allCorrectSelected = correctTexts.length > 0
            && correctTexts.every((t: string) => selTexts.has(t));
          if (!allCorrectSelected) return true;
        }
      }
    } catch (err: unknown) {
      console.error('ExplanationDisplayStateService.setExplanationText multi-answer guard failed:', err);
    }
    return false;
  }

  // Visibility lock, explanation-lock context mismatch, and dedup guards.
  private shouldSkipWrite(
    trimmed: string,
    contextKey: string,
    signature: string,
    options: { force?: boolean }
  ): boolean {
    // Visibility lock: prevent overwrites during tab restore
    if ((this as any)._visibilityLocked) return true;

    if (!options.force && this.explanationLocked) {
      const lockedContext = this.lockedContext ?? this.globalContextKey;
      const contextsMatch =
        lockedContext === this.globalContextKey ||
        contextKey === this.globalContextKey ||
        lockedContext === contextKey;

      if (!contextsMatch) return true;
      if (trimmed === '') return true;
    }

    if (!options.force) {
      const previous = this.explanationByContext.get(contextKey) ?? '';
      if (previous === trimmed && signature === this.lastExplanationSignature) return true;
    }
    return false;
  }

  // Commit the context map + signature and update latest-explanation tracking.
  private commitExplanationState(
    trimmed: string,
    contextKey: string,
    signature: string,
    targetIdx: number | null | undefined
  ): string {
    if (trimmed) {
      this.explanationByContext.set(contextKey, trimmed);
    } else {
      this.explanationByContext.delete(contextKey);
    }

    this.lastExplanationSignature = signature;

    const finalExplanation = trimmed;

    // Clear old explanation when we're NOT setting new text.
    // This prevents Q1's explanation from showing for Q2.
    if (!finalExplanation && this.latestExplanation) {
      this.latestExplanation = '';
      this.latestExplanationIndex = targetIdx ?? this._activeIndex ?? 0;
    } else {
      this.latestExplanation = finalExplanation;
    }
    return finalExplanation;
  }

  // Update the per-index subjects and collections if the index is valid.
  private updateIndexedStorage(qIdx: number | null | undefined, finalExplanation: string): void {
    if (!(typeof qIdx === 'number' && qIdx >= 0)) return;

    const trimmedFinal = (finalExplanation ?? '').trim();

    // Update persistent indexed storage
    if (trimmedFinal) {
      this.formatter.formattedExplanations[qIdx] = {
        questionIndex: qIdx,
        explanation: trimmedFinal
      };
      this.formatter.fetByIndex.set(qIdx, trimmedFinal);
    } else {
      delete this.formatter.formattedExplanations[qIdx];
      this.formatter.fetByIndex.delete(qIdx);
    }

    // Notify the indexed reactive subjects
    try {
      const { text$ } = this.getOrCreate(qIdx);
      text$.next(trimmedFinal);
      this._byIndex.get(qIdx)?.next(trimmedFinal);
    } catch (err: unknown) {
      console.error('ExplanationDisplayStateService.setExplanationText indexed-subject notify failed:', err);
    }

    // Broadcast the change to the collection
    this.formatter.explanationsUpdatedSig.set({ ...this.formatter.formattedExplanations });
  }

  setExplanationTextForQuestionIndex(index: number, explanation: string): void {
    if (index < 0) return;

    const trimmed = (explanation ?? '').trim();
    const previous = this.explanationTexts[index];

    if (previous !== trimmed) {
      this.explanationTexts[index] = trimmed;
      this.formatter.formattedExplanationSig.set(trimmed);

      this.emitFormatted(index, trimmed || null);
      this.setGate(index, !!trimmed);
    }
  }

  /**
   * Authoritative FET reader for a specific question index.
   *
   * Returns `Observable<string | null>` (null = no FET available — caller
   * decides the fallback display). This is the *workhorse* — it gates on
   * `_fetLocked`, purges per-index cached state on index transition, and
   * emits via the per-index observable cache.
   *
   * Sister methods (see `getLatestFormattedExplanation`, `getFormattedExplanation`)
   * have different shapes / fallbacks and are NOT interchangeable.
   */
  public getFormattedExplanationTextForQuestion(
    questionIndex: number
  ): Observable<string | null> {
    const FALLBACK = null;

    if (this._fetLocked) {
      const lockedEntry = this.formatter.formattedExplanations[questionIndex];
      const lockedExplanation = (lockedEntry?.explanation ?? '').trim();
      if (lockedExplanation) {
        try {
          this.emitFormatted(questionIndex, lockedExplanation);
          this.latestExplanation = lockedExplanation;
          this.latestExplanationIndex = questionIndex;
          this.setGate(questionIndex, true);
        } catch (err: unknown) {
          console.error('ExplanationDisplayStateService.getFormattedExplanationTextForQuestion locked-emit failed:', err);
        }

        return new Observable(sub => { sub.next(lockedExplanation); sub.complete(); });
      }

      return new Observable(sub => { sub.next(FALLBACK); sub.complete(); });
    }

    // Step 1: Fully purge cached FET state if switching question
    if (this._activeIndex !== questionIndex) {
      try {
        if ((this.latestExplanation ?? '') !== '') {
          this.formatter.formattedExplanationSig.set('');
        }

        if (this._activeIndex !== null) {
          this.emitFormatted(this._activeIndex, null);
          this.setGate(this._activeIndex, false);
        }

        this.latestExplanation = '';
        this.latestExplanationIndex = null;
        this._fetLocked = false;

        this.shouldDisplayExplanationSig.set(false);
        this.isExplanationTextDisplayedSig.set(false);
      } catch (err: unknown) {
        console.error('ExplanationDisplayStateService.getFormattedExplanationTextForQuestion FET-state purge failed:', err);
      }

      this._activeIndex = questionIndex;
      this.latestExplanationIndex = questionIndex;
    }

    // Normalize index FIRST
    const idx = Number(questionIndex);

    // Guard invalid
    if (!Number.isFinite(idx)) {
      try {
        this.emitFormatted(0, null);
      } catch { }
      try {
        this.setGate(0, false);
      } catch { }

      return new Observable(sub => { sub.next(FALLBACK); sub.complete(); });
    }

    // Allow rehydration after restore: refresh active index
    if (this._activeIndex === -1) this._activeIndex = questionIndex;

    const entry = this.formatter.formattedExplanations[questionIndex];
    if (!entry) {
      try {
        this.emitFormatted(questionIndex, null);
      } catch { }
      try {
        this.setGate(questionIndex, false);
      } catch { }
      return new Observable(sub => { sub.next(null); sub.complete(); });
    }

    const explanation = (entry.explanation ?? '').trim();
    if (!explanation) {      try {
        this.emitFormatted(questionIndex, null);
      } catch { }
      try {
        this.setGate(questionIndex, false);
      } catch { }
      return new Observable(sub => { sub.next(FALLBACK); sub.complete(); });
    }
    if (this._activeIndex !== questionIndex) this._activeIndex = questionIndex;

    // Drive only the index-scoped channel (no global .next here)
    try {
      this.emitFormatted(questionIndex, explanation);
      this.latestExplanation = explanation;
      this.latestExplanationIndex = questionIndex;
    } catch { }

    try {
      this.setGate(questionIndex, true);
    } catch { }

    return new Observable(sub => { sub.next(explanation); sub.complete(); });
  }

  /**
   * Synchronous read of the *current* formatted explanation signal —
   * whatever was last written to `formatter.formattedExplanationSig`,
   * regardless of question index. No gating, no index purge.
   *
   * Use this when you need a snapshot for a synchronous decision (e.g.,
   * "is there an explanation currently displayed?"). Do NOT use it for
   * per-question lookups — use `getFormattedExplanationTextForQuestion`
   * (idx-scoped + gated) or `getFormattedExplanation` (idx-scoped +
   * string fallback) instead.
   */
  public getLatestFormattedExplanation(): string | null {
    try {
      return this.formatter.formattedExplanationSig();
    } catch (err: unknown) {
      console.error('ExplanationDisplayStateService.getLatestFormattedExplanation signal read failed:', err);
      return null;
    }
  }

  /**
   * Display-layer wrapper over `getFormattedExplanationTextForQuestion`.
   *
   * Adds two behaviors the workhorse doesn't:
   *   1. Returns `Observable<string>` (never null) — emits the literal
   *      'No explanation available' string as a fallback so the template
   *      can bind directly without a null guard.
   *   2. Pre-emptively emits null + closes the gate on the *prior* active
   *      index before delegating, so a slow upstream observable can't
   *      surface a stale-question's explanation.
   *
   * Prefer this over `getFormattedExplanationTextForQuestion` when wiring
   * to a template / async pipe. Use the workhorse directly when you need
   * to distinguish "no FET" (null) from "FET says nothing" (empty string).
   */
  getFormattedExplanation(questionIndex: number): Observable<string> {
    if (!this.formatter.explanationsInitializedSig()) {
      return new Observable(sub => { sub.next('No explanation available'); sub.complete(); });
    }

    // Clear any stale formatted text whenever index changes
    if (
      this._activeIndex !== null &&
      this._activeIndex !== questionIndex &&
      this._activeIndex !== -1
    ) {
      try {
        this.emitFormatted(this._activeIndex, null);
      } catch { }
      try {
        this.setGate(this._activeIndex, false);
      } catch { }
    }

    // Now safely update active index to current question
    this._activeIndex = questionIndex;

    return this.getFormattedExplanationTextForQuestion(questionIndex).pipe(
      map((explanationText: string | null) => {
        const text = explanationText?.trim() || 'No explanation available';

        if (this._activeIndex !== questionIndex) {
          return this.latestExplanation || 'No explanation available';
        }

        return text;
      })
    );
  }

  // Convenience accessor to avoid template/type metadata mismatches.
  getFormattedExplanationByIndex(): Observable<FETPayload> {
    return this._fetSubject.asObservable();
  }

  public setIsExplanationTextDisplayed(
    isDisplayed: boolean,
    options: { force?: boolean; context?: string } = {}
  ): void {
    // Visibility lock: prevent overwrites during visibility restore
    if ((this as any)._visibilityLocked) return;

    const contextKey = this.normalizeContext(options.context);
    const signature = `${options.context ?? 'global'}:::${isDisplayed}`;

    if (!options.force) {
      const previous = this.displayedByContext.get(contextKey);
      if (
        previous === isDisplayed &&
        signature === this.lastDisplayedSignature
      ) return;
    }

    if (isDisplayed) {
      this.displayedByContext.set(contextKey, true);
    } else if (contextKey === this.globalContextKey) {
      this.displayedByContext.clear();
    } else {
      this.displayedByContext.delete(contextKey);
    }

    this.lastDisplayedSignature = signature;
    const aggregated = this.computeContextualFlag(this.displayedByContext);

    if (
      !options.force &&
      aggregated === this.isExplanationTextDisplayedSig()
    ) return;

    // Update the canonical BehaviorSubject
    this.isExplanationTextDisplayedSig.set(aggregated);

    // Also update a secondary Subject for legacy or parallel subscribers
    try {
      (this as any).isExplanationTextDisplayedSubject?.next(aggregated);
    } catch {
      // optional secondary push; ignore if missing
    }
  }

  public setShouldDisplayExplanation(
    shouldDisplay: boolean,
    options: { force?: boolean; context?: string } = {}
  ): void {
    // Visibility lock: prevent any reactive writes while restoring visibility
    if ((this as any)._visibilityLocked) {      return;
    }

    // ── CENTRALIZED MULTI-ANSWER GUARD ──────────────────────────────
    // Block setShouldDisplayExplanation(true) for multi-answer questions
    // unless ALL correct answers are currently selected. This is the
    // single choke point that prevents every upstream caller from
    // prematurely enabling FET on Q2/Q4.
    if (shouldDisplay && !options.force) {
      try {
        const quizSvc = this.injector.get(QuizService, null);
        const selectedSvc = this.injector.get(SelectedOptionService, null);
        if (quizSvc && selectedSvc) {
          const activeIdx = this._activeIndexValue ?? quizSvc.getCurrentQuestionIndex?.() ?? 0;

          // SHUFFLED FIX: use display-order question source
          const _isShufG = quizSvc?.isShuffleEnabled?.()
            && quizSvc?.shuffledQuestions?.length > 0;
          const rawQ: any = _isShufG
            ? (quizSvc?.getQuestionsInDisplayOrder?.()?.[activeIdx]
              ?? quizSvc?.shuffledQuestions?.[activeIdx]
              ?? quizSvc?.questions?.[activeIdx])
            : quizSvc?.questions?.[activeIdx];
          const rawOpts: any[] = rawQ?.options ?? [];
          const correctCount = rawOpts.filter(
            (o: any) => isOptionCorrect(o)
          ).length;
          if (correctCount > 1) {
            const correctTexts = rawOpts
              .filter((o: any) => isOptionCorrect(o))
              .map((o: any) => norm(o?.text))
              .filter((t: string) => !!t);
            const selections = selectedSvc.getSelectedOptionsForQuestion(activeIdx) ?? [];
            const selTexts = new Set(
              selections
                .filter((s: any) => s?.selected !== false)
                .map((s: any) => norm(s?.text))
                .filter((t: string) => !!t)
            );
            const allCorrectSelected = correctTexts.length > 0
              && correctTexts.every((t: string) => selTexts.has(t));
            if (!allCorrectSelected) {
              // Check questionCorrectness override before blocking
              const scoringSvc = quizSvc?.scoringService;
              const scoredCorrect = scoringSvc?.questionCorrectness?.get(activeIdx) === true;
              if (!scoredCorrect) {
                return;
              }
            }
          }
        }
      } catch { /* fall through if injection fails */ }
    }

    const contextKey = this.normalizeContext(options.context);
    const signature = `${options.context ?? 'global'}:::${shouldDisplay}`;

    if (!options.force) {
      const previous = this.shouldDisplayByContext.get(contextKey);
      if (
        previous === shouldDisplay &&
        signature === this.lastDisplaySignature
      ) return;
    }

    if (shouldDisplay) {
      this.shouldDisplayByContext.set(contextKey, true);
    } else if (contextKey === this.globalContextKey) {
      this.shouldDisplayByContext.clear();
    } else {
      this.shouldDisplayByContext.delete(contextKey);
    }

    this.lastDisplaySignature = signature;
    const aggregated = this.computeContextualFlag(this.shouldDisplayByContext);

    if (
      !options.force &&
      aggregated === this.shouldDisplayExplanationSig()
    ) return;

    // Normal reactive push (this is your main subject)
    this.shouldDisplayExplanationSig.set(aggregated);

    // Update Subject
    try {
      (this as any).shouldDisplayExplanationSubject?.next(aggregated);
    } catch {
      // Ignore — optional mirror stream
    }
  }

  public triggerExplanationEvaluation(): void {
    const currentExplanation = this.getLatestFormattedExplanation();
    const shouldShow = this.shouldDisplayExplanationSig();

    if (shouldShow && currentExplanation) {
      this.explanationTrigger.next();
      this.setExplanationText(currentExplanation, {
        force: true,
        context: 'evaluation'
      });
    }
  }

  private clearExplanationCaches(): void {
    this.latestExplanation = '';
    this.lastExplanationSignature = null;
    this.lastDisplaySignature = null;
    this.lastDisplayedSignature = null;
    this.explanationByContext.clear();
    this.shouldDisplayByContext.clear();
    this.displayedByContext.clear();
    this.explanationTexts = {};
  }

  resetExplanationText(): void {
    this.clearExplanationCaches();
    this.setExplanationText('', { force: true });
    this.explanationTextSig.set('');
    this.setShouldDisplayExplanation(false, { force: true });
    this.setIsExplanationTextDisplayed(false, { force: true });
    this.isExplanationDisplayedSig.set(false);
  }

  resetStateBetweenQuestions(): void {
    this.resetExplanationState();
    this.formatter.resetProcessedQuestionsState();
  }

  resetExplanationState(): void {
    this.unlockExplanation();
    this.clearExplanationCaches();

    this.formatter.resetFormatterState();
    this._byIndex.clear();
    this._gate.clear();
    this._gatesByIndex.clear();
    this.gate.clearTextMap();
    this.cancelPendingUnlock();
    this._fetLocked = null;
    this._gateToken = 0;
    this._currentGateToken = 0;
    this._activeIndex = null;
    this.latestExplanationIndex = -1;

    this.explanationTextSig.set('');
    this.formatter.formattedExplanationSig.set('');
    this._fetSubject.next(undefined as any);

    this.shouldDisplayExplanationSig.set(false);
    this.isExplanationTextDisplayedSig.set(false);
    this.resetCompleteSig.set(false);

    // FET is definitely NOT ready after a full reset
    try {
      this.qss.setExplanationReady(false);
    } catch { }
  }

  setResetComplete(value: boolean): void {
    this.resetCompleteSig.set(value);
  }

  public forceResetBetweenQuestions(): void {
    this.resetExplanationState();
  }

  public normalizeContext(context?: string | null): string {
    const normalized = (context ?? '').toString().trim();
    return normalized || this.globalContextKey;
  }

  private computeContextualFlag(map: Map<string, boolean>): boolean {
    return [...map.values()].some(Boolean);
  }

  // Emit per-index formatted text; coalesces duplicates and broadcasts event
  public emitFormatted(
    index: number,
    value: string | null,
    options: { token?: number; bypassGuard?: boolean } = {}
  ): void {
    const { bypassGuard = false } = options;
    // Capture the lock state on entry so an early no-op bail (empty value)
    // can restore it instead of leaking a permanent lock. See E6 §3.2.
    const priorLock = this._fetLocked;
    // Lock immediately to prevent race conditions with reactive streams
    this._fetLocked = true;

    if (this.isBlockedByMultiAnswerEmitGuard(value, index, bypassGuard)) {
      this._fetLocked = false;
      return;
    }

    const trimmed = (value ?? '').trim();
    if (!trimmed) {
      // Empty/null value is a no-op clear — do NOT leak the lock we set
      // above; restore whatever it was on entry. (E6 lock-leak fix.)
      this._fetLocked = priorLock;
      return;
    }

    this.applyFormattedEmit(index, trimmed);
  }

  // MULTI-ANSWER GUARD: block the FET emit until ALL correct answers are
  // selected. Uses RAW question options as source of truth so mutated
  // display-order copies with scrambled correct flags don't fool the check.
  // Returns true when the emit should be blocked.
  private isBlockedByMultiAnswerEmitGuard(
    value: string | null,
    index: number,
    bypassGuard: boolean
  ): boolean {
    if (!(value && index >= 0)) return false;
    try {
      const quizSvc = this.injector.get(QuizService, null);

      if (quizSvc) {
        const isShuffled = quizSvc.isShuffleEnabled?.() ?? false;
        const shuffled = Array.isArray(quizSvc.shuffledQuestions)
          ? quizSvc.shuffledQuestions
          : [];
        const baseQuestions = isShuffled && shuffled.length > 0
          ? shuffled
          : quizSvc.questions;

        // Prefer display-order accessor when available
        const displayQuestions =
          typeof quizSvc.getQuestionsInDisplayOrder === 'function'
            ? quizSvc.getQuestionsInDisplayOrder()
            : baseQuestions;

        const question = displayQuestions?.[index] ?? baseQuestions?.[index] ?? null;
        let correctCount = 0;

        if (question && Array.isArray(question.options)) {
          correctCount = question.options.filter(
            (o: any) => isOptionCorrect(o)
          ).length;
        }

        // Determine authoritative correct count from RAW questions (unmutated).
        const rawQs = quizSvc.questions ?? [];
        const rawQ: any = rawQs[index] ?? question;
        const rawCorrectCount = (rawQ?.options ?? []).filter(
          (o: any) => isOptionCorrect(o)
        ).length;
        const effectiveCorrectCount = Math.max(correctCount, rawCorrectCount);

        if (!bypassGuard && effectiveCorrectCount > 1) {
          const sos = this.injector.get(SelectedOptionService, null);
          const selections = sos?.selectedOptionsMap?.get(index) ?? [];
          const rawOpts: any[] = rawQ?.options ?? [];
          const rawCorrectTexts = new Set(
            rawOpts.filter((o: any) => isOptionCorrect(o))
              .map((o: any) => norm(o?.text)).filter((t: string) => !!t)
          );
          const selTexts = new Set(
            (selections as any[]).map((s: any) => norm(s?.text)).filter((t: string) => !!t)
          );
          const allCorrectSel = rawCorrectTexts.size > 0 && [...rawCorrectTexts].every(t => selTexts.has(t));

          const oisPerfect = quizSvc.questionResolved.get(index) === true;

          if (!oisPerfect && !allCorrectSel) {
            return true;
          }
        }
      }
    } catch (err: unknown) {
      console.error('ExplanationDisplayStateService.emitFormatted multi-answer guard failed:', err);
    }
    return false;
  }

  // Validate, store, and broadcast the formatted FET for this index.
  private applyFormattedEmit(index: number, trimmed: string): void {
    this.latestExplanationIndex = index;

    // Validate prefix option numbers against visual data
    const validatedText = this.formatter.validateAndCorrectFetPrefix(trimmed, index);

    this.latestExplanation = validatedText;

    // Store in Map by index for reliable retrieval
    this.formatter.fetByIndex.set(index, validatedText);

    // Also emit to formattedExplanationSig for FINAL LAYER.
    this.formatter.formattedExplanationSig.set(validatedText);

    // Note: _fetSubject.next(...) deliberately not called here.
    // Activating it caused FET of the current question to leak across
    // tab-switch + Next navigation. The original code had this line
    // muted (hidden in a same-line comment) and the app behaved
    // correctly without it.
    this.shouldDisplayExplanationSig.set(true);
    this.isExplanationTextDisplayedSig.set(true);

    // At this point, FET is computed and "ready" for this question
    try {
      this.getOrCreate(index).text$.next(validatedText);
      this._byIndex.get(index)?.next(validatedText);
    } catch { }

    try {
      this.qss.setExplanationReady(true);
    } catch { }
  }

  public setGate(index: number, show: boolean): void {
    this.gate.setGate(index, show);
  }

  // Call to open a gate for an index
  public openExclusive(index: number, text: string): void {
    const token = this._currentGateToken;

    // Pre-guards
    if (
      this._fetLocked ||
      index !== this._activeIndex ||
      token !== this._gateToken
    ) return;

    const trimmed = (text ?? '').trim();
    if (!trimmed || trimmed === this.latestExplanation?.trim()) return;

    this.latestExplanation = trimmed;

    // One-frame emit with re-checks
    requestAnimationFrame(() => {
      if (
        this._fetLocked ||
        index !== this._activeIndex ||
        token !== this._currentGateToken
      ) return;
      this.formatter.formattedExplanationSig.set(trimmed);
      this.shouldDisplayExplanationSig.set(true);
      this.isExplanationTextDisplayedSig.set(true);

      // FET now open and visible for this index
      try {
        this.qss.setExplanationReady(true);
      } catch { }
    });
  }

  // Holds a per-question text$ stream (isolated subjects by index)
  public getOrCreate(index: number) {
    return this.gate.getOrCreate(index);
  }

  // Returns a reactive stream for a given question index
  public getExplanationText$(index: number): Observable<string | null> {
    return this.gate.getExplanationText$(index);
  }

  // Reset explanation state cleanly for a new index
  public resetForIndex(index: number): void {
    if (
      this._activeIndex !== null &&
      this._activeIndex !== -1 &&
      this._activeIndex !== index
    ) {
      this.gate.closePrimaryGate(this._activeIndex);

      this.latestExplanation = '';
      this.latestExplanationIndex = null;
      this.formatter.formattedExplanationSig.set('');
      this.setShouldDisplayExplanation(false, { force: true });
      this.setIsExplanationTextDisplayed(false, { force: true });
    }

    // Ensure and hard-emit for new index
    const { text$, gate$ } = this.getOrCreate(index);
    const cachedFet = this.formatter.formattedExplanations[index]?.explanation?.trim()
      || this.formatter.fetByIndex.get(index)?.trim()
      || '';
    try {
      text$.next(cachedFet || '');
    } catch { }
    try {
      gate$.next(false);
    } catch { }

    this._activeIndex = index;
    this.latestExplanationIndex = index;
    if (!cachedFet) {
      this.formatter.formattedExplanations[index] = {
        questionIndex: index,
        explanation: ''
      };
    }
    try {
      this.qss.setExplanationReady(false);
    } catch { }
  }

  // Set readiness flag
  public setReadyForExplanation(ready: boolean): void {
    this._readyForExplanationSig.set(ready);  }

  public async waitUntilQuestionRendered(timeoutMs = 500): Promise<void> {
    try {
      await firstValueFrom(
        this.questionRendered$.pipe(
          filter((v) => v),
          take(1),
          timeout(timeoutMs)
        )
      );
    } catch {
      // Swallow timeouts or interruptions silently
    }
  }

  public closeGateForIndex(index: number): void {
    this.gate.closeGateForIndex(index);
  }

  public closeAllGates(): void {
    this.gate.clearGatesByIndex();
    this.cancelPendingUnlock();
    this._fetLocked = null;

    try {
      this.setShouldDisplayExplanation(false, { force: true });
      this.setIsExplanationTextDisplayed(false);
    } catch (err: unknown) {
      console.error('ExplanationDisplayStateService.closeAllGates display-state reset failed:', err);
    }
  }

  public markLastNavTime(time: number): void {
    this._lastNavTime = time;
  }

  public setQuietZone(durationMs: number): void {
    const until = performance.now() + Math.max(0, durationMs);
    this._quietZoneUntil = until;
    this.quietZoneUntilSig.set(until);
  }

  /**
   * On nav transitions, lock the FET pipeline immediately and clear visible
   * state so a prior-question's explanation can't bleed into the new one.
   *
   * Race-safety: the lock is released asynchronously (RAF + setTimeout) to
   * give downstream pipelines a frame to settle. To prevent a stale unlock
   * from a prior cycle from clobbering a fresh lock, every unlock callback
   * captures the gate token at schedule time and aborts via token mismatch
   * if a newer `purgeAndDefer` (or `openExclusive`) has since bumped the
   * token. `cancelPendingUnlock()` additionally hard-aborts both the RAF
   * and the setTimeout on entry, so the token check is a defense in depth.
   */
  public purgeAndDefer(newIndex: number): void {
    // Bump generation and lock everything immediately
    this._gateToken++;
    this._currentGateToken = this._gateToken;
    this._activeIndex = newIndex;
    this._fetLocked = true;

    // Reset formatted explanation to prevent replay from Q1
    this.formatter.formattedExplanationSig.set('');

    // Hard reset every flag
    this.latestExplanation = '';
    this.setShouldDisplayExplanation(false);
    this.setIsExplanationTextDisplayed(false);
    this.gate.deleteText(newIndex);

    // Preserve cached FET for back-navigation.
    const hasCachedFet = 
      !!(this.formatter.formattedExplanations[newIndex]?.explanation?.trim()
      || this.formatter.fetByIndex.get(newIndex)?.trim());
    if (!hasCachedFet) {
      this.formatter.fetByIndex.delete(newIndex);
      this.formatter.lockedFetIndices.delete(newIndex);
    }
    if (this.latestExplanationIndex === newIndex) {
      this.latestExplanationIndex = newIndex;
    }

    // Navigation in progress -> explanation not ready
    try {
      this.qss.setExplanationReady(false);
    } catch { }

    // Cancel any pending unlocks from older cycles
    this.cancelPendingUnlock();

    // Strict token-based unlock logic
    const localToken = this._currentGateToken;
    this._unlockRAFId = requestAnimationFrame(() => {
      this._unlockRAFId = null;
      this._unlockTimeoutId = window.setTimeout(() => {
        this._unlockTimeoutId = null;
        if (this._currentGateToken !== localToken) return;
        this._fetLocked = false;
      }, FET_UNLOCK_SETTLE_DELAY_MS);
    });

    // Belt-and-suspenders watchdog: if the deferred unlock chain above ever
    // fails to complete (rAF/timeout dropped, exception, token bumped with no
    // follow-up unlock), the lock would stay true indefinitely. Force-unlock
    // after the watchdog window — but ONLY if this cycle still owns the gate
    // (token unchanged); a newer purge means someone else manages the unlock.
    // Mirrors the watchdog already guarding unlockFetGateAfterRender.
    this._unlockWatchdogId = window.setTimeout(() => {
      this._unlockWatchdogId = null;
      if (!this._fetLocked) return;
      if (this._currentGateToken !== localToken) return;
      this._fetLocked = false;
    }, FET_UNLOCK_WATCHDOG_MS);
  }

  /** Cancel any in-flight rAF + setTimeout unlock pair (and its watchdog). */
  private cancelPendingUnlock(): void {
    if (this._unlockRAFId != null) {
      cancelAnimationFrame(this._unlockRAFId);
      this._unlockRAFId = null;
    }
    if (this._unlockTimeoutId != null) {
      clearTimeout(this._unlockTimeoutId);
      this._unlockTimeoutId = null;
    }
    if (this._unlockWatchdogId != null) {
      clearTimeout(this._unlockWatchdogId);
      this._unlockWatchdogId = null;
    }
  }
}