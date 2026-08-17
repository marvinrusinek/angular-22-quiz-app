import { inject, Service } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { filter, map, take, timeout } from 'rxjs/operators';

import { QuestionType } from '../../../models/question-type.enum';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { authorizedExplanation } from '../verdict/authorized-correctness';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../selection-message/selection-message.service';
import { SoundService } from '../../ui/sound.service';
import { TimerService } from '../timer/timer.service';

import { delay } from '../../../utils/delay';
import { norm } from '../../../utils/text-norm';

/**
 * Handles timer expiry, lock, and disable logic for QQC.
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Service()
export class QqcTimerEffectService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly nextButtonStateService = inject(NextButtonStateService);
  private readonly quizService = inject(QuizService);
  private readonly verdicts = inject(QuestionVerdictService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly selectionMessageService = inject(SelectionMessageService);
  private readonly soundService = inject(SoundService);
  private readonly timerService = inject(TimerService);

  /**
   * Collects canonical option snapshots and lock keys for a given question index.
   */
  collectLockContextForQuestion(
    i0: number,
    context: {
      question?: QuizQuestion | null;
      fallbackOptions?: Option[] | null;
      optionsToDisplay?: Option[];
      sharedOptionBindings?: OptionBindings[];
      currentQuestionIndex?: number;
      currentQuestion?: QuizQuestion | null;
    } = {}
  ): {
    canonicalOpts: Option[];
    lockKeys: Set<string | number>;
  } {
    const lockKeys = new Set<string | number>();

    const addKeyVariant = (raw: unknown) => {
      if (raw == null) return;

      if (typeof raw === 'number') {
        lockKeys.add(raw);
        lockKeys.add(String(raw));
        return;
      }

      const str = String(raw).trim();
      if (!str) return;

      const num = Number(str);
      if (Number.isFinite(num)) lockKeys.add(num);

      lockKeys.add(str);
    };

    const harvestOptionKeys = (opt?: Option, idx?: number) => {
      if (!opt) return;

      addKeyVariant(opt.optionId);
      addKeyVariant(opt.value);

      try {
        const stable = this.selectionMessageService.stableKey(opt, idx);
        addKeyVariant(stable);
      } catch { }
    };

    const resolvedQuestion =
      context.question ??
      (context.currentQuestionIndex === i0 ? context.currentQuestion : undefined);

    const baseOptions = (() => {
      if (Array.isArray(resolvedQuestion?.options) && resolvedQuestion!.options.length) {
        return resolvedQuestion!.options;
      }
      if (Array.isArray(context.fallbackOptions) && context.fallbackOptions.length) {
        return context.fallbackOptions;
      }
      if (Array.isArray(context.optionsToDisplay) && context.optionsToDisplay.length) {
        return context.optionsToDisplay;
      }
      return [] as Option[];
    })();

    let canonicalOpts: Option[] = baseOptions.map((o, idx) => {
      harvestOptionKeys(o, idx);

      const numericId = Number(o.optionId);

      return {
        ...o,
        optionId: Number.isFinite(numericId) ? numericId : o.optionId,
        selected: !!o.selected
      } as Option;
    });

    if (!canonicalOpts.length && Array.isArray(context.sharedOptionBindings)) {
      canonicalOpts = context.sharedOptionBindings
        .map((binding, idx) => {
          const opt = binding?.option;
          if (!opt) return undefined;
          harvestOptionKeys(opt, idx);
          const numericId = Number(opt.optionId);
          return {
            ...opt,
            optionId: Number.isFinite(numericId) ? numericId : opt.optionId,
            selected: !!opt.selected
          } as Option;
        })
        .filter((opt): opt is Option => !!opt);
    }

    for (const [idx, opt] of (context.optionsToDisplay ?? []).entries()) {
      harvestOptionKeys(opt, idx);
    }
    for (const [idx, binding] of (context.sharedOptionBindings ?? []).entries()) {
      harvestOptionKeys(binding?.option, idx);
    }

    return { canonicalOpts, lockKeys };
  }

  /**
   * Applies lock and disable states for a question's options after timer stop/timeout.
   */
  applyLocksAndDisableForQuestion(
    i0: number,
    canonicalOpts: Option[],
    lockKeys: Set<string | number>,
    opts: { revealFeedback: boolean },
    callbacks: {
      revealFeedbackForAllOptions: (opts: Option[]) => void;
      forceDisableSharedOption: () => void;
      updateBindingsAndOptions: (lockDisable: boolean) => {
        optionBindings: OptionBindings[];
        optionsToDisplay: Option[];
      };
    }
  ): void {
    if (opts.revealFeedback) {
      try { callbacks.revealFeedbackForAllOptions(canonicalOpts); } catch { }
    }

    try { this.selectedOptionService.lockQuestion(i0); } catch { }

    if (lockKeys.size) {
      try {
        this.selectedOptionService.lockMany(i0, Array.from(lockKeys));
      } catch { }
    }

    try {
      callbacks.forceDisableSharedOption();
    } catch { }

    try {
      callbacks.updateBindingsAndOptions(true);
    } catch { }
  }

  /**
   * Handles the question timeout event: reveals feedback, shows explanation, enables next.
   */
  onQuestionTimedOut(params: {
    targetIndex?: number;
    currentQuestionIndex: number;
    questions: QuizQuestion[];
    currentQuestion: QuizQuestion | null;
    optionsToDisplay: Option[];
    sharedOptionBindings?: OptionBindings[];
    totalQuestions: number;
    formattedByIndex: Map<number, string>;
    lastAllCorrect: boolean;
    normalizeIndex: (idx: number) => number;
    setExplanationFor: (idx: number, html: string) => void;
    resolveFormatted: (idx: number) => Promise<string>;
    revealFeedbackForAllOptions: (opts: Option[]) => void;
    forceDisableSharedOption: () => void;
    updateBindingsAndOptions: (lockDisable: boolean) => {
      optionBindings: OptionBindings[];
      optionsToDisplay: Option[];
    };
    markForCheck: () => void;
  }): {
    explanationToDisplay: string;
    timedOut: boolean;
    timerStoppedForQuestion: boolean;
  } {
    const activeIndex = params.targetIndex ?? params.currentQuestionIndex ?? 0;
    const i0 = params.normalizeIndex(activeIndex);
    const q = params.questions?.[i0] ??
      (params.currentQuestionIndex === i0 ? params.currentQuestion : undefined);

    // Collect canonical snapshot and robust lock keys
    const { canonicalOpts, lockKeys } = this.collectLockContextForQuestion(i0, {
      question: q,
      fallbackOptions: params.optionsToDisplay,
      optionsToDisplay: params.optionsToDisplay,
      sharedOptionBindings: params.sharedOptionBindings,
      currentQuestionIndex: params.currentQuestionIndex,
      currentQuestion: params.currentQuestion
    });

    // Reveal feedback, lock, and disable options
    this.applyLocksAndDisableForQuestion(i0, canonicalOpts, lockKeys, {
      revealFeedback: true
    }, {
      revealFeedbackForAllOptions: params.revealFeedbackForAllOptions,
      forceDisableSharedOption: params.forceDisableSharedOption,
      updateBindingsAndOptions: params.updateBindingsAndOptions
    });

    // Announce completion to listeners
    try {
      this.selectionMessageService.releaseBaseline(activeIndex);
      this.selectionMessageService.setOptionsSnapshot(canonicalOpts);

      const total = params.totalQuestions ?? this.quizService?.totalQuestions() ?? 0;
      const isLastQuestion = total > 0 && i0 === total - 1;
      this.selectionMessageService.forceNextButtonMessage(i0, {
        isLastQuestion
      });
    } catch { }

    // Show explanation regardless of correctness
    let explanationToDisplay = '';
    try {
      this.explanationTextService.setShouldDisplayExplanation(true, { force: true });

      const cached = params.formattedByIndex.get(i0)
        ?? this.explanationTextService.fetByIndex?.get(i0)
        ?? this.explanationTextService.formattedExplanations?.[i0]?.explanation
        ?? '';

      // ── TIMEOUT FET BODY IS AUTHORIZED, NOT LOCAL ────────────────
      //
      // This read `q?.explanation` — the bundled answer key — which is
      // `undefined` once questions come from `/questions`. With the formatter
      // cache also empty it fell through to a `Formatting…` PLACEHOLDER, and
      // `setExplanationFor` wrote that placeholder into the explanation store.
      // The heading reads that store BEFORE its authorized-explanation last
      // resort, so the placeholder shadowed the real explanation that `/check`
      // had already returned on the expired verdict — the timeout FET never
      // appeared at all.
      //
      // AUTHORIZATION IS UNCHANGED. Expiry still decides WHEN a timeout FET may
      // show; this decides only WHERE its words come from. `/check` returns the
      // explanation on `expired`, so by the time this runs the verdict either
      // has it or nothing is authorized yet.
      const authorized = (authorizedExplanation(this.quizService, i0, this.verdicts) ?? '').trim();
      const hasFet = cached && cached.toLowerCase().includes('correct because');
      const immediateTxt = (hasFet ? cached.trim() : '') || authorized;

      // NOTHING AUTHORIZED, NOTHING WRITTEN. Storing a placeholder would put a
      // non-explanation into the store that every later reader treats as real
      // content — and would shadow the authorized text when it arrives.
      if (immediateTxt) {
        params.setExplanationFor(i0, immediateTxt);
      }
      explanationToDisplay = immediateTxt;

      // Emit FET to the service
      if (hasFet) {
        this.explanationTextService.setExplanationText(immediateTxt, { index: i0, force: true });
      }

      // If no cached FET, resolve asynchronously
      if (!hasFet) {
        const compose = () => params.resolveFormatted(i0).then(formatted => {
          if (formatted) {
            params.setExplanationFor(i0, formatted);
            this.explanationTextService.setExplanationText(formatted, { index: i0, force: true });
            params.markForCheck();
          }
        }).catch(() => {});

        compose();

        // COMPOSE AGAIN WHEN THE VERDICT LANDS.
        //
        // The composed prefix ("Option 1 is correct because …") needs the
        // authorized correct-option identity, and expiry starts BOTH this
        // handler and the `/check` reveal at once. On a cold first question the
        // reveal loses that race, so the first compose has no identity to work
        // with and produces the bare body — which is what shipped to the screen
        // and stayed there, because nothing ran again.
        //
        // One shot, per question, dropped when it fires. Recomposing after the
        // verdict is idempotent when the first attempt already succeeded.
        const quizId = (this.quizService as any)?.quizId as string | undefined;
        const questionText = (this.quizService as any)
          ?.getQuestionsInDisplayOrder?.()?.[i0]?.questionText as string | undefined;

        if (quizId && questionText) {
          this.verdicts.terminalVerdicts$
            .pipe(
              filter((arrival) => arrival.quizId === quizId
                && norm(arrival.questionText) === norm(questionText)),
              take(1)
            )
            .subscribe(() => compose());
        }
      }
    } catch { }

    // Allow navigation to proceed
    this.nextButtonStateService.setNextButtonState(true);
    this.quizStateService.setAnswered(true);
    this.quizStateService.setAnswerSelected(true);

    // Defensive stop
    try { this.timerService.stopTimer(undefined, { force: true }); } catch { }

    params.markForCheck();

    return {
      explanationToDisplay,
      timedOut: true,
      timerStoppedForQuestion: true
    };
  }

  /**
   * Handles when the timer stops for the active question (non-timeout case).
   */
  handleTimerStoppedForActiveQuestion(params: {
    reason: 'timeout' | 'stopped';
    timerStoppedForQuestion: boolean;
    currentQuestionIndex: number;
    questions: QuizQuestion[];
    questionFresh: boolean;
    optionsToDisplay: Option[];
    sharedOptionBindings?: OptionBindings[];
    currentQuestion: QuizQuestion | null;
    normalizeIndex: (idx: number) => number;
    revealFeedbackForAllOptions: (opts: Option[]) => void;
    forceDisableSharedOption: () => void;
    updateBindingsAndOptions: (lockDisable: boolean) => {
      optionBindings: OptionBindings[];
      optionsToDisplay: Option[];
    };
    markForCheck: () => void;
  }): boolean {
    if (params.timerStoppedForQuestion) return true;

    const i0 = params.normalizeIndex(params.currentQuestionIndex ?? 0);
    if (!Number.isFinite(i0) || !params.questions?.[i0]) return false;
    if (params.reason !== 'timeout' && params.questionFresh) return false;

    const { canonicalOpts, lockKeys } = this.collectLockContextForQuestion(i0, {
      optionsToDisplay: params.optionsToDisplay,
      sharedOptionBindings: params.sharedOptionBindings,
      currentQuestionIndex: params.currentQuestionIndex,
      currentQuestion: params.currentQuestion
    });

    this.applyLocksAndDisableForQuestion(i0, canonicalOpts, lockKeys, {
      revealFeedback: params.reason === 'timeout'
    }, {
      revealFeedbackForAllOptions: params.revealFeedbackForAllOptions,
      forceDisableSharedOption: params.forceDisableSharedOption,
      updateBindingsAndOptions: params.updateBindingsAndOptions
    });

    if (params.reason !== 'timeout') {
      try {
        this.selectionMessageService.releaseBaseline(params.currentQuestionIndex);
      } catch { }
    }

    params.markForCheck();

    return true;  // timerStoppedForQuestion = true
  }

  /**
   * Stops the timer if all correct answers are selected.
   */
  stopTimerIfAllCorrectSelected(params: {
    currentQuestionIndex: number;
    questions: QuizQuestion[];
    optionsToDisplay: Option[];
  }): void {
    const idx = this.quizService.getCurrentQuestionIndex();

    // Canonical (truth for `correct`)
    const canonical = (this.quizService.questions?.[idx]?.options ?? []).map((o: Option) => ({ ...o }));
    // UI (truth for `selected`, possibly a different array)
    const ui = (params.optionsToDisplay ?? []).map((o: Option) => ({ ...o }));

    // Overlay UI.selected → canonical by identity
    const snapshot = this.selectedOptionService.overlaySelectedByIdentity(canonical, ui);

    // Defer one macrotask so any async CD/pipes settle
    setTimeout(() => {
      const totalCorrect = snapshot.filter(o => !!(o as any).correct).length;
      const selectedCorrect = snapshot.filter(o => !!(o as any).correct && !!(o as any).selected).length;

      if (totalCorrect > 0 && selectedCorrect === totalCorrect) {
        try { this.soundService?.play('correct'); } catch { }

        this.timerService.attemptStopTimerForQuestion({
          questionIndex: idx,
          optionsSnapshot: snapshot,
          onStop: (elapsed) => {
            (this.timerService as any).elapsedTimes ||= [];
            (this.timerService as any).elapsedTimes[idx] = elapsed ?? 0;
          }
        });
      }
    }, 0);
  }

  /**
   * Centralized, reasoned stop. Only stops when allowed.
   */
  safeStopTimer(
    reason: 'completed' | 'timeout' | 'navigate',
    timerStoppedForQuestion: boolean,
    lastAllCorrect: boolean
  ): boolean {
    if (timerStoppedForQuestion) return true;

    // Only "completed" may stop due to correctness
    if (reason === 'completed' && !lastAllCorrect) return false;

    try { this.timerService.stopTimer?.(undefined, { force: true }); } catch { }
    return true; // timerStoppedForQuestion = true
  }

  /**
   * Resolves the formatted explanation text for a given question index.
   * Tries updateExplanationText first, falls back to the formatted stream.
   * Returns the resolved text, or '' if nothing is available.
   *
   * Extracted from QuizQuestionComponent.resolveFormatted().
   */
  async resolveFormatted(params: {
    index: number;
    normalizeIndex: (idx: number) => number;
    formattedByIndex: Map<number, string>;
    useCache?: boolean;
    setCache?: boolean;
    timeoutMs?: number;
    updateExplanationText: (idx: number) => Promise<string>;
  }): Promise<string> {
    const i0 = params.normalizeIndex(params.index);
    const { useCache = true, setCache = true, timeoutMs = 1200 } = params;

    if (useCache) {
      const hit = params.formattedByIndex.get(i0);
      if (hit) return hit;
    }

    try {
      const out = await params.updateExplanationText(i0);
      let text = (out ?? '').toString().trim();

      if ((!text || text === 'No explanation available for this question.') &&
        this.explanationTextService.formattedExplanation$) {

        const src$ = this.explanationTextService.formattedExplanation$ as Observable<string | null | undefined>;

        const formatted$: Observable<string> = src$.pipe(
          filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0),
          map(s => s.trim()),
          timeout(timeoutMs),
          take(1)
        );

        try {
          text = await firstValueFrom(formatted$);
        } catch {
          text = '';
        }
      }

      if (!text || text === 'No explanation available for this question.') {
        return '';
      }

      if (text && setCache) params.formattedByIndex.set(i0, text);
      return text;
    } catch {
      return '';
    }
  }

  /**
   * Handles the full async onTimerExpiredFor flow.
   * Resolves explanation text (cached or computed), emits FET to service,
   * and returns the explanation text + async repair callback.
   *
   * Extracted from QuizQuestionComponent.onTimerExpiredFor().
   */
  async processTimerExpiry(params: {
    index: number;
    normalizeIndex: (idx: number) => number;
    questions: QuizQuestion[];
    currentQuestionIndex: number;
    currentQuestion: QuizQuestion | null;
    formattedByIndex: Map<number, string>;
    fixedQuestionIndex?: number;
    updateExplanationText: (idx: number) => Promise<string>;
  }): Promise<{
    formattedText: string;
    needsAsyncRepair: boolean;
  }> {
    const i0 = params.normalizeIndex(params.index);
    const ets = this.explanationTextService;

    // Wait if the explanation gate is still locked
    if (ets._fetLocked) await delay(60);

    // PREFER cached FET
    const cachedFet = params.formattedByIndex.get(i0)
      ?? ets.fetByIndex?.get(i0)
      ?? ets.formattedExplanations?.[i0]?.explanation
      ?? '';

    let formattedNow = '';
    if (cachedFet && cachedFet.toLowerCase().includes('correct because')) {
      formattedNow = cachedFet.trim();
    } else {
      formattedNow = (await params.updateExplanationText(i0))?.toString().trim() ?? '';
    }

    // Guard: skip empty or placeholder text, wait one frame before giving up
    if (!formattedNow || formattedNow === 'No explanation available for this question.') {
      await new Promise(requestAnimationFrame);

      const retry = (await params.updateExplanationText(i0))?.toString().trim() ?? '';
      if (!retry || retry === 'No explanation available for this question.') {
        return { formattedText: '', needsAsyncRepair: false };
      }

      ets.emitFormatted(i0, retry, { bypassGuard: true });
      return { formattedText: retry, needsAsyncRepair: false };
    }

    // Use valid formatted FET
    if (formattedNow && formattedNow !== 'No explanation available for this question.') {
      ets.emitFormatted(i0, formattedNow, { bypassGuard: true });
      return { formattedText: formattedNow, needsAsyncRepair: false };
    }

    // Fallback: raw explanation
    const rawBest =
      ((params.questions[i0]?.explanation ?? '') as string).toString().trim() ||
      ((ets.formattedExplanations[i0]?.explanation ?? '') as string).toString().trim() ||
      'Explanation not available.';
    ets.setExplanationText(rawBest, { force: true });

    // Needs async repair if no proper FET was found
    const needsAsyncRepair = !formattedNow ||
      formattedNow === 'No explanation available for this question.' ||
      !formattedNow.toLowerCase().includes('correct because');

    return { formattedText: rawBest, needsAsyncRepair };
  }

  /**
   * Performs the async repair resolution for timer expiry.
   * Only updates if the question is still active.
   *
   * Extracted from QuizQuestionComponent.onTimerExpiredFor() async tail.
   */
  async repairExplanationAsync(params: {
    index: number;
    normalizeIndex: (idx: number) => number;
    formattedByIndex: Map<number, string>;
    fixedQuestionIndex?: number;
    currentQuestionIndex: number;
    updateExplanationText: (idx: number) => Promise<string>;
  }): Promise<string | null> {
    const i0 = params.normalizeIndex(params.index);

    try {
      const clean = await this.resolveFormatted({
        index: i0,
        normalizeIndex: params.normalizeIndex,
        formattedByIndex: params.formattedByIndex,
        useCache: true,
        setCache: true,
        timeoutMs: 6000,
        updateExplanationText: params.updateExplanationText
      });

      const out = (clean ?? '').toString().trim();
      if (!out || out === 'No explanation available for this question.') return null;

      const active =
        params.normalizeIndex?.(params.fixedQuestionIndex ?? params.currentQuestionIndex ?? 0) ??
        (params.currentQuestionIndex ?? 0);
      if (active !== i0) return null;
      this.explanationTextService.setExplanationText(out, { force: true });
      return out;
    } catch {
      return null;
    }
  }

  /**
   * Handles multiple-answer timer logic: updates options state with feedback,
   * then attempts to stop the timer if all correct options are selected.
   * Returns the updated options array.
   * Extracted from handleMultipleAnswerTimerLogic().
   */
  async handleMultipleAnswerTimerLogic(params: {
    option: Option;
    optionsToDisplay: Option[];
    currentQuestionIndex: number;
  }): Promise<{
    optionsToDisplay: Option[];
    stopped: boolean;
  }> {
    try {
      // Update options state
      const updatedOptions = params.optionsToDisplay.map((opt) => {
        const isSelected = opt.optionId === params.option.optionId;

        return {
          ...opt,
          feedback: isSelected && !opt.correct ? 'x' : opt.feedback,
          showIcon: isSelected,
          active: true  // keep all options active
        };
      });

      // Stop the timer if all correct options are selected
      this.timerService.allowAuthoritativeStop();
      const stopped = await this.timerService.attemptStopTimerForQuestion({
        questionIndex: params.currentQuestionIndex,
      });

      return { optionsToDisplay: updatedOptions, stopped: !!stopped };
    } catch {
      return { optionsToDisplay: params.optionsToDisplay, stopped: false };
    }
  }

  /**
   * Flips into explanation mode and enables Next immediately after timer expiry.
   * Stops the timer, sets display state, and evaluates Next button state.
   * Extracted from onTimerExpiredFor inline ngZone.run block (lines 3936–3963).
   */
  applyTimerExpiryState(params: {
    i0: number;
    questions: QuizQuestion[];
    currentQuestionType: string | undefined;
  }): {
    feedbackText: string;
    displayExplanation: boolean;
  } {
    this.timerService.stopTimer(undefined, { force: true });

    this.explanationTextService.setShouldDisplayExplanation(true, { force: true });
    this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
    this.quizStateService.setAnswered(true);
    this.quizStateService.setAnswerSelected(true);

    const qType = params.questions?.[params.i0]?.type ?? params.currentQuestionType;
    if (qType === QuestionType.MultipleAnswer) {
      try {
        this.selectedOptionService.evaluateNextButtonStateForQuestion(
          params.i0,
          true,
          true
        );
      } catch { }
    } else {
      try { this.selectedOptionService.setAnswered(true); } catch { }
      try { this.nextButtonStateService.setNextButtonState(true); } catch { }
    }

    return {
      feedbackText: '',
      displayExplanation: true
    };
  }

  /**
   * Handles the async FET resolution after timer expiry.
   * Resolves formatted explanation text and determines if async repair is needed.
   * Extracted from onTimerExpiredFor() in QuizQuestionComponent.
   */
  async performTimerExpiredForAsync(params: {
    i0: number;
    normalizeIndex: (idx: number) => number;
    questions: QuizQuestion[];
    currentQuestionIndex: number;
    currentQuestion: QuizQuestion | null;
    formattedByIndex: Map<number, string>;
    fixedQuestionIndex: number;
    updateExplanationText: (idx: number) => Promise<string>;
  }): Promise<{
    formattedText: string | null;
    needsAsyncRepair: boolean;
  }> {
    try {
      const { formattedText, needsAsyncRepair } = await this.processTimerExpiry({
        index: params.i0,
        normalizeIndex: params.normalizeIndex,
        questions: params.questions,
        currentQuestionIndex: params.currentQuestionIndex,
        currentQuestion: params.currentQuestion,
        formattedByIndex: params.formattedByIndex,
        fixedQuestionIndex: params.fixedQuestionIndex,
        updateExplanationText: params.updateExplanationText
      });

      return { formattedText, needsAsyncRepair };
    } catch {
      return { formattedText: null, needsAsyncRepair: false };
    }
  }
}
