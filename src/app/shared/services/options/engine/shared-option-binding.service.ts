import { Service, inject } from '@angular/core';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { SelectedOption } from '../../../models/SelectedOption.model';
import { SharedOptionConfig } from '../../../models/SharedOptionConfig.model';

import { SK_SEL_Q } from '../../../constants/session-keys';

import { ExplanationTextService } from '../../features/explanation/explanation-text.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { OptionBindingFactoryService } from './option-binding-factory.service';
import { OptionClickHandlerService } from './option-click-handler.service';
import { OptionService } from '../view/option.service';
import { QuestionResolutionService } from './question-resolution.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

import { authorizedCorrectTexts } from '../../features/verdict/authorized-correctness';

import { feedbackAnchorMatches } from '../../../utils/feedback-anchor';
import { resolveIsMultiAnswer } from '../../../utils/question-type-authority';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

@Service()
export class SharedOptionBindingService {
  // ── injects ─────────────────────────────────────────────────────
  private clickHandler = inject(OptionClickHandlerService);
  private explanationTextService = inject(ExplanationTextService);
  private feedbackService = inject(FeedbackService);
  private optionBindingFactory = inject(OptionBindingFactoryService);
  private optionService = inject(OptionService);
  private questionResolution = inject(QuestionResolutionService);
  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);
  private verdicts = inject(QuestionVerdictService);

  // ── public methods ──────────────────────────────────────────────

  synchronizeOptionBindings(comp: any): void {
    if (!Array.isArray(comp.optionsToDisplay) || comp.optionsToDisplay.length === 0) {
      const hasSelection = comp.optionBindings()?.some((opt: OptionBindings) => opt.isSelected);
      if (!hasSelection && !comp.freezeOptionBindings()) comp.optionBindings.set([]);
      return;
    }

    if (comp.freezeOptionBindings() || comp.hasUserClicked()) return;

    const bindings = comp.optionsToDisplay.map((option: Option, idx: number) => {
      // Unknown until a verdict authorizes it — see OptionBindings.isCorrect.
      const isCorrect = null;
      return {
        option: {
          ...option,
          // Force visual flags OFF for the initial pass. The real
          // visual state is applied by rehydrateUiFromState AFTER
          // authoritative selections are resolved. Using stale
          // option.selected here causes a brief flash of incorrect
          // highlights on refresh.
          highlight: false,
          showIcon: false
        },
        index: idx,
        isSelected: false,
        isCorrect,
        showFeedback: false,
        feedback: option.feedback ?? 'No feedback available',
        showFeedbackForOption: { [idx]: false },
        highlightCorrectAfterIncorrect: false,
        highlightIncorrect: false,
        highlightCorrect: false,
        disabled: comp.computeDisabledState(option, idx),
        type: comp.resolveInteractionType(),
        appHighlightOption: false,
        appHighlightInputType: (comp.type === 'multiple' ? 'checkbox' : 'radio') as 'checkbox' | 'radio',
        allOptions: [...comp.optionsToDisplay],
        appHighlightReset: false,
        ariaLabel: `Option ${idx + 1}`,
        appResetBackground: false,
        optionsToDisplay: [...comp.optionsToDisplay],
        checked: false,
        change: () => { },
        active: true
      };
    });

    queueMicrotask(() => {
      // If processOptionBindings already built correct bindings (with
      // rehydrated state), skip this overwrite - the microtask would
      // replace them with stale option.selected data, causing a flash
      // of incorrect highlights before the next CD cycle corrects them.
      if (comp.optionBindingsInitialized() && comp.optionBindings()?.length > 0) {
        comp.showOptions.set(true);
        comp.renderReady.set(true);
        comp.cdRef.markForCheck();
        return;
      }
      comp.optionBindings.set(bindings);
      comp.showOptions.set(true);
      comp.renderReady.set(true);
      comp.cdRef.detectChanges();
    });

  }

  setOptionBindingsIfChanged(comp: any, newOptions: Option[]): void {
    if (!newOptions?.length) return;

    const incomingIds = newOptions.map((o: Option) => o.optionId).join(',');
    const existingIds = comp.optionBindings()?.map((b: OptionBindings) => b.option.optionId).join(',');

    if (incomingIds !== existingIds || !comp.optionBindings()?.length) {
      // On refresh (no user click), force isSelected=false so the checkbox
      // [checked] binding doesn't flash. rehydrateUiFromState will set the
      // authoritative selection state from saved data afterward.
      const trustOptionSelected = !!comp.hasUserClicked();
      comp.optionBindings.set(newOptions.map((option: Option, idx: number) => ({
        option: { ...option, highlight: false, showIcon: false },
        index: idx,
        isSelected: trustOptionSelected && !!option.selected,
        isCorrect: null,
        showFeedback: false,
        feedback: option.feedback ?? 'No feedback available',
        showFeedbackForOption: false,
        highlightCorrectAfterIncorrect: false,
        highlightIncorrect: false,
        highlightCorrect: false,
        disabled: comp.computeDisabledState(option, idx),
        type: comp.resolveInteractionType(),
        appHighlightOption: false,
        appHighlightInputType: '',
        allOptions: comp.optionsToDisplay ?? []
      })) as unknown as OptionBindings[]);
    } else {
      let idx = 0;
      const trustSel = !!comp.hasUserClicked();
      for (const binding of comp.optionBindings() ?? []) {
        const updated = newOptions[idx];
        if (updated) {
          binding.option = { ...updated, highlight: false, showIcon: false };
          binding.isSelected = trustSel && !!updated.selected;
          // Deliberately NOT re-derived from `updated.correct`. Refreshing the
          // option must not overwrite an authorized verdict with a local flag,
          // nor invent one where none exists.
        }
        idx++;
      }
    }

    comp.optionsReady = true;
    comp.showOptions.set(true);

    // Re-apply persisted refresh state. initializeFromConfig calls this
    // method AFTER generateOptionBindings already rehydrated, so the
    // bindings just created above have highlight:false/showIcon:false.
    // Without this re-rehydrate, previously-clicked wrong options lose
    // their red highlight + X icon on refresh.
    comp.rehydrateUiFromState('setOptionBindingsIfChanged');

    if (this.explanationTextService.latestExplanation) {
      const currentIdx = comp.resolveDisplayIndex(comp.currentQuestionIndex);
      if (this.explanationTextService.latestExplanationIndex === currentIdx) {
        // Only re-emit explanation for single-answer questions. For multi-
        // answer, FET must wait until ALL correct answers are selected -
        // emitting here on every binding update causes premature FET display
        // after a partial correct click.
        // Use authoritative questions array - comp.currentQuestion.options
        // often lack the `correct` flag, making correctCount=0.
        const authQ = this.quizService.questions?.[currentIdx] ?? comp.currentQuestion();
        const correctCount = (authQ?.options ?? []).filter(
          (o: any) => isOptionCorrect(o)
        ).length;
        // DECLARED TYPE FIRST. The count is a proxy for "is this multi-answer",
        // and it stops being computable once the answer key leaves the browser.
        // `questions` is a GETTER that returns shuffledQuestions while shuffle
        // is active, so indexing it with this display index is identity-safe.
        // REMOVE THE COUNT IN /questions CONTENT CUTOVER.
        // MODE INPUT STILL PROMOTES — declared type replaces the COUNT only.
        const isMulti = comp.isMultiMode || resolveIsMultiAnswer(authQ, correctCount > 1);
        if (!isMulti) {
          comp.deferHighlightUpdate(() => comp.emitExplanation(currentIdx));
        }
      }
    }
  }

  generateOptionBindings(comp: any): void {
    if (comp.hasUserClicked() && comp.optionBindings()?.length > 0) return;

    const currentIndex = comp.getActiveQuestionIndex() ?? 0;

    this.applyBindingShuffleGuard(comp, currentIndex);
    this.buildOptionsToDisplay(comp, currentIndex);
    this.createAndSetBindings(comp);

    comp.rehydrateUiFromState('generateOptionBindings');

    this.applyRevisitOverride(comp);
    this.finalizeBindings(comp);
  }

  // SHUFFLE GUARD: when shuffle is active, ensure we use options from
  // the authoritative shuffledQuestions array for this display index.
  private applyBindingShuffleGuard(comp: any, currentIndex: number): void {
    if (this.quizService.isShuffleEnabled() && this.quizService.shuffledQuestions?.length > 0) {
      const correctQ = this.quizService.shuffledQuestions[currentIndex];
      if (correctQ?.options?.length > 0) {
        const correctTexts = new Set(correctQ.options.map((o: Option) => norm(o?.text)));
        const currentTexts = new Set((comp.optionsToDisplay ?? []).map((o: Option) => norm(o?.text)));
        const match = correctTexts.size === currentTexts.size && [...correctTexts].every((t: string) => currentTexts.has(t));
        if (!match && comp.optionsToDisplay?.length > 0) {
          comp.optionsToDisplay = correctQ.options.map((o: Option) => ({ ...o }));
        }
      }
    }
  }

  private buildOptionsToDisplay(comp: any, currentIndex: number): void {
    const localOpts = Array.isArray(comp.optionsToDisplay)
      ? comp.optionsToDisplay.map((o: Option) => structuredClone(o)) : [];

    const correctTexts = new Set<string>();
    const correctIds = new Set<number>();
    const cqForAnswers = comp.currentQuestion();
    if (cqForAnswers && Array.isArray(cqForAnswers.answer)) {
      for (const a of cqForAnswers.answer) {
        if (!a) continue;
        if (a.text) correctTexts.add(norm(a.text));
        const id = Number(a.optionId);
        if (!isNaN(id)) correctIds.add(id);
      }
    }

    comp.optionsToDisplay = localOpts.map((opt: Option, i: number) => {
      const oIdNum = Number(opt.optionId);
      const oId = !isNaN(oIdNum) ? oIdNum : (currentIndex + 1) * 100 + (i + 1);
      const oText = norm(opt.text);

      const isCorrect = isOptionCorrect(opt) ||
        (!isNaN(oIdNum) && correctIds.has(oIdNum)) ||
        !!(oText && correctTexts.has(oText));

      return {
        ...opt,
        optionId: oId,
        correct: isCorrect,
        highlight: false,
        showIcon: false,
        active: opt.active ?? true,
        disabled: comp.computeDisabledState(opt, i)
      };
    });
  }

  private createAndSetBindings(comp: any): void {
    comp.optionBindings.set(this.optionBindingFactory.createBindings({
      optionsToDisplay: comp.optionsToDisplay,
      type: comp.resolveInteractionType(),
      showFeedback: comp.showFeedback(),
      showFeedbackForOption: {},
      highlightCorrectAfterIncorrect: comp.highlightCorrectAfterIncorrect(),
      shouldResetBackground: comp.shouldResetBackground(),
      ariaLabelPrefix: 'Option',
      onChange: (opt: Option, idx: number) => comp.handleOptionClick(opt, idx),
      isSelected: () => false,
      isDisabled: (opt: Option, idx: number) => comp.computeDisabledState(opt, idx)
    }));
  }

  // Previous-revisit visual override. After all the standard binding paths
  // have run, force the Previous-revisit semantics:
  //   * Question was answered correctly (clickConfirmedDotStatus === 'correct'):
  //       correct options stay highlighted; incorrect options are greyed out.
  //   * Question was answered incorrectly: clear all marks.
  // This runs unconditionally (no hasUserClicked guard) so it survives the
  // standard rehydrate path's early-returns.
  private applyRevisitOverride(comp: any): void {
    try {
      const qIdx = comp.resolveCurrentQuestionIndex?.()
        ?? comp.questionIndex?.()
        ?? comp.currentQuestionIndex
        ?? 0;
      const isCorrectOpt = (o: any): boolean => isOptionCorrect(o);
      const current = comp.optionBindings?.();

      const _res = this.questionResolution.resolveQuestionState(qIdx, { includeSelections: false });
      const dotStatus = _res.dot;

      // Decide override mode:
      //   'correct' -> paint correct opts green, others grey
      //   'wrong'   -> clear all marks
      //   ''        -> leave bindings alone (mid-interaction, e.g. partial multi-answer)
      let overrideMode: '' | 'correct' | 'wrong' = '';
      // GUARD: only apply revisit-override when the user has actually clicked
      // this question in the CURRENT session. Without this, stale sessionStorage
      // entries (dot/multiPerfect) from a previous shuffle order pre-paint
      // a fresh-visit question - the option appears already highlighted, so
      // clicking it is a visual no-op and the click never reaches interaction.
      const _hasClickedThis =
        !!comp.quizStateService?.hasClickedInSession?.(qIdx);
      if (_hasClickedThis) {
        if (_res.fullyResolvedCorrect) overrideMode = 'correct';
        else if (dotStatus === 'wrong') overrideMode = 'wrong';
      }
      // Partial multi-answer (isCanonMulti && dot=correct && !multiPerfect): no override

      if (Array.isArray(current) && current.length > 0 && overrideMode !== '') {
        // Build a NEW array of NEW binding refs with NEW option refs so that
        // OnPush option-items re-render with the corrected visuals. Mutating
        // in place leaves Angular blind to the change.
        const refreshed = current.map((b: OptionBindings) => {
          if (!b) return b;
          const isCorrect = isCorrectOpt(b.option);
          const correctRevisit = overrideMode === 'correct';
          const showHighlight = correctRevisit && isCorrect;
          const greyOut = correctRevisit && !isCorrect;

          const newOption = {
            ...(b.option ?? {}),
            selected: showHighlight,
            highlight: showHighlight,
            showIcon: showHighlight,
            active: !greyOut,
            // Stamp so option-item.shouldHighlightOption picks the green branch
            ...(showHighlight ? { _autoRevealedCorrect: true } : { _autoRevealedCorrect: false })
          };

          // Mirror correct-class into cssClasses so getOptionClasses sees it
          // even if downstream code wipes option.highlight afterwards.
          const newCss = { ...(b.cssClasses ?? {}) };
          newCss['correct-option'] = !!showHighlight;
          newCss['incorrect-option'] = false;

          return {
            ...b,
            option: newOption,
            isSelected: showHighlight,
            disabled: greyOut,
            highlightCorrect: showHighlight,
            highlightIncorrect: false,
            cssClasses: newCss
          };
        });
        comp.optionBindings.set(refreshed);
        try { comp.cdRef?.markForCheck?.(); } catch { /* ignore */ }
      }
    } catch (err: unknown) { console.error('generateOptionBindings revisit-override failed:', err); }
  }

  private finalizeBindings(comp: any): void {
    const hasFreshFeedback = Object.keys(comp.feedbackConfigs).length > 0;
    if (!hasFreshFeedback) comp.rebuildShowFeedbackMapFromBindings();

    comp.showOptions.set(true);
    comp.optionsReady = true;
    comp.renderReady.set(true);

    comp.markRenderReady('Bindings refreshed');
    comp.cdRef.markForCheck();
  }

  processOptionBindings(comp: any): void {
    const pIdx = comp.currentQuestionIndex ?? this.quizService.getCurrentQuestionIndex() ?? 0;
    this.applyProcessShuffleGuard(comp, pIdx);

    const options = comp.optionsToDisplay ?? [];

    if (!options.length) {
      comp.optionBindingsInitialized.set(false);
      return;
    }
    if (comp.freezeOptionBindings()) return;
    const cqForFeedback = comp.currentQuestion();
    if (!cqForFeedback) return;

    const currentIdx = comp.currentQuestionIndex ?? this.quizService.getCurrentQuestionIndex();

    const ctx = this.buildSelectionContext(comp, currentIdx, cqForFeedback);
    this.buildProcessedBindings(comp, options, ctx);
    this.finalizeProcessedBindings(comp);
  }

  // SHUFFLE GUARD: same as generateOptionBindings
  private applyProcessShuffleGuard(comp: any, pIdx: number): void {
    if (this.quizService.isShuffleEnabled() && this.quizService.shuffledQuestions?.length > 0) {
      const correctQ = this.quizService.shuffledQuestions[pIdx];
      if (correctQ?.options?.length > 0 && comp.optionsToDisplay?.length > 0) {
        const correctTexts = new Set(correctQ.options.map((o: Option) => norm(o?.text)));
        const currentTexts = new Set((comp.optionsToDisplay).map((o: Option) => norm(o?.text)));
        const match = correctTexts.size === currentTexts.size && [...correctTexts].every((t: string) => currentTexts.has(t));
        if (!match) {
          comp.optionsToDisplay = correctQ.options.map((o: Option) => ({ ...o }));
        }
      }
    }
  }

  // Resolve the saved-selection context (filtered to this question) and the
  // feedback sentence used to stamp every binding.
  private buildSelectionContext(comp: any, currentIdx: number, cqForFeedback: any): {
    savedSelections: any[];
    savedIds: Set<number | string>;
    savedByDisplayIdx: Set<number>;
    feedbackSentence: string;
  } {
    const rawSavedSelections = this.selectedOptionService.getSelectedOptionsForQuestion(currentIdx) || [];
    // Strict question-context filter: drop any selection whose stored
    // questionIndex doesn't match currentIdx, so a previous question's
    // selections can never stamp highlights onto a new question's options.
    const savedSelections = rawSavedSelections.filter((s: any) => {
      const sQIdx = s?.questionIndex ?? s?.qIdx ?? s?.questionIdx;
      return sQIdx == null || Number(sQIdx) === Number(currentIdx);
    });
    const savedIds = this.toIdSet(savedSelections);

    const feedbackSentence = this.feedbackService.buildFeedbackMessage(
      cqForFeedback,
      savedSelections,
      false,
      false,
      currentIdx,
      comp.optionsToDisplay
    ) || '';

    // Build a position-based set from saved selections so the id-based
    // savedIds fallback (effectiveId = idx) cannot false-positive when a
    // display index collides with another option's optionId.
    const savedByDisplayIdx = new Set<number>();
    for (const s of savedSelections) {
      const sIdx = (s as any).displayIndex ?? (s as any).index ?? (s as any).idx;
      if (sIdx != null && Number.isFinite(Number(sIdx))) {
        savedByDisplayIdx.add(Number(sIdx));
      }
    }

    return { savedSelections, savedIds, savedByDisplayIdx, feedbackSentence };
  }

  private buildProcessedBindings(
    comp: any,
    options: Option[],
    ctx: { savedIds: Set<number | string>; savedByDisplayIdx: Set<number>; feedbackSentence: string }
  ): void {
    const getBindings = comp.getOptionBindings.bind(comp);
    const highlightSet = comp.highlightedOptionIds;
    const { savedIds, savedByDisplayIdx, feedbackSentence } = ctx;

    comp.optionBindings.set(options.map((opt: Option, idx: number) => {
      const oIdNum = Number(opt.optionId);
      const effectiveId = (!isNaN(oIdNum) && oIdNum > -1) ? oIdNum : idx;

      if (opt.optionId == null) opt.optionId = effectiveId;

      opt.feedback = feedbackSentence;

      // Match saved selections: for options with a real optionId, the ID
      // alone is sufficient (real IDs are unique). For options whose
      // effectiveId is a fallback (= their array index), also require a
      // display-index match to prevent false positives when the fallback
      // index collides with another option's real optionId.
      const idMatch = savedIds.has(effectiveId) || savedIds.has(String(effectiveId));
      const hasRealId = !isNaN(oIdNum) && oIdNum > -1;
      const posMatch = savedByDisplayIdx.has(idx);
      const isSelected = hasRealId ? idMatch : (idMatch && posMatch);

      // Only trust highlightSet and savedIds during LIVE interaction
      // (hasUserClicked). On refresh, savedIds may contain stale entries
      // from accumulated selection history, and highlightSet may have
      // IDs from a previous CD cycle - both cause ghost highlights for
      // options the user never selected. rehydrateUiFromState (called
      // immediately after this loop) handles refresh highlighting
      // authoritatively with its own clean-slate + match logic.
      const useHighlightSet = comp.hasUserClicked() && highlightSet.has(effectiveId);
      const useSelected = comp.hasUserClicked() ? isSelected : false;
      opt.highlight = useSelected || useHighlightSet;

      // Pass the GUARDED selection state to getBindings so that on refresh
      // (hasUserClicked=false) no binding gets isSelected=true from stale
      // savedIds. This prevents _wasSelected from latching in
      // shouldHighlightOption() before rehydrateUiFromState can run its
      // clean-slate reset.
      // IMPORTANT: only use useSelected, NOT useHighlightSet - highlightSet
      // can contain IDs for options never clicked (e.g. both correct answers
      // in multi-answer), causing ghost isSelected=true on bindings.
      return getBindings(opt, idx, useSelected);
    }));
  }

  private finalizeProcessedBindings(comp: any): void {
    comp.rebuildShowFeedbackMapFromBindings();
    comp.updateSelections(-1);

    // Re-apply persisted refresh state AFTER the id-based rebuild above.
    // `processOptionBindings` only knows how to light options whose
    // `optionId` appears in `savedIds`. That misses position-encoded
    // matches (displayIndex/text) needed on refresh, AND it does not
    // populate `disabledOptionsPerQuestion` for never-clicked wrongs.
    // Calling rehydrate after the rebuild guarantees the canonical
    // refresh state is the last write before detectChanges.
    comp.rehydrateUiFromState('processOptionBindings');

    comp.optionsReady = true;
    comp.renderReady.set(true);
    comp.viewReady.set(true);
    comp.cdRef.detectChanges();
  }

  hydrateOptionsFromSelectionState(comp: any): void {
    if (!Array.isArray(comp.optionsToDisplay) || comp.optionsToDisplay.length === 0) {
      return;
    }

    const currentIndex =
      comp.getActiveQuestionIndex() ??
      comp.currentQuestionIndex ??
      comp.questionIndex() ??
      0;

    const storedSelections =
      this.selectedOptionService.getSelectedOptionsForQuestion(currentIndex) ?? [];

    comp.optionsToDisplay = comp.optionsToDisplay.map((opt: Option, i: number) => {
      const match = storedSelections.find(
        (s: SelectedOption) =>
          Number(s.optionId) === Number(opt.optionId) &&
          Number(s.questionIndex) === Number(currentIndex)
      );

      return {
        ...opt,
        optionId:
          typeof opt.optionId === 'number' && Number.isFinite(opt.optionId)
            ? opt.optionId
            : (currentIndex + 1) * 100 + (i + 1),
        selected: !!match?.selected,
        highlight: !!match?.highlight,
        showIcon: !!match?.showIcon,
        active: opt.active ?? true,
        disabled: comp.computeDisabledState(opt, i)
      };
    });

    comp.cdRef.markForCheck();
  }

  rehydrateUiFromState(comp: any, _reason: string): void {
    try {
      // Guard: skip if the user has already clicked or bindings are frozen.
      if (comp.hasUserClicked() || comp.freezeOptionBindings()) return;

      this.clearAllOptionVisualState(comp);

      const qIndex = comp.resolveCurrentQuestionIndex();
      const saved = this.loadSavedSelections(qIndex);
      if (!saved.length) return;

      const savedByIndex = this.buildSavedByIndex(comp, saved, qIndex);
      if (savedByIndex.size === 0) return;

      const _res = this.questionResolution.resolveQuestionState(qIndex, { includeSelections: false });
      const wasPerfect = _res.fullyResolvedCorrect;

      // A perfect revisit is a TERMINAL state, so the correct set is
      // legitimately disclosable here — this is the one place the restore path
      // may ask for it. Null when no verdict was recorded (a revisit in a fresh
      // session), which the restore methods handle without touching the bank.
      const authorizedCorrect = wasPerfect
        ? authorizedCorrectTexts(this.quizService, qIndex, this.verdicts)
        : null;

      this.restoreOptionsToDisplay(comp, savedByIndex, wasPerfect, authorizedCorrect);
      if (!wasPerfect) this.unlockQuestionOptions(qIndex);
      this.restoreOptionBindings(comp, savedByIndex, wasPerfect, authorizedCorrect);
      this.applyFeedbackDisplay(comp, saved, savedByIndex, qIndex);

      if (comp.optionBindings()?.length) {
        comp.optionBindings.set(comp.optionBindings().map((b: OptionBindings) => ({ ...b, option: { ...b.option } })));
      }
      if (comp.rebuildShowFeedbackMapFromBindings) comp.rebuildShowFeedbackMapFromBindings();
      comp.cdRef?.markForCheck?.();
    } catch (err: unknown) {
      console.error('rehydrateUiFromState failed:', err);
    }
  }

  /** Clear all visual selection state on bindings and optionsToDisplay (clean slate). Extracted verbatim. */
  private clearAllOptionVisualState(comp: any): void {
    if (comp.optionBindings()?.length) {
      for (const b of comp.optionBindings()) {
        b.isSelected = false;
        b.checked = false;
        if (b.option) {
          b.option.selected = false;
          b.option.highlight = false;
          b.option.showIcon = false;
        }
      }
    }
    if (comp.optionsToDisplay?.length) {
      for (const opt of comp.optionsToDisplay) {
        opt.selected = false;
        opt.highlight = false;
        opt.showIcon = false;
      }
    }
    comp.cdRef?.markForCheck?.();
  }

  /**
   * Load the saved selections for a question: durable sel_Q* sessionStorage
   * first (cleanest source), falling back to the merged selection service only
   * when sel_Q* is empty (single-answer wrong-only clicks). Extracted verbatim.
   */
  private loadSavedSelections(qIndex: number): any[] {
    let saved: any[] = [];
    try {
      const raw = sessionStorage.getItem(SK_SEL_Q + qIndex);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          saved = parsed;
        }
      }
    } catch { /* ignore */ }
    if (saved.length === 0) {
      saved = this.selectedOptionService.getSelectedOptionsForQuestion(qIndex) ?? [];
    }
    return saved;
  }

  /**
   * Map saved selection records to binding positions (text-primary match, ID/
   * index fallback), keeping the sel:true entry when several records resolve to
   * the same position. Extracted verbatim.
   */
  private buildSavedByIndex(comp: any, saved: any[], qIndex: number): Map<number, any> {
    const savedByIndex = new Map<number, any>();
    for (const s of saved) {
      const sQIdx = (s as any).questionIndex ?? (s as any).qIdx ?? (s as any).questionIdx;
      if (sQIdx != null && Number(sQIdx) !== qIndex) continue;
      if ((s as any)?.selected === false && !(s as any)?.showIcon && !(s as any)?.highlight) continue;

      const sText = norm((s as any).text);
      const pos = this.resolveSavedBindingPosition(comp, s, sText);

      if (pos !== -1) {
        // Prefer the sel:true entry when multiple saved records resolve to the
        // same binding position (prev-click vs current-click with differing
        // displayIndex). Otherwise a prev-click (sel:false) found first wins.
        const existing = savedByIndex.get(pos);
        if (!existing) {
          savedByIndex.set(pos, s);
        } else if ((s as any)?.selected === true && (existing as any)?.selected !== true) {
          savedByIndex.set(pos, s);
        }
      }
    }
    return savedByIndex;
  }

  /**
   * Resolve a saved selection to a binding index: text match first (immune to
   * shuffled-ID/position drift), then real-ID, then displayIndex when the entry
   * has no text (legacy data). Extracted verbatim.
   */
  private resolveSavedBindingPosition(comp: any, s: any, sText: string): number {
    let pos = -1;
    if (sText && comp.optionBindings()?.length) {
      pos = comp.optionBindings().findIndex((b: OptionBindings) => {
        const bText = norm(b?.option?.text);
        return bText && bText === sText;
      });
    }

    if (pos === -1 && !sText) {
      const sId = (s as any).optionId;
      const sIdIsReal = sId != null && sId !== -1 && String(sId) !== '-1';
      if (sIdIsReal && comp.optionBindings()?.length) {
        pos = comp.optionBindings().findIndex((b: OptionBindings) => {
          const bId = b?.option?.optionId;
          const bIdIsReal = bId != null && bId !== -1 && String(bId) !== '-1';
          return bIdIsReal && String(sId) === String(bId);
        });
      }
      if (pos === -1) {
        const sIdx = (s as any).displayIndex ?? (s as any).index ?? (s as any).idx;
        if (sIdx != null && Number.isFinite(Number(sIdx))) {
          pos = Number(sIdx);
        }
      }
    }
    return pos;
  }

  /**
   * Restore optionsToDisplay visuals for a revisit: perfect -> highlight the
   * correct picks (others blank); imperfect -> clear every mark. Extracted verbatim.
   */
  private restoreOptionsToDisplay(
    comp: any,
    savedByIndex: Map<number, any>,
    wasPerfect: boolean,
    authorizedCorrect: ReadonlySet<string> | null
  ): void {
    if (!comp.optionsToDisplay?.length) return;
    for (const [idx, opt] of comp.optionsToDisplay.entries()) {
      const match = savedByIndex.get(idx);
      if (!opt) continue;

      if (!wasPerfect) {
        opt.selected = false;
        opt.highlight = false;
        opt.showIcon = false;
        continue;
      }

      const isCorrect = this.wasCorrectOnPerfectRevisit(opt, match, authorizedCorrect);
      if (isCorrect) {
        const isSelected = !!match?.selected;
        const isPreviouslyClicked = !isSelected && !!match?.showIcon;
        opt.selected = isSelected || isPreviouslyClicked;
        opt.highlight = isSelected || isPreviouslyClicked;
        opt.showIcon = isSelected || isPreviouslyClicked;
      } else {
        opt.selected = false;
        opt.highlight = false;
        opt.showIcon = false;
      }
    }
  }

  /**
   * Unlock all options for a question on partial/unanswered revisit so the user
   * can complete the remaining correct picks. Extracted verbatim.
   */
  private unlockQuestionOptions(qIndex: number): void {
    try {
      this.selectedOptionService.unlockAllOptionsForQuestion?.(qIndex);
      this.selectedOptionService.unlockQuestion?.(qIndex);
    } catch { /* ignore */ }
  }

  /**
   * Restore optionBindings for a revisit: imperfect -> reset to interactive;
   * perfect -> highlight correct picks, grey the rest, and lock. Extracted verbatim.
   */
  private restoreOptionBindings(
    comp: any,
    savedByIndex: Map<number, any>,
    wasPerfect: boolean,
    authorizedCorrect: ReadonlySet<string> | null
  ): void {
    if (!comp.optionBindings()?.length) return;
    for (const [idx, b] of comp.optionBindings().entries()) {
      const match = savedByIndex.get(idx);
      if (b.option) {
        if (!wasPerfect) {
          this.resetBindingToInteractive(comp, b, idx);
        } else {
          this.applyResolvedBindingState(b, match, authorizedCorrect);
        }
      }
      b.showFeedback = true;
    }
  }

  /**
   * Imperfect-revisit binding reset: clear selection flags + stale cssClasses,
   * restore interactivity, recompute disabled. Extracted verbatim.
   */
  private resetBindingToInteractive(comp: any, b: OptionBindings, idx: number): void {
    b.isSelected = false;
    b.option.selected = false;
    b.option.highlight = false;
    b.option.showIcon = false;
    // Clear stale cssClasses (e.g. `disabled-option:true` from a prior partial
    // state) so visuals match the cleared state.
    if (b.cssClasses) {
      b.cssClasses['selected'] = false;
      b.cssClasses['selected-option'] = false;
      b.cssClasses['correct-option'] = false;
      b.cssClasses['incorrect-option'] = false;
      b.cssClasses['highlighted'] = false;
      b.cssClasses['disabled-option'] = false;
      b.cssClasses['locked-option'] = false;
    }
    (b.option as any).active = true;
    b.disabled = comp.computeDisabledState(b.option, idx);
  }

  /**
   * Perfect-revisit binding state: highlight correct picks (active), grey the
   * incorrect (inactive), and lock the option. Extracted verbatim.
   */
  /**
   * Was this option one of the correct ones, on a question already answered
   * perfectly — without asking the answer key?
   *
   * Two authorized sources, in order:
   *
   *  1. The verdict's correct set. A perfect revisit is terminal, so the reveal
   *     is legitimately available (see authorizedCorrectTexts, which returns
   *     null anywhere else).
   *  2. The user's own remembered picks. "Perfect" means every correct option
   *     was selected and nothing else was, so on this path chosen IS correct.
   *     That makes the fallback exact rather than approximate, and it needs no
   *     verdict at all — which matters on a revisit in a fresh session, where
   *     nothing has been checked yet.
   *
   * Neither consults `option.correct`, so a wrong or absent flag in the bank
   * cannot change what the restored question looks like.
   */
  private wasCorrectOnPerfectRevisit(
    option: any,
    match: any,
    authorizedCorrect: ReadonlySet<string> | null
  ): boolean {
    if (authorizedCorrect) return authorizedCorrect.has(norm(option?.text ?? ''));
    return !!match?.selected || !!match?.showIcon;
  }

  private applyResolvedBindingState(
    b: OptionBindings,
    match: any,
    authorizedCorrect: ReadonlySet<string> | null
  ): void {
    const isCorrect = this.wasCorrectOnPerfectRevisit(b.option, match, authorizedCorrect);
    if (isCorrect) {
      const isSelected = !!match?.selected;
      const isPreviouslyClicked = !isSelected && !!match?.showIcon;
      b.isSelected = isSelected || isPreviouslyClicked;
      b.option.selected = isSelected || isPreviouslyClicked;
      b.option.highlight = isSelected || isPreviouslyClicked;
      b.option.showIcon = isSelected || isPreviouslyClicked;
      (b.option as any).active = true;
    } else {
      b.isSelected = false;
      b.option.selected = false;
      b.option.highlight = false;
      b.option.showIcon = false;
      (b.option as any).active = false;
    }
    // Lock on revisit so the user can't re-answer; also drives the grey look.
    b.disabled = true;
  }

  /**
   * Set the feedback anchor for the restored selection (the LAST clicked option)
   * and build the feedback-display config when absent. Extracted verbatim.
   */
  private applyFeedbackDisplay(comp: any, saved: any[], savedByIndex: Map<number, any>, qIndex: number): void {
    if (saved.length === 0) return;
    // reverse() finds the LAST selected option - where feedback should appear
    // (find() would return the lowest-index match, not the last clicked).
    const activeSelection = [...saved].reverse().find((s: any) => s?.selected === true)
      ?? [...saved].reverse().find((s: any) => s?.showIcon === true)
      ?? saved[saved.length - 1];

    const activeIdxRaw = (activeSelection as any).displayIndex ?? (activeSelection as any).index ?? (activeSelection as any).idx;
    const activeIdx = (activeIdxRaw != null && Number.isFinite(Number(activeIdxRaw))) ? Number(activeIdxRaw) : -1;

    if (activeIdx >= 0) {
      comp.lastFeedbackOptionId = activeIdx;
      comp.showFeedback.set(true);
    }

    if (!comp._feedbackDisplay) {
      this.buildFeedbackDisplay(comp, activeSelection, activeIdx, savedByIndex, qIndex);
    }
  }

  /**
   * Build comp._feedbackDisplay for the restored selection: resolve the target
   * binding, compute the feedback + correct messages, and assemble the config.
   * Extracted verbatim.
   */
  private buildFeedbackDisplay(comp: any, activeSelection: any, activeIdx: number, savedByIndex: Map<number, any>, qIndex: number): void {
    let targetIdx = activeIdx;
    if (targetIdx < 0) {
      for (const k of savedByIndex.keys()) {
        if (k > targetIdx) targetIdx = k;
      }
    }
    const targetBinding = targetIdx >= 0 ? comp.optionBindings()?.[targetIdx] : null;
    const cqForTarget = comp.currentQuestion();
    if (targetBinding && cqForTarget) {
      try {
        const lastSelectionOnly = [activeSelection] as any[];
        const feedbackText = this.feedbackService.buildFeedbackMessage(
          cqForTarget, lastSelectionOnly, false, false, qIndex, comp.optionsToDisplay
        ) || '';
        let correctMessage = '';
        try {
          correctMessage = this.feedbackService.setCorrectMessage(
            (comp.optionsToDisplay ?? []).filter((o: any) => o && typeof o === 'object'),
            cqForTarget
          );
        } catch (err: unknown) {
          console.error('SharedOptionBindingService.rehydrateUiFromState correctMessage resolution failed:', err);
        }
        comp._feedbackDisplay = {
          idx: targetIdx,
          optionId: targetBinding.option?.optionId,
          config: {
            feedback: feedbackText,
            showFeedback: true,
            correctMessage,
            selectedOption: targetBinding.option,
            options: comp.optionsToDisplay ?? [],
            question: cqForTarget,
            idx: targetIdx
          } as FeedbackProps
        };
      } catch (err: unknown) { console.error('rehydrateUiFromState feedback-display failed:', err); }
    }
  }

  buildSharedOptionConfig(comp: any, b: OptionBindings, i: number): SharedOptionConfig {
    const qIndex = comp.resolveCurrentQuestionIndex();
    const isMulti = this.resolveBuildIsMulti(comp, qIndex);

    const isActuallySelected = b.isSelected;

    const optionKey = this.optionService.keyOf(b.option, i);
    // AUTHORIZED KEYS ONLY. The `|| isOptionCorrect(b.option)` that used to sit
    // here made the local answer key a fallback for timeout painting, which
    // meant the reveal appeared to work while actually being computed in the
    // browser. The keys are populated from the expired verdict's
    // correctOptionTexts, so an empty set means "the reveal has not arrived" —
    // and painting nothing is the correct render for that moment.
    const showCorrectOnTimeout = comp.timerExpiredForQuestion()
      && comp.timeoutCorrectOptionKeys?.has(optionKey) === true;

    const shouldHighlight = this.resolveShouldHighlight(
      comp, b, i, qIndex, isMulti, isActuallySelected, showCorrectOnTimeout
    );

    return this.buildConfigObject(comp, b, i, qIndex, isActuallySelected, shouldHighlight);
  }

  // Determine multi-answer from AUTHORITATIVE question data, not just
  // comp.isMultiMode which can be wrong on refresh if question data
  // hasn't fully loaded into the component yet.
  private resolveBuildIsMulti(comp: any, qIndex: number): boolean {
    const authQ = this.quizService.questions?.[qIndex];
    const authCorrectCount = (authQ?.options ?? []).filter(
      (o: any) => isOptionCorrect(o)
    ).length;
    // DECLARED TYPE FIRST — the counted guess below survives only as the
    // fallback. `qIndex` is a DISPLAY index and `questions` is a getter that
    // returns shuffledQuestions while shuffle is active, so this reads the
    // question the user is actually looking at.
    // REMOVE THE COUNT IN /questions CONTENT CUTOVER.
    // MODE INPUTS STILL PROMOTE. Passing them as the FALLBACK argument meant a
    // declared type discarded them entirely, so a declared single-answer
    // question could no longer be forced multi by isMultiMode/multipleAnswer —
    // which flipped resolveShouldHighlight from the durable-click-set branch to
    // the live-binding branch and changed which options paint.
    // Declared type replaces the COUNT only; that is the Stage 10 goal.
    return comp.isMultiMode
      || this.quizService.multipleAnswer
      || resolveIsMultiAnswer(authQ, authCorrectCount > 1);
  }

  private resolveShouldHighlight(
    comp: any,
    b: OptionBindings,
    i: number,
    qIndex: number,
    isMulti: boolean,
    isActuallySelected: boolean,
    showCorrectOnTimeout: boolean
  ): boolean {
    if (isMulti && comp.hasUserClicked()) {
      // Hard Guard: For multi-answer live interaction, the durable click set
      // is the only authority for which options should highlight.
      const qIdx = comp.getActiveQuestionIndex?.() ?? qIndex;
      const durableSet: Set<number> | undefined = comp._multiSelectByQuestion?.get(qIdx);
      const isInDurableSet = durableSet ? durableSet.has(i) : false;
      return isInDurableSet || showCorrectOnTimeout;
    }
    if (!comp.hasUserClicked()) {
      // REFRESH PATH (both single & multi): Binding state is unreliable
      // because multiple init paths (generateOptionBindings, initializeFromConfig,
      // setOptionBindingsIfChanged) overwrite each other. Query the persisted
      // sel_Q* data directly from the service as the single source of truth.
      const matchEntry = this.findSavedSelectionMatch(qIndex, b, i);
      if (matchEntry) {
        // For multi-answer: only highlight options that were actually selected
        // (selected: true). For single-answer: also highlight previously-clicked
        // wrong options (selected: false but showIcon/highlight set).
        if (isMulti) {
          return !!(matchEntry as any).selected || showCorrectOnTimeout;
        }
        return !!(matchEntry as any).selected
          || !!(matchEntry as any).showIcon
          || !!(matchEntry as any).highlight
          || showCorrectOnTimeout;
      }
      return showCorrectOnTimeout;
    }
    // Single-answer live interaction
    return !!b.option.highlight || isActuallySelected || showCorrectOnTimeout;
  }

  // Read persisted sel_Q* sessionStorage FIRST (the cleanest source), falling
  // back to getSelectedOptionsForQuestion only if empty, then text-match the
  // binding (ID/index fallbacks only when the saved entry has no text).
  private findSavedSelectionMatch(qIndex: number, b: OptionBindings, i: number): any {
    let saved: any[] = [];
    try {
      const raw = sessionStorage.getItem(SK_SEL_Q + qIndex);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          saved = parsed;
        }
      }
    } catch { /* ignore */ }
    if (saved.length === 0) {
      saved = this.selectedOptionService.getSelectedOptionsForQuestion(qIndex) ?? [];
    }
    const bText = norm(b.option?.text);
    return saved.find((s: any) => {
      const sText = norm((s as any).text);
      // If saved entry has text, ONLY match by text
      if (sText) return bText && sText === bText;
      // Legacy fallback (no text on saved entry): displayIndex then optionId
      const sIdx = (s as any).displayIndex ?? (s as any).index ?? (s as any).idx;
      if (sIdx != null && Number(sIdx) === i) return true;
      const sId = (s as any).optionId;
      const bId = b.option?.optionId;
      const sIdReal = sId != null && sId !== -1 && String(sId) !== '-1';
      const bIdReal = bId != null && bId !== -1 && String(bId) !== '-1';
      return sIdReal && bIdReal && String(sId) === String(bId);
    });
  }

  private buildConfigObject(
    comp: any,
    b: OptionBindings,
    i: number,
    qIndex: number,
    isActuallySelected: boolean,
    shouldHighlight: boolean
  ): SharedOptionConfig {
    const isOnCorrectQuestion = comp.lastProcessedQuestionIndex === qIndex;
    const currentSelections = this.selectedOptionService.getSelectedOptionsForQuestion(qIndex) ?? [];

    const verifiedOption = {
      ...b.option,
      selected: isActuallySelected,
      highlight: shouldHighlight,
      showIcon: shouldHighlight
    };

    return {
      option: verifiedOption,
      idx: i,
      type: comp.resolveInteractionType(),
      isOptionSelected: isActuallySelected,
      // KNOWN correct only. This drives highlight treatment, where "not yet
      // authorized" and "wrong" both mean don't paint it as correct — so
      // narrowing tri-state to a boolean is safe HERE specifically, and is
      // written explicitly rather than left to truthiness.
      isAnswerCorrect: b.isCorrect === true,
      highlightCorrectAfterIncorrect: comp.highlightCorrectAfterIncorrect(),
      shouldResetBackground:
        (comp.shouldResetBackground() || (!isOnCorrectQuestion && currentSelections.length === 0))
        && !shouldHighlight,
      feedback: b.feedback ?? '',
      showFeedbackForOption: comp.showFeedbackForOption,
      optionsToDisplay: comp.optionsToDisplay,
      selectedOption: comp.selectedOption(),
      currentQuestion: comp.currentQuestion(),
      showFeedback: comp.showFeedback(),
      correctMessage: comp.correctMessage(),
      showCorrectMessage: !!comp.correctMessage(),
      explanationText: '',
      showExplanation: false,
      selectedOptionIndex: comp.selectedOptionIndex(),
      highlight: shouldHighlight
    };
  }

  getOptionBindings(comp: any, option: Option, idx: number, isSelected: boolean = false): OptionBindings {
    const selected = isSelected;

    return {
      option: {
        ...structuredClone(option),
        feedback: option.feedback ?? 'No feedback available',
      },
      index: idx,
      feedback: option.feedback ?? 'No feedback available',
      // UNKNOWN at construction, like every other binding constructor — see
      // OptionBindings.isCorrect. This one was missed in the first pass: the
      // others assign `binding.isCorrect =`, so a grep for that form skipped
      // this object literal.
      isCorrect: null,
      showFeedback: comp.showFeedback(),
      showFeedbackForOption: comp.showFeedbackForOption,
      highlightCorrectAfterIncorrect: comp.highlightCorrectAfterIncorrect(),
      // Visual state, not correctness. Nothing is highlighted until a verdict
      // authorizes it.
      highlightIncorrect: false,
      highlightCorrect: false,
      allOptions: comp.optionsToDisplay,
      type: comp.resolveInteractionType(),
      appHighlightOption: false,
      // Radio vs checkbox follows the question's resolved TYPE — the same value
      // assigned to `type` above. It used to be inferred by counting correct
      // options, which made a rendering decision depend on the answer key and
      // would turn every question into a radio group once options arrive
      // without correctness.
      appHighlightInputType: comp.resolveInteractionType() === 'multiple' ? 'checkbox' : 'radio',
      appHighlightReset: comp.shouldResetBackground(),
      appResetBackground: comp.shouldResetBackground(),
      optionsToDisplay: comp.optionsToDisplay,
      isSelected: selected,
      active: option.active ?? true,
      change: () => comp.handleOptionClick(option as SelectedOption, idx),
      disabled: comp.computeDisabledState(option, idx),
      ariaLabel: 'Option ' + (idx + 1),
      checked: selected
    };
  }

  getInlineFeedbackConfig(comp: any, b: OptionBindings, i: number): FeedbackProps | null {
    let config: FeedbackProps | null = null;

    if (feedbackAnchorMatches(comp._feedbackDisplay, b.option?.optionId, i) && comp._feedbackDisplay.config?.showFeedback) {
      config = comp._feedbackDisplay.config;
    } else if (comp.timerExpiredForQuestion()) {
      const cfg = comp.feedbackConfigs?.[b.option?.optionId ?? -1] ?? comp.feedbackConfigs?.[comp.keyOf(b.option, i)];
      if (cfg?.showFeedback) config = cfg;
    }

    if (!config) return null;

    const qIdx = comp.getActiveQuestionIndex();

    const feedbackQ = comp.currentQuestion() ?? comp.getQuestionAtDisplayIndex(qIdx);

    let correctIndicesArr: number[] = comp._correctIndicesByQuestion?.get(qIdx) ?? [];
    if (correctIndicesArr.length === 0) {
      const result = this.clickHandler.resolveCorrectIndices(
        feedbackQ, qIdx, comp.isMultiMode, comp.type
      );
      correctIndicesArr = result.correctIndices;
    }

    // Type from the declared type; correctIndicesArr stays as correctness.
    // REMOVE THE COUNT IN /questions CONTENT CUTOVER.
    const effectiveMultiMode = resolveIsMultiAnswer(
      feedbackQ, comp.isMultiMode || comp.type === 'multiple' || correctIndicesArr.length > 1
    );
    const durableSelected = comp._multiSelectByQuestion?.get(qIdx);

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

  syncSelectedFlags(comp: any): void {
    // Collision guard: when a binding has no real optionId, the fallback (array
    // index) can collide with another binding's real optionId (e.g. binding[0]
    // has optionId=1, binding[1] has no id so falls back to index 1 -> collision).
    const realIdOwner = new Map<number, number>();
    for (let i = 0; i < (comp.optionBindings()?.length ?? 0); i++) {
      const id = comp.optionBindings()[i].option.optionId;
      if (id != null && id !== -1) realIdOwner.set(Number(id), i);
    }

    for (let i = 0; i < (comp.optionBindings()?.length ?? 0); i++) {
      const b = comp.optionBindings()[i];
      const id = b.option.optionId;
      const numericId = (id != null && id !== -1) ? Number(id) : i;
      const hasRealId = id != null && id !== -1;
      const isCollision = !hasRealId && realIdOwner.has(numericId) && realIdOwner.get(numericId) !== i;

      let chosen = false;
      if (!isCollision) {
        chosen = Number.isFinite(numericId) && comp.selectedOptionMap.has(numericId);
        if (!chosen) {
          chosen = comp.selectedOptionHistory.some((h: any) => Number(h) === numericId);
        }
      }

      b.option.selected = chosen;
      b.isSelected = chosen;
    }
  }

  forceDisableAllOptions(comp: any): void {
    comp.forceDisableAll.set(true);
    for (const binding of comp.optionBindings() ?? []) {
      if (binding.option) binding.option.active = false;
    }
    comp.clickService?.updateBindingSnapshots(comp);
    for (const opt of comp.optionsToDisplay ?? []) {
      if (opt) opt.active = false;
    }
    comp.cdRef.markForCheck();
  }

  clearForceDisableAllOptions(comp: any): void {
    comp.forceDisableAll.set(false);
    for (const binding of comp.optionBindings() ?? []) {
      if (binding.option) {
        binding.option.active = true;
      }
    }

    for (const opt of comp.optionsToDisplay ?? []) {
      if (opt) opt.active = true;
    }

    try {
      const qIndex = comp.currentQuestionIndex;
      this.selectedOptionService.unlockQuestion(qIndex);
    } catch (err: unknown) {
      console.error('SharedOptionBindingService.clearForceDisableAllOptions unlockQuestion failed:', err);
    }

    comp.clickService?.updateBindingSnapshots(comp);
  }

  markRenderReady(comp: any, _reason: string = ''): void {
    const bindingsReady =
      Array.isArray(comp.optionBindings()) && comp.optionBindings().length > 0;

    const optionsReady =
      Array.isArray(comp.optionsToDisplay) && comp.optionsToDisplay.length > 0;

    if (bindingsReady && optionsReady) {
      comp.renderReady.set(true);
      comp.renderReadyChange.emit(true);
    }
  }

  // -- Inlined from OptionHydrationService --------------------------

  private toIdSet(
    saved: Array<{ optionId?: number | string; selected?: boolean }> | null | undefined
  ): Set<number | string> {
    const set = new Set<number | string>();
    if (!saved?.length) return set;
    for (const s of saved) {
      if ((s as any)?.selected === false) continue;
      const id = s?.optionId;
      if (id !== undefined && id !== null) set.add(id);
    }
    return set;
  }
}