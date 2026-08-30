import { computed, inject, Service, signal } from '@angular/core';

import {
  AchievementCatalogEntry,
  AchievementDefinition,
  AchievementId,
  AchievementView,
  EarnedAchievement
} from '../../models/achievement.model';
import { ACHIEVEMENT_DEFINITIONS } from '../../constants/achievements';
import {
  CERTIFICATE_MIN_SCORE,
  CERTIFICATE_REQUIRED_BAND
} from '../../models/interview-certificate.model';
import { SK_QUIZ_ACHIEVEMENTS } from '../../constants/session-keys';
import { readLocalJson, writeLocalJson } from '../../utils/local-storage';
import { BestScores, BestScoreService } from '../progress/best-score.service';
import { InterviewReadinessService } from '../features/interview/interview-readiness.service';
import { InterviewHistoryService } from '../features/interview/interview-history.service';

/**
 * Centralized, backend-free achievement engine. It owns the ONLY durable state
 * this feature adds:
 *   - best score per quiz (quizBestScores)  — key presence = completed
 *   - earned achievements (quizAchievements) — id + ISO earnedAt
 *
 * All achievement rules live here (not scattered across components). Evaluation
 * is idempotent: re-running with the same data earns nothing new.
 */
@Service()
export class AchievementService {
  readonly definitions: readonly AchievementDefinition[] = ACHIEVEMENT_DEFINITIONS;

  private readonly bestScoreService = inject(BestScoreService);
  // Interview Master reuses these two services (no re-derivation of readiness or
  // interview score here). No cycle: neither injects AchievementService.
  private readonly readiness = inject(InterviewReadinessService);
  private readonly interviewHistory = inject(InterviewHistoryService);

  // Bumped whenever an achievement is earned. `earnedIds` depends on it, which
  // makes the derived read REACTIVE while keeping localStorage authoritative
  // (the value is still re-read on each recompute, so a direct storage seed is
  // still honoured). Previously `earnedIds` was a plain method: a downstream
  // computed() — notably the certificate's `progress` — could not track it and
  // served a stale value until some unrelated signal invalidated it, silently
  // blocking the certificate unlock.
  private readonly _rev = signal(0);

  /**
   * Record a completed quiz's score, keeping the BEST per quiz. A later, lower
   * attempt never lowers a previously stored higher score. Delegates to the
   * shared best-score store (the single source of completion + best-score data).
   */
  recordQuizResult(quizId: string, scorePercent: number): void {
    this.bestScoreService.recordBestScore(quizId, scorePercent);
  }

  /**
   * Evaluate all achievements against current quiz metadata + persisted best
   * scores. Persists any newly earned achievement and returns ONLY the ones
   * earned by THIS evaluation (so a repeat call returns []).
   */
  /**
   * Evaluate only what a completed INTERVIEW can unlock, without the quiz bank.
   *
   * Interview Mode is backend-driven and must not load `assets/data/quiz.json`
   * merely to refresh achievements. It does not need to: `interview-master`
   * reads Interview History, and `angular-explorer` is a meta achievement over
   * already-earned ids. The topic-quiz achievements — which genuinely do need
   * the catalogue — stay the responsibility of the topic-quiz flow, where they
   * are already evaluated (Quiz Selection and the topic Results page).
   *
   * Passing an empty catalogue is safe rather than merely convenient: every
   * quiz-dependent rule requires a NON-EMPTY group, so none can be satisfied by
   * accident, and an already-earned achievement is never re-awarded.
   */
  evaluateInterviewAchievements(): AchievementDefinition[] {
    return this.evaluate([]);
  }

  evaluate(quizzes: readonly AchievementCatalogEntry[]): AchievementDefinition[] {
    const best = this.bestScoreService.getBestScores();
    const earned = this.readEarned();
    const earnedIds = new Set<AchievementId>(earned.map(e => e.id));

    const newly: AchievementDefinition[] = [];

    // Data-driven achievements first (everything except the meta Explorer).
    for (const def of this.definitions) {
      if (def.id === 'angular-explorer') continue;         // meta — handled below
      if (earnedIds.has(def.id)) continue;                 // already earned → never twice
      if (this.isSatisfied(def.id, quizzes, best)) newly.push(def);
    }

    // Angular Explorer is a META achievement: it unlocks once EVERY other
    // achievement is earned — including any earned in THIS same pass — so the
    // final milestone and Explorer can unlock together.
    const explorer = this.definitions.find(d => d.id === 'angular-explorer');
    if (explorer && !earnedIds.has('angular-explorer')) {
      const earnedAfter = new Set<AchievementId>([...earnedIds, ...newly.map(d => d.id)]);
      const others = this.definitions.filter(d => d.id !== 'angular-explorer');
      if (others.every(d => earnedAfter.has(d.id))) newly.push(explorer);
    }

    if (newly.length > 0) {
      const now = new Date().toISOString();
      const updated: EarnedAchievement[] = [
        ...earned,
        ...newly.map(d => ({ id: d.id, earnedAt: now }))
      ];
      writeLocalJson(SK_QUIZ_ACHIEVEMENTS, updated);
      this._rev.update((n) => n + 1);   // publish reactively — see `_rev`
    }
    return newly;
  }

  /** Ids of every achievement earned so far. Reactive (see `_rev`). */
  readonly earnedIds = computed(() => {
    this._rev();   // reactive dependency — recompute after each new earn
    return new Set<AchievementId>(this.readEarned().map(e => e.id));
  });

  /** Compact progress summary for the catalog UI (e.g. "3 / 6"). */
  summary(): { earned: number; total: number } {
    return { earned: this.earnedIds().size, total: this.definitions.length };
  }

  /** Every achievement paired with its earned/locked state, for catalog display. */
  catalog(): AchievementView[] {
    const earned = this.earnedIds();
    return this.definitions.map(def => ({ ...def, earned: earned.has(def.id) }));
  }

  // ── rules ──────────────────────────────────────────────────────
  private isSatisfied(
    id: AchievementId,
    quizzes: readonly AchievementCatalogEntry[],
    best: BestScores
  ): boolean {
    const isCompleted = (q: AchievementCatalogEntry): boolean => best[q.quizId] != null;   // any score counts
    const isPerfect = (q: AchievementCatalogEntry): boolean => best[q.quizId] === 100;
    const inDifficulty = (d: string): AchievementCatalogEntry[] =>
      quizzes.filter(q => (q.difficulty ?? '').toLowerCase() === d);

    switch (id) {
      case 'perfect-score':
        return quizzes.some(isPerfect);
      case 'interview-master':
        return this.isInterviewMaster();
      case 'beginner-complete':
      case 'intermediate-complete':
      case 'advanced-complete': {
        const difficulty = id.replace('-complete', '');    // beginner | intermediate | advanced
        const group = inDifficulty(difficulty);
        return group.length > 0 && group.every(isCompleted);  // zero quizzes → not awarded
      }
      // 'angular-explorer' is meta (handled in evaluate), never data-driven here.
      default:
        return false;
    }
  }

  /**
   * Interview Master — the highest Interview Readiness tier AND a strong
   * Interview Mode score. REUSES InterviewReadinessService + InterviewHistoryService
   * (no second calculation), and shares the SAME bar as the Interview Master
   * Certificate so the two stay in lock-step.
   */
  private isInterviewMaster(): boolean {
    const readiness = this.readiness.readiness();
    const best = this.interviewHistory.trends().best;
    return (
      readiness?.status === 'ready' &&
      readiness.band === CERTIFICATE_REQUIRED_BAND &&
      (best ?? 0) >= CERTIFICATE_MIN_SCORE
    );
  }

  // ── persisted state (safe reads) ───────────────────────────────
  private readEarned(): EarnedAchievement[] {
    const raw = readLocalJson<unknown>(SK_QUIZ_ACHIEVEMENTS, []);
    if (!Array.isArray(raw)) return [];
    const valid = new Set(this.definitions.map(d => d.id));
    const seen = new Set<string>();
    const out: EarnedAchievement[] = [];
    for (const entry of raw) {
      const id = (entry as EarnedAchievement)?.id;
      if (typeof id !== 'string' || !valid.has(id as AchievementId) || seen.has(id)) continue;
      seen.add(id);
      const earnedAt = (entry as EarnedAchievement)?.earnedAt;
      out.push({
        id: id as AchievementId,
        earnedAt: typeof earnedAt === 'string' ? earnedAt : new Date().toISOString()
      });
    }
    return out;
  }
}
