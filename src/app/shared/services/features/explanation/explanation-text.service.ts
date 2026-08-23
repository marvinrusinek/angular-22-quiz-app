import { inject, Service, WritableSignal } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

import { FormattedExplanation } from '../../../models/FormattedExplanation.model';
import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';


import { ExplanationDisplayStateService, FETPayload } from './explanation-display-state.service';
import { ExplanationFormatterService } from './explanation-formatter.service';
import { QuizService } from '../../data/quiz.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { allCorrectSelectedFromVerdict } from '../verdict/authorized-correctness';
import { TopicQuizTypeRegistry } from '../../api/topic-quiz-type-registry.service';
import { declaredIsMultiAnswer } from '../../../utils/question-type-authority';
import { norm } from '../../../utils/text-norm';
import { swallow } from '../../../utils/error-logging';

export { FETPayload } from './explanation-display-state.service';

/**
 * Facade that preserves the original public API of ExplanationTextService.
 * All logic is delegated to ExplanationFormatterService and ExplanationDisplayStateService.
 */
@Service()
export class ExplanationTextService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly displayState = inject(ExplanationDisplayStateService);
  private readonly formatter = inject(ExplanationFormatterService);
  private readonly quizService = inject(QuizService);
  private readonly verdicts = inject(QuestionVerdictService);
  private readonly typeRegistry = inject(TopicQuizTypeRegistry);

  // ── optional back-reference ─────────────────────────────────────
  _loaderRef?: any;

  // ── remaining variables ─────────────────────────────────────────
  /**
   * Map of question display indices that have been confirmed correct
   * by SOC pristine verification. When set, ALL FET gates are bypassed
   * for that index. Set by SharedOptionClickService after scoring.
   */
  fetBypassForQuestion = new Map<number, boolean>();

  /**
   * Central FET completion gate for multi-answer questions.
   *
   * Asks the AUTHORIZED verdict whether every required correct option has
   * been selected. It used to compare the user selections against the bundled
   * answer key, which made the key decide when the user had earned it.
   */
  private isMultiAnswerPristineResolved(index: number): boolean | null {
    try {
      const idx = Number.isFinite(index) ? index : this.quizService.currentQuestionIndex;
      if (idx < 0) return null;

      // FAST PATH: if SOC has confirmed this question correct, bypass all checks.
      if (this.fetBypassForQuestion.get(idx) === true) return true;
      try {
        const scoringSvc = this.quizService?.scoringService;
        if (scoringSvc?.questionCorrectness?.get(idx) === true) return true;
      } catch (err: unknown) { swallow('explanation-text.service.ts scoring fast-path', err); }

      const qs: any = this.quizService;
      const isShuffled = qs?.isShuffleEnabled?.()
        && Array.isArray(qs?.shuffledQuestions)
        && qs.shuffledQuestions.length > 0;
      const liveQ: any = isShuffled
        ? qs?.shuffledQuestions?.[idx]
        : qs?.questions?.[idx];
      const qText = norm(liveQ?.questionText ?? '');
      if (!qText) return null;

      // MULTI-ANSWER ONLY, AND THE TYPE IS DECLARED.
      //
      // This was `pristineCorrectTexts.length < 2` — a count of the bundled
      // answer key stood in for "is this multi-answer?". The declared type says
      // so directly. Unknown returns null, exactly as a short pristine set did:
      // callers block only on `false`, so null stays permissive and this gate
      // simply declines to have an opinion.
      const declaredMulti =
        declaredIsMultiAnswer(liveQ) ?? this.typeRegistry?.isMultiAnswer?.(qText) ?? null;
      if (declaredMulti !== true) return null;  // not multi-answer, or unknown

      // COMPLETION IS THE VERDICT'S ANSWER.
      //
      // Everything between here and the return used to GATHER the user's
      // selections from three places (live options, the selection map, session
      // storage) purely to compare them against the bundled correct set. The
      // verdict already knows both halves — what the user picked and how many
      // correct options remain — so the comparison, and the gathering that
      // existed for it, are both gone.
      //
      // Null while nothing has been checked, which callers treat as "no
      // opinion" rather than as permission or refusal.
      const quizId = (this.quizService as any)?.quizId as string | undefined;
      if (!quizId) return null;
      return allCorrectSelectedFromVerdict(
        this.verdicts.verdictFor(quizId, liveQ?.questionText ?? qText)
      );
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Formatter pass-through properties
  // ═══════════════════════════════════════════════════════════════════════

  get formattedExplanations(): Record<number, FormattedExplanation> {
    return this.formatter.formattedExplanations;
  }
  set formattedExplanations(val: Record<number, FormattedExplanation>) {
    this.formatter.formattedExplanations = val;
  }

  get formattedExplanationSig(): WritableSignal<string> {
    return this.formatter.formattedExplanationSig;
  }

  get formattedExplanation$(): Observable<string> {
    return this.formatter.formattedExplanation$;
  }

  get explanationsUpdated(): Observable<Record<number, FormattedExplanation>> {
    return this.formatter.explanationsUpdated$;
  }

  get processedQuestions(): Set<string> {
    return this.formatter.processedQuestions;
  }
  set processedQuestions(val: Set<string>) {
    this.formatter.processedQuestions = val;
  }

  get fetByIndex(): Map<number, string> {
    return this.formatter.fetByIndex;
  }

  // DURABLE per-question FET for TIMED-OUT questions. The primary fetByIndex /
  // formattedExplanations are purged/deferred by the async explanation pipeline
  // (purgeAndDefer), which races the heading render on timeout for Q2+ and leaves
  // the heading with an empty FET. This map is never purged, so the single-source
  // heading can fall back to it for an expired question.
  public readonly timeoutFetByIndex = new Map<number, string>();

  get explanationsInitialized(): boolean {
    return this.formatter.explanationsInitializedSig();
  }
  set explanationsInitialized(val: boolean) {
    this.formatter.explanationsInitializedSig.set(val);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Display state pass-through properties
  // ═══════════════════════════════════════════════════════════════════════

  get isExplanationTextDisplayedSig(): WritableSignal<boolean> {
    return this.displayState.isExplanationTextDisplayedSig;
  }

  get isExplanationTextDisplayed$(): Observable<boolean> {
    return this.displayState.isExplanationTextDisplayed$;
  }

  get shouldDisplayExplanationSig(): WritableSignal<boolean> {
    return this.displayState.shouldDisplayExplanationSig;
  }

  get shouldDisplayExplanation$(): Observable<boolean> {
    return this.displayState.shouldDisplayExplanation$;
  }

  get latestExplanation(): string {
    return this.displayState.latestExplanation;
  }
  set latestExplanation(val: string) {
    this.displayState.latestExplanation = val;
  }

  get _byIndex(): Map<number, BehaviorSubject<string | null>> {
    return this.displayState._byIndex;
  }

  get _gate(): Map<number, BehaviorSubject<boolean>> {
    return this.displayState._gate;
  }

  get activeIndex$(): Observable<number> {
    return this.displayState.activeIndex$;
  }

  get _visibilityLocked(): boolean {
    return this.displayState._visibilityLocked;
  }
  set _visibilityLocked(val: boolean) {
    this.displayState._visibilityLocked = val;
  }

  get questionRendered$(): Observable<boolean> {
    return this.displayState.questionRendered$;
  }

  get _gatesByIndex(): Map<number, BehaviorSubject<boolean>> {
    return this.displayState._gatesByIndex;
  }

  get _fetLocked(): boolean | null {
    return this.displayState._fetLocked;
  }
  set _fetLocked(val: boolean | null) {
    this.displayState._fetLocked = val;
  }

  get _lastNavTime(): number {
    return this.displayState._lastNavTime;
  }
  set _lastNavTime(val: number) {
    this.displayState._lastNavTime = val;
  }

  get quietZoneUntil$(): Observable<number> {
    return this.displayState.quietZoneUntil$;
  }

  get _quietZoneUntil(): number {
    return this.displayState._quietZoneUntil;
  }
  set _quietZoneUntil(val: number) {
    this.displayState._quietZoneUntil = val;
  }

  get fetPayload$(): Observable<FETPayload> {
    return this.displayState.fetPayload$;
  }

  get _gateToken(): number {
    return this.displayState._gateToken;
  }
  set _gateToken(val: number) {
    this.displayState._gateToken = val;
  }

  get _currentGateToken(): number {
    return this.displayState._currentGateToken;
  }
  set _currentGateToken(val: number) {
    this.displayState._currentGateToken = val;
  }

  get latestExplanationIndex(): number | null {
    return this.displayState.latestExplanationIndex;
  }
  set latestExplanationIndex(val: number | null) {
    this.displayState.latestExplanationIndex = val;
    this.formatter.latestExplanationIndex = val;
  }

  get _activeIndex(): number | null {
    return this.displayState._activeIndex;
  }
  set _activeIndex(val: number | null) {
    this.displayState._activeIndex = val;
  }

  get shouldDisplayExplanationSnapshot(): boolean {
    return this.displayState.shouldDisplayExplanationSnapshot;
  }

  get explanationTexts(): Record<number, string> {
    return this.displayState.explanationTexts;
  }
  set explanationTexts(val: Record<number, string>) {
    this.displayState.explanationTexts = val;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Formatter delegated methods
  // ═══════════════════════════════════════════════════════════════════════

  getFormattedSync(qIdx: number): string | undefined {
    return this.formatter.getFormattedSync(qIdx);
  }

  initializeExplanationTexts(explanations: string[]): void {
    this.formatter.initializeExplanationTexts(
      this.displayState.explanationTexts,
      explanations
    );
  }

  initializeFormattedExplanations(
    explanations: { questionIndex: number; explanation: string }[]
  ): void {
    this.formatter.initializeFormattedExplanations(explanations);
  }

  formatExplanationText(
    question: QuizQuestion,
    questionIndex: number
  ): Observable<{ questionIndex: number; explanation: string }> {
    return this.formatter.formatExplanationText(question, questionIndex);
  }

  updateFormattedExplanation(explanation: string): void {
    this.formatter.updateFormattedExplanation(explanation);
  }

  storeFormattedExplanation(
    index: number,
    explanation: string,
    question: QuizQuestion,
    options?: Option[],
    force?: boolean
  ): void {
    this.formatter.storeFormattedExplanation(index, explanation, question, options, force);

    // Also update index-bound reactive streams in display state
    try {
      const entry = this.displayState.getOrCreate(index);
      entry.text$.next(this.formatter.formattedExplanations[index]?.explanation ?? '');
      this.displayState._byIndex.get(index)?.next(
        this.formatter.formattedExplanations[index]?.explanation ?? ''
      );
    } catch (err: unknown) {
      console.error('ExplanationTextService.storeFormattedExplanation display state update failed:', err);
    }
  }

  getCorrectOptionIndices(
    question: QuizQuestion,
    options?: Option[],
    displayIndex?: number
  ): number[] {
    return this.formatter.getCorrectOptionIndices(question, options, displayIndex);
  }

  formatExplanation(
    question: QuizQuestion,
    correctOptionIndices: number[] | null | undefined,
    explanation: string,
    displayIndex?: number
  ): string {
    return this.formatter.formatExplanation(question, correctOptionIndices, explanation, displayIndex);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Display state delegated methods
  // ═══════════════════════════════════════════════════════════════════════

  updateExplanationText(question: QuizQuestion): void {
    this.displayState.updateExplanationText(question);
  }

  getLatestExplanation(): string {
    return this.displayState.getLatestExplanation();
  }

  prepareExplanationText(question: QuizQuestion): string {
    return this.displayState.prepareExplanationText(question);
  }

  lockExplanation(context?: string): void {
    this.displayState.lockExplanation(context);
  }

  unlockExplanation(): void {
    this.displayState.unlockExplanation();
  }

  isExplanationLocked(): boolean {
    return this.displayState.isExplanationLocked();
  }

  setExplanationText(
    explanation: string | null,
    options?: { force?: boolean; context?: string; index?: number }
  ): void {
    if (explanation && explanation.trim().length > 0 && !options?.force) {
      const idx = options?.index ?? this.parseIndexFromContext(options?.context)
        ?? this.quizService.currentQuestionIndex;
      const pristine = this.isMultiAnswerPristineResolved(idx);
      if (pristine === false) return;
    }
    this.displayState.setExplanationText(explanation, options);
  }

  setExplanationTextForQuestionIndex(index: number, explanation: string): void {
    this.displayState.setExplanationTextForQuestionIndex(index, explanation);
  }

  getFormattedExplanationTextForQuestion(
    questionIndex: number
  ): Observable<string | null> {
    return this.displayState.getFormattedExplanationTextForQuestion(questionIndex);
  }

  getLatestFormattedExplanation(): string | null {
    return this.displayState.getLatestFormattedExplanation();
  }

  getFormattedExplanation(questionIndex: number): Observable<string> {
    return this.displayState.getFormattedExplanation(questionIndex);
  }

  getFormattedExplanationByIndex(): Observable<FETPayload> {
    return this.displayState.getFormattedExplanationByIndex();
  }

  setIsExplanationTextDisplayed(
    isDisplayed: boolean,
    options?: { force?: boolean; context?: string }
  ): void {
    if (isDisplayed === true && !options?.force) {
      const idxFromCtx = this.parseIndexFromContext(options?.context);
      const idx = idxFromCtx ?? this.quizService.currentQuestionIndex;
      const pristine = this.isMultiAnswerPristineResolved(idx);
      if (pristine === false) return;
    }
    this.displayState.setIsExplanationTextDisplayed(isDisplayed, options);
  }

  setShouldDisplayExplanation(
    shouldDisplay: boolean,
    options?: { force?: boolean; context?: string }
  ): void {
    if (shouldDisplay === true && !options?.force) {
      const idxFromCtx = this.parseIndexFromContext(options?.context);
      const idx = idxFromCtx ?? this.quizService.currentQuestionIndex;
      const pristine = this.isMultiAnswerPristineResolved(idx);
      if (pristine === false) return;
    }
    this.displayState.setShouldDisplayExplanation(shouldDisplay, options);
  }

  private parseIndexFromContext(context?: string): number | null {
    if (!context) return null;
    const m = /question:(\d+)/.exec(context);
    return m ? parseInt(m[1], 10) : null;
  }

  triggerExplanationEvaluation(): void {
    this.displayState.triggerExplanationEvaluation();
  }

  resetExplanationText(): void {
    this.displayState.resetExplanationText();
  }

  resetStateBetweenQuestions(): void {
    this.displayState.resetStateBetweenQuestions();
  }

  resetExplanationState(): void {
    this.fetBypassForQuestion.clear();
    this.displayState.resetExplanationState();
  }

  resetProcessedQuestionsState(): void {
    this.formatter.resetProcessedQuestionsState();
  }

  setResetComplete(value: boolean): void {
    this.displayState.setResetComplete(value);
  }

  forceResetBetweenQuestions(): void {
    this.displayState.forceResetBetweenQuestions();
  }

  emitFormatted(
    index: number,
    value: string | null,
    options?: { token?: number; bypassGuard?: boolean }
  ): void {
    if (value && value.trim().length > 0 && !options?.bypassGuard) {
      const pristine = this.isMultiAnswerPristineResolved(index);
      if (pristine === false) return;
    }
    this.displayState.emitFormatted(index, value, options);
  }

  setGate(index: number, show: boolean): void {
    this.displayState.setGate(index, show);
  }

  openExclusive(index: number, text: string): void {
    this.displayState.openExclusive(index, text);
  }

  getOrCreate(index: number) {
    return this.displayState.getOrCreate(index);
  }

  getExplanationText$(index: number): Observable<string | null> {
    return this.displayState.getExplanationText$(index);
  }

  resetForIndex(index: number): void {
    this.displayState.resetForIndex(index);
  }

  setReadyForExplanation(ready: boolean): void {
    this.displayState.setReadyForExplanation(ready);
  }

  waitUntilQuestionRendered(timeoutMs?: number): Promise<void> {
    return this.displayState.waitUntilQuestionRendered(timeoutMs);
  }

  closeGateForIndex(index: number): void {
    this.displayState.closeGateForIndex(index);
  }

  closeAllGates(): void {
    this.displayState.closeAllGates();
  }

  markLastNavTime(time: number): void {
    this.displayState.markLastNavTime(time);
  }

  setQuietZone(durationMs: number): void {
    this.displayState.setQuietZone(durationMs);
  }

  purgeAndDefer(newIndex: number): void {
    this.displayState.purgeAndDefer(newIndex);
  }
}
