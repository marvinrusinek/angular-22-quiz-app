import { Service, inject } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { FeedbackService } from '../feedback/feedback.service';
import { OptionClickHandlerService } from '../../options/engine/option-click-handler.service';
import { OptionService } from '../../options/view/option.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

import { feedbackAnchorMatches } from '../../../utils/feedback-anchor';
import { resolveIsMultiAnswer } from '../../../utils/question-type-authority';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { isValidOption } from '../../../utils/option-utils';

/**
 * Context object carrying the component state needed by SharedOptionFeedbackService.
 * The component passes this in so the service can operate without direct component access.
 */
export interface FeedbackContext {
  optionsToDisplay: Option[];
  currentQuestion: QuizQuestion | null;
  type: 'single' | 'multiple';
  selectedOptions: Set<number | string>;
  optionBindings: OptionBindings[];
  timerExpiredForQuestion: boolean;
  activeQuestionIndex: number;
  showFeedbackForOption: Record<string | number, boolean>;
  feedbackConfigs: Record<string | number, FeedbackProps>;
  lastFeedbackOptionId: number;
  lastFeedbackQuestionIndex: number;
  selectedOptionId: number | null;
  isMultiMode: boolean;

  /** For getInlineFeedbackConfig */
  _feedbackDisplay: { idx: number; optionId?: number | null; config: FeedbackProps } | null;
  _multiSelectByQuestion: Map<number, Set<number>>;
  _correctIndicesByQuestion: Map<number, number[]>;
}

/**
 * Result returned by displayFeedbackForOption describing mutations
 * the component should apply to its own state.
 */
export interface DisplayFeedbackResult {
  showFeedback: boolean;
  showFeedbackForOption: Record<string | number, boolean>;
  feedbackConfigs: Record<string | number, FeedbackProps>;
  currentFeedbackConfig: FeedbackProps;
  activeFeedbackConfig: FeedbackProps;
  lastFeedbackOptionId: number;
  lastFeedbackQuestionIndex: number;
  isResolved: boolean;
}

/**
 * Result returned by rebuildShowFeedbackMapFromBindings.
 */
export interface RebuildFeedbackMapResult {
  showFeedbackForOption: Record<string | number, boolean>;
  showFeedback: boolean;
  /** Bindings with updated showFeedbackForOption and showFeedback fields. */
  updatedBindings: OptionBindings[];
}

/**
 * Result returned by regenerateFeedback.
 */
export interface RegenerateFeedbackResult {
  feedbackConfigs: Record<string | number, FeedbackProps>;
  updatedBindings: OptionBindings[];
}

@Service()
export class SharedOptionFeedbackService {
  private feedbackService = inject(FeedbackService);
  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);
  private clickHandler = inject(OptionClickHandlerService);
  private optionService = inject(OptionService);

  /**
   * Generates a FeedbackProps config for a clicked option.
   * Mirrors SharedOptionComponent.generateFeedbackConfig (lines ~2253-2420).
   */
  generateFeedbackConfig(
    option: SelectedOption,
    selectedIndex: number,
    ctx: FeedbackContext
  ): FeedbackProps {
    if (!option) return this.unavailableFeedbackProps(ctx, selectedIndex);

    // Ensure the main option has a displayIndex
    if (option.displayIndex === undefined) option.displayIndex = selectedIndex;

    const question = ctx.currentQuestion;
    const isMulti = this.detectMultiAnswer(ctx, question);

    // For Multi-Answer: consider ALL selected options to return "Select 1 more" etc.
    // For Single-Answer: just the current one (only one can be selected).
    const optionsToCheck: SelectedOption[] = isMulti
      ? this.gatherMultiOptionsToCheck(ctx, option, selectedIndex)
      : [option];

    const feedbackMessage = this.feedbackService.buildFeedbackMessage(
      question as QuizQuestion,
      optionsToCheck,
      false, // strict
      ctx.timerExpiredForQuestion,
      ctx.activeQuestionIndex,
      ctx.optionsToDisplay,
      option  // targetOption
    );

    const validOptions = (ctx.optionsToDisplay || []).filter(isValidOption);
    const correctMessage = this.feedbackService.setCorrectMessage(validOptions, ctx.currentQuestion!);

    const finalFeedback = isMulti
      ? this.computeMultiAllCorrectOverride(ctx, selectedIndex, feedbackMessage, correctMessage)
      : feedbackMessage;

    return this.buildFeedbackProps(ctx, option, selectedIndex, correctMessage, finalFeedback);
  }

  private unavailableFeedbackProps(ctx: FeedbackContext, selectedIndex: number): FeedbackProps {
    return {
      selectedOption: null,
      correctMessage: '',
      feedback: 'Feedback unavailable.',
      showFeedback: false,
      idx: selectedIndex,
      options: ctx.optionsToDisplay ?? [],
      question: ctx.currentQuestion ?? null
    };
  }

  // Declared type first; counting correct answers is the fallback for
  // questions the API has not typed.
  // REMOVE THE COUNT IN /questions CONTENT CUTOVER.
  private detectMultiAnswer(ctx: FeedbackContext, question: QuizQuestion | null | undefined): boolean {
    return resolveIsMultiAnswer(
      question,
      ctx.type === 'multiple' ||
        (question as any)?.multipleAnswer ||
        ((question?.options?.filter(o => isOptionCorrect(o)).length ?? 0) > 1)
    );
  }

  private buildFeedbackProps(
    ctx: FeedbackContext,
    option: SelectedOption,
    selectedIndex: number,
    correctMessage: string,
    finalFeedback: string
  ): FeedbackProps {
    return {
      selectedOption: option,
      correctMessage,
      feedback: finalFeedback,
      showFeedback: true,
      idx: selectedIndex,
      options: ctx.optionsToDisplay ?? [],
      question: ctx.currentQuestion ?? null
    } as FeedbackProps;
  }

  // Gather all currently selected options for multi-answer feedback. Uses a
  // consistent effectiveId (id || index) for Set lookups to match handleSelection,
  // and also queries the service since local state can be stale between clicks.
  private gatherMultiOptionsToCheck(
    ctx: FeedbackContext,
    option: SelectedOption,
    selectedIndex: number
  ): SelectedOption[] {
    const activeQIdx = ctx.activeQuestionIndex ?? 0;
    const serviceSelections = this.selectedOptionService.getSelectedOptionsForQuestion(activeQIdx) ?? [];
    const serviceSelectedIds = new Set<number | string>();
    for (const sel of serviceSelections) {
      const sId = (sel as any).optionId ?? (sel as any).index;
      if (sId != null && sId !== -1) {
        serviceSelectedIds.add(sId);
        serviceSelectedIds.add(Number(sId));
        serviceSelectedIds.add(String(sId));
      }
    }

    const selectedModels = (ctx.optionsToDisplay || []).filter((opt, i) => {
      const id = opt.optionId;
      const normIdForFilter = (id != null && !isNaN(Number(id))) ? Number(id) : null;
      const currentEffectiveId = (normIdForFilter !== null && normIdForFilter > -1) ? normIdForFilter : i;

      // Check 1: ID is in local selectedOptions Set
      if (ctx.selectedOptions.has(currentEffectiveId)) return true;

      // Check 2: Option object itself is marked selected
      if (opt.selected) return true;

      // Check 3: It is the option currently being processed (fallback)
      if (i === selectedIndex) return true;
      if (option && opt === option) return true;
      if (option && id != null && id === option.optionId) return true;

      // Check 4: Service has this option as selected (handles stale local state)
      if (serviceSelectedIds.has(currentEffectiveId)) return true;
      return id != null && serviceSelectedIds.has(id);
    });

    // Map to include displayIndex for FeedbackService reconciliation
    const optionsToCheck = selectedModels.map(m => {
      const idx = (ctx.optionsToDisplay || []).findIndex(orig =>
        orig === m || (m.optionId != null && m.optionId > -1 && orig.optionId === m.optionId)
      );
      return {
        ...m,
        displayIndex: idx >= 0 ? idx : undefined
      } as SelectedOption;
    });

    // Safety: ensure the current option is included if not found above
    if (!optionsToCheck.find(
      o => o === option ||
      (o.optionId != null && o.optionId > -1 && o.optionId === option.optionId))
    ) {
      optionsToCheck.push(option);
    }
    return optionsToCheck;
  }

  // Direct Override: if all correct options are selected (checking EVERY source
  // of truth) return the all-correct message, else the original feedback.
  private computeMultiAllCorrectOverride(
    ctx: FeedbackContext,
    selectedIndex: number,
    feedbackMessage: string,
    correctMessage: string
  ): string {
    const displayOpts = ctx.optionsToDisplay || [];

    // Count correct options
    const correctIndices: number[] = [];
    for (const [i, o] of displayOpts.entries()) {
      if (isOptionCorrect(o)) correctIndices.push(i);
    }
    const correctCount = correctIndices.length;

    // Check selection using MULTIPLE sources: any match = selected
    const isOptSelected = (opt: Option, idx: number): boolean => {
      // Source 1: optionsToDisplay item's selected flag
      if (opt.selected) return true;
      // Source 2: local selectedOptions Set (maintained by handleSelection)
      const oid = opt.optionId;
      const normId = (oid != null && !isNaN(Number(oid))) ? Number(oid) : null;
      const effId = (normId !== null && normId > -1) ? normId : idx;
      if (ctx.selectedOptions.has(effId)) return true;
      // Source 3: optionBindings isSelected
      if (ctx.optionBindings?.[idx]?.isSelected) return true;
      if (ctx.optionBindings?.[idx]?.option?.selected) return true;
      // Source 4: is this the option being clicked right now?
      return idx === selectedIndex;
    };

    let correctSelectedCount = 0;
    let incorrectSelectedCount = 0;
    for (const [i, o] of displayOpts.entries()) {
      const selected = isOptSelected(o, i);
      if (isOptionCorrect(o) && selected) correctSelectedCount++;
      if (!isOptionCorrect(o) && selected) incorrectSelectedCount++;
    }

    if (correctCount > 0 && correctSelectedCount >= correctCount && incorrectSelectedCount === 0) {
      return `You're right! ${correctMessage}`;
    }
    return feedbackMessage;
  }

  /**
   * Orchestrates feedback display for a clicked option.
   * Mirrors SharedOptionComponent.displayFeedbackForOption (lines ~2110-2251).
   * Returns a result object with the mutations the component should apply.
   */
  displayFeedbackForOption(
    option: SelectedOption,
    index: number,
    optionId: number,
    ctx: FeedbackContext
  ): DisplayFeedbackResult | null {
    if (!option) return null;

    // Confirm feedback function is triggered
    const currentQuestionIndex = ctx.activeQuestionIndex ?? 0;

    const showFeedbackForOption: Record<string | number, boolean> = { ...ctx.showFeedbackForOption };
    const feedbackConfigs: Record<string | number, FeedbackProps> = { ...ctx.feedbackConfigs };
    let lastFeedbackQuestionIndex = ctx.lastFeedbackQuestionIndex;

    lastFeedbackQuestionIndex = this.clearStaleFeedbackAnchors(
      showFeedbackForOption, feedbackConfigs, lastFeedbackQuestionIndex, currentQuestionIndex
    );

    // Set the last option selected (used to show only one feedback block)
    // Use index for anchoring so it's stable in the template loop
    const lastFeedbackOptionId = index;

    const effectiveId = this.computeEffectiveAnchorId(optionId, index);
    this.applyFeedbackVisibility(showFeedbackForOption, effectiveId);

    // Build the context for generateFeedbackConfig with the updated maps
    const updatedCtx: FeedbackContext = {
      ...ctx,
      showFeedbackForOption,
      feedbackConfigs,
      lastFeedbackOptionId,
      lastFeedbackQuestionIndex
    };

    const feedbackConfig = this.generateFeedbackConfig(option, index, updatedCtx);

    const isResolved = this.computeAndApplyResolution(option, currentQuestionIndex, ctx);

    this.storeFeedbackConfigUnderKeys(feedbackConfigs, ctx, effectiveId, index, feedbackConfig);
    this.regenerateVisibleFeedbackConfigs(
      ctx, updatedCtx, showFeedbackForOption, feedbackConfigs, effectiveId, currentQuestionIndex
    );

    // Update the answered state in the service
    this.selectedOptionService.updateAnsweredState();

    return {
      showFeedback: true,
      showFeedbackForOption,
      feedbackConfigs,
      currentFeedbackConfig: feedbackConfig,
      activeFeedbackConfig: feedbackConfig,
      lastFeedbackOptionId,
      lastFeedbackQuestionIndex,
      isResolved
    };
  }

  // Clear stale feedback anchors when the active question changed.
  private clearStaleFeedbackAnchors(
    showFeedbackForOption: Record<string | number, boolean>,
    feedbackConfigs: Record<string | number, FeedbackProps>,
    lastFeedbackQuestionIndex: number,
    currentQuestionIndex: number
  ): number {
    if (lastFeedbackQuestionIndex !== currentQuestionIndex) {
      for (const k of Object.keys(showFeedbackForOption)) {
        delete showFeedbackForOption[k];
      }
      for (const k of Object.keys(feedbackConfigs)) delete feedbackConfigs[k];

      lastFeedbackQuestionIndex = currentQuestionIndex;
    }
    return lastFeedbackQuestionIndex;
  }

  // Use consistent effective ID (matching shouldShowFeedbackAfter)
  private computeEffectiveAnchorId(optionId: number, index: number): number {
    const normalizedIdForAnchor =
      (optionId != null && !isNaN(Number(optionId))) ? Number(optionId) : null;
    return (normalizedIdForAnchor !== null && normalizedIdForAnchor > -1)
      ? normalizedIdForAnchor : index;
  }

  // Ensure feedback visibility is set for JUST THIS option (clear others first).
  // Set both number and string keys to be bulletproof for template lookups.
  private applyFeedbackVisibility(
    showFeedbackForOption: Record<string | number, boolean>,
    effectiveId: number | string
  ): void {
    for (const k of Object.keys(showFeedbackForOption)) {
      delete showFeedbackForOption[k];
    }
    showFeedbackForOption[effectiveId] = true;
    showFeedbackForOption[String(effectiveId)] = true;
    if (typeof effectiveId === 'string' && !isNaN(Number(effectiveId))) {
      showFeedbackForOption[Number(effectiveId)] = true;
    }
  }

  // Resolve the question's answered state and persist it via the service.
  private computeAndApplyResolution(
    option: SelectedOption,
    currentQuestionIndex: number,
    ctx: FeedbackContext
  ): boolean {
    const questionForResolution =
      this.quizService.questions?.[currentQuestionIndex] ?? ctx.currentQuestion;
    const selectedForResolution =
      this.selectedOptionService.getSelectedOptionsForQuestion(currentQuestionIndex) ?? [];

    let isResolved = false;
    if (questionForResolution) {
      isResolved = this.selectedOptionService.isQuestionResolvedCorrectly(
        questionForResolution,
        selectedForResolution as any
      );
    }

    // Single-answer fallback for immediate UI click before persistence catches up.
    if (!isResolved) {
      const correctCount = questionForResolution?.options?.filter(
        (o: any) => isOptionCorrect(o)
      ).length ?? 0;
      const isSingleAnswer = correctCount <= 1;
      if (isSingleAnswer && isOptionCorrect(option)) isResolved = true;
    }

    if (isResolved) {
      this.selectedOptionService.setAnswered(true, true);
    } else {
      // Ensure we don't accidentally reveal the explanation path
      this.selectedOptionService.setAnswered(false, false);
    }
    return isResolved;
  }

  // Store config under the numeric effectiveId, the string key, and the
  // canonical keyOf() key for the option at this index.
  private storeFeedbackConfigUnderKeys(
    feedbackConfigs: Record<string | number, FeedbackProps>,
    ctx: FeedbackContext,
    effectiveId: number | string,
    index: number,
    feedbackConfig: FeedbackProps
  ): void {
    feedbackConfigs[effectiveId] = feedbackConfig;
    feedbackConfigs[String(effectiveId)] = feedbackConfig;

    const hydratedOpt = ctx.optionsToDisplay?.[index];
    if (hydratedOpt) {
      const canonicalKey = this.optionService.keyOf(hydratedOpt, index);
      feedbackConfigs[canonicalKey] = feedbackConfig;
    }
  }

  // Re-generate configs for ALL options currently showing feedback, so if the
  // latest click solves the question, previous "Select 1 more" blocks also
  // update to "You're right!" for consistency.
  private regenerateVisibleFeedbackConfigs(
    ctx: FeedbackContext,
    updatedCtx: FeedbackContext,
    showFeedbackForOption: Record<string | number, boolean>,
    feedbackConfigs: Record<string | number, FeedbackProps>,
    effectiveId: number | string,
    currentQuestionIndex: number
  ): void {
    if (!ctx.optionBindings) return;
    for (const [i, b] of ctx.optionBindings.entries()) {
      const id = (b.option?.optionId != null && b.option.optionId > -1) ? b.option.optionId : i;
      if (showFeedbackForOption[id] === true && id !== effectiveId && String(id) !== String(effectiveId)) {
        const hydrated = ctx.optionsToDisplay?.[i];
        if (hydrated) {
          const selOpt: SelectedOption = {
            ...hydrated,
            selected: true,
            questionIndex: currentQuestionIndex,
            displayIndex: i,
            feedback: hydrated.feedback ?? ''
          };
          const updatedCfg = this.generateFeedbackConfig(selOpt, i, updatedCtx);
          feedbackConfigs[id] = updatedCfg;
          feedbackConfigs[String(id)] = updatedCfg;
          // Also update under canonical key
          const bKey = this.optionService.keyOf(hydrated, i);
          feedbackConfigs[bKey] = updatedCfg;
        }
      }
    }
  }

  /**
   * Rebuilds the showFeedbackForOption map from current binding state.
   * Mirrors SharedOptionComponent.rebuildShowFeedbackMapFromBindings (lines ~1130-1182).
   * Returns mutations instead of writing to component state directly.
   */
  rebuildShowFeedbackMapFromBindings(
    optionBindings: OptionBindings[],
    lastFeedbackOptionId: number | string,
    selectedOptionHistory: (number | string)[]
  ): RebuildFeedbackMapResult {
    // RESOLVE: optionBindings may be a signal (-clean) or array (-main)
    const _rawRb = optionBindings as any;
    optionBindings = typeof _rawRb === 'function' ? (_rawRb() ?? []) : (_rawRb ?? []);
    const showMap: Record<string | number, boolean> = {};

    // Prefer lastFeedbackOptionId for the anchor; it tracks the most recent click reliably
    const targetId =
      typeof lastFeedbackOptionId === 'number' && lastFeedbackOptionId !== -1
        ? lastFeedbackOptionId
        : (Array.isArray(selectedOptionHistory) && selectedOptionHistory.length > 0)
          ? selectedOptionHistory[selectedOptionHistory.length - 1]
          : undefined;

    let fallbackSelectedId: number | undefined;
    for (const b of optionBindings ?? []) {
      const id = b?.option?.optionId;
      if (id == null) continue;

      showMap[id] = false;
      showMap[String(id)] = false;

      if (fallbackSelectedId === undefined && b.isSelected === true) {
        fallbackSelectedId = id;
      }
    }

    const finalTargetId = targetId !== undefined ? targetId : fallbackSelectedId;
    let showFeedback = false;

    if (finalTargetId !== undefined) {
      showFeedback = true;
      // Set both index and optionId in the map for maximum template robustness
      showMap[finalTargetId] = true;
      showMap[String(finalTargetId)] = true;

      // Also try to find the other identifier (if finalTargetId is an index, find its optionId and vice versa)
      const targetBinding = (optionBindings ?? [])[finalTargetId as number];
      if (targetBinding?.option?.optionId != null) {
        showMap[targetBinding.option.optionId] = true;
        showMap[String(targetBinding.option.optionId)] = true;
      }
    }

    // Preserve the existing feedbackConfigs - do NOT clear them.
    // They were set by displayFeedbackForOption() and contain the correct message.
    // Only update the showFeedbackForOption map (which controls WHERE feedback shows).
    const showFeedbackForOption = { ...showMap };

    const updatedBindings = (optionBindings ?? []).map(b => {
      const updated = { ...b, showFeedbackForOption };
      if (showFeedback) updated.showFeedback = true;
      return updated;
    });

    return {
      showFeedbackForOption,
      showFeedback,
      updatedBindings
    };
  }

  /**
   * Returns the feedback config for a given binding/index using _feedbackDisplay and clickHandler.
   * Mirrors SharedOptionComponent.getInlineFeedbackConfig (lines ~3181-3219).
   */
  getInlineFeedbackConfig(
    _b: OptionBindings,
    i: number,
    ctx: FeedbackContext
  ): FeedbackProps | null {
    // ONLY use _feedbackDisplay -- it is the single source of truth for
    // which option shows feedback and what that feedback content is.
    if (feedbackAnchorMatches(ctx._feedbackDisplay, _b.option?.optionId, i) && ctx._feedbackDisplay?.config?.showFeedback) {
      let config = ctx._feedbackDisplay.config;

      // AUTHORITATIVE MULTI-ANSWER OVERRIDE using durable tracker.
      // The _multiSelectByQuestion map survives binding regeneration and
      // is the ONLY reliable source of which options are currently selected.
      const qIdx = ctx.activeQuestionIndex;

      // Use cached correct indices (captured on first click, immune to corruption)
      let correctIndicesArr: number[] = ctx._correctIndicesByQuestion.get(qIdx) ?? [];
      if (correctIndicesArr.length === 0) {
        const feedbackQ = ctx.currentQuestion ?? this.getQuestionAtDisplayIndex(qIdx);
        const result = this.clickHandler.resolveCorrectIndices(
          feedbackQ, qIdx, ctx.isMultiMode, ctx.type
        );
        correctIndicesArr = result.correctIndices;
      }

      // Type from the declared type; correctIndicesArr stays as correctness.
      // REMOVE THE COUNT IN /questions CONTENT CUTOVER.
      const effectiveMultiMode = resolveIsMultiAnswer(
        ctx.currentQuestion ?? this.getQuestionAtDisplayIndex(qIdx),
        ctx.isMultiMode || ctx.type === 'multiple' || correctIndicesArr.length > 1
      );
      const durableSelected = ctx._multiSelectByQuestion.get(qIdx);

      if (effectiveMultiMode && durableSelected && durableSelected.size > 0 && correctIndicesArr.length > 0) {
        const clickState = this.clickHandler.computeMultiAnswerClickState(
          i, durableSelected, correctIndicesArr
        );
        const newFeedback = this.clickHandler.generateMultiAnswerFeedbackText(clickState);

        if (newFeedback !== config.feedback) {
          config = { ...config, feedback: newFeedback };
        }
      }

      return config;
    }
    return null;
  }

  /**
   * Regenerates feedback for a specific question index.
   * Mirrors SharedOptionComponent.regenerateFeedback (lines ~2922-2966).
   * Returns mutations instead of writing to component state directly.
   */
  regenerateFeedback(
    idx: number,
    optionsToDisplay: Option[],
    optionBindings: OptionBindings[]
  ): RegenerateFeedbackResult | null {
    // RESOLVE: optionBindings may be a signal (-clean) or array (-main)
    const _rawRg = optionBindings as any;
    optionBindings = typeof _rawRg === 'function' ? (_rawRg() ?? []) : (_rawRg ?? []);
    if (idx < 0 || !optionsToDisplay?.length) return null;

    // Use getQuestionAtDisplayIndex for shuffle-aware question lookup
    const question = this.getQuestionAtDisplayIndex(idx);
    if (!question?.options) return null;

    const selections = this.selectedOptionService.getSelectedOptionsForQuestion(idx) || [];
    const freshFeedback = this.feedbackService.buildFeedbackMessage(
      question,
      selections,
      false,
      false,
      idx,
      optionsToDisplay
    );

    const feedbackConfigs: Record<string | number, FeedbackProps> = {};
    const updatedBindings = (optionBindings ?? []).map((b, i) => {
      if (!b.option) return b;

      const updated = {
        ...b,
        option: { ...b.option, feedback: freshFeedback },
        feedback: freshFeedback
      };

      const key = this.optionService.keyOf(b.option, i);

      feedbackConfigs[key] = {
        feedback: freshFeedback,
        showFeedback: true,
        options: optionsToDisplay,
        question: question,
        selectedOption: b.option,
        correctMessage: freshFeedback,
        idx: b.index,
        questionIndex: idx
      };

      return updated;
    });

    return {
      feedbackConfigs,
      updatedBindings
    };
  }

  /**
   * Initializes feedback bindings from option bindings.
   * Mirrors SharedOptionComponent.initializeFeedbackBindings
   */
  initializeFeedbackBindings(
    optionBindings: OptionBindings[],
    ctx: FeedbackContext
  ): FeedbackProps[] {
    // RESOLVE: optionBindings may be a signal (-clean) or array (-main)
    const _rawIb = optionBindings as any;
    optionBindings = typeof _rawIb === 'function' ? (_rawIb() ?? []) : (_rawIb ?? []);
    if (optionBindings?.some((b) => b.isSelected)) {
      return optionBindings.map((_, idx) => this.getDefaultFeedbackProps(idx, ctx));
    }

    return optionBindings.map((optionBinding, idx) => {
      if (!optionBinding || !optionBinding.option) {
        return this.getDefaultFeedbackProps(idx, ctx);
      }

      const feedbackBinding = this.getFeedbackBindings(
        optionBinding.option,
        idx,
        ctx
      );

      return feedbackBinding;
    });
  }

  /**
   * Returns default FeedbackProps for a given index.
   * Mirrors SharedOptionComponent.getDefaultFeedbackProps (lines ~2824-2841).
   */
  getDefaultFeedbackProps(idx: number, ctx: FeedbackContext): FeedbackProps {
    const defaultQuestion: QuizQuestion = {
      questionText: '',
      options: [],
      explanation: '',
      type: QuestionType.SingleAnswer
    };

    return {
      correctMessage: 'No correct message available',
      feedback: '',
      showFeedback: false,
      selectedOption: null,
      options: ctx.optionsToDisplay ?? [],
      question: ctx.currentQuestion ?? defaultQuestion,
      idx: idx
    };
  }

  /**
   * Gets feedback bindings for an option at a given index.
   * Mirrors SharedOptionComponent.getFeedbackBindings (lines ~2657-2697).
   */
  getFeedbackBindings(
    option: Option,
    idx: number,
    ctx: FeedbackContext
  ): FeedbackProps {
    // Check if the option is selected (fallback to false if undefined or null)
    const isSelected = ctx.selectedOptionId === option.optionId;

    const feedbackMap: Record<string | number, boolean> =
      ctx.showFeedbackForOption ?? {};
    const optionKey = option?.optionId ?? idx;
    const fallbackKey = idx;

    const showFeedback =
      isSelected &&
      (feedbackMap[optionKey] ??
        feedbackMap[String(optionKey)] ??
        feedbackMap[fallbackKey] ??
        feedbackMap[String(fallbackKey)]);

    // Safeguard to ensure options array and question exist
    const options = ctx.optionsToDisplay ?? [];

    const fallbackQuestion: QuizQuestion = {
      questionText: 'No question available',
      options: [],
      explanation: '',
      type: QuestionType.SingleAnswer
    };

    const question = ctx.currentQuestion ?? fallbackQuestion;

    // Prepare the feedback properties
    return {
      options,
      question,
      selectedOption: option,
      correctMessage:
        this.feedbackService.setCorrectMessage(ctx.optionsToDisplay, ctx.currentQuestion!) ??
        'No correct message available',
      feedback: option.feedback ?? '',
      showFeedback,
      idx
    } as FeedbackProps;
  }

  /**
   * Helper to get question at a display index, respecting shuffle state.
   * When shuffle is enabled, uses shuffledQuestions (display order).
   * When shuffle is disabled, uses questions (original order).
   */
  private getQuestionAtDisplayIndex(displayIndex: number): QuizQuestion | null {
    const isShuffled = this.quizService?.isShuffleEnabled?.() &&
      this.quizService?.shuffledQuestions?.length > 0;
    const questionSource = isShuffled
      ? this.quizService.shuffledQuestions : this.quizService?.questions;
    return questionSource?.[displayIndex] ?? null;
  }
}