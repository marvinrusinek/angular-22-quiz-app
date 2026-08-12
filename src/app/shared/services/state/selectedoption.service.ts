import { Service, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Observable, Subject } from 'rxjs';
import { distinctUntilChanged, map, startWith } from 'rxjs/operators';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { SelectedOption } from '../../models/SelectedOption.model';
import { norm } from '../../utils/text-norm';

import { SK_DISPLAY_MODE, SK_IS_ANSWERED, SK_SAVED_QUESTION_INDEX, SK_SEL_Q, SK_SELECTED_OPTIONS_MAP, SK_USER_ANSWERS } from '../../constants/session-keys';
import { shallowArrayEqual } from '../../utils/shallow-equal';

import { AnswerEvaluationService } from './answer-evaluation.service';
import { NextButtonStateService } from './next-button-state.service';
import { OptionFeedbackStateService } from './option-feedback-state.service';
import { OptionIdResolverService } from './option-id-resolver.service';
import { OptionLockStateService } from './option-lock-state.service';
import { QuestionVerdictService } from '../features/verdict/question-verdict.service';
import type { QuestionCheckResult } from '../features/verdict/question-verdict.types';
import { QuizService } from '../data/quiz.service';
import { SelectionCrudService } from './selection-crud.service';
import { SelectionPersistenceService } from './selection-persistence.service';
import { swallow } from '../../utils/error-logging';

@Service()
export class SelectedOptionService {
  // ── injects ─────────────────────────────────────────────────────
  private answerEval = inject(AnswerEvaluationService);
  private feedbackState = inject(OptionFeedbackStateService);
  private idResolver = inject(OptionIdResolverService);
  private lockState = inject(OptionLockStateService);
  private nextButtonStateService = inject(NextButtonStateService);
  private persistence = inject(SelectionPersistenceService);
  private quizService = inject(QuizService);
  private verdicts = inject(QuestionVerdictService);
  private selectionCrud = inject(SelectionCrudService);

  // ── properties ──────────────────────────────────────────────────
  selectedOption: SelectedOption[] = [];
  selectedOptionsMap = new Map<number, SelectedOption[]>();
  /** The option from the most recent click (set by setSelectedOption). */
  lastClickedOption: SelectedOption | null = null;
  /** Per-question: was the last clicked option correct? Set by QQC directly. */
  lastClickedCorrectByQuestion = new Map<number, boolean>();
  /** Stable click-confirmed dot status. Set on user click, never overwritten
   *  by async evaluations. Only cleared on quiz restart. */
  clickConfirmedDotStatus = new Map<number, 'correct' | 'wrong'>();
  // Direct storage without canonicalization - more reliable for results display
  rawSelectionsMap = new Map<number, { optionId: number; text: string }[]>();
  selectedOptionIndices: { [key: number]: number[] } = {};

  // Durable backup that survives clearState() â€” used for refresh restore.
  _refreshBackup = new Map<number, SelectedOption[]>();

  // Accumulates ALL selections per question (including prior single-answer picks)
  // so that _wasSelected-style highlights survive refresh.
  _selectionHistory = new Map<number, SelectedOption[]>();

  /** Add entries to selection history without replacing existing ones.
   *  Used by the correct-click handler to persist previously-clicked wrong
   *  options so that subsequent saveState() calls don't lose them. */
  addToSelectionHistory(questionIndex: number, entries: SelectedOption[]): void {
    const history = this._selectionHistory.get(questionIndex) ?? [];
    for (const entry of entries) {
      const already = history.some(h =>
        h.optionId === entry.optionId
        && h.displayIndex === entry.displayIndex
      );
      if (!already) history.push(entry);
    }
    this._selectionHistory.set(questionIndex, history);
  }

  // Display-only snapshot of which option TEXTS were selected on a question when
  // the user last navigated away from it. Revisit reads this to repaint the
  // first-visit colors (green for selected-correct, red for selected-wrong)
  // WITHOUT repopulating the selection stores the auto-reveal reads
  // (_multiSelectByQuestion / getSelectedOptionsForQuestion) — so the "all
  // incorrects selected" auto-reveal guard stays intact on the first revisit
  // click. Keyed by display index; texts are normalized.
  private _revisitDisplayByQuestion = new Map<number, Set<string>>();

  /** Snapshot the selected option texts for a question, for revisit repaint. */
  captureRevisitDisplay(questionIndex: number, selectedTexts: string[]): void {
    const set = new Set<string>();
    for (const t of selectedTexts) {
      const n = norm(t);
      if (n) set.add(n);
    }
    if (set.size > 0) {
      this._revisitDisplayByQuestion.set(questionIndex, set);
    }
    // Empty read: leave any existing snapshot intact rather than wiping it. The
    // capture sources (uiSelectedTexts signal) can momentarily read empty due to
    // change-detection timing, and deleting a good snapshot there is exactly what
    // broke "complete a partial multi-answer on revisit".
  }

  /**
   * Texts of the options recorded in _selectionHistory for a question. Unlike the
   * uiSelectedTexts signal, _selectionHistory is written synchronously on every
   * click (SelectionCrudService.setSelectedOptionsForQuestion) and is intact at
   * nav-capture time, so this is a DETERMINISTIC source for the revisit snapshot.
   */
  getSelectionHistoryTextsForQuestion(questionIndex: number): string[] {
    const history = this._selectionHistory.get(questionIndex) ?? [];
    return history
      .filter((s: any) => s && (s.selected || s.highlight || s.showIcon))
      .map((s: any) => s?.text)
      .filter((t: any): t is string => typeof t === 'string' && t.length > 0);
  }

  /** True if this question has a revisit-display snapshot (was engaged). */
  hasRevisitDisplay(questionIndex: number): boolean {
    return (this._revisitDisplayByQuestion.get(questionIndex)?.size ?? 0) > 0;
  }

  /** Was this option (by text) selected when the user last left the question? */
  wasTextSelectedOnLastVisit(questionIndex: number, optionText: string): boolean {
    const set = this._revisitDisplayByQuestion.get(questionIndex);
    return !!set && set.has(norm(optionText));
  }

  /** The first-visit selected-text snapshot for a question (normalized), or undefined. */
  getRevisitDisplayTexts(questionIndex: number): ReadonlySet<string> | undefined {
    return this._revisitDisplayByQuestion.get(questionIndex);
  }

  clearRevisitDisplay(questionIndex: number): void {
    this._revisitDisplayByQuestion.delete(questionIndex);
  }

  // Auto-reveal-INVISIBLE mirror of the current question's selected option texts.
  // The shared-option component publishes it each CD from its live bindings UNION
  // the first-visit _revisitDisplay snapshot, so it holds the COMPLETE selection
  // across visits. The multi-answer "all correct selected" lock reads this
  // (reliable + reactive) instead of selectedOptionsMap, which isn't reliably
  // populated for multi-answer and is wiped on navigation. The auto-reveal never
  // reads it, so surfacing revisit selections here can't retrigger the reveal.
  readonly uiSelectedTextsSig = signal<Map<number, ReadonlySet<string>>>(new Map());

  /** Publish the current question's selected texts (normalized; set-if-different to avoid CD loops). */
  setUiSelectedTextsForQuestion(questionIndex: number, rawTexts: Iterable<string>): void {
    const texts = new Set<string>();
    for (const t of rawTexts) {
      const n = norm(t);
      if (n) texts.add(n);
    }
    const current = this.uiSelectedTextsSig().get(questionIndex);
    if (current && current.size === texts.size && [...texts].every((t) => current.has(t))) {
      return; // unchanged — don't churn the signal
    }
    const next = new Map(this.uiSelectedTextsSig());
    next.set(questionIndex, texts);
    this.uiSelectedTextsSig.set(next);

    // An EMPTY set on a question that had no previous entry is a fresh render,
    // not a selection change — nothing has been chosen yet. Submitting it would
    // fire a check for every question the user merely looks at, which becomes a
    // wasted network round trip once the verdict comes from the API.
    //
    // Deselecting back to empty IS a real change and still submits, because
    // `current` is defined and non-empty in that case.
    const isFreshEmptyRender = texts.size === 0 && current === undefined;
    if (!isFreshEmptyRender) this.submitToVerdictService(questionIndex, texts);
  }

  /**
   * Hand the current selection to the correctness authority.
   *
   * This is the ONLY place a Topic Quiz selection is submitted for evaluation,
   * which matters for two reasons. Correctness queries — highlighting, the
   * timer-stop check — run during rendering and must stay side-effect free, so
   * the write has to live on the selection path rather than inside a predicate.
   * And when Stage 10 makes evaluation asynchronous, this is the single point
   * that becomes a network call.
   *
   * Identity is (quizId, exact questionText) with options addressed by text —
   * never an id or an index.
   *
   * `norm()` above is trim + lowercase; the verdict service canonicalizes with
   * NFC + trim + collapse-whitespace + lowercase, so it accepts these strings
   * unchanged. (The bank contains no field with internal double spaces, so the
   * one difference between the two never arises in practice.)
   */
  private submitToVerdictService(questionIndex: number, texts: ReadonlySet<string>): void {
    try {
      const quizId = this.quizService?.quizId;
      const questionText = this.quizService?.questionsSig?.()?.[questionIndex]?.questionText;
      if (!quizId || !questionText) return;

      // Fire and forget: the verdict lands in the service's own state, which
      // consumers read. Errors are swallowed deliberately — a failed check must
      // leave the LAST CONFIRMED verdict in place rather than clearing it, and
      // the service already records an `error` phase for callers that care.
      this.verdicts
        .checkAnswer(quizId, questionText, [...texts])
        .subscribe({
          next: (result) => {
            // CREDIT ON ARRIVAL. Click-time scoring cannot decide a
            // multi-answer question under the API adapter — the check is still
            // in flight — so it defers and the point is applied here, where the
            // authorized verdict actually lands.
            //
            // This subscription is used rather than an Angular effect because
            // it provably runs: an effect in QuizScoringService was tried and
            // silently never scheduled in this zoneless app.
            //
            // Only resolved-CORRECT credits: `resolved` alone is not enough
            // (a single-answer question resolves on a wrong click too), and
            // the credit itself is idempotent per question.
            if (result?.status === 'resolved' && result.correct === true) {
              this.quizService?.scoringService?.creditResolvedQuestion(quizId, questionText);
            }

            this.applyAuthorizedMultiCompletion(questionText, texts, result);
          },
          error: () => { /* last confirmed state is retained */ }
        });
    } catch (err: unknown) {
      swallow('selectedoption.service#submitToVerdictService', err);
    }
  }

  /**
   * Multi-answer completion, established by the AUTHORIZED verdict.
   *
   * Completion used to be decided on the click, from a correct-option count
   * taken off the local bank. Under the API adapter the check is still in
   * flight at that moment, so that count was the only thing available — which
   * meant "this question is finished" was an answer-key claim, not an
   * authorized one.
   *
   * ── What counts as completion ──────────────────────────────────────
   *
   * `resolved` only. `incomplete` is explicitly not complete (the backend
   * returns no correct set at all for it), and `expired` is the timeout
   * lifecycle — a reveal the user did not earn by answering — so it must not
   * masquerade as completion here.
   *
   * ── How we know it is MULTI-answer ─────────────────────────────────
   *
   * From `correctOptionTexts.length > 1`, which is authorized terminal data,
   * NOT a bank scan. A single-answer question resolves too, and recording
   * multi-answer completion for it is exactly the category error the old
   * union made.
   *
   * ── Why the index is resolved by TEXT ──────────────────────────────
   *
   * These maps are keyed by DISPLAY index, which diverges from the canonical
   * index under shuffle (see resolveScoringContext, which self-heals the two
   * separately and warns that keying the perfect flags by the wrong one stops
   * the FET showing). This method only has the question's identity, so it
   * fingerprints the display order — position is derived, never assumed.
   */
  private applyAuthorizedMultiCompletion(
    questionText: string,
    submitted: ReadonlySet<string>,
    result: QuestionCheckResult | null | undefined
  ): void {
    try {
      if (result?.status !== 'resolved') return;

      const correctTexts = result.correctOptionTexts ?? [];
      if (correctTexts.length <= 1) return;   // single-answer: not a multi fact

      const displayIdx = this.resolveDisplayIndexByText(questionText);
      if (displayIdx < 0) return;

      const qs = this.quizService;
      if (!qs) return;

      // Idempotent by construction: these are set-to-true writes on a keyed
      // map, so a replayed or duplicated terminal verdict writes the same
      // value and triggers no second transition.
      qs.markMultiAnswerComplete?.(displayIdx);
      qs.markQuestionResolved?.(displayIdx);

      // PERFECT is strictly stronger — completion AND nothing wrong picked.
      // Both halves come from authorized data: the revealed correct set, and
      // the user's own submitted selection.
      const correctSet = new Set(correctTexts.map((t) => norm(t)));
      const anyWrongPicked = [...submitted].some((t) => !correctSet.has(norm(t)));
      if (!anyWrongPicked) {
        qs.markMultiAnswerPerfect?.(displayIdx);
      }
    } catch (err: unknown) {
      swallow('selectedoption.service#applyAuthorizedMultiCompletion', err);
    }
  }

  /** Display position of a question, by text fingerprint. -1 when not found. */
  private resolveDisplayIndexByText(questionText: string): number {
    const target = norm(questionText);
    if (!target) return -1;

    const displayQs: any[] = this.quizService?.getQuestionsInDisplayOrder?.() ?? [];
    const found = displayQs.findIndex((q: any) => norm(q?.questionText) === target);
    if (found >= 0) return found;

    // Unshuffled runs may not expose a display-order array; the canonical list
    // IS the display order then.
    const canonical: any[] = this.quizService?.questions ?? [];
    return canonical.findIndex((q: any) => norm(q?.questionText) === target);
  }

  /** Reactive read of the current question's UI-selected texts (for the M-A lock). */
  uiSelectedTextsForQuestion(questionIndex: number): ReadonlySet<string> {
    return this.uiSelectedTextsSig().get(questionIndex) ?? new Set<string>();
  }

  wasOptionSelectedForQuestion(questionIndex: number, optionText: string): boolean {
    const normalizedText = norm(optionText);

    return (this._selectionHistory.get(questionIndex) ?? []).some(
      (selected: SelectedOption) => norm(selected?.text) === normalizedText
    );
  }

  get hasRefreshBackup(): boolean {
    return this._refreshBackup.size > 0;
  }

  getRefreshBackup(idx: number): SelectedOption[] {
    return this._refreshBackup.get(idx) ?? [];
  }

  clearRefreshBackup(): void {
    this._refreshBackup.clear();
  }

  // â”€â”€ Signal-first state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  readonly selectedOptionSig = signal<SelectedOption[]>([]);
  selectedOption$ = toObservable(this.selectedOptionSig);

  readonly selectedOptionExplanationSig = signal<string>('');
  selectedOptionExplanation$ = toObservable(this.selectedOptionExplanationSig);

  readonly isOptionSelectedSig = signal<boolean>(false);

  readonly isAnsweredSig = signal<boolean>(false);
  isAnswered$: Observable<boolean> = toObservable(this.isAnsweredSig);
  public answered$ = this.isAnswered$;

  private _questionCache = new Map<number, QuizQuestion>();

  readonly questionTextSig = signal<string>('');
  questionText$ = toObservable(this.questionTextSig);

  readonly selectedOptionsMapSig = signal<Map<number, SelectedOption[]>>(new Map());
  public selectedOptionsMap$ = toObservable(this.selectedOptionsMapSig);

  optionSnapshotByQuestion = new Map<number, Option[]>();

  readonly isNextButtonEnabledSig = signal<boolean>(false);
  // Initialized as a field so toObservable() runs in field-initializer
  // injection context. Calling toObservable() lazily from a getter
  // (the previous shape) throws NG0203 because consumers like
  // QuizInitializationService.initializeAnswerSync read it from
  // outside the injection context.
  public isNextButtonEnabled$ = toObservable(this.isNextButtonEnabledSig);

  stopTimer$ = new Subject<void>();
  stopTimerEmitted = false;

  currentQuestionType: QuestionType | null = null;
  // Lock state delegated to OptionLockStateService
  public get _lockedOptionsMap(): Map<number, Set<number>> {
    return this.lockState._lockedOptionsMap;
  }

  set isNextButtonEnabled(value: boolean) {
    this.isNextButtonEnabledSig.set(value);
  }

  // ── constructor / lifecycle ─────────────────────────────────────
  constructor() {
    this.loadState();
    const index$ = this.quizService?.currentQuestionIndex$;
    if (index$) {
      index$.pipe(distinctUntilChanged()).subscribe(() => {
        this.stopTimerEmitted = false;
      });
    }

    // Reset Sync: Automatically clear all selections when QuizService resets
    this.quizService.quizReset$.subscribe(() => {
      this.resetAllOptions();
    });
  }

  // ── public methods ──────────────────────────────────────────────
  isSelectedOption(option: Option): boolean {
    return (
      this.selectedOption?.some((sel) => sel.optionId === option.optionId) ??
      false
    );
  }

  // Helper to sync state from external components (like SharedOptionComponent)
  syncSelectionState(questionIndex: number, options: SelectedOption[]): void {
    this.selectionCrud.syncSelectionState(this, questionIndex, options);
  }

  persistAnswerForResults(questionIndex: number, selections: { optionId: number; text: string }[]): void {
    this.persistence.persistAnswerForResults(questionIndex, selections);
  }

  public recoverAnswersForResults(): void {
    this.persistence.recoverAnswersForResults(this.rawSelectionsMap);
  }

  public clearAnswersForResults(): void {
    this.persistence.clearAnswersForResults();
  }

  deselectOption(): void {
    this.selectedOptionSig.set([]);
    this.isOptionSelectedSig.set(false);
  }

  // Adds an option to the selectedOptionsMap
  addOption(questionIndex: number, option: SelectedOption): void {
    this.selectionCrud.addOption(this, questionIndex, option);
  }

  // Removes an option from the selectedOptionsMap
  removeOption(questionIndex: number, optionId: number | string, indexHint?: number): void {
    this.selectionCrud.removeOption(this, questionIndex, optionId, indexHint);
  }

  setNextButtonEnabled(enabled: boolean): void {
    this.isNextButtonEnabledSig.set(enabled);  // update the button's enabled state
  }

  clearSelection(): void {
    this.isOptionSelectedSig.set(false);  // no option selected
  }

  clearOtherSelections(questionIndex: number, keepOptionId: number): void {
    const current = this.selectedOptionsMap.get(questionIndex) || [];
    this.selectedOptionsMap.set(
      questionIndex,
      current.filter(o => o.optionId === keepOptionId)
    );
  }

  // (clearAllSelectionsForQuestion removed — was dead code; live callers
  // all use clearSelectionsForQuestion which performs the same wipe of
  // _selectionHistory + sel_Q* in sessionStorage.)

  setSelectedOption(
    option: SelectedOption | null,
    questionIndex?: number,
    optionsSnapshot?: Option[],
    isMultipleAnswer?: boolean
  ): void {
    this.selectionCrud.setSelectedOption(this, option, questionIndex, optionsSnapshot, isMultipleAnswer);
  }

  setSelectedOptions(options: SelectedOption[]): void {
    this.selectionCrud.setSelectedOptions(this, options);
  }

  setSelectedOptionsForQuestion(
    questionIndex: number,
    newSelections: SelectedOption[]
  ): void {
    this.selectionCrud.setSelectedOptionsForQuestion(this, questionIndex, newSelections);
  }

  setSelectionsForQuestion(qIndex: number, selections: SelectedOption[]): void {
    this.selectionCrud.setSelectionsForQuestion(this, qIndex, selections);
  }

  getSelectedOptions(): SelectedOption[] {
    const combined: SelectedOption[] = [];

    for (const [, opts] of this.selectedOptionsMap) {
      if (Array.isArray(opts)) combined.push(...opts);
    }

    return combined;
  }

  public getSelectedOptionsForQuestion(
    questionIndex: number
  ): SelectedOption[] {
    const options = this.selectedOptionsMap.get(questionIndex) || [];
    const backup = this._refreshBackup.get(questionIndex) || [];

    const merged = new Map<string, SelectedOption>();
    const keyOf = (o: any) =>
      `${o?.optionId ?? '?'}|${o?.displayIndex ?? o?.index ?? -1}`;

    // 1. Durable sessionStorage FIRST â€” the cleanest source of truth.
    try {
      const storedStr = sessionStorage.getItem(SK_SEL_Q + questionIndex);
      if (storedStr) {
        const parsed = JSON.parse(storedStr);
        if (Array.isArray(parsed)) {
          for (const o of parsed) {
            if (o) merged.set(keyOf(o), o);
          }
          // Union in _selectionHistory so any prev-clicked entries that were
          // lost from sel_Q* (e.g. an intermediate saveState wrote only the
          // current selection) still surface for the UI. Only add if not
          // already present by composite key.
          const fromHistory = this._selectionHistory.get(questionIndex) ?? [];
          for (const h of fromHistory) {
            if (!h || h.optionId == null) continue;
            if (h.highlight !== true || h.showIcon !== true) continue;
            const k = keyOf(h);
            if (!merged.has(k)) {
              merged.set(k, { ...h, selected: false } as any);
            }
          }
        }
      }
    } catch (err: unknown) { swallow('selectedoption.service.ts', err); /* ignore */ }

    // 2. Fall back to in-memory maps only if sel_Q* had nothing.
    //    During live interaction sel_Q* may not be written yet, so
    //    the in-memory maps are needed.
    if (merged.size === 0) {
      for (const o of backup) if (o) merged.set(keyOf(o), o);
      for (const o of options) if (o) merged.set(keyOf(o), o);
    }

    return Array.from(merged.values());
  }

  public areAllCorrectAnswersSelected(
    question: QuizQuestion,
    selectedOptionIds: Set<number>
  ): boolean {
    return this.answerEval.areAllCorrectAnswersSelected(question, selectedOptionIds);
  }

  clearSelectionsForQuestion(questionIndex: number, preserveHistory = false): void {
    const idx = Number(questionIndex);
    if (!Number.isFinite(idx)) return;
    // Remove from selection and feedback maps
    if (this.selectedOptionsMap.has(idx)) this.selectedOptionsMap.delete(idx);
    // Preserve _selectionHistory for a scored-correct question (caller passes
    // preserveHistory=true) so revisit can re-render its clicked-wrong option red
    // via wasClickedIncorrectOnRevisit. Everything else below is still cleared so
    // navigation/lock state stays consistent. Wrong-only questions clear history.
    if (!preserveHistory) this._selectionHistory.delete(idx);
    // _refreshBackup is the in-memory fallback that getSelectedOptionsForQuestion
    // reads when sessionStorage is empty — without clearing it, prior clicks
    // resurface and the autoreveal "all incorrects selected" check fires
    // on the very first new click of a 2nd-visit question.
    this._refreshBackup.delete(idx);

    this.feedbackState.deleteFeedbackForQuestion(idx);
    this.optionSnapshotByQuestion?.delete(idx);

    // Clear any lingering lock states. clearLockedOptionsMap only wipes
    // _lockedOptionsMap; unlockAllOptionsForQuestion also wipes
    // _lockedByQuestion, which option-ui-sync populates via lockOption()
    // for every disabled binding and which persists across navigation,
    // causing 2nd-visit options to remain disabled.
    this.lockState.clearLockedOptionsMap(idx);
    this.lockState.unlockAllOptionsForQuestion(idx);

    // Clear the durable per-question sessionStorage key — shared-option
    // binding rebuild reads sel_Q<idx> as its source, so leaving it in
    // place rehydrates the prior selections after the in-memory clear.
    this.persistence.clearPerQuestionSessionKey(idx);

    // Propagate to the reactive signal — option-item.isDisabled reads
    // selectedOptionsMapSig (not the raw Map), so without this push,
    // sibling bindings still see the stale entry and stay disabled.
    this.selectedOptionsMapSig.set(new Map(this.selectedOptionsMap));

    // Clear this question's answer state — ONLY if the question
    // was NOT scored correct. For genuinely-perfect multi-answer questions,
    // the flag must survive so revisit rehydrate renders the green/gray
    // highlight. Partial/wrong answers never set this flag, so the delete
    // is a no-op for those cases anyway.
    if (this.quizService.questionCorrectness?.get?.(idx) !== true) {
      this.quizService.clearAnswerStateAt(idx);
    }
  }

  // Method to get the current option selected state
  getCurrentOptionSelectedState(): boolean {
    return this.isOptionSelectedSig();
  }

  getFeedbackForQuestion(questionIndex: number): Record<string, boolean> {
    return this.feedbackState.getFeedbackForQuestion(questionIndex);
  }

  republishFeedbackForQuestion(questionIndex: number): void {
    const selections = this.selectedOptionsMap.get(questionIndex) ?? [];
    this.feedbackState.republishFeedbackForQuestion(
      questionIndex,
      selections,
      this.quizService?.currentQuestionIndex,
      this.isMultiAnswerQuestion(questionIndex)
    );
  }

  // Method to update the selected option state
  public async selectOption(
    optionId: number,
    questionIndex: number,
    text: string,
    isMultiSelect: boolean,
    optionsSnapshot?: Option[]
  ): Promise<void> {
    return this.selectionCrud.selectOption(this, optionId, questionIndex, text, isMultiSelect, optionsSnapshot);
  }

  isOptionCurrentlySelected(option: Option): boolean {
    if (!option) return false;

    const currentIndex = this.quizService?.currentQuestionIndex ?? null;
    const indices =
      currentIndex != null
        ? [currentIndex] : Array.from(this.selectedOptionsMap.keys());

    const normId = this.idResolver.normalizeOptionId(option.optionId);
    const normText = this.idResolver.normalizeStr(option.text);
    const normValue = this.idResolver.normalizeStr((option as any)?.value);

    for (const qIndex of indices) {
      const selections = this.selectedOptionsMap.get(qIndex) ?? [];

      const match = selections.some((sel) => {
        if (!sel) return false;
        if (sel.questionIndex !== qIndex) return false;

        const selId = this.idResolver.normalizeOptionId(sel.optionId);
        const selText = this.idResolver.normalizeStr(sel.text);
        const selValue = this.idResolver.normalizeStr((sel as any)?.value);

        return (
          (normId !== null && normId === selId) ||
          (normText && normText === selText) ||
          (normValue && normValue === selValue)
        );
      });

      if (match) return true;
    }

    return false;
  }

  clearSelectedOption(): void {
    if (this.currentQuestionType === QuestionType.MultipleAnswer) {
      // Clear all selected options for multiple-answer questions (Question scoped)
      const idx = this.quizService.currentQuestionIndex;
      if (typeof idx === 'number') {
        this.selectedOptionsMap.delete(idx);
        this.feedbackState.deleteFeedbackForQuestion(idx);
        this.optionSnapshotByQuestion.delete(idx);
      }
    } else {
      // Clear the single selected option for single-answer questions
      this.selectedOption = [];
      this.selectedOptionSig.set([]);

      const activeIndex = Number.isInteger(
        this.quizService?.currentQuestionIndex,
      )
        ? (this.quizService.currentQuestionIndex as number)
        : null;

      if (activeIndex !== null) {
        this.feedbackState.deleteFeedbackForQuestion(activeIndex);
        this.optionSnapshotByQuestion.delete(activeIndex);
      } else {
        this.feedbackState.clearAll();
        this.optionSnapshotByQuestion.clear();
      }
    }

  }

  clearOptions(): void {
    this.selectedOptionSig.set([]);
    this.feedbackState.clearAll();
    this.optionSnapshotByQuestion.clear();
  }

  // Observable to get the current option selected state
  isOptionSelected$(): Observable<boolean> {
    return this.selectedOption$.pipe(
      startWith(this.selectedOptionSig()),  // emit the current state immediately when subscribed
      map((option) => option !== null),  // determine if an option is selected
      distinctUntilChanged()  // emit only when the selection state changes
    );
  }

  // Method to set the option selected state
  setOptionSelected(isSelected: boolean): void {
    if (this.isOptionSelectedSig() !== isSelected) {
      this.isOptionSelectedSig.set(isSelected);
    }
  }

  getSelectedOptionIndices(questionIndex: number): number[] {
    const selectedOptions = this.selectedOptionsMap.get(questionIndex) || [];
    return selectedOptions
      .map((option) => option.optionId)
      .filter((id): id is number => id !== undefined);
  }

  addSelectedOptionIndex(questionIndex: number, optionIndex: number): void {
    this.selectionCrud.addSelectedOptionIndex(this, questionIndex, optionIndex);
  }

  removeSelectedOptionIndex(questionIndex: number, optionIndex: number): void {
    this.selectionCrud.removeSelectedOptionIndex(this, questionIndex, optionIndex);
  }

  // Add (and persist) one option for a question
  public addSelection(questionIndex: number, option: SelectedOption): void {
    this.selectionCrud.addSelection(this, questionIndex, option);
  }

  // Method to add or remove a selected option for a question
  public updateSelectionState(
    questionIndex: number,
    selectedOption: SelectedOption,
    isMultiSelect: boolean
  ): void {
    this.selectionCrud.updateSelectionState(this, questionIndex, selectedOption, isMultiSelect);
  }

  updateSelectedOptions(
    questionIndex: number,
    optionIndex: number,
    action: 'add' | 'remove'
  ): void {
    this.selectionCrud.updateSelectedOptions(this, questionIndex, optionIndex, action);
  }

  updateAnsweredState(
    questionOptions: Option[] = [],
    questionIndex: number = -1
  ): void {
    try {
      const resolvedIndex = this.resolveEffectiveQuestionIndex(
        questionIndex,
        questionOptions
      );

      if (resolvedIndex == null || resolvedIndex < 0) {
        return;  // unable to resolve a valid question index
      }

      const snapshot = this.buildCanonicalSelectionSnapshot(
        resolvedIndex,
        questionOptions
      );

      if (!Array.isArray(snapshot) || snapshot.length === 0) return;

      const isAnswered = snapshot.some((option) =>
        this.idResolver.coerceToBoolean(option.selected)
      );
      this.isAnsweredSig.set(isAnswered);
    } catch (err: unknown) {
      console.error('SelectedOptionService.updateAnsweredState state evaluation failed:', err);
    }
  }

  private resolveEffectiveQuestionIndex(
    explicitIndex: number,
    questionOptions: Option[]
  ): number | null {
    if (typeof explicitIndex === 'number' && explicitIndex >= 0) {
      return explicitIndex;
    }

    const optionIndexFromPayload = Array.isArray(questionOptions)
      ? questionOptions
        .map((opt) => (opt as SelectedOption)?.questionIndex)
        .find((idx) => typeof idx === 'number' && idx >= 0)
      : undefined;
    if (typeof optionIndexFromPayload === 'number') {
      return optionIndexFromPayload;
    }

    const currentIndex = this.quizService?.getCurrentQuestionIndex?.();
    if (typeof currentIndex === 'number' && currentIndex >= 0) {
      return currentIndex;
    }

    const fallbackIndex = this.getFallbackQuestionIndex();
    return fallbackIndex >= 0 ? fallbackIndex : null;
  }

  private buildCanonicalSelectionSnapshot(
    questionIndex: number,
    _overrides: Option[]
  ): Option[] {
    return this.idResolver.buildCanonicalSelectionSnapshot(
      questionIndex,
      this.selectedOptionsMap,
      this.quizService
    );
  }

  isMultiAnswerQuestion(questionIndex: number): boolean {
    return this.answerEval.isMultiAnswerQuestion(questionIndex);
  }

  commitSelections(
    questionIndex: number,
    selections: SelectedOption[]
  ): SelectedOption[] {
    // Always normalize to numeric key
    const idx = Number(questionIndex);
    if (!Number.isFinite(idx) || idx < 0) return [];

    // Canonicalize and deep clone the selections
    const canonicalSelections = this.idResolver.canonicalizeSelectionsForQuestion(
      idx,
      selections
    ).map((sel) => ({ ...sel }));  // ensure new object identity

    // Do NOT force highlight/showIcon here â€” let calling logic or sync methods decide
    // based on multi-answer rules (e.g. only highlight the last selection).

    if (canonicalSelections.length > 0) {
      // Replace the old bucket completely
      this.selectedOptionsMap.set(idx, canonicalSelections);
    } else {
      this.selectedOptionsMap.delete(idx);
      this.optionSnapshotByQuestion.delete(idx);
    }

    // Propagate changes to the reactive map
    this.selectedOptionsMapSig.set(new Map(this.selectedOptionsMap));

    this.syncFeedbackForQuestion(idx, canonicalSelections);

    // Update the "Answered" state whenever selections change.
    // This drives the Next Button enablement.
    this.updateAnsweredState(canonicalSelections, idx);

    // Sync user answers to QuizService
    const ids = canonicalSelections
      .map((o) => o.optionId)
      .filter((id) => id !== null && id !== undefined)
      .map(id => typeof id === 'string' ? parseInt(id, 10) : id as number);

    this.quizService.updateUserAnswer(idx, ids);

    // Store FINAL selections in rawSelectionsMap for reliable results display
    // Use canonicalSelections (the processed final state), not the input
    if (canonicalSelections.length > 0) {
      const rawSelections = canonicalSelections
        .filter(s => s)
        .map(s => ({
          optionId: typeof s.optionId === 'number' ? s.optionId : -1,
          text: s.text || ''
        }))
        .filter(s => s.optionId >= 0 || s.text);

      this.rawSelectionsMap.set(idx, rawSelections);
    } else {
      // Clear when no selections
      this.rawSelectionsMap.delete(idx);
    }

    return canonicalSelections;
  }

  private syncFeedbackForQuestion(
    questionIndex: number,
    selections: SelectedOption[]
  ): void {
    this.feedbackState.syncFeedbackForQuestion(
      questionIndex,
      selections,
      this.quizService?.currentQuestionIndex,
      this.isMultiAnswerQuestion(questionIndex)
    );
  }

  public isQuestionAnswered(questionIndex: number): boolean {
    return !!this.selectedOptionsMap.get(questionIndex)?.length
      || !!this._refreshBackup.get(questionIndex)?.length;
  }

  setAnswered(isAnswered: boolean, force = false): void {
    const current = this.isAnsweredSig();
    if (force || current !== isAnswered) {
      this.isAnsweredSig.set(isAnswered);
      sessionStorage.setItem(SK_IS_ANSWERED, JSON.stringify(isAnswered));
    }
  }

  setAnsweredState(isAnswered: boolean): void {
    this.isAnsweredSig.set(isAnswered);
  }

  getAnsweredState(): boolean {
    return this.isAnsweredSig();
  }

  private loadState(): void {
    this.persistence.loadState(this as any);
  }

  saveState(): void {
    this.persistence.saveState(this as any);
  }

  public clearState(): void {
    this.selectedOptionsMap.clear();
    this.rawSelectionsMap.clear();
    this._selectionHistory.clear();
    this._revisitDisplayByQuestion.clear();
    this.uiSelectedTextsSig.set(new Map());
    this.selectedOption = [];
    this.selectedOptionIndices = {};
    this.feedbackState.clearAll();
    this.optionSnapshotByQuestion.clear();
    this.lockState.clearAll();
    this.isAnsweredSig.set(false);
    this.isOptionSelectedSig.set(false);
    this.selectedOptionsMapSig.set(new Map());

    try {
      this.persistence.clearSessionKeys();
      // Clear per-question selection keys used by rehydrateUiFromState
      const keysToRemove: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(SK_SEL_Q) || key?.startsWith(SK_DISPLAY_MODE)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) sessionStorage.removeItem(key);
    } catch (err: unknown) {
      console.error('SelectedOptionService.clearState session key cleanup failed:', err);
    }
  }

  /**
   * Used by the constructor's `quizReset$` subscriber. Differs from
   * `clearState()` only in that it ALSO emits via `selectedOptionSig`
   * (the array signal) — `clearState` resets the underlying
   * `this.selectedOption` field but doesn't push to the signal.
   * The trailing `isOptionSelectedSig`/`isAnsweredSig` writes are
   * idempotent re-emissions of values `clearState` already set.
   */
  public resetAllOptions(): void {
    this.clearState();
    this.selectedOptionSig.set([]);
    this.isOptionSelectedSig.set(false);
    this.isAnsweredSig.set(false);
  }

  resetSelectionState(): void {
    this.selectedOptionsMap.clear();
    this.selectedOption = [];
    this.selectedOptionSig.set([]);
    this.isOptionSelectedSig.set(false);
  }

  public resetOptionState(
    questionIndex?: number,
    optionsToDisplay?: Option[]
  ): void {
    try {
      if (typeof questionIndex === 'number') {
        const opts = this.selectedOptionsMap.get(questionIndex) ?? [];
        const cleared = opts.map((o) => ({
          ...o,
          selected: false,
          highlight: false,
          showIcon: false,
          disabled: false
        }));
        this.selectedOptionsMap.set(questionIndex, cleared);
      } else {
        this.selectedOptionsMap.clear();
      }

      // Also reset any visible array directly bound to the template
      if (Array.isArray(optionsToDisplay)) {
        for (const o of optionsToDisplay) {
          o.selected = false;
          o.highlight = false;
          o.showIcon = false;
          (o as any).disabled = false;
        }
      }
    } catch (err: unknown) {
      console.error('SelectedOptionService.resetOptionState option state reset failed:', err);
    }
  }

  public resetAllStates(): void {
    try {
      this.selectedOptionsMap.clear();
      this.lockState.clearLockedOptionsMap();
    } catch (err: unknown) {
      console.error('SelectedOptionService.resetAllStates map clear failed:', err);
    }
  }

  getFallbackQuestionIndex(): number {
    return this.selectedOptionsMap.keys().next().value ?? -1;
  }

  public evaluateNextButtonStateForQuestion(
    questionIndex: number,
    isMultiSelect: boolean,
    allowEmptySelection = false
  ): void {
    // Defer to ensure setSelectedOption has updated the map this tick
    queueMicrotask(() => {
      const selected = this.selectedOptionsMap.get(questionIndex) ?? [];

      if (allowEmptySelection) {
        // Timer-expiry or external overrides may allow progression without a choice.
        // Preserve the "answered" state while keeping selection tracking honest.
        const anySelected = selected.length > 0;

        this.setAnswered(true);
        this.isOptionSelectedSig.set(anySelected);
        this.nextButtonStateService.setNextButtonState(true);

        return;
      }

      if (!isMultiSelect) {
        // Single â†’ deterministic on first selection
        this.setAnswered(true);  // stream sees answered=true
        this.isOptionSelectedSig.set(true);
        this.nextButtonStateService.setNextButtonState(true);
        return;
      }

      // Multi â†’ enable on ANY selection (your policy)
      const anySelected = selected.length > 0;

      // Tell the stream it's answered so it wonâ€™t re-disable the button
      this.setAnswered(anySelected);

      this.isOptionSelectedSig.set(anySelected);
      this.nextButtonStateService.setNextButtonState(anySelected);
    });
  }

  isOptionLocked(qIndex: number, optId: string | number): boolean {
    return this.lockState.isOptionLocked(qIndex, optId);
  }

  lockOption(qIndex: number, optId: string | number): void {
    this.lockState.lockOption(qIndex, optId);
  }

  unlockOption(qIndex: number, optId: string | number): void {
    this.lockState.unlockOption(qIndex, optId);
  }

  unlockAllOptionsForQuestion(qIndex: number): void {
    this.lockState.unlockAllOptionsForQuestion(qIndex);
  }

  lockMany(qIndex: number, optIds: (string | number)[]): void {
    this.lockState.lockMany(qIndex, optIds);
  }

  lockQuestion(qIndex: number): void {
    this.lockState.lockQuestion(qIndex);
  }

  unlockQuestion(qIndex: number): void {
    this.lockState.unlockQuestion(qIndex);
  }

  isQuestionLocked(qIndex: number): boolean {
    return this.lockState.isQuestionLocked(qIndex);
  }

  resetLocksForQuestion(qIndex: number): void {
    this.lockState.resetLocksForQuestion(qIndex);
  }

  public overlaySelectedByIdentity(canonical: Option[], ui: Option[]): Option[] {
    return this.idResolver.overlaySelectedByIdentity(canonical, ui);
  }

  ensureBucket(idx: number): SelectedOption[] {
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    if (!this.selectedOptionsMap.has(idx)) this.selectedOptionsMap.set(idx, []);
    return this.selectedOptionsMap.get(idx)!;
  }

  public reapplySelectionForQuestion(option: Option, _index: number): void {
    option.selected = true;  // mark as selected again
    this.setAnswered(true);  // mark question as answered
  }

  public storeQuestion(index: number, question: QuizQuestion): void {
    if (question) this._questionCache.set(index, question);
  }

  public isQuestionComplete(
    question: QuizQuestion,
    selected: SelectedOption[]
  ): boolean {
    return this.answerEval.isQuestionComplete(question, selected);
  }

  public isQuestionResolvedCorrectly(
    question: QuizQuestion,
    selected: Array<SelectedOption | Option> | null
  ): boolean {
    return this.answerEval.isQuestionResolvedCorrectly(question, selected);
  }

  public getResolutionStatus(
    question: QuizQuestion,
    selected: Option[],
    strict: boolean = false
  ) {
    return this.answerEval.getResolutionStatus(question, selected, strict);
  }

  public getSelectedOptionsForQuestion$(idx: number): Observable<any[]> {
    return this.selectedOptionsMap$.pipe(
      map(() => {
        const normalizedIdx = this.idResolver.normalizeIdx(idx);
        return this.getSelectedOptionsForQuestion(normalizedIdx) ?? [];
      }),
      distinctUntilChanged((a, b) => shallowArrayEqual(a, b))
    );
  }

  clearAllSelectionsForQuiz(quizId: string): void {
    this.selectedOptionsMap.clear();
    this.rawSelectionsMap.clear();
    this.selectedOptionIndices = {};
    this._questionCache.clear();
    this.feedbackState.clearAll();
    this.optionSnapshotByQuestion.clear();
    this.lockState.clearAll();
    this.selectedOption = [];
    this.selectedOptionSig.set([]);
    this.isOptionSelectedSig.set(false);
    this.isAnsweredSig.set(false);

    // Also clear the durable results store for a fresh start
    this.clearAnswersForResults();

    try {
      localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      localStorage.removeItem(SK_USER_ANSWERS);
      localStorage.removeItem(SK_SAVED_QUESTION_INDEX);
      localStorage.removeItem('currentQuestionIndex');
      localStorage.removeItem(`quizState_${quizId}`);
      localStorage.removeItem(`selectedOptions_${quizId}`);
    } catch (err: unknown) {
      console.error('SelectedOptionService.clearAllSelectionsForQuiz localStorage cleanup failed:', err);
    }
  }
}