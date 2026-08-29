import { Service, inject } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import {
  selectedVerdictFor,
  verdictStateForDisplayIndex
} from '../../features/verdict/authorized-correctness';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { declaredIsMultiAnswer, resolveIsMultiAnswer } from '../../../utils/question-type-authority';
import { norm } from '../../../utils/text-norm';

/**
 * Result of resolving correct indices for a question.
 */
export interface CorrectIndicesResult {
  /** 0-based indices of correct options in display order */
  correctIndices: number[];
  /** Total correct count */
  correctCount: number;
  /** Whether multi-answer mode should be used */
  isMultiMode: boolean;
}

/**
 * State snapshot for multi-answer click processing.
 */
export interface MultiAnswerClickState {
  /** The clicked option's display index */
  clickedIndex: number;
  /**
   * Whether the clicked option is correct, or `null` when the correct-answer
   * set itself is not yet known.
   *
   * Same tri-state reasoning as `remaining` below: `correctSet.has(clickedIndex)`
   * on an empty (unknown) `correctIndices` is unconditionally `false`, which
   * read as a definite "wrong" the instant a genuinely correct click landed
   * before the verdict did — producing a premature "Not this one, try again!"
   * that then outlived the verdict because nothing recognized it as stale.
   */
  isClickedCorrect: boolean | null;
  /** Number of correct options selected so far */
  correctSelected: number;
  /** Number of incorrect options selected so far */
  incorrectSelected: number;
  /**
   * Remaining correct answers to find, or `null` when the correct-answer
   * set itself is not yet known.
   *
   * `null` is distinct from `0`: zero correct answers OUTSTANDING is a
   * genuine completion fact; not knowing the correct set at all is not.
   * Collapsing the two let a question resolve after a single click, before
   * anything had authorized what "complete" meant for it — see
   * `computeMultiAnswerClickState`.
   */
  remaining: number | null;
  /** 1-based correct option indices for display */
  correctIndices1Based: number[];
}

/**
 * Computed binding state for multi-answer after a click.
 */
export interface MultiAnswerBindingUpdate {
  isSelected: boolean;
  isCorrect: boolean;
  disabled: boolean;
  optionOverrides: {
    correct: boolean;
    selected: boolean;
    highlight: boolean;
    showIcon: boolean;
  };
}

/**
 * Input context for disabled-state computation, supplied by the component.
 */
export interface DisabledStateContext {
  currentQuestionIndex: number;
  isMultiMode: boolean;
  forceDisableAll: boolean;
  disabledOptionsPerQuestion: Map<number, Set<number>>;
  lockedIncorrectOptionIds: Set<number>;
  flashDisabledSet: Set<number>;
}

@Service()
export class OptionClickHandlerService {
  // ── injects ─────────────────────────────────────────────────────
  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);
  private verdicts = inject(QuestionVerdictService);

  // ── public methods ──────────────────────────────────────────────

  // ═══════════════════════════════════════════════════════════════════════
  // Correct Indices Resolution
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resolves the correct option indices for a question, cross-referencing
   * multiple data sources for accuracy.
   */
  resolveCorrectIndices(
    question: QuizQuestion | null,
    _questionIndex: number,
    isMultiModeFromComponent: boolean,
    typeFromComponent: string
  ): CorrectIndicesResult {
    const isCorrectFlag = isOptionCorrect;

    const questionOpts = question?.options ?? [];

    // SOURCE 1: Current question options
    const fromCurrentQ = questionOpts
      .map((o: any, idx: number) => isCorrectFlag(o) ? idx : -1)
      .filter((idx: number) => idx >= 0);

    // SOURCE 2: Raw _questions data for cross-reference
    const rawQs: any[] = (this.quizService as any)._questions ?? [];
    const qText = norm(question?.questionText);
    let fromRaw: number[] = [];
    for (const rq of rawQs) {
      if (norm(rq.questionText) === qText) {
        const rawCorrectTexts = new Set<string>(
          (rq.options ?? []).filter((o: any) => isOptionCorrect(o)).map((o: any) => norm(o.text))
        );
        fromRaw = questionOpts
          .map((o: any, idx: number) => rawCorrectTexts.has(norm(o.text)) ? idx : -1)
          .filter((idx: number) => idx >= 0);
        break;
      }
    }

    // UNKNOWN, NOT ZERO. `correctIndices.length === 0` here means nobody has
    // told this call which options are correct — never a genuine domain fact
    // (every question has at least one correct option), so an empty array is
    // unambiguously "not yet known", the same reading every consumer of this
    // result already applies (see the two call sites gated on
    // `correctIndicesArr.length > 0`, and `computeMultiAnswerClickState`'s own
    // tri-state handling of an empty `correctIndices`).
    //
    // This used to fall through to a Source 3 that scanned `quizInitialState` —
    // the bundled answer-key bank — for the same text match performed above
    // against `_questions`. Removed: authorized correctness now arrives from
    // the verdict once `/check` resolves, and every downstream consumer of this
    // function already prefers that over whatever this returns. Proven, not
    // assumed — under a true S5a simulation (quizInitialState emptied at both
    // real population sites) every one of 581 calls captured across the full
    // multi-answer/revisit/restart/timer battery returned empty from Source 1
    // and Source 2 alike, and all 20 tests passed identically to the control
    // run where the removed Source 3 had been firing on every call.
    const correctIndices = fromRaw.length > 0 ? fromRaw : fromCurrentQ;
    const correctCount = correctIndices.length;
    // `correctIndices`/`correctCount` are still the answer key and stay as they
    // are — this migration only stops TYPE being derived from them.
    const declared = declaredIsMultiAnswer(question);
    const isMultiMode = declared !== null
      ? declared
      // REMOVE IN /questions CONTENT CUTOVER.
      : (isMultiModeFromComponent || typeFromComponent === 'multiple' || correctCount > 1);

    return { correctIndices, correctCount, isMultiMode };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Multi-Answer Click State
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Computes the multi-answer state after a click, given the durable
   * selection set and correct indices.
   */
  computeMultiAnswerClickState(
    clickedIndex: number,
    durableSet: Set<number>,
    correctIndices: number[]
  ): MultiAnswerClickState {
    const correctSet = new Set(correctIndices);
    // UNKNOWN, NOT WRONG. Same reasoning as `remaining` below: with no correct
    // set to check against, `correctSet.has(clickedIndex)` is unconditionally
    // `false` — not "this click is wrong", just "nobody has said yet".
    const isClickedCorrect = correctIndices.length === 0 ? null : correctSet.has(clickedIndex);

    let correctSelected = 0;
    let incorrectSelected = 0;
    for (const selIdx of durableSet) {
      if (correctSet.has(selIdx)) correctSelected++;
      else incorrectSelected++;
    }

    // UNKNOWN, NOT ZERO. An empty `correctIndices` here means nobody has told
    // this call what the correct set is — the verdict hasn't authorized it yet
    // (see the one caller that reaches this without a verdict) — not that zero
    // answers are outstanding. `0 - 0 = 0` used to read as "complete" the
    // instant a multi-answer question saw its first click, before the check
    // had even reached the server.
    const remaining = correctIndices.length === 0
      ? null
      : Math.max(correctIndices.length - correctSelected, 0);
    const correctIndices1Based = correctIndices.map(i => i + 1);

    return {
      clickedIndex,
      isClickedCorrect,
      correctSelected,
      incorrectSelected,
      remaining,
      correctIndices1Based
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Multi-Answer Feedback Text
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Generates the feedback text for a multi-answer click.
   */
  generateMultiAnswerFeedbackText(state: MultiAnswerClickState): string {
    // UNKNOWN IS NOT WRONG. `isClickedCorrect === null` means the verdict for
    // this click hasn't landed yet — say nothing definitive rather than claim
    // "Not this one, try again!" on what may well be a correct pick. Matches
    // FeedbackService.buildFeedbackMessage's own honest-blank rule for the same
    // moment. Getting this wrong doesn't just mislabel the click: the blank
    // string is what lets the caller's stale-cache check recognize an empty
    // cached value as needing regeneration once the verdict actually resolves.
    if (state.isClickedCorrect === null) return '';
    if (state.isClickedCorrect) {
      if (state.remaining === 0) {
        const optsList = state.correctIndices1Based.length > 1
          ? `Options ${state.correctIndices1Based.slice(0, -1).join(', ')}${state.correctIndices1Based.length > 2 ? ',' : ''} and ${state.correctIndices1Based[state.correctIndices1Based.length - 1]}`
          : `Option ${state.correctIndices1Based[0]}`;
        return state.correctIndices1Based.length > 1
          ? `You're right! The correct answers are ${optsList}.`
          : `You're right! The correct answer is ${optsList}.`;
      } else {
        const remTxt = state.remaining === 1 ? '1 more correct answer' : `${state.remaining} more correct answers`;
        return `That's correct! Please select ${remTxt}.`;
      }
    } else {
      return 'Not this one, try again!';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Multi-Answer Binding Updates
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Computes what each binding should look like after a multi-answer click.
   */
  computeMultiAnswerBindingUpdates(
    bindingsCount: number,
    durableSet: Set<number>,
    correctIndices: number[],
    disabledSet: Set<number>
  ): MultiAnswerBindingUpdate[] {
    const correctSet = new Set(correctIndices);
    const updates: MultiAnswerBindingUpdate[] = [];

    for (let bi = 0; bi < bindingsCount; bi++) {
      const isInDurable = durableSet.has(bi);
      const isCorrect = correctSet.has(bi);
      updates.push({
        isSelected: isInDurable,
        isCorrect,
        disabled: disabledSet.has(bi),
        optionOverrides: {
          correct: isCorrect,
          selected: isInDurable,
          highlight: isInDurable,
          showIcon: isInDurable
        }
      });
    }

    return updates;
  }

  /**
   * Updates the disabled set for a multi-answer click.
   * Disables incorrect clicks and all incorrect options when all correct are found.
   */
  updateDisabledSet(
    disabledSet: Set<number>,
    clickedIndex: number,
    isClickedCorrect: boolean | null,
    remaining: number | null,
    bindingsCount: number,
    correctIndices: number[]
  ): void {
    const correctSet = new Set(correctIndices);

    // `null` is UNKNOWN, not wrong — `!null` is `true` in JS, which used to
    // disable a click nobody has judged yet. Only a CONFIRMED wrong click
    // disables; unknown stays enabled, same permissive default this codebase
    // already takes elsewhere for an unauthorized state.
    if (isClickedCorrect === false) disabledSet.add(clickedIndex);
    // When all correct answers selected, disable ALL incorrect options.
    // PRISTINE GUARD: before triggering the disable-all branch, sanity-
    // check correctIndices.length against quizInitialState. If pristine
    // shows more correct options than we have here, the upstream count
    // was undercounted (stale binding flags) and remaining=0 fired
    // prematurely. Abort to prevent locking the OTHER unselected correct
    // option(s).
    if (remaining === 0) {
      try {
        const isShuffled = this.quizService?.isShuffleEnabled?.() &&
          this.quizService?.shuffledQuestions?.length > 0;
        const liveIdx = this.quizService?.getCurrentQuestionIndex?.() ?? 0;
        const liveQ: any = isShuffled
          ? this.quizService?.getQuestionsInDisplayOrder?.()?.[liveIdx]
            ?? this.quizService?.shuffledQuestions?.[liveIdx]
          : this.quizService?.questions?.[liveIdx];
        const liveQText = norm(liveQ?.questionText);
        if (liveQText) {
          const bundle = this.quizService?.quizInitialState ?? [];
          for (const quiz of bundle) {
            for (const pq of (quiz?.questions ?? [])) {
              if (norm(pq?.questionText) !== liveQText) continue;
              const pristineCorrectCount = (pq?.options ?? []).filter(
                (o: any) => isOptionCorrect(o)
              ).length;
              if (pristineCorrectCount > correctIndices.length) {
                // Pristine has more correct than passed-in correctIndices.
                // This is the undercounted case — bail without locking.
                return;
              }
              break;
            }
          }
        }
      } catch { /* fall through to original disable-all */ }

      for (let bi = 0; bi < bindingsCount; bi++) {
        if (!correctSet.has(bi)) disabledSet.add(bi);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Single-Answer Feedback Override
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * For single-answer mode, verifies and potentially overrides the feedback
   * config for multi-answer edge cases detected from binding state.
   */
  overrideMultiAnswerFeedback(
    cfg: FeedbackProps,
    clickedBinding: OptionBindings,
    optionBindings: OptionBindings[]
  ): FeedbackProps {
    const isCorrectFlag = isOptionCorrect;

    // RESOLVE: optionBindings may be a signal (-clean) or plain array (-main)
    const _rawOb = optionBindings as any;
    const _ob: any[] = typeof _rawOb === 'function' ? (_rawOb() ?? []) : (_rawOb ?? []);
    const correctCountFromBindings = _ob.filter((b: any) => isCorrectFlag(b.option)).length;
    if (correctCountFromBindings <= 1) return cfg;

    const isClickedCorrect = isCorrectFlag(clickedBinding.option);
    const correctIdxs: number[] = [];
    let correctSelected = 0;
    let incorrectSelected = 0;

    for (let bi = 0; bi < _ob.length; bi++) {
      const b = _ob[bi];
      const bCorrect = isCorrectFlag(b.option);
      if (bCorrect) correctIdxs.push(bi + 1);
      if (b.isSelected || b.option?.selected) {
        if (bCorrect) correctSelected++;
        else incorrectSelected++;
      }
    }

    const totalCorrect = correctIdxs.length;
    const remaining = Math.max(totalCorrect - correctSelected, 0);

    if (isClickedCorrect) {
      if (remaining === 0 && incorrectSelected === 0) {
        const optionsList = correctIdxs.length > 1
          ? `Options ${correctIdxs.slice(0, -1).join(', ')}${correctIdxs.length > 2 ? ',' : ''} and ${correctIdxs[correctIdxs.length - 1]}`
          : `Option ${correctIdxs[0]}`;
        return {
          ...cfg,
          feedback: correctIdxs.length > 1
            ? `You're right! The correct answers are ${optionsList}.`
            : `You're right! The correct answer is ${optionsList}.`
        };
      } else if (remaining > 0) {
        const remText = remaining === 1 ? '1 more correct answer' : `${remaining} more correct answers`;
        return { ...cfg, feedback: `That's correct! Please select ${remText}.` };
      }
    } else {
      return { ...cfg, feedback: 'Not this one, try again!' };
    }

    return cfg;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Disabled State Computation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Computes whether an option should be disabled, given the component's
   * current state context. Pure decision logic — no side effects.
   */
  computeDisabledState(
    option: Option,
    index: number,
    ctx: DisabledStateContext
  ): boolean {
    const { currentQuestionIndex: qIndex, isMultiMode, forceDisableAll,
            disabledOptionsPerQuestion } = ctx;
    const lockId = (option?.optionId != null && Number(option.optionId) !== -1)
      ? option.optionId : index;

    const effectiveMulti = this.resolveEffectiveMulti(isMultiMode, qIndex);

    // Multi-answer: only use the explicit disabledOptionsPerQuestion set
    // and forceDisableAll. Lock services can cross-contaminate.
    if (effectiveMulti) {
      if (forceDisableAll) return true;
      const disabledSet = disabledOptionsPerQuestion.get(qIndex);
      return !!(disabledSet && disabledSet.has(index));
    }

    const correctEnabled = this.correctOptionStaysEnabled(option, qIndex, forceDisableAll);
    if (correctEnabled !== undefined) return correctEnabled;

    const singleClickable = this.singleAnswerStaysClickable(qIndex, forceDisableAll);
    if (singleClickable !== undefined) return singleClickable;

    return this.computeLegacyLockDisabled(option, index, lockId, qIndex, ctx);
  }

  // Detect multi-answer from data as well as the context flag — isMultiMode
  // can be stale/false during initialization before runIsMultiMode computes.
  private resolveEffectiveMulti(isMultiMode: boolean, qIndex: number): boolean {
    let effectiveMulti = isMultiMode;
    if (!effectiveMulti) {
      try {
        const isShuffledChk = this.quizService?.isShuffleEnabled?.() &&
          this.quizService?.shuffledQuestions?.length > 0;
        const qSrc = isShuffledChk
          ? this.quizService?.getQuestionsInDisplayOrder?.() ?? this.quizService.shuffledQuestions
          : this.quizService?.questions;
        const chkQ = qSrc?.[qIndex] ?? null;
        const chkCorrectCount = (chkQ?.options ?? []).filter(
          (o: any) => isOptionCorrect(o)
        ).length;
        // DECLARED TYPE FIRST — `chkQ` was resolved through the display-order
        // source above, so this is the question on screen. A declared SINGLE
        // question is no longer promoted to multi by a drifting answer key.
        // REMOVE THE COUNT IN /questions CONTENT CUTOVER.
        effectiveMulti = resolveIsMultiAnswer(chkQ, chkCorrectCount > 1);
      } catch { /* ignore */ }
    }
    return effectiveMulti;
  }

  // Correct options should NOT be disabled while the user is still selecting.
  // Returns false (stay enabled) or undefined (continue to lock checks).
  private correctOptionStaysEnabled(
    option: Option,
    qIndex: number,
    forceDisableAll: boolean
  ): boolean | undefined {
    const isCorrectOpt = isOptionCorrect(option);
    if (isCorrectOpt && !forceDisableAll) {
      const isShuffled = this.quizService?.isShuffleEnabled?.() &&
        this.quizService?.shuffledQuestions?.length > 0;
      const questionSource = isShuffled
        ? this.quizService.shuffledQuestions
        : this.quizService?.questions;
      const currentQ = questionSource?.[qIndex] ?? null;
      const questionCorrectCount = (currentQ?.options ?? []).filter(
        (o: any) => isOptionCorrect(o)
      ).length;
      // DECLARED TYPE FIRST. `currentQ` came from shuffledQuestions when
      // shuffle is on, so it is the displayed question. The count survives only
      // as the fallback. REMOVE IT IN /questions CONTENT CUTOVER.
      const isMultiFromData = resolveIsMultiAnswer(currentQ, questionCorrectCount > 1);

      if (isMultiFromData) {
        // COMPLETION, not resolved: this branch is already inside
        // `isMultiFromData`, and it asks whether the multi-answer question is
        // finished — a single-answer resolution says nothing about that.
        const isFullyResolved = this.quizService.isMultiAnswerComplete(qIndex);
        if (!isFullyResolved) return false;
      } else {
        return false;
      }
    }
    return undefined;
  }

  // SINGLE-ANSWER GUARD: while no correct option has been selected for this
  // question, every option must remain clickable so the user can recover
  // from a wrong pick. The downstream lock signals (disabledBySet,
  // optionLocked, lockedIncorrectOptionIds, flashDisabled) occasionally
  // leak true on incorrect-only single-answer clicks; bypass them here
  // until the user actually picks the correct answer.
  //
  // "Has a correct option been selected?" is answered by the verdict for the
  // player's own picks, and the question's shape by its declared type. Neither
  // asks the bank, and neither asks about an option nobody selected.
  private singleAnswerStaysClickable(qIndex: number, forceDisableAll: boolean): boolean | undefined {
    if (!forceDisableAll) {
      try {
        const saSelections =
          this.selectedOptionService.getSelectedOptionsForQuestion(qIndex) ?? [];
        const isShuffledSA = this.quizService?.isShuffleEnabled?.() &&
          this.quizService?.shuffledQuestions?.length > 0;
        const liveSAQ = isShuffledSA
          ? this.quizService?.getQuestionsInDisplayOrder?.()?.[qIndex]
            ?? this.quizService?.shuffledQuestions?.[qIndex]
          : this.quizService?.questions?.[qIndex];
        // THE VERDICT ON THE USER'S OWN PICKS DECIDES THIS.
        //
        // The question being asked is "has this player already found the
        // correct answer?", and the only authority on that is the verdict for
        // the options they actually selected. The bank scan answered it by
        // rebuilding the correct set and testing membership, which is the
        // answer key deciding a live UI state.
        //
        // `selectedVerdictFor` is undefined until the check lands, and
        // undefined is NOT "wrong" — it means nothing has been resolved yet.
        // Treating it as not-yet-correct is exactly what this guard wants:
        // options stay clickable while a check is in flight, and lock when the
        // verdict arrives and re-runs this. That is the same recovery window
        // the guard already gave a wrong pick.
        const verdictState = verdictStateForDisplayIndex(this.quizService, qIndex, this.verdicts);
        const anyCorrectSelected = saSelections.some(
          (s: any) => selectedVerdictFor(verdictState, s?.text) === true
        );

        // CARDINALITY COMES FROM THE DECLARED TYPE, not from counting flagged
        // options. An undeclared type reads as single here, which keeps the
        // options clickable — the permissive outcome, and the right one for a
        // multi-answer question too, where clicking must continue anyway.
        const isSingleAnswer = declaredIsMultiAnswer(liveSAQ) !== true;
        if (!anyCorrectSelected && isSingleAnswer) return false;
      } catch { /* ignore — fall through to legacy lock checks */ }
    }
    return undefined;
  }

  // Legacy lock aggregation: disabled if any lock signal fires.
  private computeLegacyLockDisabled(
    option: Option,
    index: number,
    lockId: number,
    qIndex: number,
    ctx: DisabledStateContext
  ): boolean {
    const { disabledOptionsPerQuestion, lockedIncorrectOptionIds, flashDisabledSet, forceDisableAll } = ctx;
    const disabledSet = disabledOptionsPerQuestion.get(qIndex);
    const disabledBySet = disabledSet && (disabledSet.has(index) || disabledSet.has(lockId));
    const forceDisabled = forceDisableAll;

    let questionLocked = false;
    try {
      questionLocked = this.selectedOptionService.isQuestionLocked(qIndex);
    } catch (err: unknown) {
      console.error('OptionClickHandlerService.computeDisabledState questionLocked check failed:', err);
    }

    let optionLocked = false;
    try {
      optionLocked = this.selectedOptionService.isOptionLocked(qIndex, index) ||
        this.selectedOptionService.isOptionLocked(qIndex, lockId);
    } catch (err: unknown) {
      console.error('OptionClickHandlerService.computeDisabledState optionLocked check failed:', err);
    }

    const lockedIncorrect = lockedIncorrectOptionIds.has(index) || lockedIncorrectOptionIds.has(lockId);
    const flashDisabled = flashDisabledSet.has(index) || flashDisabledSet.has(lockId);

    return !!(disabledBySet || forceDisabled || questionLocked || optionLocked || lockedIncorrect || flashDisabled);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Question Type Detection
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Determines if a question is single or multiple answer.
   */
  determineQuestionType(input: QuizQuestion): 'single' | 'multiple' {
    // DECLARED TYPE WINS. `correctOptionsCount > 1` used to be the FIRST arm of
    // the OR, so two `correct` flags in the local bank promoted a declared
    // single-answer question to multiple — question type was a derivative of
    // the answer key. A declared trueFalse resolves to 'single' here because
    // this returns an INTERACTION mode (radio vs checkbox); the declared type
    // itself is untouched and callers that need it read `question.type`.
    const declared = declaredIsMultiAnswer(input);
    if (declared !== null) return declared ? 'multiple' : 'single';

    // REMOVE IN /questions CONTENT CUTOVER — everything below is the fallback.
    if (input && Array.isArray(input.options)) {
      const correctOptionsCount = input.options.filter(o => isOptionCorrect(o)).length;
      if (correctOptionsCount > 1 || (input as any).multipleAnswer === true) {
        return 'multiple';
      }
    }
    return 'single';
  }

  /**
   * Detects multi-answer mode from question data, text keywords, and fallback type.
   * Returns the cached result if provided (for CD-cycle performance).
   */
  detectMultiMode(
    question: QuizQuestion | null,
    typeInput: string,
    configType?: string
  ): boolean {
    // DECLARED TYPE FIRST — and that also retires the question-TEXT heuristic
    // below, which is a second proxy for a fact the API now states outright.
    const declared = declaredIsMultiAnswer(question);
    if (declared !== null) return declared;

    // REMOVE IN /questions CONTENT CUTOVER — everything below is the fallback.
    let result = false;

    const qText = (question?.questionText || '').toLowerCase();
    if (qText.includes('select all') || qText.includes('all that apply') || qText.includes('multiple')) {
      result = true;
    }

    let correctCount = 0;
    if (question?.options && !result) {
      correctCount = question.options.filter((o: Option) => isOptionCorrect(o)).length;
      if (correctCount > 1) result = true;
    }

    // Only trust the type/config input when data is unavailable (correctCount === 0).
    if (correctCount === 0 && (typeInput === 'multiple' || configType === 'multiple')) {
      result = true;
    }

    return result;
  }

}