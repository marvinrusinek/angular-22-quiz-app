import { Service, inject } from '@angular/core';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { NextButtonStateService } from '../../state/next-button-state.service';
import { OptionClickHandlerService } from './option-click-handler.service';
import { OptionInteractionService } from './option-interaction.service';
import { OptionUiSyncService } from './option-ui-sync.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SocAnswerProcessingService } from './soc-answer-processing.service';
import { SocOptionUiService } from './soc-option-ui.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { TimerService } from '../../features/timer/timer.service';
import { TopicQuizTypeRegistry } from '../../api/topic-quiz-type-registry.service';
import {
  allCorrectSelectedFromVerdict,
  verdictStateForDisplayIndex
} from '../../features/verdict/authorized-correctness';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

/**
 * Handles option click events for shared option components.
 * Delegates to 2 extracted sub-services; retains onOptionUI, runOptionContentClick preamble/postamble,
 * and updateOptionAndUI inline.
 */
@Service()
export class SharedOptionClickService {
  // ── injects ─────────────────────────────────────────────────────
  private answerProcessing = inject(SocAnswerProcessingService);
  private clickHandler = inject(OptionClickHandlerService);
  private nextButtonStateService = inject(NextButtonStateService);
  private optionInteractionService = inject(OptionInteractionService);
  private optionUi = inject(SocOptionUiService);
  private optionUiSyncService = inject(OptionUiSyncService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private timerService = inject(TimerService);
  private typeRegistry = inject(TopicQuizTypeRegistry);
  private verdicts = inject(QuestionVerdictService);

  // ── public methods ──────────────────────────────────────────────

  onOptionUI(comp: any, ev: any): void {
    if (ev == null || ev.optionId == null) return;

    // Resolve the clicked option by IDENTITY (optionId) first, so it maps to the
    // correct canonical binding + index in optionBindings() regardless of the
    // rendered order. The render layer pins "All of the above" LAST, so a clicked
    // option's displayIndex can differ from its canonical index — trusting
    // displayIndex here would resolve to the wrong binding. Fall back to
    // displayIndex only when identity lookup fails.
    const found = comp.findBindingByOptionId(ev.optionId);
    const index = found?.i ?? ev.displayIndex;
    if (index === undefined || index < 0) return;
    const binding = found?.b ?? comp.optionBindings()[index];
    if (!binding) return;

    comp.cdRef.markForCheck();
    this.playSelectionSound(comp, binding);

    const now = Date.now();
    const isRapidDuplicate = comp._lastHandledIndex === index &&
      comp._lastHandledTime &&
      (now - comp._lastHandledTime < 100);

    if (ev.kind === 'change') {
      this.handleChangeEvent(comp, binding, index, ev, now, isRapidDuplicate);
      return;
    }

    if (ev.kind === 'interaction' || ev.kind === 'contentClick') {
      this.handleContentClick(comp, binding, index, ev, now, isRapidDuplicate);
      return;
    }
  }

  /**
   * The mat-radio/checkbox (change) branch of onOptionUI: dedup rapid
   * duplicates, mark interaction, and run the click. Extracted verbatim.
   */
  private handleChangeEvent(comp: any, binding: any, index: number, ev: any, now: number, isRapidDuplicate: any): void {
    const native = ev.nativeEvent;

    if (isRapidDuplicate) return;

    comp._lastHandledIndex = index;
    comp._lastHandledTime = now;

    this.quizStateService.markUserInteracted(comp.getActiveQuestionIndex());

    this.runOptionContentClick(comp, binding, index, native as any);
  }

  /**
   * The interaction/contentClick branch of onOptionUI: disabled guard, the
   * material-control backstop (the shuffle "lost answer" fix), rapid-duplicate
   * and already-selected guards, form-value sync, then run the click. Extracted
   * verbatim — do not alter the backstop logic.
   */
  private handleContentClick(comp: any, binding: any, index: number, ev: any, now: number, isRapidDuplicate: any): void {
    const event = ev.nativeEvent as MouseEvent;

    if (comp.isDisabled(binding, index)) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    const target = event?.target as HTMLElement;
    const isInsideMaterialControl =
      target?.tagName === 'INPUT' ||
      target?.closest('.mat-mdc-radio-button') ||
      target?.closest('.mat-mdc-checkbox');

    if (isInsideMaterialControl) {
      const isCorrectOpt = isOptionCorrect(binding?.option);
      const isSingleMode = comp.type === 'single' && !comp.isMultiMode;
      // Defer to the radio's (change) event ONLY when the option is already
      // selected (change handled it). Otherwise contentClick must process as
      // a backstop: when the inner wrapper swallows the click via
      // stopPropagation, the radio's (change) never fires and the click is
      // silently dropped — the cause of the shuffle "lost answer" bug (a new
      // question's correct option whose index didn't trigger change). The
      // rapid-duplicate guards below dedup if (change) does also fire. The
      // single-correct-disabled exception is preserved.
      const alreadySelected = !!(binding?.option?.selected || binding?.isSelected);
      if (alreadySelected && !(isSingleMode && isCorrectOpt && binding.disabled)) return;
    }

    if (isRapidDuplicate) return;

    if (comp.type === 'single' && !comp.isMultiMode && binding.option.selected && comp.showFeedback()) {
      return;
    }

    comp._lastHandledIndex = index;
    comp._lastHandledTime = now;

    if (comp.type === 'single') {
      if (comp.form.get('selectedOptionId')?.value !== index) {
        comp.form.get('selectedOptionId')?.setValue(index, { emitEvent: false });
      }
    } else {
      const ctrl = comp.form.get(String(index));
      if (ctrl) {
        ctrl.setValue(!binding.option.selected, { emitEvent: false });
      }
    }

    this.runOptionContentClick(comp, binding, index, event);
  }

  /**
   * Play the selection sound for a clicked option, resolving correctness from
   * pristine quizInitialState (TEXT match) rather than the possibly-mutated
   * binding flag. Self-contained; extracted verbatim from onOptionUI.
   */
  private playSelectionSound(comp: any, binding: any): void {
    let pristineCorrect = isOptionCorrect(binding.option);
    try {
      const optText = norm(binding.option?.text);
      if (optText) {
        const qText = comp.currentQuestion()?.questionText;
        const pristineTexts = this.quizService.getPristineCorrectTextsForQuestion(qText);
        if (pristineTexts.size > 0) {
          pristineCorrect = pristineTexts.has(optText);
        }
      }
    } catch (err: unknown) {
      console.error('SharedOptionClickService.onOptionUI pristine-correct lookup failed:', err);
    }
    comp.soundService.playOnceForOption({
      ...binding.option,
      correct: pristineCorrect,
      selected: true,
      questionIndex: comp.currentQuestionIndex
    });
  }

  /**
   * Copy the resolved click state back from the per-call `state` object onto the
   * component (render trigger, last-clicked/feedback fields, signals), and stamp
   * showFeedbackForOption onto each state binding. Terminal side-effect;
   * extracted verbatim from runOptionContentClick.
   */
  private syncClickStateToComp(comp: any, state: any): void {
    comp.disableRenderTrigger = state.disableRenderTrigger;
    comp.lastClickedOptionId = state.lastClickedOptionId;
    comp.lastClickTimestamp = state.lastClickTimestamp;
    comp.hasUserClicked.set(state.hasUserClicked);
    comp.freezeOptionBindings.set(state.freezeOptionBindings);
    comp.showFeedback.set(state.showFeedback);
    comp.showFeedbackForOption = state.showFeedbackForOption;
    comp.feedbackConfigs = state.feedbackConfigs;
    comp.lastFeedbackOptionId = state.lastFeedbackOptionId;

    for (const b of state.optionBindings) {
      if (b) b.showFeedbackForOption = { ...comp.showFeedbackForOption };
    }
  }

  /**
   * Stop the timer if every correct option for the question is now selected.
   * Resolves the canonical question by text fingerprint (falling back to qIdx /
   * effectiveCorrectIndices) and checks the durable selection set. Terminal
   * side-effect; extracted verbatim from runOptionContentClick.
   */
  private maybeStopTimerWhenAllCorrect(
    comp: any,
    qIdx: number,
    effectiveCorrectIndices: number[],
    durableSet: Set<number>
  ): void {
    try {
      // "Has every required correct answer been selected?" — one boolean, and
      // the verdict answers it directly. Note this is the SUPERSET question,
      // not perfection: the old code checked only that each correct index was
      // in the durable set, so extra wrong picks never kept the timer running.
      // `allCorrectSelectedFromVerdict` asks exactly that, which is why no
      // "and nothing wrong" clause is added here — it would stop the timer
      // later than today for a correct-plus-extra selection.
      const authorized = allCorrectSelectedFromVerdict(
        verdictStateForDisplayIndex(this.quizService, qIdx, this.verdicts)
      );
      if (authorized === true) {
        this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true });
        return;
      }
      if (authorized === false) return;

      // REMOVE WITH THE IDLE/CHECKING/ERROR CLEANUP — reached only when the
      // verdict has said nothing yet. Under the API adapter that includes the
      // in-flight `checking` moment on the completing click, so this still runs
      // in practice; stopping the timer a round trip later instead would change
      // the recorded elapsed time that a frozen revisit displays.
      let allCorrectIdxs: number[] = [];
      const allQs: any[] = this.quizService?.questions ?? [];
      const passedText = norm(comp.currentQuestion()?.questionText);
      let canonicalQ: any = null;
      if (passedText && allQs.length) {
        const cIdx = allQs.findIndex((q: any) => norm(q?.questionText) === passedText);
        if (cIdx >= 0) canonicalQ = allQs[cIdx];
      }
      if (!canonicalQ) canonicalQ = allQs[qIdx] ?? comp.currentQuestion();
      const rawOpts = canonicalQ?.options ?? [];
      allCorrectIdxs = rawOpts
        .map((o: any, i: number) => isOptionCorrect(o) ? i : -1)
        .filter((n: number) => n >= 0);
      if (allCorrectIdxs.length === 0 && effectiveCorrectIndices?.length) {
        allCorrectIdxs = effectiveCorrectIndices;
      }
      if (allCorrectIdxs.length > 0) {
        const allSelected = allCorrectIdxs.every(ci => durableSet.has(ci));
        if (allSelected) {
          this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true });
        }
      }
    } catch {}
  }

  /**
   * Build the per-call `state` context passed to handleOptionClick (the option
   * UI sync context plus the component's per-question maps, render trigger, and
   * current-question/index). Extracted verbatim from runOptionContentClick.
   */
  private buildClickState(comp: any): any {
    const baseCtx = comp.buildOptionUiSyncContext();
    return {
      ...baseCtx,
      disabledOptionsPerQuestion: comp.disabledOptionsPerQuestion,
      correctClicksPerQuestion: comp.correctClicksPerQuestion,
      freezeOptionBindings: comp.freezeOptionBindings(),
      disableRenderTrigger: comp.disableRenderTrigger,
      currentQuestion: comp.currentQuestion(),
      currentQuestionIndex: baseCtx.getActiveQuestionIndex(),
      showExplanationChange: comp.showExplanationChange,
      explanationToDisplayChange: comp.explanationToDisplayChange
    };
  }

  /**
   * Invoke OptionInteractionService.handleOptionClick inside a freeze guard,
   * wiring the UI-update callback (which re-syncs feedback fields onto `state`)
   * and a shuffle-aware emitExplanation (no-op in shuffled mode, where the SOC
   * owns FET). Extracted verbatim from runOptionContentClick.
   */
  private delegateToHandleOptionClick(comp: any, binding: any, index: number, event: any, state: any): void {
    comp.freezeOptionBindings.set(true);
    state.freezeOptionBindings = true;

    const _isShuffledForFET = this.quizService?.isShuffleEnabled?.()
      && Array.isArray(this.quizService?.shuffledQuestions)
      && this.quizService?.shuffledQuestions?.length > 0;
    const emitExplanationFn = _isShuffledForFET
      ? (_idx: number, _skip?: boolean) => { /* no-op in shuffled mode */ }
      : (idx: number, skipGuard?: boolean) => comp.emitExplanation(idx, skipGuard);

    try {
      this.optionInteractionService.handleOptionClick(
        binding,
        index,
        event,
        state,
        (idx: number) => comp.getQuestionAtDisplayIndex(idx),
        emitExplanationFn,
        (b: any, i: number, ev: any, existingCtx: any) => {
          this.updateOptionAndUI(comp, b, i, ev, existingCtx || state);
          state.showFeedback = comp.showFeedback();
          state.showFeedbackForOption = comp.showFeedbackForOption;
          state.feedbackConfigs = comp.feedbackConfigs;
          state.lastFeedbackOptionId = comp.lastFeedbackOptionId;
          state.disableRenderTrigger = comp.disableRenderTrigger;
        }
      );
    } finally {
      comp.freezeOptionBindings.set(false);
      state.freezeOptionBindings = false;
    }
  }

  /**
   * Resolve the scoring question index and its durable selection set for a
   * click. qIdx starts from getActiveQuestionIndex() but self-heals by text
   * fingerprint: that signal can stick at 0 while the user is on Q2/Q3, which
   * would write scoring to the wrong slot and skip increments. displayIdx
   * preserves the pre-self-heal display index. Also seeds + records the click in
   * the per-question durable set. Extracted verbatim from runOptionContentClick.
   */
  private resolveScoringContext(
    comp: any,
    index: number
  ): { qIdx: number; displayIdx: number; durableSet: Set<number> } {
    let qIdx = comp.getActiveQuestionIndex();
    let displayIdx = qIdx; // Display position; self-healed below against display order
    try {
      const liveQText = norm(comp.currentQuestion()?.questionText);
      const allQs: any[] = this.quizService?.questions ?? [];
      if (liveQText && allQs.length) {
        const atQIdx = norm(allQs[qIdx]?.questionText);
        if (liveQText !== atQIdx) {
          const fixed = allQs.findIndex((q: any) => norm(q?.questionText) === liveQText);
          if (fixed >= 0) qIdx = fixed;
        }
      }
      // Self-heal the DISPLAY index against the display-order array (mirrors the
      // qIdx self-heal against the original array above). getActiveQuestionIndex()
      // can be stale in shuffled mode, which would key the FET bypass / perfect
      // flags under the wrong display position — and the CQC reads by display
      // position, so the FET never shows (e.g. Q5-shuffled regardless of which
      // original question lands there). Text-fingerprint the live question into
      // the display order to recover the true position.
      if (liveQText) {
        const displayQs: any[] = this.quizService?.getQuestionsInDisplayOrder?.() ?? [];
        if (displayQs.length) {
          const atDisplayIdx = norm(displayQs[displayIdx]?.questionText);
          if (liveQText !== atDisplayIdx) {
            const fixedDisplay = displayQs.findIndex((q: any) => norm(q?.questionText) === liveQText);
            if (fixedDisplay >= 0) displayIdx = fixedDisplay;
          }
        }
      }
    } catch { /* ignore */ }
    if (!comp._multiSelectByQuestion.has(qIdx)) {
      comp._multiSelectByQuestion.set(qIdx, new Set<number>());
    }
    const durableSet = comp._multiSelectByQuestion.get(qIdx)!;
    durableSet.add(index);
    return { qIdx, displayIdx, durableSet };
  }

  /**
   * Resolve the effective correct-option indices for scoring: start from the
   * cached resolveCorrectIndices result, then (when pristine quizInitialState
   * has them) rebuild the indices by matching binding texts against the pristine
   * correct texts — bindings can have mutated `correct` flags. Returns the
   * effective indices/count, the shuffle flag, and the resolved single/multi
   * mode. Extracted verbatim from runOptionContentClick.
   */
  private resolveEffectiveCorrectIndices(comp: any, qIdx: number) {
    const liveQuestion = comp.currentQuestion() ?? comp.getQuestionAtDisplayIndex(qIdx);

    if (!comp._correctIndicesByQuestion.has(qIdx)) {
      const result = this.clickHandler.resolveCorrectIndices(
        liveQuestion, qIdx, comp.isMultiMode, comp.type
      );
      comp._correctIndicesByQuestion.set(qIdx, result.correctIndices);
    }
    const correctIndicesFromQ = comp._correctIndicesByQuestion.get(qIdx)!;
    const correctCountFromQ = correctIndicesFromQ.length;

    // Resolve correct indices from pristine quizInitialState
    let effectiveCorrectIndices = correctIndicesFromQ;
    const isShuffled = this.quizService?.isShuffleEnabled?.()
      && Array.isArray(this.quizService?.shuffledQuestions)
      && this.quizService?.shuffledQuestions?.length > 0;

    try {
      // Prefer the live displayed question — it is shuffle-correct without any
      // index. Indexing display-order arrays by qIdx is WRONG here: qIdx is the
      // self-healed ORIGINAL index, so in shuffled mode it resolves a different
      // question, poisoning the pristine-correct count and the single/multi
      // routing.
      const qTextForLookup = isShuffled
        ? (comp.currentQuestion()?.questionText
          ?? this.quizService?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
          ?? this.quizService?.shuffledQuestions?.[qIdx]?.questionText
          ?? comp.getQuestionAtDisplayIndex?.(qIdx)?.questionText)
        : (comp.currentQuestion()?.questionText
          ?? this.quizService?.questions?.[qIdx]?.questionText
          ?? comp.getQuestionAtDisplayIndex?.(qIdx)?.questionText);
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(qTextForLookup);
      if (pristineCorrectTexts.size > 0) {
        const rebuilt: number[] = [];
        const bindings: any[] = Array.isArray(comp.optionBindings()) ? comp.optionBindings() : [];
        for (let i = 0; i < bindings.length; i++) {
          if (pristineCorrectTexts.has(norm(bindings[i]?.option?.text))) rebuilt.push(i);
        }
        if (rebuilt.length > 0) {
          effectiveCorrectIndices = rebuilt;
          comp._correctIndicesByQuestion.set(qIdx, rebuilt);
        }
      }
    } catch (err: unknown) {
      console.error('SharedOptionClickService.runOptionContentClick pristine-rebuild failed:', err);
    }
    const effectiveCorrectCount = effectiveCorrectIndices.length;

    // ── SINGLE vs MULTI: TYPE, NOT ANSWER-KEY CARDINALITY ─────────────
    //
    // This used to be `... || effectiveCorrectCount > 1 || pristineCorrectCount > 1`,
    // which makes question TYPE a derivative of the answer key. It decides
    // which click path runs for EVERY click, so with correctness absent — the
    // shape `/questions` returns — both counts collapse to 0 and every
    // multi-answer question would be routed to the single-answer path.
    //
    // The declared type answers this directly: the registry holds it for the
    // current quiz, and `comp.isMultiMode`/`comp.type` are themselves
    // registry-first (answer.component.resolveQuestionType). A registry MISS
    // is deliberately NOT treated as single — that would silently downgrade
    // multi-answer questions while the request is in flight.
    const declaredMulti = this.typeRegistry.isMultiAnswer(liveQuestion?.questionText);
    const isMultiFromQ = declaredMulti !== null
      ? declaredMulti
      : (comp.isMultiMode || comp.type === 'multiple');

    return { effectiveCorrectIndices, effectiveCorrectCount, isShuffled, isMultiFromQ };
  }

  runOptionContentClick(comp: any, binding: any, index: number, event: any): void {
    const now = Date.now();
    if (comp._lastRunClickIndex === index && comp._lastRunClickTime && (now - comp._lastRunClickTime) < 200) {
      return;
    }
    comp._lastRunClickIndex = index;
    comp._lastRunClickTime = now;

    this.quizStateService.markUserInteracted(comp.getActiveQuestionIndex());

    const state: any = this.buildClickState(comp);
    this.delegateToHandleOptionClick(comp, binding, index, event, state);
    this.syncClickStateToComp(comp, state);

    const { qIdx, displayIdx, durableSet } = this.resolveScoringContext(comp, index);

    // If auto-reveal already stamped the live bindings with
    // _autoRevealedCorrect (all-incorrects-exhausted scenario), use
    // the live bindings — state.optionBindings is a stale snapshot
    // captured before auto-reveal ran and would wipe the green
    // highlight, disabled state, and correct-option CSS class.
    const liveBindings = comp.optionBindings();
    const autoRevealed = liveBindings?.some((b: any) => b?._autoRevealedCorrect);
    comp.optionBindings.set(autoRevealed ? liveBindings : state.optionBindings);

    this.nextButtonStateService.forceEnable(2000);
    this.selectedOptionService.setAnswered(true, true);

    const { effectiveCorrectIndices, effectiveCorrectCount, isShuffled, isMultiFromQ } =
      this.resolveEffectiveCorrectIndices(comp, qIdx);

    this.maybeStopTimerWhenAllCorrect(comp, qIdx, effectiveCorrectIndices, durableSet);

    // â”€â”€â”€ Delegate to answer processing sub-services â”€â”€â”€

    // ROUTED BY TYPE ALONE. The `effectiveCorrectCount > 0` guard that used to
    // sit here is answer-key dependent: with correctness absent it is 0, and a
    // multi-answer question would fall through to the single-answer path — a
    // silent behaviour change rather than a visible failure. Today the count is
    // always > 0 for a multi question, so removing the term changes nothing now
    // and stops it mattering later.
    if (isMultiFromQ) {
      // Use fresh binding from comp.optionBindings()[index] â€” the local
      // `binding` variable was captured before updateOptionAndUI's
      // `comp.optionBindings() = state.optionBindings` reassign at line 238,
      // so its option may have a stale `correct` flag relative to the
      // bindings now driving the UI. Without this fix, _feedbackDisplay
      // captures the stale option and the 2nd correct click on a
      // multi-answer question shows a sad face instead of smiley.
      const freshBinding = comp.optionBindings()?.[index] ?? binding;
      this.answerProcessing.processMultiAnswerClick({
        comp, index, binding: freshBinding, qIdx, displayIdx, durableSet,
        effectiveCorrectIndices, effectiveCorrectCount, isShuffled
      });
      return;
    }

    if (!isMultiFromQ) {
      this.answerProcessing.processSingleAnswerClick({
        comp, index, qIdx, displayIdx, durableSet,
        effectiveCorrectIndices, isShuffled
      });
    }

    this.applyPostClickFeedbackDisplay(comp, index);

    this.rebuildBindingsForRender(comp, index, isMultiFromQ, durableSet);

    comp.cdRef.detectChanges();
  }

  /**
   * Post-click feedback display: resolve the feedback config for the clicked
   * option (by key, by idx, or the active config), apply the multi-answer
   * override, and stamp comp._feedbackDisplay when it should show. Terminal
   * side-effect. Deterministic re-render is guaranteed by the cdRef.markForCheck()
   * at the end of this method (setting the plain _feedbackDisplay field does not
   * schedule change detection in this zoneless app).
   */
  private applyPostClickFeedbackDisplay(comp: any, index: number): void {
    comp._feedbackDisplay = null;
    if (comp.showFeedback()) {
      const clickedBinding = comp.optionBindings()[index];
      if (clickedBinding) {
        const key = comp.keyOf(clickedBinding.option, index);
        const byKey = comp.feedbackConfigs[key];
        const byIdx = (Object.values(comp.feedbackConfigs) as FeedbackProps[]).find(
          (c: any) => c?.idx === index && c.showFeedback
        );
        const activeCfg = comp.activeFeedbackConfig();
        let cfg: FeedbackProps | undefined =
          (byKey?.showFeedback ? byKey : undefined) ??
          byIdx ??
          (activeCfg?.showFeedback ? activeCfg : undefined);

        if (cfg?.showFeedback) {
          cfg = this.clickHandler.overrideMultiAnswerFeedback(
            cfg, clickedBinding, comp.optionBindings()
          );
        }

        if (cfg?.showFeedback) {
          comp._feedbackDisplay = { idx: index, optionId: clickedBinding.option?.optionId, config: cfg };
        }
      }
    }
    // DETERMINISTIC RENDER: _feedbackDisplay is a PLAIN field, so in this zoneless
    // app setting it does NOT schedule change detection. When this runs async
    // (after the click's CD), the template's feedback/FET predicates never
    // re-evaluate and the FET silently fails to render on some machines/browsers
    // with no error. Force a CD pass so the FET renders deterministically
    // regardless of machine speed (this replaced the old timing-dependent behavior).
    comp.cdRef?.markForCheck();
  }

  /**
   * Create NEW binding object references so OnPush option-item children detect
   * the input change and re-render. For single-answer, stamp selected/highlight/
   * showIcon from the clicked index + durable history; for multi-answer, just
   * fresh-spread each binding. Terminal side-effect; extracted verbatim from
   * runOptionContentClick.
   */
  private rebuildBindingsForRender(
    comp: any,
    index: number,
    isMultiFromQ: boolean,
    durableSet: Set<number>
  ): void {
    if (!isMultiFromQ) {
      const histSet = new Set<number>(durableSet ?? []);
      comp.optionBindings.set((comp.optionBindings() ?? []).map((b: any, bi: number) => {
        const isClicked = bi === index;
        const inHistory = histSet.has(bi);
        return {
          ...b,
          isSelected: isClicked,
          option: b.option ? {
            ...b.option,
            selected: isClicked,
            highlight: isClicked || inHistory,
            showIcon: isClicked || inHistory
          } : b.option
        };
      }));
    } else {
      comp.optionBindings.set((comp.optionBindings() ?? []).map((b: any) => ({
        ...b,
        option: b.option ? { ...b.option } : b.option
      })));
    }
  }

  // ── Option UI (delegated) ──────────────────────────────────────

  handleSelection(comp: any, option: SelectedOption, index: number, optionId: number): void {
    this.optionUi.handleSelection(comp, option, index, optionId);
  }

  handleBackwardNavigationOptionClick(comp: any, option: any, index: number): void {
    this.optionUi.handleBackwardNavigationOptionClick(comp, option, index);
  }

  applySelectionsUI(comp: any, selectedOptions: any[]): void {
    this.optionUi.applySelectionsUI(comp, selectedOptions);
  }

  updateBindingSnapshots(comp: any): void {
    this.optionUi.updateBindingSnapshots(comp);
  }

  preserveOptionHighlighting(comp: any): void {
    this.optionUi.preserveOptionHighlighting(comp);
  }

  ensureOptionsToDisplay(comp: any): void {
    this.optionUi.ensureOptionsToDisplay(comp);
  }

  enforceSingleSelection(comp: any, selectedBinding: OptionBindings): void {
    this.optionUi.enforceSingleSelection(comp, selectedBinding);
  }

  // â”€â”€â”€ Remaining inline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  updateOptionAndUI(comp: any, optionBinding: any, index: number, event: any, 
    existingCtx?: any): void {
    const ctx = existingCtx ?? comp.buildOptionUiSyncContext();

    this.optionUiSyncService.updateOptionAndUI(optionBinding, index, event, ctx);

    this.applyFeedbackStateFromCtx(comp, ctx, optionBinding, index, event);
    this.syncSelectedOptionsFromCtx(comp, ctx);
    this.rebuildBindingsFromCtx(comp, ctx);
    this.applySingleAnswerSelectionGuard(comp, ctx, index, event);

    this.updateBindingSnapshots(comp);
    comp.cdRef.detectChanges();
  }

  /**
   * Copy the feedback state resolved by optionUiSyncService from the ctx onto
   * the component (feedbackConfigs, showFeedback(For), last-feedback/selected
   * fields) and, when the clicked option's config is showing feedback, set it
   * as the active config + last-click feedback. Extracted verbatim.
   */
  private applyFeedbackStateFromCtx(comp: any, ctx: any, optionBinding: any, index: number, event: any): void {
    comp.feedbackConfigs = { ...ctx.feedbackConfigs };
    comp.showFeedbackForOption = { ...ctx.showFeedbackForOption };
    comp.showFeedback.set(ctx.showFeedback);
    comp.lastFeedbackOptionId = Number(ctx.lastFeedbackOptionId);
    comp.lastFeedbackQuestionIndex = ctx.lastFeedbackQuestionIndex;
    const isChecked = 'checked' in event ? event.checked : true;
    comp.lastSelectedOptionIndex = isChecked ? index : -1;
    comp.lastSelectedOptionId = ctx.lastFeedbackOptionId;

    const feedbackKey = comp.keyOf(optionBinding.option, index);
    const syncedConfig = comp.feedbackConfigs[feedbackKey] as FeedbackProps | undefined;
    if (syncedConfig?.showFeedback) {
      comp.activeFeedbackConfig.set(syncedConfig);
      comp.currentFeedbackConfig = syncedConfig;
      comp._lastClickFeedback = {
        index,
        config: syncedConfig,
        questionIdx: comp.resolveCurrentQuestionIndex()
      };
    }
  }

  /** Rebuild comp.selectedOptions from the ctx selection map. Extracted verbatim. */
  private syncSelectedOptionsFromCtx(comp: any, ctx: any): void {
    comp.selectedOptions.clear();
    for (const id of ctx.selectedOptionMap.keys()) {
      comp.selectedOptions.add(Number(id));
    }
  }

  /**
   * Reset optionBindings from the ctx bindings if present, otherwise re-spread
   * the live bindings applying the synced feedback/disabled state. Extracted
   * verbatim.
   */
  private rebuildBindingsFromCtx(comp: any, ctx: any): void {
    if (ctx.optionBindings) {
      comp.optionBindings.set([...ctx.optionBindings]);
    } else {
      comp.optionBindings.set(comp.optionBindings().map((b: any) => ({
        ...b,
        showFeedbackForOption: { ...comp.showFeedbackForOption },
        showFeedback: comp.showFeedback(),
        disabled: comp.computeDisabledState(b.option, b.index)
      })));
    }
  }

  /**
   * SINGLE-ANSWER GUARD: on a checked single-answer click with ≤1 correct
   * option, force exactly the clicked index selected across all bindings.
   * Extracted verbatim.
   */
  private applySingleAnswerSelectionGuard(comp: any, ctx: any, index: number, event: any): void {
    const isCheckedForGuard = 'checked' in event ? event.checked : true;
    if (isCheckedForGuard && ctx.type === 'single') {
      const correctCount = (ctx.optionBindings ?? []).filter((b: any) =>
        isOptionCorrect(b?.option)
      ).length;
      if (correctCount <= 1) {
        for (let bi = 0; bi < (comp.optionBindings() ?? []).length; bi++) {
          const ob = comp.optionBindings()[bi];
          if (!ob) continue;
          ob.isSelected = (bi === index);
          if (ob.option) {
            ob.option.selected = (bi === index);
          }
        }
      }
    }
  }
}