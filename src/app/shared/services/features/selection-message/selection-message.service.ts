import { computed, effect, Service, inject, signal, untracked } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Observable, Subscription } from 'rxjs';
import { distinctUntilChanged, filter, take } from 'rxjs/operators';

import { ExplanationTextService } from '../explanation/explanation-text.service';

import { QuestionType } from '../../../models/question-type.enum';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { isOptionCorrect } from '../../../utils/is-option-correct';
import { declaredIsMultiAnswer } from '../../../utils/question-type-authority';
import { selectedVerdictFor } from '../verdict/authorized-correctness';
import { norm } from '../../../utils/text-norm';

import { QuizDotStatusService } from '../../flow/quiz-dot-status.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import type { QuestionVerdictState } from '../verdict/question-verdict.types';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { swallow } from '../../../utils/error-logging';

/**
 * The multiple-answer prompt shown BEFORE the user has answered.
 *
 * Deliberately count-free. It replaced "Select N correct options", which
 * disclosed how many correct answers a question had before the user had earned
 * that information — a fact that lives only in the private answer key. Once
 * answering begins the authorized /check response supplies
 * remainingCorrectCount, and "Select 1 more..." is fine.
 */
export const SELECT_ALL_THAT_APPLY_MSG = 'Select all that apply';

const START_MSG = 'Please start the quiz by selecting an option.';
const CONTINUE_MSG = 'Please select an option to continue...';
const NEXT_BTN_MSG = 'Please click the Next button to continue.';
/**
 * Shown while `/check` is in flight for a single-answer question.
 *
 * The pick has been made but nobody has judged it yet. Saying "select the
 * correct answer" there asserts the pick was WRONG, which is a claim no
 * authority has made — and it was latched, so it survived navigation.
 */
const CHECKING_MSG = 'Checking…';
export const SHOW_RESULTS_MSG = 'Please click the Show Results button.';

interface OptionSnapshot {
  id: number | string,
  selected: boolean,
  correct?: boolean
}

@Service()
export class SelectionMessageService {
  // Click-driven override consumed by the computed selectionMessageSig.
  // Cleared on nav transitions (see ctor effect) so a prior question's
  // override never bleeds into the next visit.
  private readonly _clickOverride = signal<{ idx: number, msg: string } | null>(null);

  // Signal-first options snapshot
  readonly optionsSnapshotSig = signal<Option[]>([]);
  public get optionsSnapshot(): Option[] { return this.optionsSnapshotSig(); }
  public set optionsSnapshot(v: Option[]) { this.optionsSnapshotSig.set(v); }

  private _idMapByIndex = new Map<number, Map<string, string | number>>();

  // Progression Locks
  public _singleAnswerIncorrectLock = new Set<number>();
  public _singleAnswerCorrectLock = new Set<number>();
  private _multiAnswerInProgressLock = new Set<number>();
  private _multiAnswerCompletionLock = new Set<number>();
  private _multiAnswerPreLock = new Set<number>();

  public _lastMessageByIndex = new Map<number, string>();
  public _baselineReleased = new Set<number>();
  public _wrongClickCounts = new Map<number, number>();

  // In-session "this idx was completed" tracker. Populated only when
  // pushMessage records a real completion message (NEXT_BTN / SHOW_RESULTS /
  // "Answered ✓..."). Used by deriveNavMessageForIdx as the authoritative
  // answered probe — external maps (questionCorrectness, questionResolved,
  // quizStateService.isQuestionAnswered) leak across sessions / collide in
  // shuffled mode.
  private _completedIdxSet = new Set<number>();

  private _pendingMsgTokens = new Map<number, number>();

  private dotStatusService = inject(QuizDotStatusService);
  private explanationTextService = inject(ExplanationTextService);
  private quizService = inject(QuizService);
  private verdicts = inject(QuestionVerdictService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);

  // Strict computed: click override (if for current idx) → derive from
  // currentQuestionIndexSig + _completedIdxSet. No writers anywhere.
  public readonly selectionMessageSig = computed<string>(() => {
    const idx = this.quizService.currentQuestionIndexSig();
    if (!Number.isFinite(idx) || idx < 0) return START_MSG;
    const override = this._clickOverride();
    if (override && override.idx === idx) return override.msg;
    return this.deriveNavMessageForIdx(idx);
  });

  public readonly selectionMessage$: Observable<string> =
    toObservable(this.selectionMessageSig).pipe(distinctUntilChanged());

  constructor() {
    // Invalidate the click override the moment the user nav'd to a different
    // index. Without this, revisiting a previously-completed Q would see the
    // stale "Please click the Next button..." override and skip the
    // "Answered ✓..." derivation.
    //
    // Why this is an `effect` and not a `computed`:
    //   - Detecting an idx TRANSITION requires comparing the new value to a
    //     remembered previous value. A computed can't write back state, so
    //     can't store the "lastIdx" needed for comparison.
    //   - Tried alternatives (per-visit token signal, override.idx-equality
    //     gating alone) either still need a writer on nav or fail to clear
    //     a stale override when the user navs away and back to the same idx.
    //
    // Test-environment caveat:
    //   - Jest does not flush constructor-time root-providedIn effects via
    //     `TestBed.flushEffects()`. The selection-message integration spec
    //     verifies post-nav semantics by displacing the override with a
    //     subsequent `pushMessage` at a different idx (the same thing the
    //     click pipeline does in production). In real Angular runtime this
    //     effect fires synchronously on signal change, so production code
    //     works correctly even without the displacement.
    let lastIdx: number | null = null;
    effect(() => {
      const idx = this.quizService.currentQuestionIndexSig();
      if (!Number.isFinite(idx) || idx < 0) return;
      if (lastIdx !== null && lastIdx !== idx) {
        untracked(() => {
          const cur = this._clickOverride();
          if (cur && cur.idx !== idx) this._clickOverride.set(null);
        });
      }
      lastIdx = idx;
    });
  }

  private deriveNavMessageForIdx(idx: number): string {
    const total = this.quizService.totalQuestions();
    const qs: any = this.quizService;

    // Resolve original index for shuffled mode — questionCorrectness is
    // keyed by ORIGINAL question index, not display position.
    let isShuf = false;
    let origIdx = -1;
    try {
      isShuf = !!qs?.isShuffleEnabled?.();
      if (isShuf) {
        let eqId = qs?.quizId || '';
        if (!eqId) {
          try { eqId = localStorage.getItem('lastQuizId') || ''; } catch (err: unknown) { swallow('selection-message.service.ts', err); /* ignore */ }
        }
        if (eqId) {
          const mapped = qs?.scoringService?.quizShuffleService?.toOriginalIndex?.(eqId, idx);
          if (typeof mapped === 'number' && mapped >= 0) origIdx = mapped;
        }
      }
    } catch (err: unknown) { swallow('selection-message.service.ts', err); /* ignore */ }

    // Single authoritative probe: only marked when this session's pushMessage
    // already recorded a real completion message for this idx. No reliance on
    // external maps that leak across sessions or collide in shuffled mode.
    void isShuf; void origIdx; void qs;
    // A question that only TIMED OUT (no genuine selection) was force-marked
    // completed so its Next/Show-Results button stays enabled — but it is not
    // truly answered, so on revisit prompt the user to select rather than
    // claim "Answered ✓".
    const answered = this._completedIdxSet.has(idx) && !this.isTimedOutUnanswered(idx);

    const isLast = total > 0 && idx === total - 1;
    return answered
      ? (isLast ? 'Answered ✓ Click Show Results...' : 'Answered ✓ Click Next to continue...')
      : 'Please select an option to continue...';
  }

  // True when the question was force-completed purely by a timer expiry and the
  // user never made a genuine selection. Selections are cleared on revisit, so
  // this relies on durable signals only. The "genuinely answered" probe is the
  // click-confirmed dot status — set ONLY by real option clicks, never by a
  // timeout — NOT quizStateService.isQuestionAnswered, which a timed-out
  // question can spuriously pick up on revisit (the Q2-vs-Q6 discrepancy).
  private isTimedOutUnanswered(idx: number): boolean {
    if (this.dotStatusService?.timedOutFetForced?.has(idx) !== true) return false;
    const qs: any = this.quizService;
    const dot = this.selectedOptionService?.clickConfirmedDotStatus?.get?.(idx);
    const genuinelyAnswered =
      dot === 'correct' || dot === 'wrong'
      || qs?.isQuestionResolved?.(idx) === true
      || qs?.questionCorrectness?.get?.(idx) === true;
    return !genuinelyAnswered;
  }

  // Cheap check used by enforceBaselineAtInit to skip pushing the baseline
  // ("Select N correct options...") when the question is already answered —
  // otherwise the baseline overwrites the nav-driven Next/Show-Results
  // message after the question is revisited.
  private isQuestionAlreadyAnswered(idx: number): boolean {
    const qs: any = this.quizService;
    let origIdx = -1;
    try {
      const isShuf = qs?.isShuffleEnabled?.() && qs?.shuffledQuestions?.length > 0;
      if (isShuf) {
        let eqId = qs?.quizId || '';
        if (!eqId) {
          try { eqId = localStorage.getItem('lastQuizId') || ''; } catch (err: unknown) { swallow('selection-message.service.ts', err); /* ignore */ }
        }
        if (eqId) {
          const mapped = qs?.scoringService?.quizShuffleService?.toOriginalIndex?.(eqId, idx);
          if (typeof mapped === 'number' && mapped >= 0) origIdx = mapped;
        }
      }
    } catch (err: unknown) { swallow('selection-message.service.ts', err); /* ignore */ }
    return this.quizStateService.isQuestionAnswered?.(idx) === true
      || qs?.questionCorrectness?.get?.(idx) === true
      || (origIdx >= 0 && qs?.questionCorrectness?.get?.(origIdx) === true)
      || qs?.isQuestionResolved?.(idx) === true
      || this.explanationTextService?.fetBypassForQuestion?.get?.(idx) === true;
  }

  public getCurrentMessage(): string {
    return this.selectionMessageSig();
  }

  public isCompletedInSession(idx: number): boolean {
    return this._completedIdxSet.has(idx);
  }

  public resetAll(): void {
    this._singleAnswerCorrectLock.clear();
    this._singleAnswerIncorrectLock.clear();
    this._multiAnswerInProgressLock.clear();
    this._multiAnswerCompletionLock.clear();
    this._multiAnswerPreLock.clear();
    this._lastMessageByIndex.clear();
    this._baselineReleased.clear();
    this._pendingMsgTokens.clear();
    this._idMapByIndex.clear();
    this._wrongClickCounts?.clear();
    this._completedIdxSet.clear();
    this.optionsSnapshotSig.set([]);
    this._clickOverride.set(null);
  }

  private getQuestion(index: number): QuizQuestion | null {
    const svc = this.quizService as any;
    const questions = (svc.isShuffleEnabled() && svc.shuffledQuestions?.length > 0)
      ? svc.shuffledQuestions : svc.questions;

    return (Array.isArray(questions) && index >= 0 && index < questions.length)
      ? questions[index] : (svc.currentQuestion?.value ?? null);
  }

  /**
   * The question type driving a selection message — DECLARED TYPE WINS.
   *
   * All four call sites below used to read
   *
   *     (correctCount > 1 || declared === MultipleAnswer)
   *       ? MultipleAnswer : (declared ?? SingleAnswer)
   *
   * where the count is the FIRST arm of the OR. A local answer key carrying two
   * `correct` flags therefore promoted a declared single-answer — or trueFalse —
   * question to multiple, and the message told the user to keep selecting.
   *
   * A declared type is returned VERBATIM so trueFalse survives as trueFalse
   * instead of collapsing into SingleAnswer.
   */
  private resolveQType(
    declared: QuestionType | undefined,
    correctCount: number
  ): QuestionType {
    if (declaredIsMultiAnswer({ type: declared } as QuizQuestion) !== null) {
      return declared as QuestionType;
    }

    // REMOVE IN /questions CONTENT CUTOVER. Undeclared is not "single".
    return correctCount > 1 ? QuestionType.MultipleAnswer : QuestionType.SingleAnswer;
  }

  public determineSelectionMessage(
    questionIndex: number,
    totalQuestions: number,
    _isAnswered: boolean
  ): string {
    const uiSnapshot = this.getLatestOptionsSnapshot();
    if (!uiSnapshot || uiSnapshot.length === 0) {
      return questionIndex === 0 ? START_MSG : CONTINUE_MSG;
    }

    const q = this.getQuestion(questionIndex);
    const declaredType: QuestionType | undefined = q?.type;

    const keyOf = (o: any): string | number => {
      if (!o) return '__nil';
      if (o.optionId != null) return o.optionId;
      if (o.id != null) return o.id;
      const v = norm(o.value);
      const t = norm(o.text ?? o.label);
      return `${v}|${t}`;
    };

    const selectedKeys = new Set<string | number>();
    for (const o of uiSnapshot) if (o?.selected) selectedKeys.add(keyOf(o));

    const rawSel = this.selectedOptionService?.selectedOptionsMap?.get(questionIndex);
    const extraKeys = this.collectSelectedKeys(rawSel, keyOf);
    for (const k of extraKeys) selectedKeys.add(k);

    const canonical = Array.isArray(q?.options) ? (q!.options as Option[]) : [];
    this.ensureStableIds(questionIndex, canonical, uiSnapshot);

    const overlaid: Option[] = 
      (canonical.length ? canonical : this.normalizeOptionArray(uiSnapshot)).map((o, idx) => {
        const id = this.toStableId(o, idx);
        return this.toOption(o, idx, selectedKeys.has(id) || !!o.selected);
      }
    );

    const correctCount = overlaid.filter((o) => !!o?.correct).length;
    const qType: QuestionType = this.resolveQType(declaredType, correctCount);

    return this.computeFinalMessage({
      index: questionIndex,
      total: totalQuestions,
      qType,
      opts: overlaid
    });
  }

  /**
   * Missing correct options for the question at this DISPLAY index, from the
   * verdict service — or null when no verdict has been recorded yet.
   *
   * Null rather than 0 so the caller can tell "nothing selected yet" from
   * "nothing left to find"; a 0 here would wrongly read as complete.
   *
   * Shuffle-aware: the display-order array is the only correct source, since
   * `index` is a display index.
   */
  /**
   * The recorded verdict for the question at a DISPLAY index, or null.
   *
   * Shuffle-aware for the same reason `remainingCorrectFromVerdict` is: the
   * display-order array is the only correct source when `index` is a display
   * index.
   */
  private verdictStateFor(index: number): QuestionVerdictState | null {
    try {
      const service = this.quizService as any;
      const quizId = service?.quizId;
      const questionText =
        service?.getQuestionsInDisplayOrder?.()?.[index]?.questionText
        ?? service?.questions?.[index]?.questionText;
      if (!quizId || !questionText) return null;
      return this.verdicts.verdictFor(quizId, questionText);
    } catch {
      return null;
    }
  }

  private remainingCorrectFromVerdict(index: number): number | null {
    try {
      const service = this.quizService as any;
      const quizId = service?.quizId;
      const questionText =
        service?.getQuestionsInDisplayOrder?.()?.[index]?.questionText
        ?? service?.questions?.[index]?.questionText;
      if (!quizId || !questionText) return null;

      const state = this.verdicts.verdictFor(quizId, questionText);
      return state.remainingCorrectCount;   // null unless a verdict exists
    } catch {
      return null;   // never let a message computation throw
    }
  }

  public computeFinalMessage(args: {
    index: number;
    total: number;
    qType: QuestionType;
    opts: Option[];
  }): string {
    const { index, total, qType, opts } = args;
    if (!opts || opts.length === 0) return index === 0 ? START_MSG : CONTINUE_MSG;
    const isLastQuestion = total > 0 && index === total - 1;

    const totalCorrect = opts.filter(o => isOptionCorrect(o)).length;
    const selectedCorrect = opts.filter(o => o.selected && isOptionCorrect(o)).length;
    const selectedWrong = opts.filter(o => o.selected && !isOptionCorrect(o)).length;

    if (qType === QuestionType.SingleAnswer) {
      // CORRECTNESS COMES FROM THE VERDICT, AND ONLY ONCE IT EXISTS.
      //
      // This branch classified the pick with `isOptionCorrect(option)` while
      // its multi-answer sibling had already moved to the authorized verdict.
      // An API-sourced option carries no `correct` at all, so a CORRECT pick
      // counted as zero-correct/one-wrong and the user was told to "select the
      // correct answer" — then `_singleAnswerIncorrectLock` latched it, so the
      // wrong message survived Next/Previous and every later revisit.
      //
      // Tracing the live path showed both halves of the defect: `own=false`
      // (no flag on the option) AND `phase=checking` (no verdict yet). Reading
      // a different source alone would not have fixed it — at click time there
      // is nothing to read. So this waits, and the arrival recomputes.
      const state = this.verdictStateFor(index);
      const phase = state?.phase ?? "idle";
      const selectedTexts = opts.filter((o) => o.selected).map((o) => o.text ?? "");

      if (selectedTexts.length === 0) {
        return index === 0 ? START_MSG : CONTINUE_MSG;
      }

      // A pick exists but nothing has judged it. Claim NOTHING, and write
      // neither lock — a lock here is what made the wrong state permanent.
      if (phase !== "resolved" && phase !== "expired") {
        this.recomputeWhenVerdictArrives({ index, total, qType, opts });
        return CHECKING_MSG;
      }

      const answeredCorrectly = selectedTexts.some(
        (text) => selectedVerdictFor(state, text) === true
      );

      if (answeredCorrectly) {
        this._singleAnswerCorrectLock.add(index);
        this._singleAnswerIncorrectLock.delete(index);
        return isLastQuestion ? SHOW_RESULTS_MSG : NEXT_BTN_MSG;
      }

      this._singleAnswerIncorrectLock.add(index);
      // Track cumulative wrong clicks per question for last-question logic.
      if (!this._wrongClickCounts) this._wrongClickCounts = new Map();
      const prevCount = this._wrongClickCounts.get(index) ?? 0;
      this._wrongClickCounts.set(index, prevCount + 1);
      // On the last question, show "Show Results" only when ALL incorrect
      // options have been exhausted (correct auto-revealed). A single-answer
      // question has exactly ONE correct option by definition, so the number of
      // wrong ones is every option but one — derived from the public option
      // count, never from a scan of the answer key.
      if (isLastQuestion) {
        const totalIncorrect = Math.max(0, opts.length - 1);
        if (this._wrongClickCounts.get(index)! >= totalIncorrect) {
          return SHOW_RESULTS_MSG;
        }
      }
      return 'Please select the correct answer to continue.';
    }

    if (qType === QuestionType.MultipleAnswer) {
      // How many CORRECT options are still unselected, from the verdict
      // service rather than a scan of `correct` flags. Incorrect picks cannot
      // move this number — the verdict counts only missing correct options,
      // which is exactly the existing behaviour (`totalCorrect -
      // selectedCorrect` likewise ignored wrong selections).
      const remaining = this.remainingCorrectFromVerdict(index)
        ?? (totalCorrect - selectedCorrect);

      // How many options the user has picked — NOT how many were right.
      //
      // This was `selectedCorrect + selectedWrong`, which is the same number
      // (every selected option is one or the other) but arrived at by sorting
      // the picks against the answer key. Counting `selected` directly makes
      // the authorized path provably correctness-free: with a verdict present,
      // nothing in this branch reads a `correct` flag at all.
      const totalSelected = opts.filter((o) => o.selected).length;

      // All correct answers selected → Next button or Show Results
      if (remaining === 0) {
        this._multiAnswerCompletionLock.add(index);
        return isLastQuestion ? SHOW_RESULTS_MSG : NEXT_BTN_MSG;
      }

      // Nothing selected yet → a COUNT-FREE prompt.
      //
      // This used to read `Select ${totalCorrect} correct options`, which told
      // the user how many correct answers existed BEFORE they had answered
      // anything — a fact only the private answer key knows. The count is not
      // recoverable from public question data, and exposing it through
      // /questions would hand every visitor a materially useful hint.
      //
      // After the first selection the count is legitimate: it comes from the
      // authorized /check response as remainingCorrectCount, below.
      if (totalSelected === 0) {
        return SELECT_ALL_THAT_APPLY_MSG;
      }

      // Some selected but not all correct yet → show remaining correct needed
      this._multiAnswerInProgressLock.add(index);
      return `Select ${remaining} more correct answer${remaining !== 1 ? 's' : ''} to continue...`;
    }

    return index === 0 ? START_MSG : CONTINUE_MSG;
  }

  /** In-flight message recomputations, keyed by quiz + canonical question. */
  private readonly pendingMessageRecompute = new Map<string, Subscription>();

  /**
   * Recompute this question's selection message once its verdict is terminal.
   *
   * "Checking..." is honest but it must not be the last word. Nothing else
   * recomputes the message: the click path computes it once, and the verdict
   * arrives milliseconds later with no one listening — the message would sit
   * at "Checking..." forever.
   *
   * One-shot, keyed, self-cleaning, and stale-guarded, mirroring the pattern
   * `soc-answer-processing` already uses for its respread. No polling, no
   * delays: the verdict announces itself.
   */
  private recomputeWhenVerdictArrives(args: {
    index: number; total: number; qType: QuestionType; opts: Option[];
  }): void {
    const service = this.quizService as any;
    const quizId = service?.quizId;
    const questionText =
      service?.getQuestionsInDisplayOrder?.()?.[args.index]?.questionText
      ?? service?.questions?.[args.index]?.questionText;
    if (!quizId || !questionText) return;

    const arrivals = this.verdicts?.terminalVerdicts$;
    if (!arrivals || typeof arrivals.pipe !== 'function') return;

    const key = `${quizId} ${norm(questionText)}`;
    if (this.pendingMessageRecompute.has(key)) return;

    const sub = arrivals
      .pipe(
        filter((arrival) =>
          arrival.quizId === quizId && norm(arrival.questionText) === norm(questionText)),
        take(1)
      )
      .subscribe(() => {
        this.pendingMessageRecompute.delete(key);

        // STALE GUARD: the verdict is current for ITS question, but the user
        // may have moved on — pushing now would put one question's message on
        // another's screen.
        const showing =
          service?.getQuestionsInDisplayOrder?.()?.[args.index]?.questionText;
        if (showing && norm(showing) !== norm(questionText)) return;

        // Re-entry is bounded: the phase is terminal now, so the branch
        // classifies and returns a final message rather than registering again.
        const msg = this.computeFinalMessage(args);
        this._lastMessageByIndex.set(args.index, msg);
        this.pushMessage(msg, args.index);
      });

    if (sub.closed) this.pendingMessageRecompute.delete(key);
    else this.pendingMessageRecompute.set(key, sub);
  }

  public pushMessage(newMsg: string, _index: number): void {
    if (newMsg === NEXT_BTN_MSG
        || newMsg === SHOW_RESULTS_MSG
        || (typeof newMsg === 'string' && newMsg.startsWith('Answered ✓'))) {
      this._completedIdxSet.add(_index);
    }
    this._clickOverride.set({ idx: _index, msg: newMsg });
  }

  public releaseBaseline(index: number): void {
    this._baselineReleased.add(index);
    this._pendingMsgTokens.set(index, -1);
  }

  public forceNextButtonMessage(index: number, opts: { isLastQuestion?: boolean } = {}): void {
    const total = this.quizService.totalQuestions();
    const isLast = opts.isLastQuestion ?? (total > 0 && index === total - 1);
    const nextMsg = isLast ? SHOW_RESULTS_MSG : NEXT_BTN_MSG;
    this.releaseBaseline(index);
    this._lastMessageByIndex.set(index, nextMsg);
    this.pushMessage(nextMsg, index);
  }

  public enforceBaselineAtInit(i0: number, qType: QuestionType, totalCorrect: number): void {
    if (this._baselineReleased.has(i0)) return;
    // Skip baseline for already-answered questions — pushing "Select N..."
    // would overwrite the nav-driven Answered ✓ message on revisit. A
    // timed-out-but-unanswered question is NOT genuinely answered, so let it
    // fall through to the select-prompt baseline below.
    if (this._completedIdxSet.has(i0) && !this.isTimedOutUnanswered(i0)) {
      const total = this.quizService.totalQuestions();
      const isLast = total > 0 && i0 === total - 1;
      const navMsg = isLast
        ? 'Answered ✓ Click Show Results...'
        : 'Answered ✓ Click Next to continue...';
      this._lastMessageByIndex.set(i0, navMsg);
      this.pushMessage(navMsg, i0);
      return;
    }
    // Count-free for the same reason as the in-flow prompt above: this baseline
    // is pushed when the question first renders, before any answer exists.
    const msg = qType === QuestionType.MultipleAnswer
      ? SELECT_ALL_THAT_APPLY_MSG
      : (i0 === 0 ? START_MSG : CONTINUE_MSG);
    this._lastMessageByIndex.set(i0, msg);
    this.pushMessage(msg, i0);
  }

  public forceBaseline(index: number): void {
    const q = this.getQuestion(index);
    const totalCorrect = (q?.options ?? []).filter((o: any) => o.correct).length;
    const qType = this.resolveQType(q?.type, totalCorrect);

    // Clear released state so enforceBaselineAtInit doesn't skip
    this._baselineReleased.delete(index);
    this._pendingMsgTokens.delete(index);

    this.enforceBaselineAtInit(index, qType, totalCorrect);
  }

  public async setSelectionMessage(isAnswered: boolean): Promise<void> {
    const i0 = this.quizService.currentQuestionIndex;
    const total = this.quizService.totalQuestions();
    if (i0 < 0 || !this._baselineReleased.has(i0) && !isAnswered) return;

    queueMicrotask(() => {
      if (this._pendingMsgTokens.get(i0) === -1) return;
      const msg = this.determineSelectionMessage(i0, total, isAnswered);
      if (this._lastMessageByIndex.get(i0) !== msg) {
        this._lastMessageByIndex.set(i0, msg);
        this.pushMessage(msg, i0);
      }
    });
  }

  public setOptionsSnapshot(opts: Option[] | null | undefined): void {
    const safe = Array.isArray(opts) ? opts.map((o) => ({ ...o })) : [];
    if (safe.length > 0) this.optionsSnapshotSig.set(safe);
  }

  public notifySelectionMutated(options: Option[] | null | undefined): void {
    this.setOptionsSnapshot(options);
  }

  public emitFromClick(params: any): void {
    const opts = params.canonicalOptions as Option[];
    const correctCount = (opts ?? []).filter(
      (o: any) => isOptionCorrect(o)
    ).length;
    const declaredType = params.questionType;
    const qType: QuestionType = this.resolveQType(declaredType, correctCount);

    const msg = this.computeFinalMessage({
      index: params.index,
      total: params.totalQuestions,
      qType,
      opts
    });
    if (params.onMessageChange) params.onMessageChange(msg);
    this.pushMessage(msg, params.index);
  }

  private ensureStableIds(index: number, canonical: Option[], uiSnapshot: any[]): void {
    let fwd = this._idMapByIndex.get(index) ?? new Map<string, string | number>();
    for (const [i, c] of canonical.entries()) {
      const id = c.optionId ?? (c as any).id ?? `q${index}o${i}`;
      c.optionId = id;
      fwd.set(this.stableKey(c, i), id);
      fwd.set(`ix:${i}`, id);
    }
    this._idMapByIndex.set(index, fwd);
    for (const [i, o] of uiSnapshot.entries()) {
      const id = fwd.get(this.stableKey(o as Option, i)) ?? fwd.get(`ix:${i}`);
      if (id != null) (o as any).optionId = id;
    }
  }

  public stableKey(opt: Option, idx?: number): string {
    if (!opt) return `unknown-${idx ?? 0}`;
    if (opt.optionId != null && String(opt.optionId) !== '-1') return String(opt.optionId);
    if ((opt as any).id != null && String((opt as any).id) !== '-1') return String((opt as any).id);
    const v = norm(opt.value);
    const t = norm(opt.text ?? (opt as any).label);
    const core = v || t ? `${v}|${t}` : 'any';
    return `ix:${idx ?? 0}:${core}`;
  }

  private toStableId(o: any, idx?: number): number | string {
    return o?.optionId ?? o?.id ?? o?.value ?? (o?.text ? `t:${o.text}` : `i:${idx ?? 0}`);
  }

  private toOption(o: any, idx: number, selectedOverride?: boolean): Option {
    const id = this.toStableId(o, idx);
    const selected = selectedOverride ?? !!o?.selected;
    return {
      optionId: id as any,
      text: String(o?.text ?? o?.label ?? ''),
      correct: !!(o?.correct ?? o?.isCorrect),
      value: o?.value ?? id,
      selected,
      highlight: selected,
      showIcon: selected,
      feedback: String(o?.feedback ?? ''),
      styleClass: String(o?.styleClass ?? '')
    } as Option;
  }

  public getLatestOptionsSnapshot(): OptionSnapshot[] {
    const snap = this.optionsSnapshotSig();
    return Array.isArray(snap) ? snap.map((o, i) => ({
      id: this.toStableId(o, i),
      selected: !!o.selected,
      correct: typeof o.correct === 'boolean' ? o.correct : undefined
    })) : [];
  }

  public getLatestOptionsSnapshotAsOptions(): Option[] {
    return this.normalizeOptionArray(this.getLatestOptionsSnapshot());
  }

  private normalizeOptionArray(input: any[]): Option[] {
    return (input ?? []).map((item, idx) => {
      if ('id' in item && 'selected' in item) {
        return this.toOption({ ...item, optionId: item.id }, idx);
      }
      return this.toOption(item, idx);
    });
  }

  private collectSelectedKeys(rawSel: any, keyFn: (o: any) => string | number): Set<string | number> {
    const keys = new Set<string | number>();
    if (!rawSel) return keys;
    if (rawSel instanceof Set) {
      for (const s of rawSel) keys.add(s?.optionId ?? s);
    } else if (Array.isArray(rawSel)) {
      for (const o of rawSel) keys.add(keyFn(o));
    }
    return keys;
  }

  public reconcileObservedWithCurrentSelection(index: number, optionsNow: Option[]): void {
    const totalCorrect = optionsNow.filter(o => !!o?.correct).length;
    const q = this.getQuestion(index);
    const qType = this.resolveQType(q?.type, totalCorrect);

    const msg = this.computeFinalMessage({
      index,
      total: this.quizService.totalQuestions(),
      qType,
      opts: optionsNow
    });
    this.setSelectionMessageText(msg);
  }

  public setSelectionMessageText(message: string): void {
    const idx = this.quizService.currentQuestionIndex ?? 0;
    this._clickOverride.set({ idx, msg: message });
  }
}
