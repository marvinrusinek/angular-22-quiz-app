import { Service } from '@angular/core';

import { SK_QUIZ_BEST_SCORES } from '@shared/constants/session-keys';
import { readLocalJson, writeLocalJson } from '@shared/utils/local-storage';

/** quizId -> best score (0-100). A key's presence means the quiz was completed. */
export type BestScores = Record<string, number>;

/**
 * The single owner of the durable per-quiz best-score store (`quizBestScores`).
 *
 * Both the Achievements engine and Progress Tracking read completion + best-score
 * data from HERE — neither reads localStorage for it directly and neither owns a
 * competing store. Key presence = the quiz was completed (any score); the value
 * is the highest recorded percentage, which a lower retake never lowers.
 *
 * Reads are defensive (malformed data → dropped) and one-time seed from the
 * legacy `highScoresLocal` list so users with existing progress get credit.
 */
@Service()
export class BestScoreService {
  /** Record a completed quiz's score, keeping the BEST per quiz (never lowered). */
  recordBestScore(quizId: string, scorePercent: number): void {
    if (!quizId) return;
    const score = this.clampPercent(scorePercent);
    const best = this.readRaw();
    const previous = best[quizId];
    best[quizId] = previous == null ? score : Math.max(previous, score);
    writeLocalJson(SK_QUIZ_BEST_SCORES, best);
  }

  /** All best scores (safe-parsed), seeding from legacy data on first read if empty. */
  getBestScores(): BestScores {
    this.seedFromLegacyIfEmpty();
    return this.readRaw();
  }

  /** Best score for one quiz, or null if the quiz has not been completed. */
  getBestScore(quizId: string): number | null {
    const value = this.getBestScores()[quizId];
    return typeof value === 'number' ? value : null;
  }

  /** Whether the quiz has been completed at least once (any score). */
  isCompleted(quizId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.getBestScores(), quizId);
  }

  // ── internals ──────────────────────────────────────────────────
  private readRaw(): BestScores {
    const raw = readLocalJson<unknown>(SK_QUIZ_BEST_SCORES, {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: BestScores = {};
    for (const [quizId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[quizId] = this.clampPercent(value);
    }
    return out;
  }

  private seedFromLegacyIfEmpty(): void {
    if (Object.keys(this.readRaw()).length > 0) return;
    const legacy = readLocalJson<unknown[]>('highScoresLocal', []);
    if (!Array.isArray(legacy) || legacy.length === 0) return;
    const best: BestScores = {};
    for (const entry of legacy) {
      const quizId = (entry as { quizId?: unknown })?.quizId;
      const score = (entry as { score?: unknown })?.score;
      if (typeof quizId === 'string' && typeof score === 'number' && Number.isFinite(score)) {
        const pct = this.clampPercent(score);
        best[quizId] = best[quizId] == null ? pct : Math.max(best[quizId], pct);
      }
    }
    if (Object.keys(best).length > 0) writeLocalJson(SK_QUIZ_BEST_SCORES, best);
  }

  private clampPercent(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }
}
