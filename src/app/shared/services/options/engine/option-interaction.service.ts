import { Service, inject } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { SK_DOT_CONFIRMED, SK_MULTI_PERFECT } from '../../../constants/session-keys';
import { writeSessionString } from '../../../utils/session-storage';

import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { TopicQuizDotVerdictSyncService } from '../../features/verdict/dot-verdict-sync.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../../features/selection-message/selection-message.service';
import { TimerService } from '../../features/timer/timer.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

export interface OptionInteractionState {
  optionBindings: OptionBindings[];
  optionsToDisplay: Option[];
  currentQuestionIndex: number;
  selectedOptionHistory: (number | string)[];
  selectedOptionMap: Map<number | string, boolean>;
  disabledOptionsPerQuestion: Map<number, Set<number>>;
  correctClicksPerQuestion: Map<number, Set<number>>;
  feedbackConfigs: { [key: string]: FeedbackProps };
  showFeedbackForOption: { [key: string]: boolean };
  lastFeedbackOptionId: number | string;
  lastFeedbackQuestionIndex: number;
  lastClickedOptionId: number | string | null;
  lastClickTimestamp: number | null;
  hasUserClicked: boolean;
  freezeOptionBindings: boolean;
  showFeedback: boolean;
  disableRenderTrigger: number;
  type: 'single' | 'multiple';
  currentQuestion: QuizQuestion | null;
  showExplanationChange: any;
  explanationToDisplayChange: any;
}

/**
 * Values resolved by the first phase of a click (resolveClickContext) and
 * threaded through the remaining phases. Splitting handleOptionClick into
 * phases keeps the public method tiny while preserving the exact original
 * order of operations.
 */
interface ClickContextBase {
  qIdx: number;
  isPristineCorrect: (o: any) => boolean;
  targetKey: number;
  targetCompositeKey: string;
  isMultipleMode: boolean;
}

/** ClickContextBase plus the selection-update values from the second phase. */
interface ClickContext extends ClickContextBase {
  question: QuizQuestion | null;
  questionOptions: any[];
  isCurrentlySelected: boolean;
  futureSelection: SelectedOption[];
  futureKeys: Set<number>;
  newState: boolean;
  mockEvent: any;
}

@Service()
export class OptionInteractionService {
  // ── injects ─────────────────────────────────────────────────────
  private quizService = inject(QuizService);
  private verdicts = inject(QuestionVerdictService);
  private dotVerdictSync = inject(TopicQuizDotVerdictSyncService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);
  private timerService = inject(TimerService);

  // ── public methods ──────────────────────────────────────────────

  /**
   * Main handler for option content clicks
   */
  handleOptionClick(
    binding: OptionBindings,
    index: number,
    event: any,
    state: OptionInteractionState,
    getQuestionAtDisplayIndex: (idx: number) => QuizQuestion | null,
    emitExplanation: (idx: number, skipGuard?: boolean) => void,
    updateOptionAndUI: (b: OptionBindings, i: number, ev: any, ctx?: any) => void
  ): void {
    // Three phases, exact original order preserved: resolve the click context
    // (index, correctness, type — may early-return on the multi-deselect guard),
    // compute the selection update (future selection/keys, mock event), then
    // apply all effects (persist, commit, highlight, timer, scoring, feedback,
    // UI update, message).
    const base = this.resolveClickContext(binding, index, event, state);
    if (!base) return;
    const ctx = this.computeSelectionUpdate(base, binding, index, state, getQuestionAtDisplayIndex);

    // SUBMIT BEFORE EVALUATE. Phase 2 has produced the complete new selection
    // (`ctx.futureSelection`); phase 3 is what runs the correctness-dependent
    // effects. Recording the verdict here is what makes those effects able to
    // read a real verdict instead of an `idle` one — the ordering bug that
    // forced the temporary `.correct` fallbacks in 9A/9B.
    this.submitSelectionForVerdict(ctx);

    this.applyClickEffects(ctx, binding, index, state, emitExplanation, updateOptionAndUI);
  }

  /**
   * Was the CLICKED option correct, per the recorded verdict?
   *
   * Null when the option carries no verdict — the caller then falls back.
   * Distinct from allCorrectFromVerdict: this asks about ONE option the user
   * selected, not whether the question is complete.
   */
  private clickedCorrectFromVerdict(question: QuizQuestion | null, clickedOption: any): boolean | null {
    const quizId = (this.quizService as any)?.quizId as string | undefined;
    const questionText = question?.questionText;
    const optionText = clickedOption?.text as string | undefined;
    if (!quizId || !questionText || !optionText) return null;
    return this.verdicts.verdictForOption(quizId, questionText, optionText);
  }

  /**
   * Has every correct option been selected, according to the verdict?
   *
   * Returns null when no verdict exists, so the caller can fall back rather
   * than mistake "unknown" for "not complete".
   *
   * Read-only, and safe here because phase 3 runs after the submission.
   */
  private allCorrectFromVerdict(question: QuizQuestion | null): boolean | null {
    const quizId = (this.quizService as any)?.quizId as string | undefined;
    const questionText = question?.questionText;
    if (!quizId || !questionText) return null;

    const state = this.verdicts.verdictFor(quizId, questionText);
    if (state.phase === 'resolved') return state.isResolvedCorrect === true;
    if (state.phase === 'incomplete') return false;
    return null;   // idle | checking | expired | error → caller decides
  }

  /**
   * Hand the now-authoritative selection to the single submission owner.
   *
   * OWNERSHIP: `SelectedOptionService.setUiSelectedTextsForQuestion()` remains
   * the only path to `QuestionVerdictService.checkAnswer()`. This does not call
   * the verdict service directly, so there is exactly one submission path.
   *
   * DUPLICATE PREVENTION: that method early-returns when the text set is
   * unchanged, so the later `ngDoCheck` sync — which publishes the same set —
   * becomes a no-op rather than a second submission.
   *
   * The revisit snapshot is unioned in for the same reason the component does
   * it: on a revisit the live bindings alone do not carry the first-visit
   * picks, and a set that differs from what `ngDoCheck` will publish would
   * defeat the equality guard and cause a duplicate submission.
   *
   * Selection RULES are untouched — this only reads the selection phase 2
   * already computed.
   */
  private submitSelectionForVerdict(ctx: ClickContext): void {
    try {
      const texts: string[] = [];
      for (const selected of ctx.futureSelection ?? []) {
        const text = (selected as any)?.text;
        if (typeof text === 'string' && text.length > 0) texts.push(text);
      }

      const revisit = this.selectedOptionService.getRevisitDisplayTexts(ctx.qIdx);
      if (revisit) texts.push(...revisit);

      this.selectedOptionService.setUiSelectedTextsForQuestion(ctx.qIdx, texts);
    } catch {
      // Never let verdict submission break the click. A missing verdict leaves
      // the migrated readers on their documented fallback.
    }
  }

  // ── click phases ────────────────────────────────────────────────

  /**
   * Phase 1 — resolve the click context: normalize bindings, resolve the active
   * display index, build the pristine-correctness delegate, mark interaction,
   * stop propagation, derive the target keys + early dot status, and resolve the
   * single/multi type. Returns null to abort when the multi-answer guard fires
   * (preventing deselection of a correct answer). Order is identical to the
   * original inline head of handleOptionClick.
   */
  private resolveClickContext(
    binding: OptionBindings,
    index: number,
    event: any,
    state: OptionInteractionState
  ): ClickContextBase | null {
    // state.optionBindings may arrive as a signal function (-clean) or plain
    // array (-main); normalize to an array on the state object.
    this.normalizeStateOptionBindings(state);

    // The caller seeds state.currentQuestionIndex from the URL-authoritative
    // getActiveQuestionIndex(); resolve the active DISPLAY index from it.
    const qIdx = this.resolveActiveDisplayIndex(state);

    // Thin delegate: resolve pristine correctness from quizInitialState (TEXT
    // matching, shuffle-safe), capturing qIdx + state.
    const isPristineCorrect = (o: any): boolean =>
      this.isPristineCorrectFor(o, qIdx, state);

    this.quizStateService.markUserInteracted(qIdx);
    if (event && event.stopPropagation) event.stopPropagation();

    const getEffectiveId = (o: any, i: number) => (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;
    const targetKey = getEffectiveId(binding.option, index);
    // Composite identity (id|displayIndex): optionId alone can collide when
    // loader fallbacks produce duplicate ids; keep each position distinct.
    const targetCompositeKey = `${targetKey}|${index}`;

    // DOT CORRECTNESS IS NO LONGER DECIDED HERE.
    //
    // This used to read `isPristineCorrect(binding.option)` and stamp the dot
    // immediately, which is only possible while the answer key is in the
    // browser. Phase 1 runs BEFORE the selection is submitted, so there is no
    // verdict to consult yet — the write moves to phase 3, after
    // `submitSelectionForVerdict`, and is skipped entirely while the verdict is
    // still unknown. A pending check paints no correctness.
    //
    // The scoring service's per-click record is a separate concern (10I) and
    // still runs on click.
    this.recordCorrectClickForScoring(qIdx, binding, isPristineCorrect);

    const correctCountInBindings = this.resolveCorrectCountInBindings(state);
    const pristineCorrectCount = this.resolvePristineCorrectCount(correctCountInBindings, qIdx, state);
    const isMultipleMode = this.resolveIsMultipleMode(state, correctCountInBindings, pristineCorrectCount);

    // Guard: prevent deselection of correct answers in multiple.
    if (isMultipleMode && binding.isSelected && isPristineCorrect(binding.option)) {
      if (event && event.preventDefault) event.preventDefault();
      return null;
    }

    return {
      qIdx, isPristineCorrect, targetKey, targetCompositeKey, isMultipleMode
    };
  }

  /**
   * Phase 2 — compute the selection update: resolve the simulated selection,
   * detect already-selected, build the future selection + keys, normalize
   * displayIndex, and derive the new UI-state basics (newState, mockEvent).
   * Returns the full ClickContext for the effects phase. Order is identical to
   * the original inline STATE SETUP / UPDATE UI STATE BASICS sections.
   */
  private computeSelectionUpdate(
    base: ClickContextBase,
    binding: OptionBindings,
    index: number,
    state: OptionInteractionState,
    getQuestionAtDisplayIndex: (idx: number) => QuizQuestion | null
  ): ClickContext {
    const { qIdx, targetKey, targetCompositeKey, isMultipleMode } = base;

    const question = getQuestionAtDisplayIndex(qIdx);
    const questionOptions = Array.isArray(question?.options) ? question.options : [];

    let simulatedSelection = this.resolveSimulatedSelection(qIdx, state);
    const existingIdx = this.findExistingSelectionIndex(simulatedSelection, targetCompositeKey);
    const isCurrentlySelected = (existingIdx !== -1);

    let futureSelection = this.buildFutureSelection(
      isCurrentlySelected, simulatedSelection, existingIdx, binding, targetKey, qIdx, index, isMultipleMode
    );
    const futureKeys = this.buildFutureKeysAndSyncMap(futureSelection, state);

    // Back-fill displayIndex on every entry so persisted entries rehydrate.
    futureSelection = this.normalizeSelectionDisplayIndices(futureSelection, state);
    simulatedSelection = [...futureSelection];

    const newState = !isCurrentlySelected;
    const mockEvent = this.buildMockEvent(isMultipleMode, newState, binding, index);

    return {
      ...base, question, questionOptions, isCurrentlySelected,
      futureSelection, futureKeys, newState, mockEvent
    };
  }

  /**
   * Phase 3 — apply all click effects in the original order: selection history,
   * dot-persist, durable commit + answered flag, highlight sync, timer stop,
   * scoring/FET (unshuffled), feedback anchoring, the final state flags, the UI
   * update callback, and the selection message.
   */
  private applyClickEffects(
    ctx: ClickContext,
    binding: OptionBindings,
    index: number,
    state: OptionInteractionState,
    emitExplanation: (idx: number, skipGuard?: boolean) => void,
    updateOptionAndUI: (b: OptionBindings, i: number, ev: any, ctx?: any) => void
  ): void {
    const {
      qIdx, isPristineCorrect, targetKey,
      isMultipleMode, question, questionOptions, isCurrentlySelected,
      futureSelection, futureKeys, newState, mockEvent
    } = ctx;

    this.updateSelectionHistory(state, newState, index);

    // DOT CORRECTNESS, from the verdict submitted moments ago in phase 2.
    // Null while the check is still in flight, in which case nothing is written
    // and the dot keeps whatever it showed — no correctness is invented.
    const dotStatus = this.recordDotStatusFromVerdict(qIdx, binding, question);

    // COMPLETION comes from the verdict recorded moments ago, in this same
    // click, before these effects ran. `isResolvedCorrect === true` means every
    // correct option is selected — the SUPERSET rule — which is exactly what
    // the index-intersection below computed, and it drives dot status, the
    // completion branch and the timer-stop argument.
    //
    // TEMPORARY FALLBACK: the local computation still runs when no verdict was
    // recorded (submission failed, or a caller reached phase 3 without one).
    // Removed once the timeout paths move in STAGE 9D, which is what still
    // needs the local read.
    const verdictAllCorrect = this.allCorrectFromVerdict(question);
    const correctIndicesSet = this.resolveCorrectIndicesSet(question, state, questionOptions);
    const allCorrectFound = verdictAllCorrect
      ?? (correctIndicesSet.size > 0 && [...correctIndicesSet].every(i => futureKeys.has(i)));

    // DEFERRED DOT PERSIST: single-answer persists immediately; multi-answer
    // persists 'correct' only when ALL correct are selected (a partial 'correct'
    // makes the refresh fallback lock auto-highlight an unselected answer).
    this.persistDotConfirmedStatus(isMultipleMode, allCorrectFound, dotStatus, qIdx);

    this.commitSelectionState(qIdx, futureSelection, futureKeys, state);

    // INDEX-MODEL REWRITE (Phase 2): record the durable per-display-index
    // answered flag on completion so the post-nav re-derivation can re-enable
    // Next on revisit (the selection stores are cleared on revisit).
    if (!isMultipleMode || allCorrectFound) {
      this.quizStateService.markQuestionAnswered(qIdx);
    }

    this.applyHighlightSync(state, index, qIdx, targetKey, isMultipleMode, futureKeys);

    const isShuffleActive = (this.quizService as any)?.isShuffleEnabled?.() &&
      (this.quizService as any)?.shuffledQuestions?.length > 0;

    this.stopTimerIfAnswerCorrect(isShuffleActive, isMultipleMode, isPristineCorrect, binding.option, allCorrectFound, question);

    // In shuffled mode scoring/FET is handled by the SOC, so OIS must not score
    // or emit there. The pristine multi-answer probe guards against bindings
    // showing only 1 correct due to mutation.
    const pristineIsMultiAnswer = this.resolvePristineIsMultiAnswer(question, qIdx, state);
    this.scoreAndEmitIfUnshuffledPerfect(
      isShuffleActive, allCorrectFound, isMultipleMode, pristineIsMultiAnswer,
      qIdx, state, emitExplanation
    );

    this.updateFeedbackAnchor(state, isCurrentlySelected, index, futureKeys);
    this.applyFeedbackAnchoring(state, targetKey, index, binding);

    state.lastClickedOptionId = index;
    state.hasUserClicked = true;
    state.disableRenderTrigger++;

    // CALL UPDATE with THE AUTHORITATIVE CONTEXT (state)
    (updateOptionAndUI as any)(binding, index, mockEvent, state);

    this.syncMessageAfterClick(state, qIdx, isMultipleMode, futureKeys);
  }

  /**
   * Compute the next selection list for a click. Deselecting an already-
   * selected option drops it; otherwise build the new selection entry. In
   * single-answer mode the result is just the new option (only one selected
   * at a time); in multi-answer mode it is appended to the existing
   * selections. Pure — no side effects. Extracted verbatim from
   * handleOptionClick.
   *
   * NOTE (single-answer): we do NOT clearSelectionsForQuestion here — that
   * would wipe _selectionHistory and sel_Q* in sessionStorage, erasing the
   * "previously clicked" record for prior wrong clicks. `[newOpt]` already
   * enforces single-answer "only one currently selected" semantics in the
   * live map; history accumulation is handled downstream.
   */
  private buildFutureSelection(
    isCurrentlySelected: boolean,
    simulatedSelection: SelectedOption[],
    existingIdx: number,
    binding: OptionBindings,
    targetKey: number | string,
    qIdx: number,
    index: number,
    isMultipleMode: boolean
  ): SelectedOption[] {
    if (isCurrentlySelected) {
      return simulatedSelection.filter((_, i) => i !== existingIdx);
    }
    const newOpt: SelectedOption = {
      ...binding.option,
      optionId: targetKey,
      selected: true,
      questionIndex: qIdx,
      index: index,
      displayIndex: index
    } as SelectedOption;
    if (!isMultipleMode) {
      return [newOpt];
    }
    return [...simulatedSelection, newOpt];
  }

  /**
   * Resolve the display-index set for the future selection and mirror it onto
   * state.selectedOptionMap. Each selection entry's display index is taken
   * directly when present, else recovered by matching optionId/text against
   * the current bindings (then optionsToDisplay). Returns the resolved index
   * set and clears+repopulates selectedOptionMap by effective id. Extracted
   * verbatim from handleOptionClick (capture-free getEffectiveId redefined).
   */
  private buildFutureKeysAndSyncMap(
    futureSelection: SelectedOption[],
    state: OptionInteractionState
  ): Set<number> {
    const getEffectiveId = (o: any, i: number) =>
      (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;
    const futureKeys = new Set<number>();
    for (const s of futureSelection) {
      const sId = s.optionId;
      const sText = norm(s.text);
      let idx = s.displayIndex ?? s.index ?? s.idx;

      if (idx === undefined || idx === null || idx === -1 || isNaN(Number(idx))) {
        const foundIdx = state.optionBindings.findIndex(b => {
          if (b.option === s) return true;
          const bId = b.option?.optionId;
          if (sId != null && sId !== -1 && bId != null && bId !== -1 && String(sId) === String(bId)) return true;
          return !!sText && norm(b.option?.text) === sText;
        });
        if (foundIdx !== -1) idx = foundIdx;
        else {
          const oIdx = state.optionsToDisplay.findIndex(o => {
            if (o === s) return true;
            if (sId != null && sId !== -1 && o.optionId != null && o.optionId !== -1 && String(sId) === String(o.optionId)) return true;
            return !!sText && norm(o.text) === sText;
          });
          if (oIdx !== -1) idx = oIdx;
        }
      }
      if (idx !== undefined && idx !== null && idx !== -1 && !isNaN(Number(idx))) {
        futureKeys.add(Number(idx));
      }
    }

    state.selectedOptionMap.clear();
    for (const k of futureKeys) {
      const b = state.optionBindings[k];
      const eid = b ? getEffectiveId(b.option, k) : k;
      state.selectedOptionMap.set(eid, true);
    }
    return futureKeys;
  }

  /**
   * Unshuffled single-answer "perfect" scoring + FET emission. When the
   * clicked answer fully resolves the question correctly (and it's not a
   * multi-answer question), record the score and emit the explanation. In
   * shuffled mode this is a no-op — the SOC owns scoring/FET there, using
   * authoritative pristine logic. Terminal side-effect; extracted verbatim.
   */
  private scoreAndEmitIfUnshuffledPerfect(
    isShuffleActive: boolean,
    allCorrectFound: boolean,
    isMultipleMode: boolean,
    pristineIsMultiAnswer: boolean,
    qIdx: number,
    state: OptionInteractionState,
    emitExplanation: (idx: number, skipGuard?: boolean) => void
  ): void {
    if (isShuffleActive) return;
    let scoreFired = false;
    if (allCorrectFound && !isMultipleMode && !pristineIsMultiAnswer) {
      // SINGLE-ANSWER resolved — the gate is `!isMultipleMode &&
      // !pristineIsMultiAnswer`. Despite the field name this is not a
      // multi-answer fact, so neither multi map is written; the legacy union
      // carries it until its readers are migrated.
      // RESOLVED only. A single-answer question that resolves is not a
      // multi-answer completion, and writing one here is what made the old
      // union claim things it could not support.
      this.quizService.markQuestionResolved(qIdx);
      writeSessionString(SK_MULTI_PERFECT + qIdx, 'true');
      // NO SCORE HERE — the gate is answer-key derived; credit is applied by
      // creditResolvedQuestion on authorized verdict arrival. `scoreFired`
      // below stays: it gates the EXPLANATION emit, a display decision about
      // the user's own completed interaction rather than a score.
      scoreFired = true;
    }
    if (scoreFired) {
      if ((state as any).showExplanationChange) {
        (state as any).showExplanationChange.emit(true);
      }
      queueMicrotask(() => emitExplanation(qIdx, true));
    }
  }

  /**
   * Record the click's early dot status: register a correct click for the
   * scoring service's multi-answer gate, and set the in-memory confirmed
   * dot status + last-clicked-correct flag for this question. Terminal
   * side-effect; extracted verbatim from handleOptionClick. (The
   * sessionStorage persist of dot_confirmed is deliberately left inline and
   * deferred until the question type is known.)
   */
  /**
   * Record a correct click for the SCORING service's multi-answer gate.
   *
   * Still answer-key-derived and still synchronous. Scoring is Stage 10I and is
   * deliberately untouched here — this is split out from the old
   * `recordEarlyDotStatus` so that removing the dot writes did not silently
   * remove a scoring side effect too.
   */
  private recordCorrectClickForScoring(
    qIdx: number,
    binding: OptionBindings,
    isPristineCorrect: (o: any) => boolean
  ): void {
    try {
      if (isPristineCorrect(binding.option)) {
        (this.quizService as any)?.scoringService?.recordCorrectClick?.(qIdx, binding.option.text);
      }
    } catch { /* ignore */ }
  }

  /**
   * Write the dot status for this click, from the VERDICT.
   *
   * Runs in phase 3, after `submitSelectionForVerdict`, so a synchronous
   * adapter has already recorded the answer. Returns the status it wrote, or
   * null when the verdict is not yet known — the caller then persists nothing
   * and the dot stays as it was, which is the honest render for "checking".
   *
   * `verdictForOption` answers only for options the user actually selected,
   * which is exactly the old semantic: these two maps record whether the option
   * the user JUST CLICKED was right, not whether the question is finished.
   */
  private recordDotStatusFromVerdict(
    qIdx: number,
    binding: OptionBindings,
    question: QuizQuestion | null
  ): 'correct' | 'wrong' | null {
    const clickedIsCorrect = this.clickedCorrectFromVerdict(question, binding.option);

    if (clickedIsCorrect === null) {
      // Still checking. Hand the wait to the sync service, which completes the
      // write when the response lands, and paint no correctness meanwhile.
      const quizId = (this.quizService as any)?.quizId as string | undefined;
      const optionText = (binding.option as any)?.text as string | undefined;
      if (quizId && question?.questionText && optionText) {
        this.dotVerdictSync.awaitVerdict(qIdx, quizId, question.questionText, optionText);
      }
      return null;
    }

    // A newer synchronous answer supersedes any earlier pending wait.
    this.dotVerdictSync.cancel(qIdx);

    const dotStatus = clickedIsCorrect ? 'correct' : 'wrong';
    this.selectedOptionService.clickConfirmedDotStatus.set(qIdx, dotStatus);
    this.selectedOptionService.lastClickedCorrectByQuestion.set(qIdx, clickedIsCorrect);
    return dotStatus;
  }

  /**
   * Stop the countdown timer when the answer is resolved correctly. In
   * shuffled mode only isPristineCorrect is trusted (allCorrectFound uses
   * mutated binding flags that can be wrong when questions are reordered).
   * Terminal side-effect; extracted verbatim from handleOptionClick.
   */
  private stopTimerIfAnswerCorrect(
    isShuffleActive: boolean,
    isMultipleMode: boolean,
    isPristineCorrect: (o: any) => boolean,
    clickedOption: any,
    allCorrectFound: boolean,
    question: QuizQuestion | null
  ): void {
    // The CLICKED option's own verdict, recorded before this phase ran.
    //
    // `verdictForOption` answers only for options the user actually selected,
    // which is exactly right here: a single-answer question is terminal on any
    // click, but the timer must stop only when the click was CORRECT. Terminal
    // and correct are different questions, and this is the one that matters.
    const clickedIsCorrect =
      this.clickedCorrectFromVerdict(question, clickedOption) ?? isPristineCorrect(clickedOption);

    const shouldStopTimer = isShuffleActive
      ? (!isMultipleMode && clickedIsCorrect)
      : (allCorrectFound || (!isMultipleMode && clickedIsCorrect));
    if (shouldStopTimer) {
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch (err: unknown) {
        console.error('OptionInteractionService.stopTimerIfAnswerCorrect timer stop failed:', err);
      }
    }
  }

  /**
   * Resolve the active DISPLAY index for the click. The caller
   * (shared-option-click.service) seeds state.currentQuestionIndex from the
   * URL-authoritative getActiveQuestionIndex() (the questionIndex() @Input) —
   * the single source of truth for the active display position — so trust it
   * first and fall back to the live service signal only when it's invalid.
   *
   * The previous logic preferred quizService.getCurrentQuestionIndex() (which
   * sticks at 0 during init/hydration) then ran a text-match "self-heal"
   * against ORIGINAL-order questions[]; in shuffle, state.currentQuestion is
   * itself wrong-order, so the self-heal collapsed every click onto the same
   * original slot (the index-0 mis-keying behind the revisit bug) AND produced
   * an original-order index while downstream consumers expect a DISPLAY index.
   * Removed — qIdx is the display index end to end now.
   */
  private resolveActiveDisplayIndex(state: OptionInteractionState): number {
    const stateIdx = state.currentQuestionIndex;
    const liveIdx = this.quizService?.getCurrentQuestionIndex?.();
    return (typeof stateIdx === 'number' && Number.isFinite(stateIdx) && stateIdx >= 0)
      ? stateIdx
      : ((typeof liveIdx === 'number' && Number.isFinite(liveIdx) && liveIdx >= 0) ? liveIdx : 0);
  }

  /**
   * Resolve the initial simulated selection for the clicked question from the
   * durable store. Detects stale pre-refresh selections (durable click tracker
   * empty but the service still has stored selections — remnants from before a
   * refresh) and discards them so the user starts fresh. Does NOT clear the
   * sessionStorage/_selectionHistory entries — those are legitimate prior clicks
   * that must rehydrate as prev-clicked. Extracted verbatim from handleOptionClick.
   */
  private resolveSimulatedSelection(
    qIdx: number,
    state: OptionInteractionState
  ): SelectedOption[] {
    const storedSelection = this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
    const durableClicks = (state as any)._multiSelectByQuestion?.get(qIdx);
    const isStaleFromRefresh = storedSelection.length > 0
      && (!durableClicks || durableClicks.size === 0);
    return isStaleFromRefresh ? [] : [...storedSelection];
  }

  /**
   * Find whether the clicked option is already selected, by composite
   * (effectiveId|displayIndex) matching — optionId alone can collide when
   * loader fallbacks produce duplicate ids. Returns the index or -1.
   * The only closure (getEffectiveId) is capture-free and redefined inline.
   * Extracted verbatim from handleOptionClick.
   */
  private findExistingSelectionIndex(
    simulatedSelection: SelectedOption[],
    targetCompositeKey: string
  ): number {
    const getEffectiveId = (o: any, i: number) => (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;
    return simulatedSelection.findIndex(o => {
      const sIdx = o.displayIndex ?? (o as any).index ?? (o as any).idx ?? -1;
      const sKey = `${getEffectiveId(o, sIdx)}|${sIdx}`;
      return sKey === targetCompositeKey;
    });
  }

  /**
   * Build the synthetic change event passed to updateOptionAndUI: a `checked`
   * shape for multi-answer (radio-group-free), a `value` shape for single.
   * Extracted verbatim from handleOptionClick.
   */
  private buildMockEvent(
    isMultipleMode: boolean,
    newState: boolean,
    binding: OptionBindings,
    index: number
  ): { source: null; checked: boolean } | { source: null; value: number } {
    return isMultipleMode
      ? { source: null, checked: newState }
      : { source: null, value: binding.option.optionId ?? index };
  }

  /**
   * Count the correct options in the live bindings. state.optionBindings may
   * arrive as a signal function (-clean) or a plain array (-main); normalize
   * then count via isOptionCorrect. Pure read; extracted verbatim from
   * handleOptionClick.
   */
  private resolveCorrectCountInBindings(state: OptionInteractionState): number {
    const _rawBindings = state.optionBindings as any;
    const bindingsForScore: any[] = typeof _rawBindings === 'function'
      ? (_rawBindings() ?? [])
      : (_rawBindings ?? []);
    return bindingsForScore.filter((b: any) => isOptionCorrect(b.option)).length;
  }

  /**
   * Authoritative Type Resolution: a question is multi-answer if the state
   * says so, the text says "select all"/"multiple"/"apply", or more than one
   * correct option is detected (in the live bindings OR the pristine quiz
   * data). Pure read; extracted verbatim from handleOptionClick.
   */
  private resolveIsMultipleMode(
    state: OptionInteractionState,
    correctCountInBindings: number,
    pristineCorrectCount: number
  ): boolean {
    const qText = state.currentQuestion?.questionText?.toLowerCase() || '';
    const isExplicitMulti = qText.includes('select all') || qText.includes('multiple') || qText.includes('apply');
    return state.type === 'multiple' || (state as any).isMultiMode === true ||
      isExplicitMulti || correctCountInBindings > 1 || pristineCorrectCount > 1;
  }

  /**
   * UPDATE UI STATE BASICS (history part): push the clicked index onto
   * selectedOptionHistory when newly selected, or remove it when deselected.
   * Terminal side-effect on state; extracted verbatim from handleOptionClick.
   */
  private updateSelectionHistory(
    state: OptionInteractionState,
    newState: boolean,
    index: number
  ): void {
    if (newState && !state.selectedOptionHistory.includes(index)) {
      state.selectedOptionHistory.push(index);
    } else if (!newState) {
      const hIdx = state.selectedOptionHistory.indexOf(index);
      if (hIdx !== -1)  state.selectedOptionHistory.splice(hIdx, 1);
    }
  }

  /**
   * DEFERRED DOT PERSIST: persist the dot-confirmed status to sessionStorage.
   * Single-answer persists immediately; multi-answer persists 'correct' only
   * when ALL correct are selected (a partial 'correct' makes the DOT-CONFIRMED
   * FALLBACK LOCK treat the question as fully resolved on refresh and
   * auto-highlight an unselected correct answer), and 'wrong' on an incorrect
   * click; multi-answer partial-correct is intentionally NOT persisted (the
   * in-memory map handles live rendering). Terminal side-effect; closure-free;
   * extracted verbatim from handleOptionClick.
   */
  private persistDotConfirmedStatus(
    isMultipleMode: boolean,
    allCorrectFound: boolean,
    dotStatus: 'correct' | 'wrong' | null,
    qIdx: number
  ): void {
    try {
      // A pending verdict persists NOTHING. Writing a guess here would be
      // worse than writing nothing, because sessionStorage survives the reload
      // that would otherwise correct it.
      if (dotStatus === null && !allCorrectFound) return;

      if (!isMultipleMode) {
        if (dotStatus !== null) sessionStorage.setItem(SK_DOT_CONFIRMED + qIdx, dotStatus);
      } else if (allCorrectFound) {
        sessionStorage.setItem(SK_DOT_CONFIRMED + qIdx, 'correct');
      } else if (dotStatus === 'wrong') {
        sessionStorage.setItem(SK_DOT_CONFIRMED + qIdx, 'wrong');
      }
      // For multi-answer partial correct: don't persist to sessionStorage.
      // The in-memory map handles live rendering; refresh should NOT see
      // a 'correct' status for an incomplete multi-answer question.
    } catch (err: unknown) {
      console.error('OptionInteractionService.handleOptionClick dot-status persist failed:', err);
    }
  }

  /**
   * UPDATE ANCHOR: if we just selected something, that's the new anchor; if we
   * unselected, find the most recently selected option in history that is STILL
   * selected and anchor on it (else -1). Side-effect on state.lastFeedbackOptionId;
   * the only closure used (getEffectiveId) is capture-free and redefined inline.
   * Extracted verbatim from handleOptionClick.
   */
  private updateFeedbackAnchor(
    state: OptionInteractionState,
    isCurrentlySelected: boolean,
    index: number,
    futureKeys: Set<number>
  ): void {
    const getEffectiveId = (o: any, i: number) => (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;
    if (!isCurrentlySelected) {
      state.lastFeedbackOptionId = index;
    } else {
      // Robustly find the most recent in history that is STILL selected
      const stillSelectedId = [...(state.selectedOptionHistory || [])]
        .reverse()
        .find(histId => {
          // Find the option in optionsToDisplay that corresponds to this history entry
          const oIdx = state.optionsToDisplay.findIndex((_, i) => i === histId || String(i) === String(histId));
          const opt = oIdx !== -1 ? state.optionsToDisplay[oIdx] : state.optionsToDisplay.find(o => o.optionId != null && o.optionId !== -1 && o.optionId == histId);
          return opt && futureKeys.has(getEffectiveId(opt, state.optionsToDisplay.indexOf(opt)));
        });

      if (stillSelectedId !== undefined) {
        // Find its reliable index to use as the lastFeedbackOptionId
        const finalIdx = state.optionsToDisplay.findIndex((_, i) => i === stillSelectedId || String(i) === String(stillSelectedId));
        state.lastFeedbackOptionId = finalIdx !== -1 ? finalIdx : stillSelectedId;
      } else {
        state.lastFeedbackOptionId = -1;
      }
    }
  }

  /**
   * AUTHORITATIVE FEEDBACK ANCHORING: reset showFeedbackForOption completely
   * (so feedback only shows under the LAST selection), then re-anchor it on the
   * clicked option's keys, and set lastFeedbackOptionId + showFeedback. Terminal
   * side-effect on state; closure-free; extracted verbatim from handleOptionClick.
   */
  private applyFeedbackAnchoring(
    state: OptionInteractionState,
    targetKey: number,
    index: number,
    binding: OptionBindings
  ): void {
    // Reset completely for both single and multi-answer questions so feedback only shows under the LAST selection.
    state.showFeedbackForOption = {};

    state.showFeedbackForOption = {
      [targetKey]: true,
      [index]: true,
      [`idx:${index}`]: true
    };
    if (binding.option.optionId != null) {
      state.showFeedbackForOption[binding.option.optionId] = true;
    }
    state.lastFeedbackOptionId = targetKey;
    state.showFeedback = true;
  }

  /**
   * Back-fill displayIndex on EVERY futureSelection entry, not just the freshly
   * clicked one. Pre-existing entries from persisted state can be missing
   * displayIndex, and rehydrate keys strictly on displayIndex — so entries
   * without it silently fail to restore on refresh. Resolve by matching
   * optionId/text against the current bindings or optionsToDisplay to stamp the
   * correct position. Pure transform; extracted verbatim from handleOptionClick.
   * (Previously broke the shuffle revisit Next-button as `normalizeSelectionDisplayIndices`;
   * retried now that Phases 1+2 made the index model reliable and a permanent
   * revisit regression guard exists.)
   */
  private normalizeSelectionDisplayIndices(
    futureSelection: SelectedOption[],
    state: OptionInteractionState
  ): SelectedOption[] {
    return futureSelection.map((s: SelectedOption) => {
      const hasIdx =
        s?.displayIndex != null && Number.isFinite(Number(s.displayIndex));
      if (hasIdx) return s;
      const sId = s?.optionId;
      const sText = norm(s?.text);
      let pos = state.optionBindings.findIndex((b: OptionBindings) => {
        const bId = b?.option?.optionId;
        if (sId != null && sId !== -1 && bId != null && bId !== -1 && String(sId) === String(bId)) return true;
        return !!sText && norm(b?.option?.text) === sText;
      });
      if (pos === -1) {
        pos = state.optionsToDisplay.findIndex((o: Option) => {
          if (sId != null && sId !== -1 && o?.optionId != null && o.optionId !== -1 && String(sId) === String(o.optionId)) return true;
          return !!sText && norm(o?.text) === sText;
        });
      }
      if (pos === -1) return s;
      return { ...s, displayIndex: pos, index: pos };
    });
  }

  /**
   * Normalize state.optionBindings to a plain array in place. It may arrive
   * as a signal function (-clean) or plain array (-main); all downstream code
   * iterates/indexes it, so coerce once up front. Mutating `state` is safe —
   * it's a per-call context object, not the SOC itself. Self-contained leaf
   * side-effect; extracted verbatim from handleOptionClick's head.
   */
  private normalizeStateOptionBindings(state: OptionInteractionState): void {
    const _rawOb = (state as any).optionBindings;
    if (typeof _rawOb === 'function') {
      (state as any).optionBindings = (_rawOb() ?? []);
    } else if (!Array.isArray(_rawOb)) {
      (state as any).optionBindings = [];
    }
  }

  /**
   * PRISTINE CORRECTNESS RESOLVER: resolve whether the clicked option is
   * truly correct from quizInitialState, not from potentially-mutated binding
   * data. Uses question TEXT matching (not index) to handle shuffled mode
   * correctly. Extracted verbatim from handleOptionClick's inline closure;
   * `qIdx`/`state` are passed by the thin delegate that captures them by
   * reference so late `qIdx` reassignments are honored at call-time.
   */
  private isPristineCorrectFor(
    o: any,
    qIdx: number,
    state: OptionInteractionState
  ): boolean {
    if (!o) return false;
    try {
      const optText = norm(o?.text);
      if (!optText) return false;
      // Resolve the current question text for matching.
      // CRITICAL: In shuffled mode, state.currentQuestion points to the
      // WRONG question (original order). ALWAYS prefer display-order
      // sources first in shuffled mode.
      const isShuffledPC = (this.quizService as any)?.isShuffleEnabled?.()
        && (this.quizService as any)?.shuffledQuestions?.length > 0;
      let question: any;
      if (isShuffledPC) {
        question = this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx]
          ?? (this.quizService as any)?.shuffledQuestions?.[qIdx]
          ?? state.currentQuestion
          ?? (this.quizService as any)?.questions?.[qIdx];
      } else {
        question = state.currentQuestion
          ?? (this.quizService as any)?.questions?.[qIdx]
          ?? this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx];
      }
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(question?.questionText);
      return pristineCorrectTexts.has(optText);
    } catch { /* ignore */ }
    return false;
  }

  /**
   * Commit the resolved selection to the durable stores: the per-question
   * selection map (via syncSelectionState) and the quiz-service user-answer
   * record (the option ids derived from futureKeys). Terminal side-effect;
   * extracted verbatim from handleOptionClick (passes a fresh copy of
   * futureSelection, matching the prior `simulatedSelection = [...]` spread).
   */
  private commitSelectionState(
    qIdx: number,
    futureSelection: SelectedOption[],
    futureKeys: Set<number>,
    state: OptionInteractionState
  ): void {
    const getEffectiveId = (o: any, i: number) =>
      (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;
    this.selectedOptionService.syncSelectionState(qIdx, [...futureSelection]);
    this.quizService.updateUserAnswer(
      qIdx,
      Array.from(futureKeys).map(idx => {
        const o = state.optionsToDisplay[idx] || state.optionBindings[idx]?.option;
        const eid = getEffectiveId(o, idx);
        return typeof eid === 'number' ? eid : -1;
      }).filter(id => id !== -1)
    );
  }

  /**
   * Authoritative highlight/selection sync for the option bindings after a
   * click. Single-answer: only the current click is "selected", but the
   * current click plus all previously-clicked options stay highlighted
   * (history is seeded from durable storage so prior clicks survive a
   * refresh). Multi-answer: a two-pass update mirrors `futureKeys` onto both
   * bindings and optionsToDisplay. Void side-effect on `state`; body extracted
   * verbatim from handleOptionClick.
   */
  private applyHighlightSync(
    state: OptionInteractionState,
    index: number,
    qIdx: number,
    targetKey: number | string,
    isMultipleMode: boolean,
    futureKeys: Set<number>
  ): void {
    if (!isMultipleMode) {
      // Accumulate history (don't reset it)
      if (!state.selectedOptionHistory.includes(index)) {
        state.selectedOptionHistory.push(index);
      }
      // Seed history from durable sel_Q* on first post-refresh click.
      // state.selectedOptionHistory is component-local and empty after
      // refresh, but sel_Q* holds every prior click for this question. Without
      // seeding, the binding loop below unhighlights prev-clicked options
      // (wasPreviouslyClicked=false) and turns them white.
      const historySet = new Set<number | string>(state.selectedOptionHistory);
      try {
        const saved = this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
        for (const s of saved) {
          const sText = norm(s?.text);
          const sId = s?.optionId;
          let pos = -1;
          if (sText) {
            pos = state.optionBindings.findIndex((b: OptionBindings) =>
              norm(b?.option?.text) === sText
            );
          }
          if (pos === -1 && sId != null && sId !== -1) {
            pos = state.optionBindings.findIndex((b: OptionBindings) =>
              b?.option?.optionId != null && String(b.option.optionId) === String(sId)
            );
          }
          if (pos === -1) {
            const sIdx = s?.displayIndex ?? s?.index;
            if (sIdx != null && Number.isFinite(Number(sIdx))) pos = Number(sIdx);
          }
          if (pos !== -1) {
            historySet.add(pos);
            if (!state.selectedOptionHistory.includes(pos)) {
              state.selectedOptionHistory.push(pos);
            }
          }
        }
      } catch { /* ignore */ }
      for (const [i, b] of state.optionBindings.entries()) {
        const isCurrent = (i === index);
        const wasPreviouslyClicked = historySet.has(i);
        // Radio state: only current
        b.isSelected = isCurrent;
        if (b.option) {
          b.option.selected = isCurrent;
          // Highlight: current + previously clicked
          b.option.highlight = isCurrent || wasPreviouslyClicked;
          b.option.showIcon = isCurrent || wasPreviouslyClicked;
        }
        b.highlightCorrect = false;
        b.highlightIncorrect = false;
        b.showFeedback = isCurrent;
      }
      state.selectedOptionMap.clear();
      state.selectedOptionMap.set(targetKey, true);
      state.feedbackConfigs = {};
    } else { // Multiple mode: two-pass update to ensure correct results regardless of binding order
      // Pass 1: Sync 'selected' state for all bindings AND optionsToDisplay based on futureKeys.
      // Binding options are structuredClone'd copies of optionsToDisplay, so both must be updated.
      for (const [i, b] of state.optionBindings.entries()) {
        const isCurrentlySelected = futureKeys.has(i);
        b.isSelected = isCurrentlySelected;
        if (b.option) {
          b.option.selected = isCurrentlySelected;
        }
        if (state.optionsToDisplay?.[i]) {
          state.optionsToDisplay[i].selected = isCurrentlySelected;
        }
      }

      // Pass 2: Calculate 'highlight' and 'showIcon' based on the updated state
      for (const [i, b] of state.optionBindings.entries()) {
        if (!b.option) continue;
        const isCurrentlySelected = b.isSelected;
        b.option.highlight = isCurrentlySelected;
        b.option.showIcon = isCurrentlySelected;
        if (state.optionsToDisplay?.[i]) {
          state.optionsToDisplay[i].highlight = isCurrentlySelected;
          state.optionsToDisplay[i].showIcon = isCurrentlySelected;
        }
      }
    }
  }

  /**
   * Resolve the canonical set of correct-option indices for the current
   * question via a 3-tier fallback:
   *   1. Pristine-first: text-match against quizInitialState (immune to
   *      stale/mutated correct flags after Restart Quiz)
   *   2. questionOptions's own `correct` flags
   *   3. state.optionBindings's `isCorrect` / `option.correct`
   *
   * Pure read — never mutates inputs. Returns an empty Set if all three
   * sources fail.
   */
  private resolveCorrectIndicesSet(
    question: QuizQuestion | null,
    state: OptionInteractionState,
    questionOptions: Option[]
  ): Set<number> {
    const correctIndicesSet = new Set<number>();

    // PRISTINE-FIRST: Resolve correct indices from quizInitialState to avoid
    // stale/mutated correct flags on questionOptions (e.g. after Restart Quiz).
    try {
      const qTextForLookup = question?.questionText ?? state.currentQuestion?.questionText;
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(qTextForLookup);
      if (pristineCorrectTexts.size > 0) {
        for (const [i, o] of questionOptions.entries()) {
          if (pristineCorrectTexts.has(norm(o?.text))) {
            correctIndicesSet.add(i);
          }
        }
      }
    } catch { /* ignore */ }

    // Fallback: use questionOptions directly (may have stale flags but better than nothing)
    if (correctIndicesSet.size === 0) {
      for (const [i, o] of questionOptions.entries()) {
        if (isOptionCorrect(o)) correctIndicesSet.add(i);
      }
    }

    // Also try bindings as a source of correct info
    if (correctIndicesSet.size === 0) {
      for (const [i, b] of state.optionBindings.entries()) {
        // `=== true` because isCorrect is tri-state: null is "not authorized
        // yet", which must not be read as either answer.
        if (b.isCorrect === true || isOptionCorrect(b.option)) correctIndicesSet.add(i);
      }
    }

    return correctIndicesSet;
  }

  /**
   * Pristine correct-count probe: looks up the pristine quiz data for the
   * current question and returns the count of correct options. Bindings can
   * carry mutated correct flags (only 1 of 2 shown as correct), so this
   * cross-check ensures multi-answer questions aren't misidentified as
   * single-answer.
   *
   * Returns `seed` if the pristine lookup fails or yields nothing. Returns
   * the pristine count when available (which OVERWRITES seed — same as
   * the original inline behavior; may shrink seed in odd binding states).
   */
  private resolvePristineCorrectCount(seed: number, qIdx: number, state: OptionInteractionState): number {
    try {
      const qTextLookup = state.currentQuestion?.questionText
        || this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
        || (this.quizService as any)?.questions?.[qIdx]?.questionText;
      const pristineTexts = this.quizService.getPristineCorrectTextsForQuestion(qTextLookup);
      if (pristineTexts.size > 0) {
        return pristineTexts.size;
      }
    } catch { /* ignore */ }
    return seed;
  }

  /**
   * Pristine multi-answer probe: looks up the pristine quiz data by the
   * current question text (shuffle-aware) and returns true when there's
   * more than one correct answer. Bindings can carry stale/mutated correct
   * flags, so this is the authoritative single/multi classifier inside
   * handleOptionClick.
   */
  private resolvePristineIsMultiAnswer(
    question: QuizQuestion | null,
    qIdx: number,
    state: OptionInteractionState
  ): boolean {
    try {
      const isShuffledPM = (this.quizService as any)?.isShuffleEnabled?.()
        && (this.quizService as any)?.shuffledQuestions?.length > 0;
      const qTextForLookup = isShuffledPM
        ? (question?.questionText
          ?? this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
          ?? (this.quizService as any)?.shuffledQuestions?.[qIdx]?.questionText
          ?? state.currentQuestion?.questionText)
        : (question?.questionText ?? state.currentQuestion?.questionText);
      const pristineTexts = this.quizService.getPristineCorrectTextsForQuestion(qTextForLookup);
      return pristineTexts.size > 1;
    } catch {
      return false;
    }
  }

  /**
   * Tail-end of handleOptionClick: compute the post-click selection message
   * for the current question and push it. Reads the live optionBindings
   * (signal-or-array tolerant) and projects each option's "selected" state
   * from the just-computed futureKeys set so the message reflects the new
   * state, not the pre-click state.
   */
  private syncMessageAfterClick(
    state: OptionInteractionState,
    qIdx: number,
    isMultipleMode: boolean,
    futureKeys: Set<number>
  ): void {
    try {
      // RESOLVE: state.optionBindings may be a signal in -clean / array in -main
      const _rawSob = state.optionBindings as any;
      const _sob: any[] = typeof _rawSob === 'function' ? (_rawSob() ?? []) : (_rawSob ?? []);
      const message = this.selectionMessageService.computeFinalMessage({
        index: qIdx,
        total: this.quizService?.totalQuestions(),
        qType: isMultipleMode ? QuestionType.MultipleAnswer : QuestionType.SingleAnswer,
        opts: _sob.map((b: any, i: number) => ({
          ...b.option,
          selected: futureKeys.has(i)
        })) as Option[]
      });
      this.selectionMessageService.pushMessage(message, qIdx);
    } catch (err: unknown) {
      console.error('OptionInteractionService.handleOptionClick message sync failed:', err);
    }
  }
}