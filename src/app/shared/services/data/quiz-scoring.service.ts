import { inject, Service, Injector, signal } from '@angular/core';

import { SK_CORRECT_ANSWERS_COUNT, SK_SAVED_QUESTION_INDEX } from '../../constants/session-keys';

import { QuizScore } from '../../models/QuizScore.model';

import { QuizShuffleService } from '../flow/quiz-shuffle.service';
import { QuestionVerdictService } from '../features/verdict/question-verdict.service';
import { QuizService } from './quiz.service';
import { SelectedOptionService } from '../state/selectedoption.service';

import { norm } from '../../utils/text-norm';
import { swallow } from '../../utils/error-logging';

@Service()
export class QuizScoringService {
  // ── injects ─────────────────────────────────────────────────────
  public readonly quizShuffleService = inject(QuizShuffleService);
  // Lazily resolved (via Injector, like feedback.service) to read the cross-visit
  // UI selection in the multi-answer gate without risking a DI cycle at construction.
  private readonly injector = inject(Injector);

  // ── signals ─────────────────────────────────────────────────────
  readonly correctCountSig = signal<number>(0);
  readonly scoreSig = signal<number>(0);
  public readonly correctAnswersCountSig = signal<number>(0);

  // ── properties ──────────────────────────────────────────────────
  // State tracking for scoring (Index -> IsCorrect)
  public questionCorrectness = new Map<number, boolean>();

  quizScore: QuizScore | null = null;
  // Persisted list loaded first so `highScores` (the read-only view source)
  // mirrors it from the start — the High Scores table then shows the stored list
  // even before/without a fresh completion re-recording (e.g. on a refresh).
  highScoresLocal = JSON.parse(localStorage.getItem('highScoresLocal') ?? '[]');
  highScores: QuizScore[] = this.highScoresLocal;

  // Stable id for the CURRENT quiz attempt. Minted at attempt start / Restart
  // Quiz (startNewAttempt) and persisted to sessionStorage so it survives the
  // start → complete → Results flow AND a Results refresh (same-tab), which is
  // what lets the High Scores write dedup by attempt instead of by score.
  private currentAttemptId = sessionStorage.getItem('currentAttemptId') ?? '';

  // Tracks confirmed correct clicks per question. Each call to recordCorrectClick
  // adds the option text; the pristine gate only allows scoring when the count
  // matches the pristine correct count. This avoids relying on SelectedOptionService
  // which can return polluted/extra selections.
  private _confirmedCorrectClicks = new Map<number, Set<string>>();

  private readonly scoreQuizIdStorageKey = 'scoreQuizId';

  // ── constructor / lifecycle ─────────────────────────────────────
  constructor() {
    this.loadQuestionCorrectness();
  }

  // ── public methods ──────────────────────────────────────────────

  // ═══════════════════════════════════════════════════════════════════════
  // Core Scoring
  // ═══════════════════════════════════════════════════════════════════════

  /** Record that a correct option was clicked for a multi-answer question. */
  recordCorrectClick(questionIndex: number, optionText: string): void {
    const nrm = norm(optionText);
    if (!nrm) return;

    if (!this._confirmedCorrectClicks.has(questionIndex)) {
      this._confirmedCorrectClicks.set(questionIndex, new Set());
    }
    this._confirmedCorrectClicks.get(questionIndex)!.add(nrm);
  }

  /** Clear confirmed clicks for a question (used on reset). */
  clearConfirmedClicks(questionIndex?: number): void {
    if (questionIndex !== undefined) {
      this._confirmedCorrectClicks.delete(questionIndex);
    } else {
      this._confirmedCorrectClicks.clear();
    }
  }

  /**
   * Simple Scoring: Direct scoring method that bypasses complex answer matching.
   * Call this when you already know whether the user's selection is correct.
   * @param questionIndex The display index of the question
   * @param isCorrect Whether the user's current answer state is correct
   * @param isMultipleAnswer Whether this is a multi-answer question
   * @param shouldShuffle Whether shuffle is currently enabled
   * @param quizId The current quiz ID
   */
  public scoreDirectly(
    questionIndex: number,
    isCorrect: boolean,
    isMultipleAnswer: boolean,
    shouldShuffle: boolean,
    quizId: string
  ): void {
    this.incrementScore([], isCorrect, isMultipleAnswer, questionIndex, shouldShuffle, quizId);
  }

  incrementScore(
    _answers: number[],
    correctAnswerFound: boolean,
    isMultipleAnswer: boolean,
    questionIndex: number,
    shouldShuffle: boolean,
    quizId: string
  ): void {
    const qIndex = questionIndex >= 0 ? questionIndex : 0;

    const scoringKey = this.resolveScoringKey(qIndex, shouldShuffle, quizId);
    const wasCorrect = this.resolveWasCorrect(scoringKey);
    const isNowCorrect = this.applyPristineMultiAnswerGate(
      correctAnswerFound, quizId, isMultipleAnswer, qIndex, scoringKey
    );

    // DEFERRED: no verdict decision yet. Writing here would record a guess.
    if (isNowCorrect === null) return;

    this.applyCorrectnessUpdate(scoringKey, isNowCorrect, wasCorrect);
    this.saveQuestionCorrectness();
  }

  /**
   * Credit ONE question whose verdict has resolved correct.
   *
   * The reactive half of scoring. Click-time scoring can only decide when the
   * verdict is already terminal, and under the API adapter it never is — the
   * check is still in flight. So the completing click defers and this applies
   * the point when the authorized verdict actually lands.
   *
   * Called from the EXISTING subscription in
   * `SelectedOptionService.submitToVerdictService`, which is the one place
   * guaranteed to run when the response arrives. An Angular `effect` was tried
   * first and never scheduled in this zoneless app, which is exactly the
   * failure mode this avoids: a reaction that silently never runs.
   *
   * IDEMPOTENT by construction — it credits only when `questionCorrectness`
   * does not already record `true` for the scoring key, and that map is the
   * same ledger click-time scoring writes. There is no second score store, so
   * a replayed verdict, a revisit or a re-render cannot double-count.
   */
  creditResolvedQuestion(quizId: string, questionText: string): void {
    if (!quizId || !questionText) return;

    try {
      const quizService = this.injector.get(QuizService, null) as any;
      const displayOrder = quizService?.getQuestionsInDisplayOrder?.() ?? [];
      if (!Array.isArray(displayOrder) || displayOrder.length === 0) return;

      // Identity is question TEXT, resolved to a DISPLAY index. A source index
      // would credit the wrong question once the order is shuffled.
      const target = norm(questionText);
      const displayIndex = displayOrder.findIndex(
        (q: any) => norm(q?.questionText ?? '') === target
      );
      if (displayIndex < 0) return;

      const shouldShuffle = quizService?.isShuffleEnabled?.() === true;
      const scoringKey = this.resolveScoringKey(displayIndex, shouldShuffle, quizId);

      if (this.questionCorrectness.get(scoringKey) === true) return;   // already credited

      this.applyCorrectnessUpdate(scoringKey, true, false);
      this.saveQuestionCorrectness();
    } catch (err: unknown) {
      swallow('quiz-scoring.service.ts creditResolvedQuestion', err);
    }
  }

  // Scoring Key Resolution — Strict Shuffle Guard: only use the shuffle-service
  // mapping when shuffle is explicitly ENABLED. A stale QuizShuffleService map
  // (from a prev session) could otherwise remap an unshuffled question (0->3)
  // and update the wrong score key.
  private resolveScoringKey(qIndex: number, shouldShuffle: boolean, quizId: string): number {
    let scoringKey = qIndex;
    if (shouldShuffle) {
      // Try to get quizId from various sources if it's empty
      let effectiveQuizId = quizId;
      if (!effectiveQuizId) {
        try {
          effectiveQuizId = localStorage.getItem('lastQuizId') || '';
        } catch (err: unknown) { swallow('quiz-scoring.service.ts', err); }
      }
      if (!effectiveQuizId) {
        const shuffleKeys = Object.keys(localStorage).filter(k => k.startsWith('shuffleState:'));
        if (shuffleKeys.length > 0) {
          effectiveQuizId = shuffleKeys[0].replace('shuffleState:', '');
        }
      }

      if (effectiveQuizId) {
        const originalIndex = this.quizShuffleService.toOriginalIndex(effectiveQuizId, qIndex);
        if (typeof originalIndex === 'number' && originalIndex >= 0) {
          scoringKey = originalIndex;
        }
      }
    }
    return scoringKey;
  }

  // Read prior correctness (keyed by scoringKey only). Self-heal a stale
  // "already correct" entry when correctCount is 0 so scoring can proceed.
  private resolveWasCorrect(scoringKey: number): boolean {
    let wasCorrect = this.questionCorrectness.get(scoringKey) || false;
    if (wasCorrect && this.correctCountSig() === 0) {
      wasCorrect = false;
      this.questionCorrectness.set(scoringKey, false);
    }
    return wasCorrect;
  }

  /**
   * Whether the LEAVING question may be credited as correct.
   *
   * Answered entirely from the VERDICT. A green dot alone is not enough: it can
   * come from a single correct click on a partial multi-answer, which must not
   * score. `isResolvedCorrect` already encodes the Topic Quiz superset rule, so
   * this needs no second opinion.
   *
   * No verdict means no credit. It used to mean "scan the bank", which credited
   * questions the server had never judged.
   *
   * Pure — no side effects; safe to call during navigation.
   */
  public isLeavingQuestionCreditable(
    qIndex: number,
    quizId: string,
    scoringKey: number,
    extraSelectedTexts?: ReadonlySet<string>
  ): boolean {
    // Union the confirmed correct clicks with any cross-visit selected texts
    // (uiSelectedTexts = live bindings ∪ first-visit snapshot). _confirmedCorrectClicks
    // resets on navigation, so on REVISIT it lacks the first-visit correct clicks —
    // without the union, completing a multi-answer on revisit would never credit.
    const selected = new Set<string>(this._confirmedCorrectClicks.get(qIndex) ?? []);
    if (extraSelectedTexts) for (const t of extraSelectedTexts) selected.add(norm(t));

    // THE VERDICT IS THE ONLY AUTHORITY.
    // Keyed by qIndex (DISPLAY) — scoringKey is a SOURCE index under shuffle.
    const fromVerdict = this.multiAnswerCompleteFromVerdict(quizId, qIndex);
    if (fromVerdict !== null) return fromVerdict;

    // No verdict: untouched, in flight, or failed. NOT creditable.
    //
    // This used to scan the local bank — returning true for anything with one
    // correct option, which credited a single-answer question the server had
    // never judged. Scoring may not invent an outcome from data the browser is
    // about to stop having; the finalization gate blocks Results while a check
    // is pending, so the only way to reach here is a question that was never
    // answered, and zero is the right contribution for that.
    return false;
  }

  // PRISTINE GATE: block a multi-answer increment unless ALL pristine correct
  // answers have been confirmed clicked. Safety net for non-OIS callers.
  private applyPristineMultiAnswerGate(
    correctAnswerFound: boolean,
    quizId: string,
    isMultipleAnswer: boolean,
    qIndex: number,
    scoringKey: number
  ): boolean | null {
    let isNowCorrect = correctAnswerFound;  // simplified
    if (isNowCorrect && quizId && isMultipleAnswer) {
      // Union the confirmed correct clicks with the cross-visit UI selection
      // (uiSelectedTexts = live bindings ∪ first-visit snapshot). _confirmedCorrectClicks
      // resets on navigation, so COMPLETING a multi-answer on REVISIT would otherwise
      // never satisfy the gate — mirrors the union in isLeavingQuestionCreditable.
      const confirmed = this._confirmedCorrectClicks.get(qIndex) ?? new Set<string>();
      const selected = new Set<string>(confirmed);
      try {
        const sos = this.injector.get(SelectedOptionService, null);
        const ui = sos?.uiSelectedTextsForQuestion?.(qIndex);
        if (ui) for (const t of ui) selected.add(norm(t));
      } catch (err: unknown) { swallow('quiz-scoring.service.ts gate ui-union', err); }
      // VERDICT FIRST — same question, authoritative answer.
      // Keyed by qIndex (DISPLAY) — scoringKey is a SOURCE index under shuffle.
      const fromVerdict = this.multiAnswerCompleteFromVerdict(quizId, qIndex);

      // NON-TERMINAL MEANS DEFER, NOT REJECT.
      //
      // Under the API adapter the check is in flight at click time, so this
      // reads `checking` and gets null. Treating that as "not complete" is what
      // dropped the completing click's credit: false was written and nothing
      // revisited it when the response arrived. Null now means "no decision
      // yet" — incrementScore writes nothing, and creditResolvedQuestion()
      // applies the point from the response subscription.
      if (fromVerdict === null) return null;

      if (!fromVerdict) isNowCorrect = false;
      return isNowCorrect;
    }
    return isNowCorrect;
  }

  // Resolve pristine correct texts by index lookup, then cross-validate against
  // confirmed clicks (in shuffled mode the index lookup can hit the wrong
  // question; the right one's correct texts ALL appear in confirmed clicks).
  /**
   * Is this question's multi-answer requirement satisfied, per the VERDICT?
   *
   * Returns null when no authorized verdict exists, so the caller falls back to
   * the pristine scan below rather than mistaking "unknown" for "not complete".
   *
   * Both scoring gates ask exactly one question — "has every correct option
   * been selected?" — which is the SUPERSET rule the verdict already decides.
   * Asking the authority is both safer and more accurate than re-deriving it:
   * the pristine scan has to guess which source question a display index refers
   * to under shuffle, and cross-validates against confirmed clicks to recover.
   * The verdict is keyed by question TEXT, so there is nothing to guess.
   */
  private multiAnswerCompleteFromVerdict(quizId: string, displayIndex: number): boolean | null {
    if (!quizId) return null;

    try {
      const questionText = this.questionTextForDisplayIndex(displayIndex);
      if (!questionText) return null;

      const verdicts = this.injector.get(QuestionVerdictService, null);
      if (!verdicts) return null;

      const state = verdicts.verdictFor(quizId, questionText);
      if (state.phase === 'resolved') return state.isResolvedCorrect === true;
      if (state.phase === 'incomplete') return false;
      return null;   // idle | checking | expired | error → caller decides
    } catch (err: unknown) {
      swallow('quiz-scoring.service.ts verdict gate', err);
      return null;
    }
  }

  /**
   * The question text at a DISPLAY index, shuffle-aware.
   *
   * Takes the display index, NOT the scoring key. Those differ under shuffle:
   * `resolveScoringKey` maps the display index through
   * `QuizShuffleService.toOriginalIndex`, so the scoring key is a SOURCE index.
   * Looking a source index up in the display-order array resolves a different
   * question entirely — which produced no verdict and silently withheld credit
   * for a multi-answer completed on revisit while shuffled.
   */
  private questionTextForDisplayIndex(displayIndex: number): string | null {
    // Resolved through the injector rather than a constructor dependency:
    // QuizService owns this service, so injecting it directly would be a cycle.
    const service = this.injector.get(QuizService, null) as any;
    const inDisplayOrder = service?.getQuestionsInDisplayOrder?.()?.[displayIndex]?.questionText;
    return typeof inDisplayOrder === 'string' && inDisplayOrder.length > 0 ? inDisplayOrder : null;
  }


  // Update the correctness map + running count based on now-vs-was correctness.
  private applyCorrectnessUpdate(scoringKey: number, isNowCorrect: boolean, wasCorrect: boolean): void {
    if (isNowCorrect && !wasCorrect) {
      this.questionCorrectness.set(scoringKey, true);
      this.updateCorrectCountForResults(this.correctCountSig() + 1);
    } else if (!isNowCorrect && wasCorrect) {
      this.updateCorrectCountForResults(Math.max(this.correctCountSig() - 1, 0));
      this.questionCorrectness.set(scoringKey, false);
    } else if (!isNowCorrect && !this.questionCorrectness.has(scoringKey)) {
      // Only set to false if not already set — don't overwrite a true
      // value that was set directly by the SOC's display-index path.
      this.questionCorrectness.set(scoringKey, false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Score Updates & Guards
  // ═══════════════════════════════════════════════════════════════════════

  sendCorrectCountToResults(value: number, quizId?: string): void {
    const safeValue = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

    // GUARD: If something tries to set score to 0 but we have correctly answered
    // questions in our map, ignore the zero and re-derive from the map.
    // This prevents navigation-triggered accidental resets.
    if (safeValue === 0 && this.questionCorrectness.size > 0) {
      const trueCount = Array.from(this.questionCorrectness.values())
        .filter(v => v === true).length;
      if (trueCount > 0) {
        this.correctCountSig.set(trueCount);
        this.correctAnswersCountSig.set(trueCount);
        localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, String(trueCount));
        if (quizId) localStorage.setItem(this.scoreQuizIdStorageKey, quizId);
        return;
      }
    }

    this.correctCountSig.set(safeValue);
    this.correctAnswersCountSig.set(safeValue);
    localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, String(safeValue));
    if (quizId) {
      localStorage.setItem(this.scoreQuizIdStorageKey, quizId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Reset
  // ═══════════════════════════════════════════════════════════════════════

  resetScore(quizId?: string): void {
    this.questionCorrectness.clear();
    this._confirmedCorrectClicks.clear();
    this.saveQuestionCorrectness();  // clear persistence
    this.correctCountSig.set(0);
    // Use _forceSetScore to bypass the guard in sendCorrectCountToResults
    this._forceSetScore(0, quizId);  }

  /** Bypass guard — only for explicit resets (restart, new quiz). */
  _forceSetScore(value: number, quizId?: string): void {
    const safeValue = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    this.correctCountSig.set(safeValue);
    this.correctAnswersCountSig.set(safeValue);
    localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, String(safeValue));
    if (quizId) localStorage.setItem(this.scoreQuizIdStorageKey, quizId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Persistence
  // ═══════════════════════════════════════════════════════════════════════

  loadQuestionCorrectness(): void {
    try {
      const stored = localStorage.getItem('questionCorrectness');
      if (stored) {
        const parsed = JSON.parse(stored);
        this.questionCorrectness = new Map(
          Object.entries(parsed).map(([k, v]) => [Number(k), Boolean(v)])
        );      }
    } catch (err: unknown) {
      console.error('QuizScoringService.loadQuestionCorrectness localStorage parse failed:', err);
    }
  }

  saveQuestionCorrectness(): void {
    try {
      const obj = Object.fromEntries(this.questionCorrectness);
      localStorage.setItem('questionCorrectness', JSON.stringify(obj));
    } catch (err: unknown) {
      console.error('QuizScoringService.saveQuestionCorrectness localStorage write failed:', err);
    }
  }

  restoreScoreFromPersistence(quizId: string): void {
    try {
      // If quizId is not yet known (e.g. called from QuizService constructor
      // before the route has resolved), do nothing. Wiping state here
      // destroys the localStorage-persisted score the user just earned
      // right before the refresh.
      if (!quizId || quizId.length === 0) return;

      const savedIndexRaw = localStorage.getItem(SK_SAVED_QUESTION_INDEX);
      const savedIndex = Number(savedIndexRaw);
      const hasInProgressIndex = Number.isFinite(savedIndex) && Math.trunc(savedIndex) >= 0;
      const scoreQuizId = localStorage.getItem(this.scoreQuizIdStorageKey) ?? '';
      const quizMatches = scoreQuizId.length > 0 && scoreQuizId === quizId;

      // Compute what we HAVE stored for this quiz. If there's real data,
      // this is an in-progress session and we must restore it on refresh,
      // even if the user was on Q1 (savedIndex === 0).
      const storedRaw = localStorage.getItem(SK_CORRECT_ANSWERS_COUNT);
      const storedCount = Number(storedRaw);
      const safeStored = Number.isFinite(storedCount)
        ? Math.max(0, Math.trunc(storedCount)) : 0;
      const mapTrueCount = Array.from(this.questionCorrectness.values())
        .filter((v) => v === true).length;
      const hasStoredScore = safeStored > 0 || mapTrueCount > 0;

      // Wipe ONLY when: (a) quiz doesn't match (switching quizzes), OR
      // (b) there is genuinely no progress (no stored score AND no
      // in-progress index). Otherwise, restore from the stronger source.
      const shouldWipe = !quizMatches || (!hasInProgressIndex && !hasStoredScore);
      if (shouldWipe) {
        this.correctCountSig.set(0);
        this.correctAnswersCountSig.set(0);
        this.questionCorrectness.clear();
        this.saveQuestionCorrectness();
        localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, '0');
        localStorage.setItem(this.scoreQuizIdStorageKey, quizId);
        return;
      }

      const restored = Math.max(safeStored, mapTrueCount);
      this.correctCountSig.set(restored);
      this.correctAnswersCountSig.set(restored);
      localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, String(restored));
    } catch (err: unknown) {
      console.error('QuizScoringService.restoreScoreFromPersistence score restore failed:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // High Scores
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Mint a NEW attempt id (called when a quiz attempt starts and on Restart
   * Quiz). Persisted so it survives navigation to Results and a Results refresh.
   */
  startNewAttempt(): string {
    const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.currentAttemptId = id;
    try {
      sessionStorage.setItem('currentAttemptId', id);
    } catch (err: unknown) {
      // Storage unavailable — the in-memory id still works for this session.
      swallow('quiz-scoring.service.ts#startNewAttempt', err);
    }
    return id;
  }

  /** The current attempt's id (reused across Results open/refresh — NOT re-minted). */
  getCurrentAttemptId(): string {
    if (!this.currentAttemptId) {
      try {
        this.currentAttemptId = sessionStorage.getItem('currentAttemptId') ?? '';
      } catch (err: unknown) {
        swallow('quiz-scoring.service.ts#getCurrentAttemptId', err);
      }
    }
    return this.currentAttemptId;
  }

  saveHighScores(quizId: string, totalQuestions: number): void {
    this.recordCompletedQuizScore(
      quizId,
      this.calculatePercentageOfCorrectlyAnsweredQuestions(totalQuestions),
      totalQuestions,
      this.getCurrentAttemptId()
    );
  }

  /**
   * Record ONE High Scores row for a COMPLETED quiz attempt.
   *
   * Dedup is by ATTEMPT identity (`attemptId`), NOT by quiz+score+total — so two
   * genuine retakes that happen to score the same remain SEPARATE rows, while
   * re-opening / refreshing the SAME attempt's Results (which re-runs this) does
   * not append a duplicate. Called once per results-page load (the single
   * convergence point); the write itself no longer lives in the results VIEW.
   * The persistent list is never cleared here (Restart Quiz must not wipe it).
   */
  recordCompletedQuizScore(
    quizId: string,
    score: number,
    totalQuestions: number,
    attemptId: string
  ): void {
    if (!quizId) return;

    this.highScoresLocal = this.highScoresLocal ?? [];

    // Skip the WRITE when this attempt is already recorded (Results reopen /
    // refresh) or when there's no attempt to attribute (e.g. viewing old results
    // without starting one). DON'T early-return: we still normalize + publish
    // below so the read-only view reflects the stored list (otherwise
    // `highScores` could render an unnormalized/blank list).
    const alreadyRecorded =
      !!attemptId &&
      this.highScoresLocal.some((entry: QuizScore) => entry.attemptId === attemptId);

    if (attemptId && !alreadyRecorded) {
      this.quizScore = {
        quizId: quizId,
        attemptDateTime: new Date(),
        score: score,
        totalQuestions: totalQuestions,
        attemptId: attemptId
      };
      this.highScoresLocal.push(this.quizScore);
    }

    const MAX_HIGH_SCORES = 10;  // show results of the last 10 quizzes

    // Sort descending by date
    this.highScoresLocal.sort((a: any, b: any) => {
      const dateA = new Date(a.attemptDateTime);
      const dateB = new Date(b.attemptDateTime);
      return dateB.getTime() - dateA.getTime();
    });
    // Filter out scores older than 7 days
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    this.highScoresLocal = this.highScoresLocal.filter((entry: any) => {
      const scoreDate = new Date(entry.attemptDateTime);
      return scoreDate >= oneWeekAgo;
    });

    this.highScoresLocal.splice(MAX_HIGH_SCORES);
    localStorage.setItem(
      'highScoresLocal',
      JSON.stringify(this.highScoresLocal)
    );
    this.highScores = this.highScoresLocal;
  }

  calculatePercentageOfCorrectlyAnsweredQuestions(totalQuestions: number): number {
    const correctAnswers = this.correctAnswersCountSig();

    if (totalQuestions === 0) return 0;  // handle division by zero

    return Math.round((correctAnswers / totalQuestions) * 100);
  }

  // ── private methods ─────────────────────────────────────────────
  private updateCorrectCountForResults(value: number): void {
    const safeValue = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    this.correctCountSig.set(safeValue);
    this.sendCorrectCountToResults(this.correctCountSig());
  }
}
