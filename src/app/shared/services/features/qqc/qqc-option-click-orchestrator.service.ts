import { inject, Service } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { SK_DOT_CONFIRMED } from '../../../constants/session-keys';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { NextButtonStateService } from '../../state/next-button-state.service';
import { QuizService } from '../../data/quiz.service';
import { QuizShuffleService } from '../../flow/quiz-shuffle.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../selection-message/selection-message.service';
import { declaredIsMultiAnswer } from '../../../utils/question-type-authority';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

/**
 * Manages option click orchestration: canonical option building, multi-answer
 * selection tracking, correctness evaluation, and lock logic for QQC.
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Service()
export class QqcOptionClickOrchestratorService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly nextButtonStateService = inject(NextButtonStateService);
  private readonly quizService = inject(QuizService);
  private readonly quizShuffleService = inject(QuizShuffleService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly selectionMessageService = inject(SelectionMessageService);

  // ── remaining variables ─────────────────────────────────────────
  /**
   * Per-question multi-answer selection tracking.
   * Maps question index → set of selected option indices.
   */
  private _multiAnswerSelections = new Map<number, Set<number>>();

  /**
   * Computes a stable ID for an option, used for deduplication and matching.
   */
  getStableId(o: Option | SelectedOption, idx?: number): string | number {
    const effectiveIdx = idx ?? (o as any).index ?? (o as any).idx;
    return this.selectionMessageService.stableKey(o as Option, effectiveIdx);
  }

  /**
   * Applies local selection state for single/multi-answer questions.
   * Mutates the provided option arrays in place.
   */
  applyLocalSelectionState(params: {
    questionType: QuestionType | undefined;
    optionsNow: Option[];
    optionsToDisplay: Option[];
    evtIdx: number;
    checked: boolean;
    questionIndex: number;
  }): void {
    const { questionType, optionsNow, optionsToDisplay, evtIdx, checked, questionIndex } = params;

    if (questionType === QuestionType.SingleAnswer && checked === false) {
      for (const opt of optionsNow) {
        if (opt.selected) opt.selected = true;
      }
      if (Array.isArray(optionsToDisplay)) {
        for (const opt of optionsToDisplay) {
          if (opt.selected) opt.selected = true;
        }
      }
    } else {
      this.selectionMessageService.releaseBaseline(questionIndex);

      if (questionType === QuestionType.SingleAnswer) {
        for (const [i, opt] of optionsNow.entries()) {
          opt.selected = i === evtIdx ? (checked ?? true) : false;
        }
        if (Array.isArray(optionsToDisplay)) {
          for (const [i, opt] of optionsToDisplay.entries()) {
            opt.selected = i === evtIdx ? (checked ?? true) : false;
          }
        }
      } else {
        optionsNow[evtIdx].selected = checked ?? true;
        if (Array.isArray(optionsToDisplay)) {
          optionsToDisplay[evtIdx].selected = checked ?? true;
        }
      }
    }
  }

  /**
   * Determines if a question should use multi-answer selection logic.
   */
  isMultiForSelection(question: QuizQuestion | undefined): boolean {
    if (!question) return false;

    // A declared type decides alone. As an OR arm it did not: the local bank's
    // flags could still promote a declared single-answer question to multiple.
    const declared = declaredIsMultiAnswer(question);
    if (declared !== null) return declared;

    // REMOVE IN /questions CONTENT CUTOVER.
    return (question.options?.filter((o: any) => isOptionCorrect(o)).length ?? 0) > 1;
  }

  /**
   * Tracks multi-answer selections and scores if all correct are selected.
   * Returns whether all correct options are now selected.
   */
  trackMultiAnswerSelection(params: {
    questionIndex: number;
    evtIdx: number;
    checked: boolean;
    question: QuizQuestion;
  }): { allCorrectSelected: boolean; selections: Set<number> } {
    const { questionIndex, evtIdx, checked, question } = params;

    if (!this._multiAnswerSelections.has(questionIndex)) {
      this._multiAnswerSelections.set(questionIndex, new Set());
    }
    const selections = this._multiAnswerSelections.get(questionIndex)!;

    if (checked !== false) {
      selections.add(evtIdx);
    } else {
      selections.delete(evtIdx);
    }

    // PRISTINE-FIRST: Resolve correct indices from quizInitialState to avoid
    // stale/mutated correct flags on question.options.
    let correctIndices: number[] = [];
    try {
      let pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(question?.questionText);

      // Index-based fallback when question-text doesn't match canonical
      // (e.g., text drift between live data and quizInitialState).
      if (pristineCorrectTexts.size === 0 && this.quizService?.quizId) {
        const pristineQuiz = (this.quizService?.quizInitialState ?? [])
          .find((qz: any) => qz?.quizId === this.quizService?.quizId);
        const pristineOpts: any[] = pristineQuiz?.questions?.[questionIndex]?.options ?? [];
        pristineCorrectTexts = new Set(
          pristineOpts
            .filter((o: any) => isOptionCorrect(o))
            .map((o: any) => norm(o?.text))
            .filter((t: string) => !!t)
        );
      }

      for (const [i, o] of (question.options as any[]).entries()) {
        if (pristineCorrectTexts.has(norm(o?.text))) correctIndices.push(i);
      }
    } catch { /* ignore */ }

    // Fallback: use question.options directly
    if (correctIndices.length === 0) {
      correctIndices = question.options
        .map((o: any, i: number) => isOptionCorrect(o) ? i : -1)
        .filter((i: number) => i !== -1);
    }

    const allCorrectSelected = correctIndices.length > 0 &&
      correctIndices.every((ci: number) => selections.has(ci));

    return { allCorrectSelected, selections };
  }

  /**
   * Records per-click dot color tracking for the clicked option.
   */
  trackClickedOptionCorrectness(
    questionIndex: number,
    evtIdx: number,
    question: QuizQuestion | undefined
  ): boolean {
    const clickedOptData = question?.options?.[evtIdx];
    const clickedIsCorrect = isOptionCorrect(clickedOptData);

    const dotStatus = clickedIsCorrect ? 'correct' : 'wrong';
    this.selectedOptionService.lastClickedCorrectByQuestion.set(questionIndex, clickedIsCorrect);
    this.selectedOptionService.clickConfirmedDotStatus.set(questionIndex, dotStatus);
    try {
      sessionStorage.setItem(SK_DOT_CONFIRMED + questionIndex, dotStatus);
    } catch {}

    return clickedIsCorrect;
  }

  /**
   * Builds canonical options with consistent selection state from the service.
   * Returns a clean snapshot of all options with correct selected flags.
   */
  buildCanonicalOptions(params: {
    question: QuizQuestion;
    questionIndex: number;
    evtIdx: number;
    evtOpt: SelectedOption;
    checked: boolean;
  }): Option[] {
    const { question, questionIndex, evtIdx, evtOpt, checked } = params;
    const getStableId = (o: Option | SelectedOption, idx?: number) => this.getStableId(o, idx);

    const currentSelectedFromService =
      this.selectedOptionService.selectedOptionsMap?.get(questionIndex) ?? [];

    const canonicalOpts: Option[] = (question.options ?? []).map((o, i) => {
      const stableId = getStableId(o, i);
      const isSelected = currentSelectedFromService.some(sel => {
        const selId = sel.optionId;
        const oId = o.optionId;
        if (selId != null && oId != null && String(selId) !== '-1' && String(oId) !== '-1' && String(selId) === String(oId)) return true;
        return getStableId(sel, (sel as any).index ?? -1) === stableId;
      });

      return {
        ...o,
        optionId: (o.optionId != null && String(o.optionId) !== '-1') ? Number(o.optionId) : i,
        selected: isSelected
      };
    });

    // Enforce single-answer exclusivity canonically
    if (question.type === QuestionType.SingleAnswer) {
      for (const [i, opt] of canonicalOpts.entries()) {
        opt.selected = i === evtIdx;
      }
      if (evtOpt?.correct && canonicalOpts[evtIdx]) {
        canonicalOpts[evtIdx].selected = true;
        this.selectionMessageService._singleAnswerCorrectLock.add(questionIndex);
        this.selectionMessageService._singleAnswerIncorrectLock.delete(questionIndex);
      }
    } else if (canonicalOpts[evtIdx]) {
      canonicalOpts[evtIdx].selected = checked ?? true;
    }

    return canonicalOpts;
  }

  /**
   * Applies lock logic for the clicked option.
   * For multi-answer: only locks incorrect options.
   * For single-answer: locks clicked option; if correct, locks all.
   */
  applyOptionLocks(params: {
    questionIndex: number;
    evtOpt: SelectedOption;
    question: QuizQuestion;
    optionsToDisplay: Option[];
  }): void {
    const { questionIndex, evtOpt, question, optionsToDisplay } = params;

    try {
      const clickedIdNum = Number(evtOpt?.optionId ?? NaN);
      const isMultiAnswer = question.type === QuestionType.MultipleAnswer ||
        (question.options?.filter((o: any) => isOptionCorrect(o)).length ?? 0) > 1;

      if (Number.isFinite(clickedIdNum)) {
        if (!isMultiAnswer || !evtOpt?.correct) {
          this.selectedOptionService.lockOption(questionIndex, clickedIdNum);
        }
      }
      // Single-answer: when the correct option is clicked, lock ALL options so
      // incorrect ones display dark gray and disabled. Detect single-answer by
      // either question.type OR by correct-count <= 1 (resilient to missing type).
      const isSingleAnswer = question.type === QuestionType.SingleAnswer || !isMultiAnswer;
      if (isSingleAnswer && evtOpt?.correct) {
        const idSource = (optionsToDisplay?.length ? optionsToDisplay : question?.options) ?? [];
        const allIdsNum = idSource
          .map((o, i) => {
            const id = Number(o?.optionId);
            return Number.isFinite(id) && id !== -1 ? id : i;
          });
        this.selectedOptionService.lockMany(questionIndex, allIdsNum as number[]);
      }
    } catch (err: unknown) {
      console.error('QqcOptionClickOrchestratorService.applyOptionLocks lock logic failed:', err);
    }
  }

  /**
   * Computes whether all correct answers are selected.
   */
  computeCorrectness(params: {
    canonicalOpts: Option[];
    question: QuizQuestion;
    questionIndex: number;
    evtOpt: SelectedOption;
    isMultiForSelection: boolean;
  }): { allCorrect: boolean; enableNext: boolean; hasAnySelection: boolean } {
    const { canonicalOpts, question, questionIndex, evtOpt, isMultiForSelection } = params;
    const getStableId = (o: Option | SelectedOption, idx?: number) => this.getStableId(o, idx);

    const correctOpts = canonicalOpts.filter(o => !!o.correct);
    const selKeys = new Set(
      canonicalOpts.filter(o => o.selected).map((o, i) => getStableId(o, i))
    );
    const selectedCorrectCount = correctOpts.filter((o) => {
      const originalIdx = (question.options ?? []).findIndex(orig => orig === o);
      return selKeys.has(getStableId(o, originalIdx !== -1 ? originalIdx : -1));
    }).length;

    // For multi-answer, cross-check against RAW question data so a mutated
    // canonicalOpts with fewer correct flags than the ground truth can't
    // flip allCorrect=true prematurely (e.g. incâ†’correct where canonicalOpts
    // only marks 1 option as correct, giving selectedCorrectCount===1===correctOpts.length).
    let rawAllCorrect = true;
    if (isMultiForSelection) {
      try {
        const rawQs: any[] = this.quizService?.questions ?? [];
        const qText = norm(question?.questionText);
        const rawQ = qText
          ? rawQs.find((r: any) => norm(r?.questionText) === qText)
          : rawQs[questionIndex];
        if (rawQ && Array.isArray(rawQ.options)) {
          const rawCorrectTexts = rawQ.options
            .filter((o: any) => isOptionCorrect(o))
            .map((o: any) => norm(o?.text))
            .filter((t: string) => !!t);
          if (rawCorrectTexts.length > 0) {
            const selTexts = new Set(
              canonicalOpts.filter(o => o.selected).map((o: any) => norm(o?.text)).filter((t: string) => !!t)
            );
            rawAllCorrect = rawCorrectTexts.every((t: string) => selTexts.has(t));
          }
        }
      } catch { /* trust canonical */ }
    }
    const allCorrect =
      isMultiForSelection
        ? correctOpts.length > 0
          && selectedCorrectCount === correctOpts.length
          && rawAllCorrect
        : !!evtOpt?.correct;

    const hasAnySelection = canonicalOpts.some(o => o.selected);
    const enableNext = isMultiForSelection ? hasAnySelection : allCorrect;

    return { allCorrect, enableNext, hasAnySelection };
  }

  /**
   * Checks if an option is locked (already clicked) by numeric ID.
   * Returns true if the click should be blocked.
   */
  isOptionLocked(questionIndex: number, optionId: number | undefined): boolean {
    try {
      const lockIdNum = Number(optionId);
      if (Number.isFinite(lockIdNum) && this.selectedOptionService.isOptionLocked(questionIndex, lockIdNum)) {
        return true;
      }
    } catch (err: unknown) {
      console.error('QqcOptionClickOrchestratorService.isOptionLocked lock check failed:', err);
    }
    return false;
  }

  /**
   * Resets multi-answer selections for a question (for use on question change).
   */
  resetSelectionsForQuestion(questionIndex: number): void {
    this._multiAnswerSelections.delete(questionIndex);
  }

  /**
   * Clears all tracked multi-answer selections.
   */
  resetAllSelections(): void {
    this._multiAnswerSelections.clear();
  }

  /**
   * Resolves the pristine (pre-shuffle) question for the current index.
   * Uses shuffle mapping first, then falls back to text-based lookup.
   * Extracted from onOptionClicked post-click RAF block (lines 2296â€“2317).
   */
  resolvePristineQuestion(params: {
    quizId: string;
    questionText: string | undefined;
  }): { origIdx: number | null; pristine: QuizQuestion | null } {
    const qIdx = this.quizService.getCurrentQuestionIndex();

    let origIdx = this.quizShuffleService.toOriginalIndex(params.quizId, qIdx);
    let pristine = (origIdx !== null) ? this.quizService.getPristineQuestion(origIdx) : null;

    // Try to find origIdx by question text if mapping fails
    if (!pristine && params.questionText) {
      const canonical = this.quizService.quizDataLoader.getCanonicalQuestions(params.quizId);
      const normalize = (s: string) => s.replace(/\s/g, '').toLowerCase();
      const foundIdx = canonical.findIndex(q => normalize(q.questionText) === normalize(params.questionText!));
      if (foundIdx !== -1) {
        origIdx = foundIdx;
        pristine = canonical[foundIdx];
      }
    }

    return { origIdx, pristine };
  }

  /**
   * Performs the post-click RAF tasks: resolves pristine question,
   * generates feedback text, runs post-click tasks, handles core
   * selection, marks bindings selected, and refreshes feedback.
   * Extracted from onOptionClicked RAF block (lines 2292â€“2328).
   */
  async performPostClickRafTasks(params: {
    idx: number;
    evtOpt: SelectedOption | undefined;
    evtIdx: number;
    question: QuizQuestion;
    event: { option: SelectedOption | null; index: number; checked: boolean };
    quizId: string;
    generateFeedbackText: (q: QuizQuestion) => Promise<string>;
    postClickTasks: (opt: SelectedOption, idx: number, checked: boolean, wasPreviouslySelected: boolean, questionIndex: number) => Promise<void>;
    handleCoreSelection: (ev: { option: SelectedOption; index: number; checked: boolean }, idx: number) => void;
    markBindingSelected: (opt: Option) => void;
    refreshFeedbackFor: (opt: Option) => void;
  }): Promise<void> {
    const resolvedQuizId = params.quizId || 'dependency-injection';

    // Resolve pristine question (for potential correctness validation)
    this.resolvePristineQuestion({
      quizId: resolvedQuizId,
      questionText: params.question?.questionText
    });

    await params.generateFeedbackText(params.question);
    await params.postClickTasks(params.evtOpt as SelectedOption, params.evtIdx, true, false, params.idx);
    if (params.event.option) {
      params.handleCoreSelection(
        params.event as { option: SelectedOption; index: number; checked: boolean },
        params.idx
      );
    }
    if (params.evtOpt) params.markBindingSelected(params.evtOpt);
    params.refreshFeedbackFor(params.evtOpt as Option);
  }

  /**
   * Applies next-button state and answered/selection flags after correctness is computed.
   */
  applyCorrectnessState(params: {
    enableNext: boolean;
    isMultiForSelection: boolean;
  }): void {
    if (params.enableNext) {
      if (params.isMultiForSelection) {
        this.nextButtonStateService.forceEnable(800);
      } else {
        this.nextButtonStateService.setNextButtonState(true);
      }
    } else {
      this.nextButtonStateService.setNextButtonState(false);
    }
    this.quizStateService.setAnswered(params.enableNext);
    this.quizStateService.setAnswerSelected(params.enableNext);
    this.selectedOptionService.setAnswered(params.enableNext);
  }

  /**
   * Builds the selected-options set for highlighting from canonical options.
   */
  buildSelectedKeysSet(canonicalOpts: Option[]): Set<string | number> {
    return new Set(
      canonicalOpts.filter(o => o.selected).map((o, i) => this.getStableId(o, i))
    );
  }

  /**
   * Performs the full synchronous click orchestration flow:
   * builds options snapshot, applies selection state, persists selection,
   * tracks multi-answer, tracks correctness, builds canonical options,
   * applies locks, emits selection message, and computes correctness.
   *
   * Returns all computed results for the component to apply to its state.
   */
  performSynchronousClickFlow(params: {
    question: QuizQuestion;
    questionIndex: number;
    evtIdx: number;
    evtOpt: SelectedOption;
    checked: boolean;
    optionsToDisplay: Option[];
    currentQuestionOptions: Option[] | undefined;
    totalQuestions: number;
    msgTok: number;
  }): {
    optionsNow: Option[];
    canonicalOpts: Option[];
    selectedKeysSet: Set<string | number>;
    isMultiForSelection: boolean;
    allCorrect: boolean;
    enableNext: boolean;
    hasAnySelection: boolean;
    msgTok: number;
  } {
    const { question, questionIndex, evtIdx, evtOpt, checked, optionsToDisplay, totalQuestions } = params;
    let msgTok = params.msgTok;

    // Build a mutable snapshot of options
    const optionsNow: Option[] =
      optionsToDisplay?.map(o => ({ ...o })) ??
      params.currentQuestionOptions?.map(o => ({ ...o })) ??
      [];

    // Apply local selection state
    this.applyLocalSelectionState({
      questionType: question?.type,
      optionsNow,
      optionsToDisplay,
      evtIdx,
      checked,
      questionIndex
    });

    const isMultiForSelection = this.isMultiForSelection(question);

    // Persist selection
    this.persistClickSelection(evtOpt, evtIdx, questionIndex, isMultiForSelection);

    // Track multi-answer scoring
    this.applyMultiAnswerScoring(question, questionIndex, evtIdx, checked, isMultiForSelection);

    // Track per-click dot color
    this.trackClickedOptionCorrectness(questionIndex, evtIdx, question);

    // Build canonical options
    const canonicalOpts = this.buildCanonicalOptions({
      question,
      questionIndex,
      evtIdx,
      evtOpt,
      checked
    });

    // Apply option locks
    this.applyOptionLocks({
      questionIndex,
      evtOpt,
      question,
      optionsToDisplay
    });

    const selectedKeysSet = this.buildSelectedKeysSet(canonicalOpts);

    // Emit selection message
    msgTok = msgTok + 1;
    this.emitSelectionMessage({
      idx: questionIndex,
      totalQuestions,
      questionType: question?.type,
      optionsNow,
      canonicalOpts,
      msgTok
    });

    // Compute correctness
    const { allCorrect, enableNext, hasAnySelection } = this.computeCorrectness({
      canonicalOpts,
      question,
      questionIndex,
      evtOpt,
      isMultiForSelection
    });

    this.applyCorrectnessWithLockOverride(questionIndex, enableNext, isMultiForSelection);

    return {
      optionsNow,
      canonicalOpts,
      selectedKeysSet,
      isMultiForSelection,
      allCorrect,
      enableNext,
      hasAnySelection,
      msgTok
    };
  }

  // Persist the clicked selection (best-effort).
  private persistClickSelection(
    evtOpt: SelectedOption,
    evtIdx: number,
    questionIndex: number,
    isMultiForSelection: boolean
  ): void {
    try {
      const selectionToPersist = { ...evtOpt, index: evtIdx };
      this.selectedOptionService.setSelectedOption(selectionToPersist, questionIndex, undefined, isMultiForSelection);
    } catch (err: unknown) {
      console.error('QqcOptionClickOrchestratorService.performSynchronousClickFlow selection-persist failed:', err);
    }
  }

  // Track multi-answer selection and score directly once all correct are picked.
  private applyMultiAnswerScoring(
    question: QuizQuestion,
    questionIndex: number,
    evtIdx: number,
    checked: boolean,
    isMultiForSelection: boolean
  ): void {
    if (isMultiForSelection && question?.options) {
      const { allCorrectSelected } = this.trackMultiAnswerSelection({
        questionIndex,
        evtIdx,
        checked,
        question
      });

      if (allCorrectSelected) {
        this.quizService.scoreDirectly(questionIndex, true, true);
      }
    }
  }

  // Apply correctness state to services. When the question is already
  // locked (e.g. timer-expired auto-resolution), force enableNext=true so
  // a post-timeout click can't accidentally disable a Next button that's
  // already been enabled by the timeout pathway.
  private applyCorrectnessWithLockOverride(
    questionIndex: number,
    enableNext: boolean,
    isMultiForSelection: boolean
  ): void {
    let effectiveEnableNext = enableNext;
    try {
      if (this.selectedOptionService.isQuestionLocked?.(questionIndex)) {
        effectiveEnableNext = true;
      }
    } catch { /* ignore */ }
    this.applyCorrectnessState({ enableNext: effectiveEnableNext, isMultiForSelection });
  }

  /**
   * Emits selection message from a click event.
   */
  emitSelectionMessage(params: {
    idx: number;
    totalQuestions: number;
    questionType: QuestionType | undefined;
    optionsNow: Option[];
    canonicalOpts: Option[];
    msgTok: number;
  }): void {
    this.selectionMessageService.setOptionsSnapshot(params.canonicalOpts);
    this.selectionMessageService.emitFromClick({
      index: params.idx,
      totalQuestions: params.totalQuestions,
      questionType: params.questionType ?? QuestionType.SingleAnswer,
      options: params.optionsNow,
      canonicalOptions: params.canonicalOpts as any[],
      token: params.msgTok
    });
  }
}