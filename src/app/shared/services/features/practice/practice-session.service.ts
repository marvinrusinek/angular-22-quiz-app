import { computed, inject, Service, signal } from '@angular/core';

import { GeneratedAssessment } from '../../../models/GeneratedAssessment.model';
import { PracticeResult } from '../../../models/PracticeResult.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SK_PRACTICE_SESSION } from '../../../constants/session-keys';
import { readSessionJson, removeSessionKey, writeSessionJson } from '../../../utils/session-storage';
import { getQuizData } from '../../../quiz-data-cache';
import {
  canAdvanceFromQuestion,
  computePracticeResult,
  isMultiAnswerQuestion,
  isQuestionResolved
} from '../../../utils/practice-scoring';

import { firstValueFrom } from 'rxjs';

import { TopicQuizQuestionsService } from '../../api/topic-quiz-questions.service';
import { questionsFromApiViews } from '../../../utils/topic-quiz-content';
import { PracticeVerdictService } from './practice-verdict.service';
import { AssessmentBuilderService } from '../assessment/assessment-builder.service';
import { TopicPerformanceHistoryService } from '../../progress/topic-performance-history.service';
import { WeakAreasService } from '../../progress/weak-areas.service';

/** Persisted shape. Versioned so a future change can be migrated or discarded. */
export const PRACTICE_SESSION_VERSION = 1 as const;

interface PersistedPracticeSession {
  version: typeof PRACTICE_SESSION_VERSION;
  sessionId: string;
  /** The EXACT generated questions, including their shuffled option order. */
  questions: QuizQuestion[];
  topicIds: string[];
  answersByIndex: Record<number, number[]>;
  currentIndex: number;
  status: 'active' | 'submitted';
  /** Persisted so Practice Results survives a refresh without re-scoring. */
  result: PracticeResult | null;
}

/**
 * Owns one Weak Areas Practice session: generation, position, answers, and the
 * sessionStorage snapshot that survives a refresh.
 *
 * The snapshot stores the generated QUESTIONS themselves, not a recipe for
 * regenerating them — a refresh must resume the identical session, and
 * regenerating would reshuffle both question and option order.
 *
 * Practice is UNTIMED, so unlike the interview session there is no expiry or
 * remaining-time state to persist.
 */
@Service()
export class PracticeSessionService {
  private readonly builder = inject(AssessmentBuilderService);
  private readonly weakAreas = inject(WeakAreasService);
  private readonly topicHistory = inject(TopicPerformanceHistoryService);
  private readonly questionsApi = inject(TopicQuizQuestionsService);
  private readonly verdicts = inject(PracticeVerdictService);

  private readonly _sessionId = signal<string>('');
  private readonly _questions = signal<QuizQuestion[]>([]);
  private readonly _topicIds = signal<string[]>([]);
  private readonly _answersByIndex = signal<Record<number, number[]>>({});
  private readonly _currentIndex = signal(0);
  private readonly _status = signal<'active' | 'submitted'>('active');
  private readonly _result = signal<PracticeResult | null>(null);

  readonly sessionId = this._sessionId.asReadonly();
  readonly questions = this._questions.asReadonly();
  readonly topicIds = this._topicIds.asReadonly();
  readonly answersByIndex = this._answersByIndex.asReadonly();
  readonly currentIndex = this._currentIndex.asReadonly();
  readonly status = this._status.asReadonly();
  readonly result = this._result.asReadonly();

  readonly total = computed(() => this._questions().length);
  readonly currentQuestion = computed<QuizQuestion | null>(
    () => this._questions()[this._currentIndex()] ?? null
  );

  /** Session-route guard: a real generated session that is still being worked. */
  readonly hasSession = computed(() => this.total() > 0 && this._status() === 'active');

  /** Results-route guard: a submitted session with a scored result. */
  readonly hasResult = computed(() => this._status() === 'submitted' && this._result() != null);

  readonly answeredIndices = computed<ReadonlySet<number>>(() => {
    const map = this._answersByIndex();
    const set = new Set<number>();
    for (const key of Object.keys(map)) {
      if ((map[+key]?.length ?? 0) > 0) set.add(+key);
    }
    return set;
  });

  readonly answeredCount = computed(() => this.answeredIndices().size);
  readonly allAnswered = computed(() => this.total() > 0 && this.answeredCount() === this.total());

  readonly isCurrentAnswered = computed(() => this.answeredIndices().has(this._currentIndex()));
  readonly canGoPrevious = computed(() => this._currentIndex() > 0);

  readonly currentSelection = computed<number[]>(
    () => this._answersByIndex()[this._currentIndex()] ?? []
  );

  /**
   * The authorized verdict reader handed to the pure scoring helpers.
   *
   * Reads `PracticeVerdictService`, i.e. what `POST /check` said. Declared as a
   * field so every call site shares one definition and none can substitute a
   * local recount.
   */
  private readonly authorizedResolved = (question: QuizQuestion): boolean =>
    this.verdicts.isResolved(question?.sourceQuizId ?? '', question?.questionText ?? '');

  private readonly authorizedCorrectTexts = (question: QuizQuestion): readonly string[] =>
    this.verdicts.verdictFor(question?.sourceQuizId ?? '', question?.questionText ?? '').correctTexts;

  /** Current question is fully, exactly right — reveals FET and locks options. */
  readonly isCurrentResolved = computed(() => {
    // Read the verdict signal so this recomputes when a verdict lands.
    this.verdicts.verdicts();
    return isQuestionResolved(
      this.currentQuestion(), this.currentSelection(), this.authorizedResolved
    );
  });

  readonly isCurrentMultiAnswer = computed(() => isMultiAnswerQuestion(this.currentQuestion()));

  /**
   * The SINGLE advance gate. Next, the right-arrow shortcut and Submit all read
   * it, so a keyboard user can never bypass a gate the button enforces.
   */
  readonly canAdvance = computed(() => {
    this.verdicts.verdicts();
    return canAdvanceFromQuestion(
      this.currentQuestion(), this.currentSelection(), this.authorizedResolved
    );
  });

  readonly isLastQuestion = computed(() => this._currentIndex() === this.total() - 1);

  /** Next moves forward only when the gate passes AND another question exists. */
  readonly canGoNext = computed(() => this.canAdvance() && !this.isLastQuestion());

  /** Submit unlocks on the last question under the same gate as Next. */
  readonly canSubmit = computed(
    () => this.total() > 0 && this.isLastQuestion() && this.canAdvance()
  );

  constructor() {
    // Rehydrate on first injection so a refresh landing on the guarded route
    // finds an active session rather than being bounced.
    this.restore();
  }

  /**
   * Generate a NEW session from the CURRENTLY calculated weak topics. Returns
   * false when there is nothing to practise, so callers never start an empty
   * session. Always reshuffles — this is never a replay of a previous session.
   */
  async start(): Promise<boolean> {
    const topicIds = this.weakAreas.weakTopicIds();
    if (topicIds.length === 0) return false;

    // Questions come from the API, which ships question text, the DECLARED type
    // and option texts — and no answer key. A failure returns false and the
    // caller shows its empty state; there is deliberately NO fallback to the
    // local bank, which would reintroduce the dependency this slice removes.
    const pools = await this.loadApiPools(topicIds);
    if (!pools) return false;

    const built: GeneratedAssessment | null =
      this.builder.buildPractice(topicIds, 10, pools);
    if (!built || built.questions.length === 0) return false;

    // A new session must not inherit the previous one's verdicts.
    this.verdicts.clear();

    // A NEW sessionId is minted here and nowhere else, so `practice:{sessionId}`
    // stays stable across every remount and refresh of this attempt.
    this._sessionId.set(this.newSessionId());
    this._questions.set(built.questions);
    this._topicIds.set([...topicIds]);
    this._answersByIndex.set({});
    this._currentIndex.set(0);
    this._status.set('active');
    this._result.set(null);
    this.persist();
    return true;
  }

  /**
   * Practice Again: record the finished attempt FIRST (so its data feeds the
   * recalculation), then generate a brand-new session from the freshly
   * recalculated weak topics.
   *
   * Returns false when no weak topics remain — the caller shows the
   * "No weak areas detected" state instead of starting an empty session.
   */
  practiceAgain(): Promise<boolean> {
    this.ensureRecorded();
    // weakAreas.weakTopicIds() is computed over the topic-performance signal that
    // ensureRecorded() just wrote, so start() draws from the UPDATED weak topics.
    return this.start();
  }

  /**
   * Fetch each weak topic's questions from the API.
   *
   * Returns null if ANY topic fails, so a session is never built from a partial
   * pool that would silently change the question mix. No local-bank fallback:
   * an unreachable API means no practice session, which is the honest outcome.
   */
  private async loadApiPools(
    topicIds: readonly string[]
  ): Promise<Map<string, QuizQuestion[]> | null> {
    const pools = new Map<string, QuizQuestion[]>();
    for (const topicId of topicIds) {
      try {
        const views = await firstValueFrom(this.questionsApi.loadQuestions(topicId));
        pools.set(topicId, questionsFromApiViews(views));
      } catch {
        return null;
      }
    }
    return pools;
  }

  select(index: number, optionIds: number[]): void {
    if (index < 0 || index >= this.total()) return;
    if (this._status() === 'submitted') return;   // answers lock after submission
    this._answersByIndex.update((current) => ({ ...current, [index]: [...optionIds] }));
    this.persist();
  }

  goTo(index: number): void {
    if (index < 0 || index >= this.total()) return;
    this._currentIndex.set(index);
    this.persist();
  }

  next(): void {
    if (this.canGoNext()) this.goTo(this._currentIndex() + 1);
  }

  previous(): void {
    if (this.canGoPrevious()) this.goTo(this._currentIndex() - 1);
  }

  /**
   * Score and close the session. Idempotent: a second call (double click, a
   * remount, a refresh that replays the flow) keeps the FIRST result, so the
   * recorded attempt and the displayed result can never disagree.
   */
  submit(): void {
    if (this._status() === 'submitted') return;
    if (this.total() === 0) return;
    if (!this.canSubmit()) return;   // same gate the visible button enforces

    this._result.set(
      computePracticeResult({
        sessionId: this._sessionId(),
        questions: this._questions(),
        answersByIndex: this._answersByIndex(),
        completedAt: new Date().toISOString(),
        topicNameFor: (topicId) => this.topicNameFor(topicId),
        authorizedResolved: this.authorizedResolved,
        authorizedCorrectTexts: this.authorizedCorrectTexts
      })
    );
    this._status.set('submitted');
    this.persist();
    this.ensureRecorded();
  }

  /**
   * Record this attempt's per-topic raw counts into topicPerformanceHistory:v1,
   * EXACTLY ONCE. Safe to call repeatedly: the history service dedupes by
   * attemptId against PERSISTED state, so a Results remount or refresh is a
   * durable no-op rather than relying on an in-memory flag.
   *
   * The counts come straight off the SAME PracticeResult that Results renders,
   * so the record and the screen can never diverge. Nothing here touches
   * Interview History, High Scores, achievements, certificates or quiz
   * completion counts.
   */
  ensureRecorded(): void {
    const result = this._result();
    if (!result || !result.sessionId) return;
    this.topicHistory.record(
      `practice:${result.sessionId}`,
      'weak-areas-practice',
      result.perTopic.map((topic) => ({
        topicId: topic.topicId,
        topicName: topic.topicName,
        correct: topic.correct,
        total: topic.total
      }))
    );
  }

  /** Drop the session entirely (Back to Quizzes). Recorded history is untouched. */
  clear(): void {
    this._sessionId.set('');
    this._questions.set([]);
    this._topicIds.set([]);
    this._answersByIndex.set({});
    this._currentIndex.set(0);
    this._status.set('active');
    this._result.set(null);
    removeSessionKey(SK_PRACTICE_SESSION);
  }

  /** Display title for a sourceQuizId — the same lookup Interview Mode uses. */
  private topicNameFor(topicId: string): string {
    return getQuizData().find((quiz) => quiz.quizId === topicId)?.milestone ?? topicId;
  }

  // ── persistence ─────────────────────────────────────────────────
  private persist(): void {
    if (this.total() === 0) return;
    const snapshot: PersistedPracticeSession = {
      version: PRACTICE_SESSION_VERSION,
      sessionId: this._sessionId(),
      questions: this._questions(),
      topicIds: this._topicIds(),
      answersByIndex: this._answersByIndex(),
      currentIndex: this._currentIndex(),
      status: this._status(),
      result: this._result()
    };
    writeSessionJson(SK_PRACTICE_SESSION, snapshot);
  }

  private restore(): void {
    const raw = readSessionJson<PersistedPracticeSession | null>(SK_PRACTICE_SESSION, null);
    if (!raw || raw.version !== PRACTICE_SESSION_VERSION) return;
    if (!Array.isArray(raw.questions) || raw.questions.length === 0) return;
    if (!raw.sessionId) return;

    this._sessionId.set(raw.sessionId);
    this._questions.set(raw.questions);
    this._topicIds.set(Array.isArray(raw.topicIds) ? raw.topicIds : []);
    this._answersByIndex.set(
      raw.answersByIndex && typeof raw.answersByIndex === 'object' ? raw.answersByIndex : {}
    );
    // Clamp a hand-edited or stale index into range.
    const index = Number(raw.currentIndex);
    this._currentIndex.set(
      Number.isInteger(index) && index >= 0 && index < raw.questions.length ? index : 0
    );

    // A snapshot claiming 'submitted' without a scored result is unusable — fall
    // back to active rather than stranding the user on a Results page with
    // nothing to show.
    const result = this.validResult(raw.result, raw.sessionId);
    const submitted = raw.status === 'submitted' && result != null;
    this._result.set(submitted ? result : null);
    this._status.set(submitted ? 'submitted' : 'active');
  }

  /** Reject a malformed or mismatched persisted result rather than rendering it. */
  private validResult(raw: unknown, sessionId: string): PracticeResult | null {
    const candidate = raw as PracticeResult | null;
    if (!candidate || typeof candidate !== 'object') return null;
    if (candidate.sessionId !== sessionId) return null;
    if (!Number.isInteger(candidate.total) || candidate.total <= 0) return null;
    if (!Array.isArray(candidate.perTopic) || !Array.isArray(candidate.review)) return null;
    return candidate;
  }

  private newSessionId(): string {
    return `wap_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}
