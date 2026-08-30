import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { AchievementService } from './achievement.service';
import { AchievementCatalogEntry } from '../../models/achievement.model';
import { SK_QUIZ_ACHIEVEMENTS, SK_QUIZ_BEST_SCORES } from '../../constants/session-keys';
import { InterviewReadiness, InterviewReadinessBand } from '../../models/interview-readiness.model';
import { InterviewReadinessService } from '../features/interview/interview-readiness.service';
import { InterviewHistoryService } from '../features/interview/interview-history.service';

/**
 * Minimal quiz factory — quizId + difficulty ONLY. No cast to the full Quiz
 * model needed: this IS the entire AchievementCatalogEntry contract, proving
 * evaluate() needs nothing else — no questions, options, correct flags, or
 * explanations reach it through any test in this file (S6d).
 */
function quiz(quizId: string, difficulty?: string): AchievementCatalogEntry {
  return { quizId, difficulty };
}

const BEGINNER = [quiz('b1', 'beginner'), quiz('b2', 'beginner')];
const INTERMEDIATE = [quiz('i1', 'intermediate')];
const ADVANCED = [quiz('a1', 'advanced')];
const ALL: AchievementCatalogEntry[] = [...BEGINNER, ...INTERMEDIATE, ...ADVANCED];

// ── signal-backed interview stubs (Interview Master reuses these services) ──
const readinessSig = signal<InterviewReadiness | null>(null);
const trendsSig = signal<{ best: number | null }>({ best: null });

function makeReadiness(band: InterviewReadinessBand, status: 'ready' | 'insufficient' = 'ready'): InterviewReadiness {
  return {
    status, score: band === 'interview-ready' ? 92 : 80, band,
    recentPerformance: 90, consistency: 85, rawConsistency: 85, topicCoverage: 80, topicStrength: 80,
    coverageAvailable: true, practicedTopicCount: 5, eligibleTopicCount: 5,
    strongestFactor: 'recent-performance', limitingFactor: 'topic-strength',
    explanation: '', recommendations: [], attemptsUsed: 5, totalAttempts: 5
  };
}

/** Put the interview signals into (or out of) the Interview Master state. */
function setInterviewMastery(on: boolean): void {
  readinessSig.set(on ? makeReadiness('interview-ready') : null);
  trendsSig.set({ best: on ? 95 : null });
}

describe('AchievementService', () => {
  let service: AchievementService;

  beforeEach(() => {
    localStorage.clear();
    readinessSig.set(null);
    trendsSig.set({ best: null });
    TestBed.configureTestingModule({
      providers: [
        { provide: InterviewReadinessService, useValue: { readiness: readinessSig } },
        { provide: InterviewHistoryService, useValue: { trends: trendsSig } }
      ]
    });
    service = TestBed.inject(AchievementService);
  });

  const ids = (defs: { id: string }[]): string[] => defs.map((d) => d.id);
  const earnedIds = (): string[] => [...service.earnedIds()];

  // 1
  it('earns nothing when nothing has been completed', () => {
    expect(service.evaluate(ALL)).toEqual([]);
    expect(earnedIds()).toEqual([]);
  });

  // 2
  it('awards Perfect Score for a single 100% quiz', () => {
    service.recordQuizResult('b1', 100);
    expect(ids(service.evaluate(ALL))).toContain('perfect-score');
  });

  // 3
  it('does NOT award Perfect Score for a completed-but-imperfect quiz', () => {
    service.recordQuizResult('b1', 80);
    expect(ids(service.evaluate(ALL))).not.toContain('perfect-score');
  });

  // 4
  it('awards Beginner Complete only when every beginner quiz is completed', () => {
    service.recordQuizResult('b1', 50);
    expect(ids(service.evaluate(ALL))).not.toContain('beginner-complete');
    service.recordQuizResult('b2', 10);
    expect(ids(service.evaluate(ALL))).toContain('beginner-complete');
  });

  // ── Interview Master (reuses readiness + interview score) ──────────────
  // 5
  it('awards Interview Master at the highest readiness tier AND a strong score', () => {
    setInterviewMastery(true);
    expect(ids(service.evaluate(ALL))).toContain('interview-master');
  });

  // 6
  it('does NOT award Interview Master below the bar (tier / score / insufficient)', () => {
    readinessSig.set(makeReadiness('strong'));   // not the highest tier
    trendsSig.set({ best: 95 });
    expect(ids(service.evaluate(ALL))).not.toContain('interview-master');

    readinessSig.set(makeReadiness('interview-ready'));
    trendsSig.set({ best: 89 });                 // score below 90
    expect(ids(service.evaluate(ALL))).not.toContain('interview-master');

    readinessSig.set(makeReadiness('interview-ready', 'insufficient'));  // one attempt only
    trendsSig.set({ best: 95 });
    expect(ids(service.evaluate(ALL))).not.toContain('interview-master');
  });

  // ── Angular Explorer (meta: unlock every OTHER achievement) ────────────
  // 7
  it('does NOT award Angular Explorer just for completing every quiz', () => {
    for (const q of ALL) service.recordQuizResult(q.quizId, 20);   // completes, no 100%, no interview
    const earned = ids(service.evaluate(ALL));
    expect(earned).toContain('beginner-complete');
    expect(earned).not.toContain('angular-explorer');   // perfect-score + interview-master still missing
  });

  // 8
  it('awards Angular Explorer once (and together with) the final missing achievement', () => {
    for (const q of ALL) service.recordQuizResult(q.quizId, 100);   // perfect-score + all difficulty completes
    expect(ids(service.evaluate(ALL))).not.toContain('angular-explorer');   // interview-master still missing
    // Earning the last one (Interview Master) unlocks Explorer in the SAME pass.
    setInterviewMastery(true);
    const finalPass = ids(service.evaluate(ALL));
    expect(finalPass).toContain('interview-master');
    expect(finalPass).toContain('angular-explorer');
    expect(earnedIds()).toEqual(
      expect.arrayContaining([
        'perfect-score', 'beginner-complete', 'intermediate-complete',
        'advanced-complete', 'interview-master', 'angular-explorer'
      ])
    );
  });

  // 9
  it('is idempotent — a second evaluate with no new progress returns []', () => {
    service.recordQuizResult('b1', 100);
    expect(service.evaluate(ALL).length).toBeGreaterThan(0);
    expect(service.evaluate(ALL)).toEqual([]);
  });

  // 10
  it('never awards the same achievement twice across evaluations', () => {
    service.recordQuizResult('b1', 100);
    service.evaluate(ALL);
    service.recordQuizResult('b2', 100);
    expect(ids(service.evaluate(ALL))).not.toContain('perfect-score');
    expect(earnedIds().filter((id) => id === 'perfect-score').length).toBe(1);
  });

  // 11
  it('keeps the BEST score — a lower later attempt does not lower it', () => {
    service.recordQuizResult('b1', 100);
    service.recordQuizResult('b1', 40);
    expect(JSON.parse(localStorage.getItem(SK_QUIZ_BEST_SCORES) ?? '{}').b1).toBe(100);
  });

  // 12
  it('does not award a difficulty achievement when zero quizzes exist for it', () => {
    const onlyBeginner = [...BEGINNER];
    for (const q of onlyBeginner) service.recordQuizResult(q.quizId, 100);
    const earned = ids(service.evaluate(onlyBeginner));
    expect(earned).toContain('beginner-complete');
    expect(earned).not.toContain('intermediate-complete');
    expect(earned).not.toContain('advanced-complete');
  });

  // 13
  it('survives malformed persisted achievement data (drops junk, keeps valid)', () => {
    localStorage.setItem(SK_QUIZ_ACHIEVEMENTS, '{ not valid json');
    expect(() => service.evaluate(ALL)).not.toThrow();
    expect(earnedIds()).toEqual([]);
  });

  // 14
  it('ignores unknown/duplicate ids when reading', () => {
    localStorage.setItem(SK_QUIZ_ACHIEVEMENTS, JSON.stringify([
      { id: 'perfect-score', earnedAt: '2020-01-01T00:00:00.000Z' },
      { id: 'perfect-score', earnedAt: '2020-01-02T00:00:00.000Z' },
      { id: 'angular-master', earnedAt: 'x' },   // retired id → dropped
      { id: 'not-a-real-achievement', earnedAt: 'x' }
    ]));
    expect(earnedIds()).toEqual(['perfect-score']);
  });

  // 15
  it('does not revoke Angular Explorer when a new, uncompleted quiz is added', () => {
    for (const q of ALL) service.recordQuizResult(q.quizId, 100);
    setInterviewMastery(true);
    expect(ids(service.evaluate(ALL))).toContain('angular-explorer');
    // A new beginner quiz appears — beginner-complete/explorer no longer "satisfied"
    // but earned achievements are NEVER revoked.
    service.evaluate([...ALL, quiz('b3', 'beginner')]);
    expect(earnedIds()).toContain('angular-explorer');
  });

  // 16
  it('seeds best scores from legacy highScoresLocal when none stored yet', () => {
    localStorage.setItem('highScoresLocal', JSON.stringify([{ quizId: 'b1', score: 100 }]));
    expect(ids(service.evaluate(ALL))).toContain('perfect-score');
  });

  // 17 — REGRESSION GUARD. `earnedIds` must stay a SIGNAL, not a plain method
  // that re-reads localStorage. A downstream computed() (notably the
  // certificate's `progress`) cannot track a method call, so it would serve a
  // stale value until some unrelated signal happened to invalidate it — which
  // silently blocked the certificate unlock. Any revert breaks this test.
  it('earnedIds is reactive: a downstream computed sees newly earned achievements', () => {
    const explorerEarned = computed(() => service.earnedIds().has('angular-explorer'));

    // Read FIRST, while nothing is earned — this caches the computed.
    expect(explorerEarned()).toBe(false);

    // Earn everything (including the meta Explorer) via a normal evaluation.
    localStorage.setItem(
      SK_QUIZ_BEST_SCORES,
      JSON.stringify({ b1: 100, b2: 90, i1: 90, a1: 90 })
    );
    setInterviewMastery(true);
    expect(ids(service.evaluate(ALL))).toContain('angular-explorer');

    // The already-read computed must now recompute. Fails if earnedIds regresses.
    expect(explorerEarned()).toBe(true);
  });
});
