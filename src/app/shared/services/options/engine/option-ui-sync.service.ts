import { Service, inject } from '@angular/core';
import { MatCheckboxChange } from '@angular/material/checkbox';
import { MatRadioChange } from '@angular/material/radio';

import { QuestionType } from '../../../models/question-type.enum';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { SK_DISPLAY_MODE, SK_IS_ANSWERED, SK_MULTI_PERFECT } from '../../../constants/session-keys';
import { writeSessionString } from '../../../utils/session-storage';

import { FeedbackService } from '../../features/feedback/feedback.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { OptionLockPolicyService } from '../policy/option-lock-policy.service';
import { OptionSelectionPolicyService } from '../policy/option-selection-policy.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../../features/selection-message/selection-message.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { declaredIsMultiAnswer, resolveIsMultiAnswer } from '../../../utils/question-type-authority';
import { norm } from '../../../utils/text-norm';
import { swallow } from '../../../utils/error-logging';

export interface OptionUiSyncContext {
  form: any;
  type: 'single' | 'multiple';
  optionBindings: OptionBindings[];
  optionsToDisplay: Option[];
  currentQuestionIndex: number;
  forceDisableAll: boolean;
  feedbackConfigs: Record<string, any>;
  showFeedbackForOption: Record<number | string, boolean>;
  lastFeedbackOptionId: number | string;
  lastFeedbackQuestionIndex: number;
  lastClickedOptionId: number | string | null;
  lastClickTimestamp: number | null;
  freezeOptionBindings: boolean;
  hasUserClicked: boolean;
  showFeedback: boolean;
  selectedOptionHistory: (number | string)[];
  selectedOptionMap: Map<number | string, boolean>;
  perQuestionHistory: Set<number | string>;

  keyOf: (opt: Option, i: number) => string;
  getActiveQuestionIndex: () => number;
  getQuestionAtDisplayIndex: (idx: number) => QuizQuestion | null;
  emitExplanation: (idx: number, skipGuard?: boolean) => void;

  enforceSingleSelection: (b: OptionBindings) => void;
  syncSelectedFlags: () => void;
  toggleSelectedOption: (opt: Option) => void;
  onSelect?: (binding: OptionBindings, checked: boolean, questionIndex: number) => void;
}

@Service()
export class OptionUiSyncService {
  // ── injects ─────────────────────────────────────────────────────
  private feedbackService = inject(FeedbackService);
  private nextButtonStateService = inject(NextButtonStateService);
  private optionLockPolicyService = inject(OptionLockPolicyService);
  private optionSelectionPolicyService = inject(OptionSelectionPolicyService);
  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);

  // ── public methods ──────────────────────────────────────────────

  updateOptionAndUI(
    optionBinding: OptionBindings,
    index: number,
    event: MatCheckboxChange | MatRadioChange,
    ctx: OptionUiSyncContext
  ): void {
    const currentIndex = ctx.getActiveQuestionIndex() ?? 0;

    this.resetFeedbackAnchorIfQuestionChanged(currentIndex, ctx);

    const checked = 'checked' in event ? (event as MatCheckboxChange).checked : true;
    const isTrulyMulti = this.computeIsTrulyMulti(ctx);

    // UI-LEVEL RESET for single-answer mode (Visuals only, OIS handles service state)
    // ONLY run if it's definitely NOT a multi-answer scenario.
    if (!isTrulyMulti && checked) {
      this.applySingleAnswerUiReset(index, currentIndex, ctx);
    }

    if (this.isRapidDuplicateUnselect(optionBinding?.option?.optionId, checked, Date.now(), ctx)) {
      return;
    }

    this.applySelectionAndFeedback(optionBinding, index, currentIndex, checked, isTrulyMulti, ctx);

    this.runMultiScoringAndCallbacks(optionBinding, index, currentIndex, checked, isTrulyMulti, ctx);

    this.applyLockingAndFinalize(optionBinding, currentIndex, isTrulyMulti, ctx);
  }

  /**
   * Authoritative single-vs-multi resolution: combines binding correct-flag
   * counts, the canonical pristine count, the context type/flags, and question
   * wording ("select all", "multiple", "apply"). Extracted verbatim.
   */
  private computeIsTrulyMulti(ctx: OptionUiSyncContext): boolean {
    const isCorrectHelper = isOptionCorrect;
    // RESOLVE: ctx.optionBindings may be a signal (-clean) or plain array (-main).
    // Use _cob locally; do NOT reassign ctx.optionBindings — that overwrote
    // the signal property and triggered infinite error spam in StackBlitz.
    const _rawCob = ctx.optionBindings as any;
    const _cob: any[] = typeof _rawCob === 'function' ? (_rawCob() ?? []) : (_rawCob ?? []);
    const correctCountInBindings = _cob.filter((b: any) => isCorrectHelper(b.option)).length;
    // DECLARED TYPE FIRST — no counting, and no guessing from the wording of
    // the question text either. The heuristics below are all proxies for a
    // fact the API now states outright.
    const declared = declaredIsMultiAnswer((ctx as any).currentQuestion);
    if (declared !== null) return declared;

    // REMOVE IN /questions CONTENT CUTOVER — everything below is the fallback.
    // Canonical fallback: when binding flags are stale/missing, recover
    // the correct count from quizInitialState (pristine source). Use the
    // higher of the two so single-answer detection isn't weakened.
    const canonicalCorrectCount = this.resolveCanonicalCorrectCount(_cob);
    const effectiveCorrectCount = Math.max(correctCountInBindings, canonicalCorrectCount);

    // Authoritative Type Resolution
    const qText = (ctx as any).currentQuestion?.questionText?.toLowerCase() || '';
    const isExplicitMulti = qText.includes('select all') || qText.includes('multiple') || qText.includes('apply');
    return ctx.type === 'multiple' || (ctx as any).isMultiMode === true ||
                        isExplicitMulti || effectiveCorrectCount > 1;
  }

  /**
   * Single-answer visual reset: seeds selection history (component-local +
   * durable sel_Q*), rebuilds binding refs so OnPush children re-render with
   * only the current option selected, and clears the feedback map. Extracted
   * verbatim. Caller gates on (!isTrulyMulti && checked).
   */
  private applySingleAnswerUiReset(index: number, currentIndex: number, ctx: OptionUiSyncContext): void {
      // Accumulate history for previous-selection highlighting
      if (!ctx.selectedOptionHistory.includes(index)) {
        ctx.selectedOptionHistory.push(index);
      }
      // Seed history from durable sel_Q* on first post-refresh click.
      // ctx.selectedOptionHistory is component-local and empty after refresh,
      // but sel_Q* holds every prior click. Without seeding, prev-clicked
      // bindings unhighlight to white on the next click.
      try {
        const saved = this.selectedOptionService.getSelectedOptionsForQuestion(currentIndex) ?? [];
        for (const s of saved) {
          const sText = norm((s as any)?.text);
          const sId = (s as any)?.optionId;
          let pos = -1;
          if (sText) {
            pos = ctx.optionBindings.findIndex((b: any) =>
              norm(b?.option?.text) === sText
            );
          }
          if (pos === -1 && sId != null && sId !== -1) {
            pos = ctx.optionBindings.findIndex((b: any) =>
              b?.option?.optionId != null && String(b.option.optionId) === String(sId)
            );
          }
          if (pos === -1) {
            const sIdx = (s as any)?.displayIndex ?? (s as any)?.index;
            if (sIdx != null && Number.isFinite(Number(sIdx))) pos = Number(sIdx);
          }
          if (pos !== -1 && !ctx.selectedOptionHistory.includes(pos)) {
            ctx.selectedOptionHistory.push(pos);
          }
        }
      } catch (err: unknown) { swallow('option-ui-sync.service.ts selection-history resolve', err); }
      const historySet = new Set(ctx.selectedOptionHistory);

      // RESOLVE: ctx.optionBindings may be a signal (-clean) or array (-main)
      const _rawObB = ctx.optionBindings as any;
      const _obB: any[] = typeof _rawObB === 'function' ? (_rawObB() ?? []) : (_rawObB ?? []);
      // Build NEW binding refs so OnPush option-item children re-render.
      // In-place mutation here used to leak through to the visible state
      // ONLY when something downstream (e.g. processSingleAnswerClick's
      // pristineSingleCorrect branch) replaced the bindings array later.
      // Incorrect single-answer clicks have no such downstream rebuild,
      // so the red-highlight on the wrong option never appeared.
      ctx.optionBindings = _obB.map((b: any, i: number) => {
        const isCurrent = (i === index);
        const inHistory = historySet.has(i);
        return {
          ...b,
          isSelected: isCurrent,
          highlightCorrect: false,
          highlightIncorrect: false,
          showFeedback: isCurrent,
          option: b.option ? {
            ...b.option,
            selected: isCurrent,
            highlight: isCurrent || inHistory,
            showIcon: isCurrent || inHistory
          } : b.option
        };
      });
      ctx.selectedOptionMap.clear();
      ctx.feedbackConfigs = {};
  }

  /**
   * Apply the click's selection state: history, single-answer painting,
   * feedback anchors, per-click multi correctness, and the service sync +
   * feedback-config refresh. Extracted verbatim.
   */
  private applySelectionAndFeedback(optionBinding: OptionBindings, index: number, currentIndex: number, checked: boolean, isTrulyMulti: boolean, ctx: OptionUiSyncContext): void {
    const isCorrectHelper = isOptionCorrect;
    const effectiveId = (optionBinding?.option?.optionId != null && optionBinding.option.optionId !== -1)
      ? optionBinding.option.optionId : index;

    // Maintain global history for anchor fallback
    if (checked) {
      if (!ctx.selectedOptionHistory.includes(index)) {
        ctx.selectedOptionHistory.push(index);
      }
    }

    // Apply the selection to the current option (single-answer only)
    // For multi-answer, handleOptionClick already set the correct selection state
    if (!isTrulyMulti) this.applySingleSelectionPainting(index, ctx);

    if (checked) {
      ctx.selectedOptionMap.set(effectiveId, true);
      const anchorKey = `idx:${index}`;
      ctx.showFeedbackForOption[anchorKey] = true;
      ctx.lastFeedbackOptionId = index;
    } else {
      ctx.lastFeedbackOptionId = -1;
    }

    ctx.showFeedback = true;

    // authoritatively sync context flags to bindings before service calls
    this.syncSelectedFlags(ctx);

    // For multi-answer: set per-click correctness BEFORE the service call
    // (which triggers the subscription and dot re-render in quiz component)
    if (isTrulyMulti) {
      const clickedIsCorrect = isCorrectHelper(optionBinding.option);
      this.selectedOptionService.lastClickedCorrectByQuestion.set(currentIndex, clickedIsCorrect);
    }

    // Sync to services (Single call here)
    this.forceSelectIntoServices(optionBinding, effectiveId, index, currentIndex, checked, ctx);

    this.toggleSelectedOption(optionBinding.option, index, checked, ctx);
    this.refreshFeedbackConfigForClicked(optionBinding, index, effectiveId, ctx);
  }

  /**
   * Multi-answer scoring (skipped in shuffle, where SOC owns scoring/FET) plus
   * the component callbacks: onSelect, visited tracking, and highlight refresh.
   * Extracted verbatim.
   */
  private runMultiScoringAndCallbacks(optionBinding: OptionBindings, index: number, currentIndex: number, checked: boolean, isTrulyMulti: boolean, ctx: OptionUiSyncContext): void {
    // Scoring and FET triggering for Multi-answer
    // In shuffled mode, SOC handles all scoring/FET.
    const isShufSkipScore = this.quizService?.isShuffleEnabled?.()
      && this.quizService?.shuffledQuestions?.length > 0;
    if (isTrulyMulti && !isShufSkipScore) {
      this.checkAndScoreMultiAnswer(ctx, currentIndex);
    }

    // Notify component (sound, etc.)
    if (ctx.onSelect) ctx.onSelect(optionBinding, checked, currentIndex);

    this.trackVisited(index, ctx);

    // FINAL FEEDBACK PASS: Only apply if refreshFeedbackConfigForClicked didn't
    // already set authoritative feedback (it handles resolution logic correctly).
    // Running applyFeedback after would overwrite with stale buildFeedbackMessage.

    // optional: refresh directive highlighting after state changes
    this.refreshHighlights(ctx.optionBindings);
  }

  /**
   * Lock policy + final state sync: resolve the question type, lock incorrect
   * options, mirror lock state into SelectedOptionService, enforce single
   * selection, re-sync flags, run the bypass-path scoring, and push the
   * selection message. Extracted verbatim.
   */
  private applyLockingAndFinalize(optionBinding: OptionBindings, currentIndex: number, isTrulyMulti: boolean, ctx: OptionUiSyncContext): void {
    // AUTHORITATIVE TYPE INFERENCE: Rely on data, not just metadata
    const resolvedType = (isTrulyMulti)
      ? QuestionType.MultipleAnswer : QuestionType.SingleAnswer;

    this.optionLockPolicyService.updateLockedIncorrectOptions({
      bindings: ctx.optionBindings ?? [],
      forceDisableAll: ctx.forceDisableAll,
      resolvedType,
      computeShouldLockIncorrectOptions: (t, has, all) =>
        this.computeShouldLockIncorrectOptions(t, has, all)
    });

    // AUTHORITATIVE SYNC: Update SelectedOptionService with the locking results
    const qIdx = ctx.getActiveQuestionIndex();
    for (const [i, b] of ctx.optionBindings.entries()) {
      const lockId = (b.option?.optionId != null && String(b.option.optionId) !== '-1') ? b.option.optionId : i;
      if (b.disabled) {
        this.selectedOptionService.lockOption(qIdx, lockId);
      } else {
        this.selectedOptionService.unlockOption(qIdx, lockId);
      }
    }

    if (ctx.type === 'single') {
      this.optionSelectionPolicyService.enforceSingleSelection({
        optionBindings: ctx.optionBindings,
        selectedBinding: optionBinding,
        showFeedbackForOption: ctx.showFeedbackForOption,
        updateFeedbackState: (id) => {
          ctx.showFeedback = true;
          ctx.showFeedbackForOption[id] = true;
        }
      });
    }

    this.syncSelectedFlags(ctx);

    // SCORING: The checkbox `change` event path bypasses OIS and onOptionSelected,
    // so scoring must happen here for multi-answer questions. Check if ALL correct
    // answers are now selected and score accordingly.
    // In shuffled mode, SOC handles all scoring/FET.
    const isShufSkipScore2 = this.quizService?.isShuffleEnabled?.()
      && this.quizService?.shuffledQuestions?.length > 0;
    if (!isShufSkipScore2) {
      this.checkAndScoreMultiAnswer(ctx, currentIndex);
    }

    this.selectionMessageService.notifySelectionMutated(ctx.optionsToDisplay);
    this.selectionMessageService.setSelectionMessage(false);
  }

  private resetFeedbackAnchorIfQuestionChanged(currentIndex: number, ctx: OptionUiSyncContext): void {
    if (ctx.lastFeedbackQuestionIndex !== currentIndex) {
      ctx.feedbackConfigs = {};
      // Mutate to clear instead of reassigning
      for (const k of Object.keys(ctx.showFeedbackForOption)) {
        delete ctx.showFeedbackForOption[k];
      }
      ctx.lastFeedbackOptionId = -1;
      ctx.lastFeedbackQuestionIndex = currentIndex;
      ctx.selectedOptionHistory.length = 0;
      ctx.selectedOptionMap.clear();
      ctx.perQuestionHistory.clear();
    }
  }


  private isRapidDuplicateUnselect(
    optionId: number | string | undefined,
    checked: boolean,
    now: number,
    ctx: OptionUiSyncContext
  ): boolean {
    return ctx.lastClickedOptionId === optionId &&
      ctx.lastClickTimestamp != null &&
      now - ctx.lastClickTimestamp < 150 &&
      !checked;
  }

  private forceSelectIntoServices(
    optionBinding: OptionBindings,
    _optionId: number | string | undefined,
    index: number,
    currentIndex: number,
    checked: boolean,
    ctx: OptionUiSyncContext
  ): void {
    if (checked) {
      const fullSelections = this.buildFullSelections(ctx, currentIndex);
      // Selection: Store the COMPLETE set in service
      this.selectedOptionService.setSelectedOptionsForQuestion(currentIndex, fullSelections);
    } else {
      // Unselection: Remove from service using the unique array index
      this.selectedOptionService.removeOption(currentIndex, index as any, index);
    }

    this.maybeEmitSingleAnswerFet(optionBinding, currentIndex, ctx);

    // Update Next Button State based on ACTUAL selection count
    const hasSelection = ctx.selectedOptionMap.size > 0;
    this.nextButtonStateService.setNextButtonState(hasSelection);
  }

  // Build the FULL list of selections PRESERVING TIME ORDER via history,
  // then catching any selected options not present in history.
  private buildFullSelections(ctx: OptionUiSyncContext, currentIndex: number): any[] {
    const getEffectiveId = (o: any, i: number) => (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;

    const fullSelections: any[] = [];
    const seenIndices = new Set<number>();

    // 1. Process history (known order)
    // selectedOptionMap is keyed by effectiveId (optionId when real,
    // else position index). selectedOptionHistory stores position
    // indices. Resolve each history entry to its binding's effectiveId
    // before checking the map, so a 1-based optionId that collides
    // with another option's position index doesn't cause a false match.
    for (const hIdx of ctx.selectedOptionHistory || []) {
      const numIdx = Number(hIdx);
      const hBinding = ctx.optionBindings[numIdx];
      const hEffId = hBinding ? getEffectiveId(hBinding.option, numIdx) : numIdx;
      if (ctx.selectedOptionMap.has(hEffId) && !seenIndices.has(numIdx)) {
        if (hBinding) {
          fullSelections.push({
            ...hBinding.option,
            optionId: hEffId,
            index: numIdx,
            displayIndex: numIdx,
            questionIndex: currentIndex,
            selected: true
          });
          seenIndices.add(numIdx);
        }
      }
    }

    // 2. Catch any selected options not in history (redundancy)
    // Use the binding's effectiveId for the map lookup — the map
    // key is effectiveId (optionId), not position index. Using the
    // raw position idx would false-positive when a 1-based optionId
    // from another option collides with this binding's array index.
    // Collision guard: when a binding has no real optionId, getEffectiveId
    // falls back to the array index, which can collide with another
    // binding's real optionId. Build a set of real IDs to detect this.
    const realIdOwnerForSelect = new Map<number | string, number>();
    for (const [idx, b] of ctx.optionBindings.entries()) {
      const id = b.option?.optionId;
      if (id != null && id !== -1) {
        realIdOwnerForSelect.set(id, idx);
      }
    }
    for (const [idx, b] of ctx.optionBindings.entries()) {
      const bEffId = getEffectiveId(b.option, idx);
      if (ctx.selectedOptionMap.has(bEffId) && !seenIndices.has(idx)) {
        // Reject false-positive: fallback index collides with another binding's real optionId
        const hasRealId = b.option?.optionId != null && b.option.optionId !== -1;
        if (!hasRealId) {
          const owner = realIdOwnerForSelect.get(bEffId);
          if (owner !== undefined && owner !== idx) {
            continue; // skip — this binding doesn't actually match the map entry
          }
        }
        fullSelections.push({
          ...b.option,
          optionId: bEffId,
          index: idx,
          displayIndex: idx,
          questionIndex: currentIndex,
          selected: true
        });
        seenIndices.add(idx);
      }
    }

    return fullSelections;
  }

  // Single-answer only: set answered + emit FET when the clicked option is
  // pristine-correct. Skipped in shuffled mode (SOC handles scoring/FET).
  private maybeEmitSingleAnswerFet(
    optionBinding: OptionBindings,
    currentIndex: number,
    ctx: OptionUiSyncContext
  ): void {
    const isShufForFET = this.quizService?.isShuffleEnabled?.()
      && this.quizService?.shuffledQuestions?.length > 0;
    if (ctx.type === 'single' && !isShufForFET) {
      const clickedIsCorrect = this.resolveClickedIsCorrectPristine(optionBinding, currentIndex, ctx);
      if (clickedIsCorrect) {
        this.selectedOptionService.setAnswered(true, true);
        ctx.emitExplanation(currentIndex);
      }
    }
  }

  // Resolve whether the clicked option is correct against pristine quizInitialState.
  // After Restart Quiz, binding correct flags can be stale, so resolve from pristine.
  private resolveClickedIsCorrectPristine(
    optionBinding: OptionBindings,
    currentIndex: number,
    ctx: OptionUiSyncContext
  ): boolean {
    let clickedIsCorrect = false;
    try {
      const clickedText = norm(optionBinding?.option?.text);
      const bundle = this.quizService?.quizInitialState ?? [];
      if (clickedText && bundle.length > 0) {
        // Use TEXT-BASED question matching — index-based lookup fails in
        // shuffled mode because pristineQuiz.questions[displayIndex] is
        // the WRONG question (original order).
        const isShuf = this.quizService?.isShuffleEnabled?.()
          && this.quizService?.shuffledQuestions?.length > 0;
        const displayQ = isShuf
          ? (this.quizService?.getQuestionsInDisplayOrder?.()?.[currentIndex]
            ?? this.quizService?.shuffledQuestions?.[currentIndex])
          : (ctx.getQuestionAtDisplayIndex?.(currentIndex)
            ?? this.quizService?.questions?.[currentIndex]);
        const qText = norm(displayQ?.questionText);
        if (qText) {
          let matched = false;
          for (const quiz of bundle) {
            for (const pq of (quiz?.questions ?? [])) {
              if (norm(pq?.questionText) !== qText) continue;
              matched = true;
              const matchedOpt = (pq?.options ?? []).find((o: any) => norm(o?.text) === clickedText);
              if (matchedOpt) {
                clickedIsCorrect = isOptionCorrect(matchedOpt);
              }
              break;
            }
            if (matched) break;
          }
        }
      }
    } catch (err: unknown) {
      console.error('OptionUiSyncService.forceSelectIntoServices pristine-correctness check failed:', err);
    }
    return clickedIsCorrect;
  }

  private applySingleSelectionPainting(
    selectedIndex: number,
    ctx: OptionUiSyncContext
  ): void {
    const history = new Set(ctx.selectedOptionHistory || []);

    for (const [idx, b] of ctx.optionBindings.entries()) {
      const isSelected = (idx === selectedIndex);
      const inHistory = history.has(idx);

      b.isSelected = isSelected;
      b.option.selected = isSelected;

      b.option.highlight = isSelected || inHistory;
      b.option.showIcon = isSelected || inHistory;

      // Force directive update
      b.directiveInstance?.updateHighlight();
    }
  }

  private trackVisited(effectiveId: number | undefined, ctx: OptionUiSyncContext): boolean {
    let isAlreadyVisited = false;
    if (effectiveId !== undefined) {
      isAlreadyVisited = ctx.selectedOptionHistory.includes(effectiveId);
      if (!isAlreadyVisited) ctx.selectedOptionHistory.push(effectiveId);
    }
    return isAlreadyVisited;
  }

  private refreshFeedbackConfigForClicked(
    optionBinding: OptionBindings,
    index: number,
    optionId: number | string | undefined,
    ctx: OptionUiSyncContext
  ): void {
    const qIdx = ctx.getActiveQuestionIndex() ?? 0;
    const currentQuestion = ctx.getQuestionAtDisplayIndex(qIdx);
    const freshOptions = (ctx.optionsToDisplay?.length ?? 0) > 0
      ? ctx.optionsToDisplay
      : currentQuestion?.options ?? [];

    const isCorrectHelper = isOptionCorrect;

    // Use existing binding state (set by handleOptionClick) as the source of truth.
    // Do NOT overwrite bindings from service — handleOptionClick already set the
    // correct isSelected state for each binding, and overwriting from the service
    // can restore stale/accumulated selections.
    const selectedOptions: Option[] = ctx.optionBindings
      .filter(b => b.isSelected)
      .map(b => b.option);

    const dynamicFeedback = currentQuestion
      ? this.feedbackService.buildFeedbackMessage(currentQuestion, selectedOptions, false, false, qIdx, freshOptions, optionBinding.option)
      : '';


    const correctMessage = this.feedbackService.setCorrectMessage(freshOptions, currentQuestion!);

    // EVALUATE RESOLUTION — use bindings as single source of truth for both
    // correct indices and selected indices to guarantee index consistency.
    const correctIndicesSet = new Set<number>();
    const futureIndices = new Set<number>();
    for (const [i, b] of ctx.optionBindings.entries()) {
      if (isCorrectHelper(b.option)) correctIndicesSet.add(i);
      if (b.isSelected) futureIndices.add(i);
    }

    const allCorrectFound = correctIndicesSet.size > 0 && [...correctIndicesSet].every(i => futureIndices.has(i));

    // Determine if we are really in multi-mode for the sake of the feedback message
    const correctCountInBindings = correctIndicesSet.size;
    const canonicalCorrectCount = this.resolveCanonicalCorrectCount(ctx.optionBindings);
    const effectiveCorrectCount = Math.max(correctCountInBindings, canonicalCorrectCount);
    // DECLARED TYPE WINS. This read `type === 'multiple' || … || count > 1`,
    // which lets the local answer key PROMOTE a declared single-answer question
    // to multiple whenever the bank drifts or is tampered with.
    // `resolveIsMultiAnswer` keeps the same counted guess as a fallback but
    // subordinates it, so a declared type decides.
    //
    // REMOVE THE COUNTED ARGUMENT IN /questions CONTENT CUTOVER.
    const isTrulyMulti = resolveIsMultiAnswer(
      currentQuestion,
      ctx.type === 'multiple' || (ctx as any).isMultiMode === true || effectiveCorrectCount > 1
    );

    const key = ctx.keyOf(optionBinding.option, index);
    for (const configKey of Object.keys(ctx.feedbackConfigs)) {
      ctx.feedbackConfigs[configKey].showFeedback = false;
    }

    ctx.feedbackConfigs[key] = {
      feedback: dynamicFeedback,
      showFeedback: true,
      options: freshOptions,
      question: currentQuestion ?? null,
      selectedOption: optionBinding.option,
      correctMessage: correctMessage,
      idx: index,
      questionIndex: qIdx
    } as any;

    // Simplified: update the feedback configuration only.
    // Locking is handled authoritatively by OptionLockPolicyService inside updateOptionAndUI.
    const isCorrectTarget = isCorrectHelper(optionBinding.option);
    
    if (allCorrectFound && isCorrectTarget) {
      if (ctx.feedbackConfigs[key]) {
        ctx.feedbackConfigs[key].feedback = `You're right! ${correctMessage}`;
      }
    } else if (isTrulyMulti && isCorrectTarget) {
       // intermediate multi-answer correct feedback
       const numCorrectSelected = [...futureIndices].filter(i => correctIndicesSet.has(i)).length;
       const remaining = Math.max(correctIndicesSet.size - numCorrectSelected, 0);
       if (remaining > 0) {
          const remText = remaining === 1 ? '1 more correct answer' : `${remaining} more correct answers`;
          if (ctx.feedbackConfigs[key]) {
            ctx.feedbackConfigs[key].feedback = `That's correct! Please select ${remText}.`;
          }
       }
    } else {
       // It's either an incorrect click, or it was wrong somehow
       if (ctx.feedbackConfigs[key]) {
         ctx.feedbackConfigs[key].feedback = dynamicFeedback; 
       }
    }


    // Anchor feedback using dual keys for robust lookup in template
    for (const k of Object.keys(ctx.showFeedbackForOption)) {
      delete ctx.showFeedbackForOption[k];
    }
    ctx.showFeedbackForOption[index] = true;
    ctx.showFeedbackForOption[String(index)] = true;
    if (optionId != null && optionId !== -1) {
      ctx.showFeedbackForOption[optionId as any] = true;
      ctx.showFeedbackForOption[String(optionId)] = true;
    }

    ctx.lastFeedbackOptionId = index;
    ctx.showFeedback = true;
    ctx.hasUserClicked = true;
  }

  /**
   * Check if all correct answers are selected for multi-answer questions and
   * trigger scoring via quizService.scoreDirectly(). This handles the checkbox
   * `change` event path which bypasses OIS and QuizComponent.onOptionSelected.
   */
  private syncSelectedFlags(ctx: OptionUiSyncContext): void {
    const getEffId = (o: any, idx: number) => (o?.optionId != null && o.optionId !== -1) ? o.optionId : idx;

    // Collision guard: when a binding has no real optionId, getEffId falls back
    // to the array index.  That index can collide with another binding's real
    // optionId (e.g. binding[0].optionId=1 vs binding[1] fallback index=1).
    // Map real optionIds â†’ their owning binding index so we can reject false matches.
    const realIdOwner = new Map<number | string, number>();
    for (let i = 0; i < (ctx.optionBindings?.length ?? 0); i++) {
      const id = ctx.optionBindings[i].option?.optionId;
      if (id != null && id !== -1) realIdOwner.set(id, i);
    }

    for (let i = 0; i < (ctx.optionBindings?.length ?? 0); i++) {
      const b = ctx.optionBindings[i];
      const eid = getEffId(b.option, i);
      let chosen = ctx.selectedOptionMap.get(eid) === true;

      // Reject false-positive: this binding has no real optionId and its
      // fallback index collides with another binding's real optionId.
      if (chosen) {
        const hasRealId = b.option?.optionId != null && b.option.optionId !== -1;
        if (!hasRealId) {
          const owner = realIdOwner.get(eid);
          if (owner !== undefined && owner !== i) {
            chosen = false;
          }
        }
      }

      b.option.selected = chosen;
      b.isSelected = chosen;

      // Sync optionsToDisplay selected flag (binding options are structuredClone'd copies)
      if (ctx.optionsToDisplay?.[i]) ctx.optionsToDisplay[i].selected = chosen;
    }
  }

  private checkAndScoreMultiAnswer(ctx: OptionUiSyncContext, questionIndex: number): void {
    // Get the authoritative question data
    const question = ctx.getQuestionAtDisplayIndex(questionIndex);
    const freshOptions = ctx.optionsToDisplay?.length > 0
      ? ctx.optionsToDisplay : (question?.options ?? []);

    const { correctOptions, correctTextSet } =
      this.resolveCorrectOptionsForScoring(ctx, questionIndex, question, freshOptions);

    if (correctOptions.length === 0) return;

    const isTrulyMulti = correctOptions.length > 1 || ctx.type === 'multiple';
    const isActuallySingle = !isTrulyMulti;

    let selectedOptions = this.gatherSelectedOptionsForScoring(ctx, questionIndex);

    // Fold in the cross-visit union (uiSelectedTexts = live bindings ∪ first-visit
    // snapshot) for multi-answer, so COMPLETING a partial multi-answer on REVISIT
    // is detected even though the live sources only hold the just-clicked option.
    // Remembered texts are represented as {text} stubs; scoring matches on text.
    if (isTrulyMulti) {
      const uiSelected = this.selectedOptionService.uiSelectedTextsForQuestion(questionIndex);
      if (uiSelected && uiSelected.size > 0) {
        selectedOptions = [...selectedOptions];
        const known = new Set(selectedOptions.map((s: any) => norm(s?.text)).filter(Boolean));
        for (const t of uiSelected) {
          if (!known.has(t)) selectedOptions.push({ text: t } as any);
        }
      }
    }

    const { correctSelectedCount, hasIncorrect } =
      this.countCorrectSelected(selectedOptions, correctTextSet);

    if (isActuallySingle) {
      if (correctSelectedCount >= 1 && !hasIncorrect) {
        // NO SCORE HERE — `correctSelectedCount` comes from `correctTextSet`,
        // which resolveCorrectOptionsForScoring builds from the local bank.
        // Credit is applied by creditResolvedQuestion on verdict arrival.
      }
      return;
    }

    this.scoreMultiAnswerIfPerfect(
      ctx, questionIndex, correctOptions, correctTextSet,
      selectedOptions, correctSelectedCount, hasIncorrect
    );
  }

  // PRISTINE-FIRST: Resolve correct options from quizInitialState to avoid
  // stale/mutated correct flags on freshOptions (e.g. after Restart Quiz).
  private resolveCorrectOptionsForScoring(
    ctx: OptionUiSyncContext,
    questionIndex: number,
    question: any,
    freshOptions: any[]
  ): { correctOptions: any[]; correctTextSet: Set<string> } {
    const normalize = (s: unknown): string => norm(s);
    let correctOptions = freshOptions.filter(o => isOptionCorrect(o));
    let correctTextSet = new Set(
      correctOptions.map(o => normalize(o.text)).filter(Boolean)
    );

    try {
      const bundle = this.quizService?.quizInitialState ?? [];
      if (bundle.length > 0) {
        // Use TEXT-BASED question matching — index-based lookup
        // (pristineQuiz.questions[displayIndex]) fails in shuffled mode.
        const isShuf = this.quizService?.isShuffleEnabled?.()
          && this.quizService?.shuffledQuestions?.length > 0;
        const displayQ = isShuf
          ? (this.quizService?.getQuestionsInDisplayOrder?.()?.[questionIndex]
            ?? this.quizService?.shuffledQuestions?.[questionIndex])
          : question;
        const qText = normalize(displayQ?.questionText);
        if (qText) {
          let matched = false;
          for (const quiz of bundle) {
            for (const pq of (quiz?.questions ?? [])) {
              if (normalize(pq?.questionText) !== qText) continue;
              matched = true;
              const pristineCorrect = (pq?.options ?? [])
                .filter((o: any) => isOptionCorrect(o));
              if (pristineCorrect.length > 0) {
                correctOptions = pristineCorrect;
                correctTextSet = new Set(
                  pristineCorrect.map((o: any) => normalize(o.text)).filter(Boolean)
                );
              }
              break;
            }
            if (matched) break;
          }
        }
      }
    } catch (err: unknown) { swallow('option-ui-sync.service.ts pristine-correct match', err); }

    return { correctOptions, correctTextSet };
  }

  // Gather selected options from MULTIPLE sources for robustness, using the
  // source with the most entries (most complete state).
  private gatherSelectedOptionsForScoring(ctx: OptionUiSyncContext, questionIndex: number): any[] {
    // 1. Bindings (most immediate UI state)
    const bindingSelected = ctx.optionBindings
      .filter(b => b.isSelected || b.option.selected)
      .map(b => b.option);

    // 2. Context selectedOptionMap
    const mapSelectedIds = new Set<number | string>();
    if (ctx.selectedOptionMap) {
      for (const [key, val] of ctx.selectedOptionMap.entries()) {
        if (val) mapSelectedIds.add(key);
      }
    }
    const getEffIdMap = (o: any, idx: number) => (o?.optionId != null && o.optionId !== -1) ? o.optionId : idx;
    const mapSelected = ctx.optionBindings
      .filter((b, idx) => {
        const eid = getEffIdMap(b.option, idx);
        return mapSelectedIds.has(eid) ||
          mapSelectedIds.has(String(eid)) ||
          mapSelectedIds.has(Number(eid));
      })
      .map(b => b.option);

    // 3. SelectedOptionService (source of truth)
    const serviceSelected = this.selectedOptionService.getSelectedOptionsForQuestion(questionIndex) ?? [];

    let selectedOptions: any[] = bindingSelected;
    if (mapSelected.length > selectedOptions.length) selectedOptions = mapSelected;
    if (serviceSelected.length > selectedOptions.length) selectedOptions = serviceSelected;
    return selectedOptions;
  }

  // Count how many correct options are among the selected, using text matching.
  private countCorrectSelected(
    selectedOptions: any[],
    correctTextSet: Set<string>
  ): { correctSelectedCount: number; hasIncorrect: boolean } {
    const normalize = (s: unknown): string => norm(s);
    let correctSelectedCount = 0;
    let hasIncorrect = false;

    for (const sel of selectedOptions) {
      const selText = normalize(sel?.text);
      // Use pristine correctTextSet for matching, not stale binding flags
      if (selText && correctTextSet.has(selText)) {
        correctSelectedCount++;
      } else if (selText) {
        // If the selected text is not in the pristine correct set, it's incorrect
        hasIncorrect = true;
      }
    }
    return { correctSelectedCount, hasIncorrect };
  }

  private scoreMultiAnswerIfPerfect(
    ctx: OptionUiSyncContext,
    questionIndex: number,
    correctOptions: any[],
    correctTextSet: Set<string>,
    selectedOptions: any[],
    correctSelectedCount: number,
    hasIncorrect: boolean
  ): void {
    const normalize = (s: unknown): string => norm(s);
    // Also sanity-check the selection count directly against the durable
    // correct-index tracker via bindings. hasIncorrect text-matching can
    // false-negative when freshOptions has had correct flags mutated by
    // an earlier flow, which would otherwise let this branch fire after
    // only a partial set of correct answers plus incorrects.
    const selectedTexts = new Set(selectedOptions.map(s => normalize(s?.text)).filter(Boolean));
    const allCorrectTextsSelected =
      correctTextSet.size > 0 &&
      [...correctTextSet].every(t => selectedTexts.has(t));
    const anyIncorrectTextSelected = selectedTexts.size > 0 &&
      [...selectedTexts].some(t => !correctTextSet.has(t));
    if (
      correctSelectedCount >= correctOptions.length &&
      correctOptions.length >= 2 &&
      allCorrectTextsSelected &&
      !hasIncorrect &&
      !anyIncorrectTextSelected
    ) {
      // NO SCORE HERE. The gate above is answer-key derived — `correctTextSet`
      // comes from resolveCorrectOptionsForScoring walking pristine
      // quizInitialState — and this runs on the click while /check is still in
      // flight. Credit is applied by creditResolvedQuestion when the authorized
      // verdict lands.
      //
      // Mark this multi-answer question as fully resolved so the
      // rendering layer (option-item.isDisabled) honors b.disabled
      // for unselected incorrect options. Without this flag, the
      // policy correctly stamps b.disabled=true but the UI still
      // returns false from isDisabled() in multi-answer mode.
      // NO COMPLETION OR PERFECT HERE. The gate above is answer-key derived —
      // `correctTextSet` comes from resolveCorrectOptionsForScoring walking
      // pristine quizInitialState — and this runs on the click, while /check is
      // still in flight. Both states are established from the authorized
      // verdict in SelectedOptionService.applyAuthorizedMultiCompletion, which
      // also derives PERFECT from the revealed correct set versus what the user
      // actually submitted.
      //
      // RESOLVED stays: "the user answered" follows from their own interaction.
      this.quizService.markQuestionResolved(questionIndex);
      writeSessionString(SK_MULTI_PERFECT + questionIndex, 'true');
      // Force FET readiness even if already scored correct (to be safe)
      this.selectedOptionService.setAnswered(true, true);
      // Persist FET-ready state to sessionStorage. quiz-option-processing's
      // persistOptionSelection gates these writes on isQuestionComplete from
      // evaluateMultiAnswer, which can disagree for some questions (e.g.
      // non-contiguous correct indices). Writing here is a safety net so
      // FET actually renders when all correct answers are selected.
      try {
        sessionStorage.setItem(SK_IS_ANSWERED, 'true');
        sessionStorage.setItem(SK_DISPLAY_MODE + questionIndex, 'explanation');
      } catch (err: unknown) { swallow('option-ui-sync.service.ts FET-ready persist', err); }
      this.nextButtonStateService.setNextButtonState(true);
      // Emit FET — the shared-option-click path handles this when
      // clickState.remaining === 0, but when that path doesn't fire,
      // the explanation never renders. Emit here as a safety net.
      // skipGuard=true bypasses the lock that otherwise suppresses FET.
      if (ctx.emitExplanation) {
        setTimeout(() => ctx.emitExplanation(questionIndex, true), 0);
      }
    }
  }

  private toggleSelectedOption(_clicked: Option, clickedIndex: number, checked: boolean, ctx: OptionUiSyncContext): void {
    const isCorrectHelper = isOptionCorrect;
    const correctCount = (ctx.optionsToDisplay ?? []).filter(o => isCorrectHelper(o)).length;
    const isMultiple = ctx.type === 'multiple' || correctCount > 1;

    const historySet = new Set(ctx.selectedOptionHistory || []);
    for (let i = 0; i < (ctx.optionsToDisplay ?? []).length; i++) {
      const o = ctx.optionsToDisplay[i];
      const isClicked = (i === clickedIndex);
      const inHistory = historySet.has(i);

      if (isMultiple) {
        // Multi-answer: toggle only the clicked option, preserve others
        if (isClicked) {
          o.selected = checked;
        }

        const isSelected = !!o.selected;

        o.highlight = isSelected;
        o.showIcon = isSelected;
      } else {
        o.selected = isClicked ? checked : false;
        o.showIcon = (isClicked && checked) || inHistory;
        o.highlight = (isClicked && checked) || inHistory;
      }
    }

    // keep array ref refresh if your UI depends on it
    ctx.optionsToDisplay = [...ctx.optionsToDisplay];
  }

  // â”€â”€ Inlined from OptionVisualEffectsService â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private refreshHighlights(bindings: OptionBindings[]): void {
    for (const b of bindings ?? []) {
      b?.directiveInstance?.updateHighlight?.();
    }
  }

  // â”€â”€ Inlined from OptionLockRulesService â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private computeShouldLockIncorrectOptions(
    type: QuestionType,
    hasCorrectSelection: boolean,
    allCorrectSelected: boolean
  ): boolean {
    if (type === QuestionType.MultipleAnswer || type as any === 'multiple') {
      return allCorrectSelected;
    }
    return hasCorrectSelection;
  }

  // Text-match the bindings' question against quizInitialState (pristine
  // structuredClone of QUIZ_DATA) to recover the canonical correct count.
  // Live binding `option.correct` flags can be stale/missing, which made
  // multi-answer detection (correctCountInBindings > 1) wrongly classify
  // Q2/Q4 as single-answer and lock incorrect options after just 1 correct
  // selection. Using the immutable pristine source side-steps that.
  private resolveCanonicalCorrectCount(bindings: OptionBindings[]): number {
    try {
      if (!bindings?.length) return 0;
      const bindingTexts = bindings.map(b => norm(b?.option?.text)).filter(Boolean);
      if (!bindingTexts.length) return 0;
      const bundle = this.quizService?.quizInitialState ?? [];
      for (const quiz of bundle) {
        for (const pq of (quiz?.questions ?? [])) {
          const opts = pq?.options ?? [];
          if (opts.length !== bindings.length) continue;
          const allMatch = opts.every(
            (o: any, i: number) => norm(o?.text) === bindingTexts[i]
          );
          if (!allMatch) continue;
          return opts.filter(
            (o: any) => isOptionCorrect(o)
          ).length;
        }
      }
      return 0;
    } catch (err: unknown) {
      console.error('OptionUiSyncService.resolveCanonicalCorrectCount pristine lookup failed:', err);
      return 0;
    }
  }
}