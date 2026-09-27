import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { AchievementService } from './achievement.service';
import { InterviewAttemptHistoryEntry, InterviewTopicHistoryEntry } from '@shared/models';
import { SK_QUIZ_ACHIEVEMENTS } from '@shared/constants/session-keys';
import { InterviewHistoryService } from '@shared/services/features/interview/interview-history.service';
import { InterviewReadinessService } from '@shared/services/features/interview/interview-readiness.service';
import {
  CatalogStatus,
  InterviewCatalogService,
  InterviewTopic
} from '@shared/services/interview/interview-catalog.service';

/**
 * Interview Master must never be awarded — or persisted — on the strength of an
 * Interview catalogue that has not been loaded.
 *
 * Coverage is 20% of the readiness score. Before the catalogue loads, the real
 * InterviewReadinessService used to fall back to "the topics the user already
 * practised" as the denominator, which reads as 100% coverage. That could tip a
 * user over the 90-point `interview-ready` band, and the achievement is stored
 * permanently (and cascades into Angular Explorer and certificate eligibility).
 *
 * These tests wire the REAL AchievementService and the REAL InterviewReadinessService
 * together (only the catalogue and history sources are stubbed), because the
 * existing AchievementService spec mocks readiness and so cannot see this path.
 */

function topic(topicId: string, pct: number): InterviewTopicHistoryEntry {
  return { topicId, topicName: topicId.toUpperCase(), correct: pct, total: 100, percentage: pct };
}

function attempt(i: number, pct: number, topics: InterviewTopicHistoryEntry[]): InterviewAttemptHistoryEntry {
  return {
    id: `a${i}`,
    attemptNumber: i + 1,
    completedAt: `2026-07-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
    score: pct,
    totalQuestions: 100,
    percentage: pct,
    completionReason: 'submitted',
    durationSeconds: 600,
    configuredDifficulty: 'mixed',
    selectedTopicIds: topics.map((t) => t.topicId),
    topicPerformance: topics
  };
}

/** Five 92% attempts over just TWO topics: 93.6 with fake full coverage, ~77.6 against a 10-topic catalogue. */
const HISTORY = [0, 1, 2, 3, 4].map((i) => attempt(i, 92, [topic('forms', 92), topic('di', 92)]));

function catalogue(count: number): InterviewTopic[] {
  const named = ['forms', 'di'];
  return Array.from({ length: count }, (_, i) => ({
    id: named[i] ?? `t${i}`,
    name: `Topic ${i}`,
    difficulty: 'beginner',
    questionCount: 10
  }));
}

describe('AchievementService — Interview Master vs the Interview catalogue', () => {
  const topics = signal<readonly InterviewTopic[]>([]);
  const status = signal<CatalogStatus>('idle');
  let load: jest.Mock<Promise<void>, []>;
  let service: AchievementService;

  function setup(loadImpl: () => Promise<void> = async () => undefined): void {
    load = jest.fn(loadImpl);
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: InterviewHistoryService, useValue: { history: signal(HISTORY), trends: signal({ best: 92 }) } },
        { provide: InterviewCatalogService, useValue: { topics, status, load } }
      ]
    });
    service = TestBed.inject(AchievementService);
    // Sanity: the fixture really is interview-ready when coverage is faked at 100%.
    void TestBed.inject(InterviewReadinessService);
  }

  const stored = (): string => localStorage.getItem(SK_QUIZ_ACHIEVEMENTS) ?? '';
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    topics.set([]);
    status.set('idle');
  });

  it('user lands on Quiz Selection / Results without visiting the Builder (catalogue idle): NOT awarded, NOT persisted', () => {
    setup();
    expect(service.evaluateInterviewAchievements().map((d) => d.id)).not.toContain('interview-master');
    expect(stored()).not.toContain('interview-master');
  });

  it('catalogue still loading: NOT awarded, NOT persisted', () => {
    status.set('loading');
    setup();
    expect(service.evaluateInterviewAchievements().map((d) => d.id)).not.toContain('interview-master');
    expect(stored()).not.toContain('interview-master');
  });

  it('catalogue failed to load (unavailable): fail closed — NOT awarded, NOT persisted', async () => {
    status.set('unavailable');
    setup();
    expect(service.evaluateInterviewAchievements().map((d) => d.id)).not.toContain('interview-master');
    await flush();
    expect(service.earnedIds().has('interview-master')).toBe(false);
    expect(stored()).not.toContain('interview-master');
  });

  it('catalogue loaded but coverage is genuinely insufficient (2 of 10 topics): NOT awarded', () => {
    topics.set(catalogue(10));
    status.set('ready');
    setup();
    expect(service.evaluateInterviewAchievements().map((d) => d.id)).not.toContain('interview-master');
    expect(stored()).not.toContain('interview-master');
  });

  it('catalogue loaded and the user legitimately qualifies (2 of 2 topics, 92%): awarded and persisted', () => {
    topics.set(catalogue(2));
    status.set('ready');
    setup();
    expect(service.evaluateInterviewAchievements().map((d) => d.id)).toContain('interview-master');
    expect(stored()).toContain('interview-master');
    expect(load).not.toHaveBeenCalled();              // already loaded: no extra request
  });

  it('idle catalogue, qualifying user: loads the catalogue and awards ONCE it proves coverage (deferred, not lost)', async () => {
    setup(async () => {
      topics.set(catalogue(2));
      status.set('ready');
    });
    expect(service.evaluateInterviewAchievements().map((d) => d.id)).not.toContain('interview-master');
    expect(stored()).not.toContain('interview-master');   // nothing persisted while unverified

    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(service.earnedIds().has('interview-master')).toBe(true);
    expect(stored()).toContain('interview-master');
  });

  it('idle catalogue whose load reveals insufficient coverage: never awarded', async () => {
    setup(async () => {
      topics.set(catalogue(10));
      status.set('ready');
    });
    service.evaluateInterviewAchievements();
    await flush();
    expect(service.earnedIds().has('interview-master')).toBe(false);
    expect(stored()).not.toContain('interview-master');
  });

  it('does not fire a catalogue request for a user who could not qualify anyway', () => {
    TestBed.resetTestingModule();
    localStorage.clear();
    load = jest.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: InterviewHistoryService, useValue: { history: signal([]), trends: signal({ best: null }) } },
        { provide: InterviewCatalogService, useValue: { topics, status, load } }
      ]
    });
    TestBed.inject(AchievementService).evaluateInterviewAchievements();
    expect(load).not.toHaveBeenCalled();
  });
});
