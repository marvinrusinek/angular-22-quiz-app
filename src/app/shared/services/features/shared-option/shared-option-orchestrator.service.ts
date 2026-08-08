import { Service } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { FeedbackContext } from './shared-option-feedback.service';

import type { SharedOptionComponent } from '../../../../components/question/answer/shared-option-component/shared-option.component';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { declaredIsMultiAnswer } from '../../../utils/question-type-authority';
import { norm } from '../../../utils/text-norm';

type Host = SharedOptionComponent;

@Service()
export class SharedOptionOrchestratorService {

  // ===== Lifecycle =====
  runOnInit(host: Host): void {
    host.initializeQuestionIndex();
    host.resetStateForNewQuestion();
    host.subscribeToTimerExpiration();
    host.setupFallbackRendering();
    host.initializeConfiguration();
    host.initializeOptionDisplayWithFeedback();
    host.setupSubscriptions();
    host.subscribeToSelectionChanges();
  }

  runAfterViewInit(host: Host): void {
    host.viewReady.set(true);
    host.setupRehydrateTriggers();

    if (!host.optionBindings()?.length && host.optionsToDisplay?.length) {
      host.generateOptionBindings();
    }
  }

  runOnDestroy(_host: Host): void {
    // Subscriptions cleaned up via takeUntilDestroyed(destroyRef)
  }

  // ===== Index helpers =====
  runInitializeQuestionIndex(host: Host): void {
    const qIndex = host.questionIndex() ??
        host.currentQuestionIndex ??
        host.config()?.idx ??
        host.quizService?.currentQuestionIndex ?? 0;
    host.lastProcessedQuestionIndex = qIndex;
    host.updateResolvedQuestionIndex(qIndex);
  }

  runResolveCurrentQuestionIndex(host: Host): number {
    const active = host.getActiveQuestionIndex();
    return Number.isFinite(active) ? Math.max(0, Math.floor(active)) : 0;
  }

  runGetActiveQuestionIndex(host: Host): number {
    const qi = host.questionIndex();
    if (typeof qi === 'number' && Number.isFinite(qi)) return qi;

    if (typeof host.currentQuestionIndex === 'number' && 
      Number.isFinite(host.currentQuestionIndex)
    ) {
      return host.currentQuestionIndex;
    }
    if (Number.isFinite(host.resolvedQuestionIndex)) {
      return host.resolvedQuestionIndex!;
    }
    const svcIndex = host.quizService?.getCurrentQuestionIndex?.() ?? host.quizService?.currentQuestionIndex;
    if (typeof svcIndex === 'number' && Number.isFinite(svcIndex)) return svcIndex;

    return 0;
  }

  runNormalizeQuestionIndex(_host: Host, candidate: unknown): number | null {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      return null;
    }
    if (candidate < 0) return 0;
    return Math.floor(candidate);
  }

  runUpdateResolvedQuestionIndex(host: Host, candidate: unknown): void {
    if (typeof candidate !== 'number' && candidate !== null) return;

    const normalized = host.normalizeQuestionIndex(candidate);
    if (normalized !== null) host.resolvedQuestionIndex = normalized;
  }

  runGetQuestionAtDisplayIndex(host: Host, displayIndex: number): QuizQuestion | null {
    const isShuffled = host.quizService?.isShuffleEnabled?.() &&
      host.quizService?.shuffledQuestions?.length > 0;
    const questionSource = isShuffled
      ? host.quizService.shuffledQuestions
      : host.quizService?.questions;
    return questionSource?.[displayIndex] ?? null;
  }

  // ===== Multi-mode =====
  runIsMultiMode(host: Host): boolean {
    const idx = host.getActiveQuestionIndex();

    // Always resolve the display-order question for this index
    const currentQ = host.getQuestionAtDisplayIndex(idx) ?? host.currentQuestion();

    // DECLARED TYPE FIRST. The whole fingerprint dance below exists only to
    // count correct options in the local bank, which is the answer key. When
    // the API has typed this question there is nothing to infer, and the
    // fingerprint's failure modes (stale currentQuestion, option-text drift)
    // stop mattering entirely.
    const declaredMulti = declaredIsMultiAnswer(currentQ);
    if (declaredMulti !== null) {
      host._isMultiModeCache = declaredMulti;
      return declaredMulti;
    }

    // REMOVE IN /questions CONTENT CUTOVER — everything below is the fallback
    // for questions the API has not typed.
    // PRISTINE-FIRST via OPTION-TEXT FINGERPRINT.
    // Question-text matching can fail (currentQuestion may be null/stale at
    // initial render). Match by the option-text fingerprint instead â€” it
    // uniquely identifies a question across the entire QUIZ_DATA.
    let result = false;
    try {
      const qs: any = host.quizService;

      // Collect candidate option texts from anywhere we can find them.
      const collectTexts = (arr: any[] | undefined | null): string[] => {
        if (!Array.isArray(arr)) return [];
        return arr.map((o: any) => norm(o?.text)).filter((t: string) => !!t);
      };
      let candidateTexts: string[] = collectTexts(host.optionBindings()?.map((b: OptionBindings) => b?.option));
      if (!candidateTexts.length) candidateTexts = collectTexts(host.optionsToDisplay);
      if (!candidateTexts.length) candidateTexts = collectTexts(currentQ?.options);

      if (candidateTexts.length > 0) {
        const candidateSet = new Set(candidateTexts);
        const bundle: any[] = qs?.quizInitialState ?? [];
        outer: for (const quiz of bundle) {
          for (const pq of (quiz?.questions ?? [])) {
            const pqOpts = pq?.options ?? [];
            if (pqOpts.length !== candidateTexts.length) continue;
            const pqTexts = pqOpts.map((o: any) => norm(o?.text));
            // Every pristine option text must appear in candidate set.
            if (!pqTexts.every((t: string) => candidateSet.has(t))) continue;
            const correctCount = pqOpts.filter(
              (o: any) => isOptionCorrect(o)
            ).length;
            if (correctCount > 1) result = true;
            break outer;
          }
        }
      }

      // ALSO try question-text match in case option fingerprint missed.
      if (!result) {
        const isShuffled = qs?.isShuffleEnabled?.()
          && Array.isArray(qs?.shuffledQuestions)
          && qs.shuffledQuestions.length > 0;
        const displayQ = isShuffled
          ? (qs?.getQuestionsInDisplayOrder?.()?.[idx] ?? qs?.shuffledQuestions?.[idx])
          : currentQ;
        const pq = qs?.getPristineQuestionByText?.(
          displayQ?.questionText ?? currentQ?.questionText
        );
        if (pq) {
          const correctCount = (pq.options ?? []).filter(
            (o: any) => isOptionCorrect(o)
          ).length;
          if (correctCount > 1) result = true;
        }
      }
    } catch { /* ignore */ }

    // Fall back to detectMultiMode if pristine didn't decide.
    if (!result) {
      result = host.clickHandler.detectMultiMode(
        currentQ, 
        host.type, 
        host.config()?.type
      );
    }

    // Update cache for other code that reads it
    host._isMultiModeCache = result;
    return result;
  }

  // ===== Feedback =====
  runBuildFeedbackContext(host: Host): FeedbackContext {
    return {
      optionsToDisplay: host.optionsToDisplay,
      currentQuestion: host.currentQuestion(),
      type: host.type as 'single' | 'multiple',
      selectedOptions: host.selectedOptions,
      optionBindings: host.optionBindings(),
      timerExpiredForQuestion: host.timerExpiredForQuestion(),
      activeQuestionIndex: host.getActiveQuestionIndex(),
      showFeedbackForOption: host.showFeedbackForOption,
      feedbackConfigs: host.feedbackConfigs,
      lastFeedbackOptionId: host.lastFeedbackOptionId as number,
      lastFeedbackQuestionIndex: host.lastFeedbackQuestionIndex,
      selectedOptionId: host.selectedOptionId(),
      isMultiMode: host.isMultiMode,
      _feedbackDisplay: host._feedbackDisplay,
      _multiSelectByQuestion: host._multiSelectByQuestion,
      _correctIndicesByQuestion: host._correctIndicesByQuestion
    };
  }

  runDisplayFeedbackForOption(host: Host, option: SelectedOption, index: number, optionId: number): void {
    if (!option) return;
    const ctx = host.buildFeedbackContext();
    const result = host.feedbackManager.displayFeedbackForOption(option, index, optionId, ctx);
    if (!result) return;
    host.showFeedback.set(result.showFeedback);
    host.showFeedbackForOption = result.showFeedbackForOption;
    host.feedbackConfigs = result.feedbackConfigs;
    host.currentFeedbackConfig = result.currentFeedbackConfig;
    host.activeFeedbackConfig.set(result.activeFeedbackConfig);
    host.lastFeedbackOptionId = result.lastFeedbackOptionId;
    host.lastFeedbackQuestionIndex = result.lastFeedbackQuestionIndex;
    host.cdRef.markForCheck();
  }

  runRebuildShowFeedbackMapFromBindings(host: Host): void {
    const result = host.feedbackManager.rebuildShowFeedbackMapFromBindings(
      host.optionBindings(), host.lastFeedbackOptionId, host.selectedOptionHistory
    );
    host.showFeedback.set(result.showFeedback);
    host.showFeedbackForOption = result.showFeedbackForOption;
    for (const b of host.optionBindings() ?? []) {
      b.showFeedbackForOption = host.showFeedbackForOption;
      if (host.showFeedback()) b.showFeedback = true;
    }
    host.cdRef.markForCheck();
  }

  runRegenerateFeedback(host: Host, idx: number): void {
    const result = host.feedbackManager.regenerateFeedback(idx, host.optionsToDisplay, host.optionBindings());
    if (result) {
      host.feedbackConfigs = result.feedbackConfigs;
      host.cdRef.markForCheck();
    }
  }

  // ===== Selection / visibility =====
  runUpdateSelections(host: Host, rawSelectedId: number | string): void {
    host.optionSelectionUiService.applySingleSelectClick(
        host.optionBindings(),
        rawSelectedId,
        host.selectedOptionHistory
    );
    if (host.showFeedback()) {
      host.rebuildShowFeedbackMapFromBindings();
    }
    host.cdRef.markForCheck();
  }

  runOnVisibilityChange(host: Host): void {
    if (document.visibilityState !== 'visible') {
      return;
    }
    try {
      host.ensureOptionsToDisplay();
      host.preserveOptionHighlighting();
      host.cdRef.markForCheck();
    } catch (err: unknown) {
      console.error('SharedOptionOrchestratorService.runOnVisibilityChange visibility handling failed:', err);
    }
  }

  // ===== Disabled / classes =====
  runComputeDisabledState(host: Host, option: Option, index: number): boolean {
    return host.clickHandler.computeDisabledState(option, index, {
      currentQuestionIndex: host.currentQuestionIndex,
      isMultiMode: host.isMultiMode,
      forceDisableAll: host.forceDisableAll(),
      disabledOptionsPerQuestion: host.disabledOptionsPerQuestion,
      lockedIncorrectOptionIds: host.lockedIncorrectOptionIds,
      flashDisabledSet: host.flashDisabledSet
    });
  }

  runShouldDisableOption(host: Host, binding: OptionBindings): boolean {
    if (!binding || !binding.option) return false;
    if (host.isMultiMode) return host.forceDisableAll();
    return true;
  }

  runGetOptionClasses(host: Host, binding: OptionBindings): { [key: string]: boolean } {
    return host.optionService.getOptionClasses(
      binding,
      binding.index,
      host.highlightedOptionIds,
      host.flashDisabledSet,
      host.isLocked(binding, binding.index),
      host.timerExpiredForQuestion()
    );
  }

  runOnOptionInteraction(host: Host, binding: OptionBindings, index: number, event: MouseEvent): void {
    if (host.isDisabled(binding, index)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    host.runOptionContentClick(binding, index, event);
  }

  // ===== Rendering / explanation =====
  runMarkRenderReady(host: Host, _reason: string): void {
    const bindingsReady =
      Array.isArray(host.optionBindings()) && host.optionBindings().length > 0;
    const optionsReady =
      Array.isArray(host.optionsToDisplay) && host.optionsToDisplay.length > 0;

    if (bindingsReady && optionsReady) {
      host.renderReady.set(true);
      host.renderReadyChange.emit(true);
    }
  }

  runEmitExplanation(host: Host, questionIndex: number, skipGuard: boolean): void {
    host.explanationHandler.resolveAndEmitExplanation({
      questionIndex,
      activeQuestionIndex: host.getActiveQuestionIndex(),
      currentQuestion: host.currentQuestion(),
      quizId: host.quizId() ?? '',
      optionBindings: host.optionBindings(),
      optionsToDisplay: host.optionsToDisplay,
      isMultiMode: host.isMultiMode,
      getQuestionAtDisplayIndex: (idx: number) => host.getQuestionAtDisplayIndex(idx)
    }, skipGuard);
  }

  runDeferHighlightUpdate(host: Host, callback: () => void): void {
    if (host._pendingHighlightRAF !== null) {
      cancelAnimationFrame(host._pendingHighlightRAF);
    }
    host._pendingHighlightRAF = requestAnimationFrame(() => {
      host._pendingHighlightRAF = null;
      callback();
    });
  }

  runFinalizeOptionPopulation(host: Host): void {
    if (!host.optionsToDisplay?.length) return;

    if (host.type !== 'multiple') {
      // In shuffled mode, use display-order question (currentQuestion may be wrong)
      const qs: any = host.quizService;
      const isShuf = qs?.isShuffleEnabled?.()
        && Array.isArray(qs?.shuffledQuestions)
        && qs.shuffledQuestions.length > 0;
      const displayIdx = host.getActiveQuestionIndex();
      const cq = host.currentQuestion();
      const questionForType = isShuf
        ? (qs?.getQuestionsInDisplayOrder?.()?.[displayIdx] ?? qs?.shuffledQuestions?.[displayIdx] ?? cq)
        : cq;
      host.type = questionForType
          ? host.determineQuestionType(questionForType) : 'single';
    }
  }

  runResetUIForNewQuestion(host: Host): void {
    host.hasUserClicked.set(false);
    host.optionBindingsInitialized.set(false);
    host.highlightedOptionIds.clear();
    host.selectedOptionMap.clear();
    host.showFeedbackForOption = {};
    host.lastFeedbackOptionId = -1;
    host.lastSelectedOptionId = -1;
    host.selectedOptionHistory = [];
    host.feedbackConfigs = {};
    host.lockedIncorrectOptionIds.clear();
    host.timerExpiredForQuestion.set(false);
    host._timerExpiryHandled = false;
    host.forceDisableAll.set(false);
    host.timeoutCorrectOptionKeys?.clear?.();
    host.flashDisabledSet?.clear?.();
  }

  runInitializeOptionBindings(host: Host): void {
    if (host.optionBindingsInitialized()) return;

    host.optionBindingsInitialized.set(true);
    if (!host.optionsToDisplay?.length) {
      host.optionBindingsInitialized.set(false);
      return;
    }
    host.generateOptionBindings();
  }

  runEnsureOptionIds(host: Host): void {
    for (const [index, option] of (host.optionsToDisplay ?? []).entries()) {
      const id = Number(option.optionId);
      if (option.optionId == null || isNaN(id) || id < 0) {
        option.optionId = index;
      }
    }
  }

  runFindBindingByOptionId(host: Host, optionId: number): { b: OptionBindings; i: number } | null {
    const opts = host.optionBindings() ?? [];
    const i = opts.findIndex((x: OptionBindings, idx: number) => {
      const explicitId = x?.option?.optionId;
      const effectiveId = (explicitId != null && Number(explicitId) > -1)
        ? Number(explicitId) : idx;
      return effectiveId === Number(optionId);
    });
    if (i < 0) return null;
    return { b: opts[i], i };
  }

  runCanShowOptions(host: Host): boolean {
    const hasBindings = (host.optionBindings()?.length ?? 0) > 0;
    // Primary path: strict gating
    if (hasBindings && host.canDisplayOptions() && host.renderReady()) return true;
    // Resilience fallback: form + every binding has an option resolved
    const bindings = host.optionBindings();
    const everyHasOption = Array.isArray(bindings)
      && bindings.length > 0
      && bindings.every((b: OptionBindings) => !!b?.option);
    return !!host.form && everyHasOption;
  }

  runCanDisplayOptions(host: Host): boolean {
    return (
      !!host.form &&
      host.renderReady() &&
      host.showOptions() &&
      Array.isArray(host.optionBindings()) &&
      host.optionBindings().length > 0 &&
      host.optionBindings().every((b: OptionBindings) => !!b.option)
    );
  }

  runShouldShowIcon(host: Host, option: Option, i: number): boolean {
    const k = host.keyOf(option, i);
    const showFromCfg = !!host.feedbackConfigs[k]?.showFeedback;
    const showLegacy = !!(option as any).showIcon;
    return showFromCfg || showLegacy;
  }
}