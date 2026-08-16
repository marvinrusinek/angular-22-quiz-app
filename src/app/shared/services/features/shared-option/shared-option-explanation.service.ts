import { Service, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { filter, take } from 'rxjs/operators';

import { SK_SEL_Q } from '../../../constants/session-keys';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { authorizedExplanation } from '../verdict/authorized-correctness';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { resolveIsMultiAnswer } from '../../../utils/question-type-authority';

/**
 * Context passed from the component for explanation resolution.
 */
export interface ExplanationContext {
  /** The resolved display index for the question */
  resolvedIndex: number;
  /** The question object (already resolved from display index) */
  question: QuizQuestion | null;
  /** The current question from the component (may be stale) */
  currentQuestion: QuizQuestion | null;
  /** The quiz ID */
  quizId: string;
  /** Option bindings currently rendered */
  optionBindings: OptionBindings[];
  /** Options to display (input property) */
  optionsToDisplay: Option[];
  /** Whether this is a multi-answer question */
  isMultiMode: boolean;
}

@Service()
export class SharedOptionExplanationService {
  pendingExplanationIndex = -1;

  private explanationTextService = inject(ExplanationTextService);
  private verdicts = inject(QuestionVerdictService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);

  // ═══════════════════════════════════════════════════════════════════════
  // Main Explanation Emission
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resolves the question index, applies stale-call guard, builds context,
   * and delegates to emitExplanation. Called from the component's thin wrapper.
   */
  resolveAndEmitExplanation(params: {
    questionIndex: number;
    activeQuestionIndex: number;
    currentQuestion: QuizQuestion | null;
    quizId: string;
    optionBindings: OptionBindings[];
    optionsToDisplay: Option[];
    isMultiMode: boolean;
    getQuestionAtDisplayIndex: (idx: number) => QuizQuestion | null;
  }, skipGuard = false): void {
    const { questionIndex, activeQuestionIndex, currentQuestion, getQuestionAtDisplayIndex } = params;

    const resolvedIndex = Number.isFinite(activeQuestionIndex)
      ? Math.max(0, Math.trunc(activeQuestionIndex))
      : Number.isFinite(questionIndex)
        ? Math.max(0, Math.trunc(questionIndex))
        : this.resolveExplanationQuestionIndex(questionIndex, activeQuestionIndex);

    const question =
      getQuestionAtDisplayIndex(resolvedIndex)
      ?? currentQuestion
      ?? this.quizService.questions?.[resolvedIndex]
      ?? null;

    // Guard: Prevent stale deferred calls from emitting for the wrong question.
    if (currentQuestion && resolvedIndex !== questionIndex) {
      const questionAtIndex = getQuestionAtDisplayIndex(resolvedIndex)
        ?? this.quizService.getQuestionsInDisplayOrder?.()?.[resolvedIndex]
        ?? this.quizService.questions?.[resolvedIndex];
      if (questionAtIndex && questionAtIndex.questionText !== currentQuestion.questionText) {
        return;
      }
    }

    const ctx: ExplanationContext = {
      resolvedIndex,
      question,
      currentQuestion,
      quizId: params.quizId,
      optionBindings: params.optionBindings,
      optionsToDisplay: params.optionsToDisplay,
      isMultiMode: params.isMultiMode
    };

    this.emitExplanation(ctx, skipGuard);
  }

  /**
   * Evaluates whether the question is resolved, then formats and emits
   * the explanation text through all required service channels.
   */
  emitExplanation(ctx: ExplanationContext, skipGuard = false): void {
    const { resolvedIndex, question } = ctx;

    // Guard: Emit FET only when the question is resolved correctly.
    // Use display-order question source to handle shuffled mode correctly.
    const authQ = this.quizService.getQuestionsInDisplayOrder?.()?.[resolvedIndex]
      ?? this.quizService.questions?.[resolvedIndex] ?? question;

    if (!skipGuard) {
      if (authQ && Array.isArray(authQ.options)) {
        const resolved = this.checkResolution(ctx);
        if (!resolved) return;
      } else if (!question || !Array.isArray(question?.options)) {
        // No question data available — cannot verify resolution. Block FET.
        return;
      }
    }

    // `|| question?.explanation` used to sit here as a last-ditch fallback. It
    // is gone: the resolver above already answers from the verdict, so this
    // could only ever have supplied text the verdict had refused to authorize.
    const explanationText = this.resolveExplanationText(ctx)?.trim() ?? '';

    if (!explanationText) {
      // NOT NECESSARILY "no explanation" — far more often "not yet".
      //
      // Under the API adapter the check is still in flight at click time, so a
      // single-answer question emits its FET on the very click whose verdict
      // has not landed. Reading the bank made that invisible; reading the
      // verdict makes it the normal case, and returning here would simply lose
      // the FET.
      //
      // Multi-answer questions accidentally survived this: their completion
      // path emits again after MULTI_ANSWER_BACKUP_FET_DELAY_MS, by which time
      // the verdict has arrived. Single-answer had no such second chance.
      this.emitWhenVerdictArrives(ctx, skipGuard);
      return;
    }

    // Cache the resolved formatted text
    this.cacheResolvedFormattedExplanation(resolvedIndex, explanationText);

    // Clear locks and pulse stream
    try {
      this.explanationTextService._fetLocked = false;
      this.explanationTextService.unlockExplanation();
    } catch (err: unknown) {
      console.error('SharedOptionExplanationService.emitExplanation unlock failed:', err);
    }

    // Force display flags to TRUE
    this.explanationTextService.setIsExplanationTextDisplayed(true);
    this.explanationTextService.shouldDisplayExplanationSig.set(true);

    this.pendingExplanationIndex = resolvedIndex;
    this.applyExplanationText(explanationText, resolvedIndex);
    this.scheduleExplanationVerification(resolvedIndex, explanationText);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Resolution Check
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Checks whether the question is resolved (all correct answers selected).
   * Uses UI state first, falls back to service state.
   */
  private checkResolution(ctx: ExplanationContext): boolean {
    const { resolvedIndex, question } = ctx;

    const selectedFromService =
      this.selectedOptionService.getSelectedOptionsForQuestion(resolvedIndex) ?? [];

    // ── AUTHORIZED COMPLETION ─────────────────────────────────────────
    //
    // `strict: false` is the COMPLETION question — every correct option chosen,
    // extra wrong picks tolerated. `strict: true` would be PERFECT, which is a
    // different question and deliberately not asked here.
    //
    // This status is verdict-backed: its counts come from `selectedVerdicts`,
    // which covers only options the USER submitted, so an auto-revealed option
    // can never manufacture completion. `evaluated` is what makes that safe —
    // idle/checking/error report zero because nothing is KNOWN, not because
    // nothing was correct, and reading `resolved` alone would treat "not
    // answered yet" as "answered wrongly".
    const status = this.selectedOptionService.getResolutionStatus(
      question!,
      selectedFromService as any,
      false
    );

    const { correctCount, pristineCorrectTexts, authQuestion } =
      this.resolveCorrectCountAndTexts(ctx);

    // TYPE IS DECLARED, NOT COUNTED.
    //
    // `correctCount > 1` made the local answer key decide what KIND of question
    // this is, which is why a question declared SINGLE but flagged with three
    // correct options took the multi-answer rule and refused to resolve after
    // one correct pick. `authQuestion` came from the display-order resolver
    // above, so this reads the question actually on screen under shuffle.
    // trueFalse resolves to single-selection at the authority layer.
    // REMOVE THE COUNT IN /questions CONTENT CUTOVER.
    const isMultiAnswer = resolveIsMultiAnswer(
      authQuestion,
      correctCount > 1 || this.quizService.multipleAnswer
    );

    const selectedFromUi = this.collectSelectedFromUi(ctx);

    const uiResolved = this.computeUiResolved(
      selectedFromUi, status, isMultiAnswer, correctCount, pristineCorrectTexts, question!
    );

    let resolved = (selectedFromUi.length > 0) ? uiResolved : status.resolved;

    // PRISTINE GATE — COMPATIBILITY ONLY, while nothing is authorized.
    //
    // It requires every pristine-correct text to be among the selections, which
    // is the answer key deciding completion. That is exactly what the verdict
    // now answers, so once `evaluated` is true this must not run: it could only
    // ever VETO an authorized completion, and it cannot answer at all once the
    // bank stops shipping (no correct texts to match).
    //
    // An earlier attempt at this returned `status.resolved` before the gate and
    // was reverted, blamed for the revisit FET-in-heading regression. That
    // diagnosis was wrong: the causes were the timer expiring a question ON
    // ARRIVAL and applyExplanationText marking a render as an interaction, both
    // fixed in d3d13ee7. The heading's own revisit guard — not this gate — is
    // what keeps the question text on screen.
    if (!status.evaluated && isMultiAnswer && pristineCorrectTexts.size > 0) {
      resolved = this.applyMultiAnswerPristineGate(
        ctx, selectedFromUi, selectedFromService, pristineCorrectTexts, resolved
      );
    }

    // Single-answer only: let the service override the UI verdict (multi's
    // selectedOptionsMap can be contaminated by init paths).
    if (!resolved && status.resolved && !isMultiAnswer) resolved = true;

    return resolved;
  }

  // Resolve correct count/texts from pristine quizInitialState — live options
  // can have stale correct flags (e.g. after Restart Quiz) that inflate the count.
  private resolveCorrectCountAndTexts(
    ctx: ExplanationContext
  ): { correctCount: number; pristineCorrectTexts: Set<string>; authQuestion: QuizQuestion | null } {
    const { resolvedIndex, question } = ctx;

    const authQuestion = this.quizService.getQuestionsInDisplayOrder?.()?.[resolvedIndex]
      ?? this.quizService.questions?.[resolvedIndex] ?? question;
    let correctCount = 0;
    const pristineCorrectTexts = new Set<string>();
    const qText = this.normalize(authQuestion?.questionText ?? question?.questionText);
    try {
      for (const quiz of this.quizService?.quizInitialState ?? []) {
        for (const pq of quiz?.questions ?? []) {
          if (this.normalize(pq?.questionText) !== qText) continue;
          const correctOpts = (pq?.options ?? []).filter(
            (o: any) => isOptionCorrect(o)
          );
          if (correctOpts.length === 0) continue;
          correctCount = correctOpts.length;
          for (const o of correctOpts) {
            const t = this.normalize(o?.text);
            if (t) pristineCorrectTexts.add(t);
          }
          break;
        }
        if (correctCount > 0) break;
      }
    } catch { /* ignore */ }
    if (correctCount === 0) {
      correctCount = (authQuestion?.options ?? question!.options).filter(
        (o: any) => isOptionCorrect(o)
      ).length;
    }
    // The question is returned alongside the counts so the caller can ask it
    // for its DECLARED type rather than inferring one from those counts. Same
    // object the counts came from, so type and count can never describe two
    // different questions.
    return { correctCount, pristineCorrectTexts, authQuestion: authQuestion ?? null };
  }

  // optionBindings may be a signal (-clean) or array (-main)
  private collectSelectedFromUi(ctx: ExplanationContext): any[] {
    const { optionBindings, optionsToDisplay } = ctx;
    const _rawOb1 = optionBindings as any;
    const _ob1: any[] = typeof _rawOb1 === 'function' ? (_rawOb1() ?? []) : (_rawOb1 ?? []);
    const visualOptions = (Array.isArray(_ob1) && _ob1.length > 0)
      ? _ob1.map((b: OptionBindings) => b.option)
      : (optionsToDisplay ?? []);

    return visualOptions
      .map((opt: any, idx: number) => {
        const bindingSelected = _ob1?.[idx]?.isSelected === true;
        const optionSelected = opt?.selected === true || bindingSelected;
        return optionSelected
          ? ({
            optionId: opt?.optionId,
            text: opt?.text,
            correct: opt?.correct,
            displayIndex: idx
          } as any)
          : null;
      })
      .filter((opt: any) => opt != null);
  }

  private isResolutionSelectionCorrect(
    sel: any,
    pristineCorrectTexts: Set<string>,
    question: any
  ): boolean {
    const selText = this.normalize(sel?.text);
    if (pristineCorrectTexts.size > 0 && selText) {
      return pristineCorrectTexts.has(selText);
    }
    if (isOptionCorrect(sel)) return true;

    const selId = sel?.optionId;

    const byId = question!.options.find((o: any) =>
      o?.optionId !== undefined && o?.optionId !== null &&
      String(o.optionId) === String(selId)
    );
    if (byId) return isOptionCorrect(byId);

    const byText = question!.options.find((o: any) =>
      this.normalize(o?.text) !== '' && this.normalize(o?.text) === selText
    );
    if (byText) return isOptionCorrect(byText);

    return false;
  }

  /**
   * Has the user FINISHED this question?
   *
   * COMPLETION IS AUTHORIZED, NOT COUNTED. This used to answer entirely from
   * the local bank: count the correct flags, count how many of the user's
   * selections matched them, and compare. Two things were wrong with that.
   * The rule it picked came from `correctCount > 1` — the answer key deciding
   * the question's TYPE — so a declared SINGLE question that the bank happened
   * to flag three times demanded three picks and never resolved. And the
   * comparison itself is an answer-key read, which returns nothing once the key
   * stops shipping to the browser.
   *
   * `status` answers both, from the verdict: `resolved` is COMPLETION with
   * `strict: false` — every correct option chosen, extra wrong picks tolerated
   * — which is the same question this method asks. It covers single, trueFalse
   * and multiple alike, because the verdict applies each type's own rule.
   *
   * `evaluated` is the safety property. idle/checking/error report zero counts
   * because nothing is KNOWN, not because nothing was correct, so the local
   * reconstruction stays as the fallback for exactly those states — and for
   * nothing else. REMOVE IT IN /questions CONTENT CUTOVER.
   */
  private computeUiResolved(
    selectedFromUi: any[],
    status: { resolved: boolean; evaluated: boolean },
    isMultiAnswer: boolean,
    correctCount: number,
    pristineCorrectTexts: Set<string>,
    question: any
  ): boolean {
    if (selectedFromUi.length === 0) return false;

    if (status.evaluated) return status.resolved;

    // ── TEMPORARY: NO AUTHORIZED VERDICT YET ──────────────────────────
    const correctSelected = selectedFromUi.filter(
      (sel: any) => this.isResolutionSelectionCorrect(sel, pristineCorrectTexts, question)
    ).length;

    // The RULE is still chosen by the declared type — only the comparison is
    // local. A declared single question needs one correct pick even when the
    // bank flags several.
    return isMultiAnswer ? correctSelected >= correctCount : correctSelected >= 1;
  }

  private applyMultiAnswerPristineGate(
    ctx: ExplanationContext,
    selectedFromUi: any[],
    selectedFromService: any[],
    pristineCorrectTexts: Set<string>,
    resolved: boolean
  ): boolean {
    const { resolvedIndex } = ctx;
    const selectedTexts = new Set<string>();
    for (const s of selectedFromUi) {
      const t = this.normalize(s?.text);
      if (t) selectedTexts.add(t);
    }
    for (const s of selectedFromService) {
      if (s?.selected === false) continue;
      const t = this.normalize((s as any)?.text);
      if (t) selectedTexts.add(t);
    }
    try {
      const idx = resolvedIndex;
      const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SK_SEL_Q + idx) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const s of parsed) {
            if (s?.selected !== true) continue;
            const t = this.normalize(s?.text);
            if (t) selectedTexts.add(t);
          }
        }
      }
    } catch { /* ignore */ }
    let allPresent = true;
    for (const t of pristineCorrectTexts) {
      if (!selectedTexts.has(t)) { allPresent = false; break; }
    }
    if (!allPresent) resolved = false;
    return resolved;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Apply & Verify
  // ═══════════════════════════════════════════════════════════════════════

  applyExplanationText(
    explanationText: string,
    displayIndex: number
  ): void {
    // NOT VISIT-SCOPED. Writing the explanation is a render, not a click.
    //
    // On a revisit this method runs again — the question already carries a
    // terminal verdict and its selections are restored, so the resolution gate
    // passes and the FET re-emits. Marking that as an interaction THIS VISIT
    // told the heading it was looking at a live answer view, which defeats the
    // revisit guard in shouldShowFet() and left the explanation in the heading
    // instead of the question text after Previous. The durable evidence is
    // still recorded; only the per-visit claim is withheld.
    this.quizStateService.markUserInteracted(displayIndex, { visitScoped: false });

    const contextKey = this.buildExplanationContext(displayIndex);

    this.explanationTextService._activeIndex = displayIndex;
    this.explanationTextService.latestExplanation = explanationText;
    this.explanationTextService.latestExplanationIndex = displayIndex;

    this.explanationTextService.emitFormatted(displayIndex, explanationText);

    this.explanationTextService.setExplanationText(explanationText, {
      force: true,
      context: contextKey,
      index: displayIndex
    });

    const displayOptions = { context: contextKey, force: true } as const;
    this.explanationTextService.setShouldDisplayExplanation(
      true,
      displayOptions
    );
    this.explanationTextService.setIsExplanationTextDisplayed(
      true,
      displayOptions
    );
    this.explanationTextService.setResetComplete(true);

    this.explanationTextService.lockExplanation();

    this.quizStateService.setDisplayState({
      mode: 'explanation',
      answered: true
    });
  }

  buildExplanationContext(questionIndex: number): string {
    const normalized = Number.isFinite(questionIndex)
      ? Math.max(0, Math.floor(questionIndex))
      : 0;

    return `question:${normalized}`;
  }

  scheduleExplanationVerification(
    displayIndex: number,
    explanationText: string
  ): void {
    requestAnimationFrame(() => {
      let latest: string | null = null;
      try {
        latest = this.explanationTextService.formattedExplanationSig();
      } catch {
        latest = null;
      }

      if (this.pendingExplanationIndex !== displayIndex) return;

      if (latest?.trim() === explanationText.trim()) {
        this.clearPendingExplanation();
        return;
      }

      this.explanationTextService.unlockExplanation();
      this.applyExplanationText(explanationText, displayIndex);
      this.clearPendingExplanation();
    });
  }

  resolveDisplayIndex(
    questionIndex: number,
    getActiveQuestionIndex: () => number,
    currentQuestionIndex: number,
    resolvedQuestionIndex: number | null
  ): number {
    const explicit = Number.isFinite(questionIndex)
      ? Math.max(0, Math.floor(questionIndex))
      : null;

    const resolved =
      explicit ??
      getActiveQuestionIndex() ??
      currentQuestionIndex ??
      resolvedQuestionIndex;
    return Number.isFinite(resolved) ? Math.max(0, Math.floor(resolved!)) : 0;
  }

  clearPendingExplanation(): void {
    this.pendingExplanationIndex = -1;
  }

  /**
   * Resolves a question index for explanation emission using a fallback chain:
   *   1. The provided questionIndex (if finite)
   *   2. The active question index from the component
   *   3. The service-level current question index
   *   4. Emergency fallback: 0
   */
  resolveExplanationQuestionIndex(
    questionIndex: number,
    activeQuestionIndex: number
  ): number {
    if (Number.isFinite(questionIndex)) {
      return Math.max(0, Math.trunc(questionIndex));
    }

    if (Number.isFinite(activeQuestionIndex)) {
      return Math.max(0, Math.trunc(activeQuestionIndex));
    }

    const svcIndex = this.quizService?.getCurrentQuestionIndex?.() ?? this.quizService?.currentQuestionIndex;
    if (typeof svcIndex === 'number' && Number.isFinite(svcIndex)) {
      return Math.max(0, Math.trunc(svcIndex));
    }

    return 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Explanation Text Resolution
  // ═══════════════════════════════════════════════════════════════════════

  cacheResolvedFormattedExplanation(index: number, formatted: string): void {
    const text = (formatted ?? '').trim();
    if (!text) return;

    this.explanationTextService.formattedExplanations[index] = {
      questionIndex: index,
      explanation: text
    };
    this.explanationTextService.fetByIndex.set(index, text);
    this.explanationTextService.updateFormattedExplanation(text);
  }

  /**
   * Resolves the formatted explanation text using visual option positions
   * for correct "Option N" labeling (shuffle-safe).
   */
  /** One pending wait per question, so repeated clicks do not stack subscriptions. */
  private readonly pendingFetEmits = new Map<string, Subscription>();

  /**
   * Re-emit the FET the moment the authorized verdict lands.
   *
   * The same shape `soc-answer-processing.scheduleTerminalRespread` uses for
   * the binding repaint, and for the same reason: the click asks a question the
   * server has not answered yet, so the work has to happen on the answer rather
   * than on the ask.
   *
   * A one-shot subscription per question, dropped when it fires. Without the
   * key check every click on an unfinished multi-answer question would add
   * another subscriber and the completing verdict would emit N times.
   */
  private emitWhenVerdictArrives(ctx: ExplanationContext, skipGuard: boolean): void {
    const quizId = (this.quizService as any)?.quizId as string | undefined;
    const questionText =
      this.quizService.getQuestionsInDisplayOrder?.()?.[ctx.resolvedIndex]?.questionText
      ?? ctx.question?.questionText;
    if (!quizId || !questionText) return;

    const key = `${quizId} ${this.normalize(questionText)}`;
    if (this.pendingFetEmits.has(key)) return;

    const sub = this.verdicts.terminalVerdicts$
      .pipe(
        filter((arrival) =>
          arrival.quizId === quizId
          && this.normalize(arrival.questionText) === this.normalize(questionText)),
        take(1)
      )
      .subscribe(() => {
        this.pendingFetEmits.delete(key);

        // STALE GUARD. The verdict is still current for ITS question, but the
        // user may have navigated on — emitting now would put one question's
        // explanation on another's screen.
        const showing =
          this.quizService.getQuestionsInDisplayOrder?.()?.[ctx.resolvedIndex]?.questionText;
        if (!showing || this.normalize(showing) !== this.normalize(questionText)) return;

        // Re-entry is bounded: the verdict is terminal now, so the resolver
        // returns text and this path is not taken a second time.
        this.emitExplanation(ctx, skipGuard);
      });

    if (sub.closed) this.pendingFetEmits.delete(key);
    else this.pendingFetEmits.set(key, sub);
  }

  /**
   * The authorized explanation for a DISPLAY index, or '' when none is.
   *
   * Returns a string rather than `string | null` because every caller here
   * feeds a text pipeline that already treats empty as "nothing to emit".
   * Keeping the distinction would have meant teaching four call sites a new
   * state for no behavioural gain.
   *
   * Resolved by display index, so under shuffle it keys to the question ON
   * SCREEN — the same resolver the option painting and scoring use. Getting
   * this wrong would attach one question's explanation to another (the class
   * of defect 95a3d3cc was).
   */
  private resolveAuthorizedExplanation(displayIndex: number): string {
    return authorizedExplanation(this.quizService, displayIndex, this.verdicts) ?? '';
  }

  resolveExplanationText(ctx: ExplanationContext): string {
    const { resolvedIndex: displayIndex, question, optionsToDisplay, currentQuestion, quizId } = ctx;
    // RESOLVE: ctx.optionBindings may be a signal (-clean) or array (-main)
    const _rawOb2 = (ctx as any).optionBindings;
    const optionBindings: any[] = typeof _rawOb2 === 'function' ? (_rawOb2() ?? []) : (_rawOb2 ?? []);
    // Use ctx.question (resolved from display index) over currentQuestion (can be null)
    const effectiveQuestion = question ?? currentQuestion;

    // 1. Determine which options are ACTUALLY displayed right now
    const displayOptions = (Array.isArray(optionBindings) && optionBindings.length > 0)
      ? optionBindings.map(b => b.option)
      : (Array.isArray(optionsToDisplay) && optionsToDisplay.length > 0)
        ? optionsToDisplay : [];

    // Both early exits below used to return `effectiveQuestion.explanation`.
    // They are unauthorized reveals by any other name, so they now answer with
    // the verdict or with nothing.
    if (displayOptions.length === 0) {
      return this.resolveAuthorizedExplanation(displayIndex);
    }

    // 2. Identify the authoritative canonical question
    const allCanonical = this.quizService.quizDataLoader.getCanonicalQuestions(quizId) || [];
    const currentQText = this.normalize(effectiveQuestion?.questionText);

    let authQ = allCanonical.find(q => this.normalize(q.questionText) === currentQText);
    authQ = authQ || (effectiveQuestion as QuizQuestion);

    if (!authQ) return this.resolveAuthorizedExplanation(displayIndex);

    // 3. Build sets of correct identifiers from the authoritative source
    const correctIds = new Set<number>();
    const correctTexts = new Set<string>();

    if (Array.isArray(authQ.answer)) {
      for (const a of authQ.answer) {
        if (!a) continue;
        const id = Number(a.optionId);
        if (!isNaN(id)) correctIds.add(id);
        const t = this.normalize(a.text);
        if (t) correctTexts.add(t);
      }
    }
    if (correctIds.size === 0 && Array.isArray(authQ.options)) {
      for (const o of authQ.options) {
        if (!o || !o.correct) continue;
        const id = Number(o.optionId);
        if (!isNaN(id)) correctIds.add(id);
        const t = this.normalize(o.text);
        if (t) correctTexts.add(t);
      }
    }

    // 4. Calculate indices based on VISUAL POSITIONS
    const correctIndices = displayOptions
      .map((opt, i) => {
        const id = Number(opt.optionId);
        const text = this.normalize(opt.text);
        const isCorrect = (!isNaN(id) && correctIds.has(id)) ||
          (text && correctTexts.has(text)) ||
          !!opt.correct;

        return isCorrect ? i + 1 : null;
      })
      .filter((n): n is number => n !== null);

    // 5. Format and Emit
    //
    // THE EXPLANATION TEXT IS AUTHORIZED, NOT LOCAL.
    //
    // This read `authQ.explanation` — the bundled answer key — which is why
    // the FET could not survive `assets/data/quiz.json` leaving the browser.
    // `/check` returns the explanation on `resolved` and `expired` and on
    // nothing else, so asking the verdict gets the same text under the same
    // authorization the correct options already travel under.
    //
    // NO LOCAL FALLBACK. An unauthorized question yields an empty string, and
    // every caller of this method treats empty as "do not emit" — which is the
    // correct behaviour for a reveal nobody has earned yet, and the behaviour
    // that will still be correct once the asset is gone.
    const rawExplanation = this.resolveAuthorizedExplanation(displayIndex);
    if (!rawExplanation) return '';
    const formatted = this.explanationTextService.formatExplanation(
      { ...authQ, options: displayOptions },
      correctIndices,
      rawExplanation,
      displayIndex
    );

    this.explanationTextService.storeFormattedExplanation(
      displayIndex,
      formatted,
      authQ,
      displayOptions,
      true
    );

    return formatted;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════

  private normalize(value: unknown): string {
    return String(value ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\u00A0/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }
}