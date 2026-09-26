import { TestBed } from '@angular/core/testing';

import {
  INTERVIEW_HISTORY_MAX,
  InterviewAttemptHistoryEntry,
  InterviewResult,
  InterviewTopicScore
} from '@shared/models';
import { SK_INTERVIEW_HISTORY } from '@shared/constants/session-keys';
import {
  filterAttempts,
  InterviewHistoryService,
  summarizeTrends,
  validateAttemptEntry,
  validateHistoryStore
} from './interview-history.service';
import type { SanitizedAttemptInput } from '@shared/services/interview/interview-result-history.adapter';

/** A sanitized attempt as the adapter would produce it. */
function sanitized(over: Partial<SanitizedAttemptInput> = {}): SanitizedAttemptInput {
  return {
    sessionId: 'is_1',
    completedAt: '2026-08-01T12:00:00.000Z',
    score: 7,
    totalQuestions: 10,
    percentage: 70,
    completionReason: 'submitted',
    answered: 9,
    unanswered: 1,
    incorrect: 2,
    durationSeconds: 900,
    timeUsedSeconds: 540,
    submittedByExpiry: false,
    focusChanges: 2,
    configKind: 'custom',
    configuredDifficulty: 'beginner',
    selectedTopicIds: ['rxjs'],
    topicPerformance: [
      { topicId: 'rxjs', topicName: 'RxJS', correct: 4, total: 5, percentage: 80 }
    ],
    ...over
  };
}

// ── factories ─────────────────────────────────────────────────────────
function topic(quizId: string, correct: number, total: number): InterviewTopicScore {
  return { quizId, title: quizId.toUpperCase(), correct, total, percentage: Math.round((correct / total) * 100) };
}

// A distinct InterviewResult with a given percentage/score (new object each call
// so the dedup-by-reference guard never collapses two genuine attempts).
function makeResult(pct: number, over: Partial<InterviewResult> = {}): InterviewResult {
  return {
    total: 100,
    answered: 100,
    unanswered: 0,
    correct: pct,
    incorrect: 100 - pct,
    percentage: pct,
    timeUsedSeconds: 120,
    timeRemainingSeconds: 0,
    difficulty: 'mixed',
    topicIds: ['a'],
    perTopic: [topic('a', pct, 100)],
    submittedByExpiry: false,
    focusChanges: 0,
    ...over
  };
}

function entry(pct: number, over: Partial<InterviewAttemptHistoryEntry> = {}): InterviewAttemptHistoryEntry {
  return {
    id: `id-${pct}-${Math.round(pct * 7)}`,
    completedAt: '2026-07-22T10:00:00.000Z',
    score: pct,
    totalQuestions: 100,
    percentage: pct,
    completionReason: 'submitted',
    durationSeconds: 120,
    configuredDifficulty: 'mixed',
    selectedTopicIds: ['a'],
    topicPerformance: [{ topicId: 'a', topicName: 'A', correct: pct, total: 100, percentage: pct }],
    ...over
  };
}

function seed(attempts: InterviewAttemptHistoryEntry[], version: unknown = 2): void {
  localStorage.setItem(SK_INTERVIEW_HISTORY, JSON.stringify({ version, attempts }));
}

function freshService(): InterviewHistoryService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  return TestBed.inject(InterviewHistoryService);
}

describe('InterviewHistoryService — persistence', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('1. first completed interview creates the first history entry', () => {
    const svc = freshService();
    expect(svc.history()).toHaveLength(0);
    svc.record(makeResult(70));
    expect(svc.history()).toHaveLength(1);
    expect(svc.history()[0]).toMatchObject({ score: 70, percentage: 70, totalQuestions: 100 });
  });

  it('2. submitted interviews are saved as "submitted"', () => {
    const svc = freshService();
    svc.record(makeResult(80, { submittedByExpiry: false }));
    expect(svc.history()[0].completionReason).toBe('submitted');
  });

  it('3. timer-expired interviews are saved as "time-expired"', () => {
    const svc = freshService();
    svc.record(makeResult(50, { submittedByExpiry: true }));
    expect(svc.history()[0].completionReason).toBe('time-expired');
  });

  it('4. abandoned interviews (no finalized result) are not saved', () => {
    const svc = freshService();
    svc.record(null);
    svc.record(undefined);
    expect(svc.history()).toHaveLength(0);
    expect(localStorage.getItem(SK_INTERVIEW_HISTORY)).toBeNull();
  });

  it('5. re-recording the same result object does not duplicate (re-render safe)', () => {
    const svc = freshService();
    const r = makeResult(64);
    svc.record(r);
    svc.record(r);   // e.g. a stray Results re-render calling through again
    svc.record(r);
    expect(svc.history()).toHaveLength(1);
  });

  it('6. reloading an already-saved result does not duplicate (refresh safe)', () => {
    const svc = freshService();
    svc.record(makeResult(88));
    expect(svc.history()).toHaveLength(1);

    // Simulate a refresh: a brand-new service instance loads from storage.
    const reloaded = freshService();
    expect(reloaded.history()).toHaveLength(1);
    expect(reloaded.history()[0].percentage).toBe(88);
  });

  it('7. the oldest entry is removed once 20 attempts are exceeded', () => {
    const svc = freshService();
    for (let i = 1; i <= INTERVIEW_HISTORY_MAX + 1; i++) svc.record(makeResult(i));
    const hist = svc.history();
    expect(hist).toHaveLength(INTERVIEW_HISTORY_MAX);
    // 21 recorded (scores 1..21); oldest (1) dropped → window is 2..21.
    expect(hist[0].score).toBe(2);
    expect(hist[hist.length - 1].score).toBe(21);
  });

  it('8. attempts remain in chronological (insertion) order', () => {
    const svc = freshService();
    for (const p of [30, 55, 42, 91]) svc.record(makeResult(p));
    expect(svc.history().map((e) => e.score)).toEqual([30, 55, 42, 91]);
  });

  it('clear() empties history and removes the store', () => {
    const svc = freshService();
    svc.record(makeResult(70));
    svc.clear();
    expect(svc.history()).toHaveLength(0);
    expect(localStorage.getItem(SK_INTERVIEW_HISTORY)).toBeNull();
  });

  it('assigns increasing lifetime attempt numbers', () => {
    const svc = freshService();
    svc.record(makeResult(70));
    svc.record(makeResult(80));
    svc.record(makeResult(90));
    expect(svc.history().map((e) => e.attemptNumber)).toEqual([1, 2, 3]);
  });

  it('keeps attempt numbers monotonic as older entries age out', () => {
    const svc = freshService();
    for (let i = 1; i <= INTERVIEW_HISTORY_MAX + 2; i++) svc.record(makeResult(i));
    const nums = svc.history().map((e) => e.attemptNumber);
    // 22 recorded; retained window is numbers 3..22 (not renumbered to 1..20).
    expect(nums[0]).toBe(3);
    expect(nums[nums.length - 1]).toBe(INTERVIEW_HISTORY_MAX + 2);
  });

  it('durably skips an attempt already persisted (same id, new result object)', () => {
    const svc = freshService();
    svc.record(makeResult(70), 'att-X');
    svc.record(makeResult(70), 'att-X');   // distinct object, same attempt id
    expect(svc.history()).toHaveLength(1);
    expect(svc.history()[0].id).toBe('att-X');
  });

  it('records distinct attempt ids separately', () => {
    const svc = freshService();
    svc.record(makeResult(70), 'att-a');
    svc.record(makeResult(70), 'att-b');
    expect(svc.history().map((e) => e.id)).toEqual(['att-a', 'att-b']);
  });

  it('durable dedup survives service recreation (reload)', () => {
    const s1 = freshService();
    s1.record(makeResult(70), 'att-keep');
    const s2 = freshService();               // reloads persisted history
    s2.record(makeResult(70), 'att-keep');   // same attempt id, fresh object
    expect(s2.history()).toHaveLength(1);
  });

  it('clamps a stored score that would exceed the question count', () => {
    const svc = freshService();
    svc.record(makeResult(80, { correct: 999, total: 10, percentage: 100, perTopic: [topic('a', 10, 10)] }));
    const e = svc.history()[0];
    expect(e.score).toBeLessThanOrEqual(e.totalQuestions);
  });

  it('reuses Topic Performance analytics for topicPerformance', () => {
    const svc = freshService();
    svc.record(makeResult(75, { perTopic: [topic('forms', 4, 5), topic('http', 1, 2)], correct: 5, total: 7, percentage: 71 }));
    const tp = svc.history()[0].topicPerformance;
    expect(tp.map((t) => t.topicId).sort()).toEqual(['forms', 'http']);
    expect(tp.find((t) => t.topicId === 'forms')).toMatchObject({ correct: 4, total: 5, percentage: 80 });
  });
});

/**
 * v2 is SANITIZED. The interview answer key lives on the backend now, so a
 * durable local copy of questions, options, correctness and explanations is
 * exactly what this schema removes.
 */
describe('sanitized v2 storage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  function readStore(): { version: number; attempts: InterviewAttemptHistoryEntry[] } {
    return JSON.parse(localStorage.getItem(SK_INTERVIEW_HISTORY) ?? '{}');
  }

  it('writes version 2 and never persists review data', () => {
    const svc = freshService();
    svc.record(makeResult(70), 'att_1');

    const raw = localStorage.getItem(SK_INTERVIEW_HISTORY) ?? '';
    expect(readStore().version).toBe(2);
    for (const banned of [
      'review', 'questions', 'options', 'selectedOptionIds', 'correctOptionIds',
      'explanation', 'answerKey', 'sessionToken', 'questionText'
    ]) {
      expect(raw).not.toContain(banned);
    }
  });

  it('recordAttempt stores the backend summary and per-topic tallies', () => {
    const svc = freshService();
    svc.recordAttempt(sanitized({ sessionId: 'is_1', score: 8, totalQuestions: 10, percentage: 80 }));

    const [entry] = svc.history();
    expect(entry).toMatchObject({
      sessionId: 'is_1', score: 8, totalQuestions: 10, percentage: 80,
      completionReason: 'submitted', focusChanges: 2
    });
    expect(entry!.topicPerformance[0]).toMatchObject({ topicId: 'rxjs', topicName: 'RxJS' });
    expect('review' in entry!).toBe(false);
  });

  it('DEDUPLICATES by sessionId, not by score and date', () => {
    const svc = freshService();
    const attempt = sanitized({ sessionId: 'is_1' });

    // Navigate → refresh → re-fetch → remount all describe ONE attempt.
    svc.recordAttempt(attempt);
    svc.recordAttempt(attempt);
    svc.recordAttempt({ ...attempt });
    expect(svc.history()).toHaveLength(1);

    // A DIFFERENT session with an identical score and timestamp is still a
    // second attempt — score+date alone could not tell these cases apart.
    svc.recordAttempt({ ...attempt, sessionId: 'is_2' });
    expect(svc.history()).toHaveLength(2);
  });

  it('a preset attempt gets no invented difficulty; a custom one keeps its own', () => {
    const svc = freshService();
    svc.recordAttempt(sanitized({
      sessionId: 'is_preset', configKind: 'preset', presetId: 'junior',
      presetName: 'Junior Developer', configuredDifficulty: undefined
    }));
    svc.recordAttempt(sanitized({
      sessionId: 'is_custom', configKind: 'custom', configuredDifficulty: 'advanced'
    }));

    const [preset, custom] = svc.history();
    expect(preset!.configKind).toBe('preset');
    expect(preset!.configuredDifficulty).toBeUndefined();   // mixed by design
    expect(preset!.presetName).toBe('Junior Developer');
    expect(custom!.configuredDifficulty).toBe('advanced');
    expect(custom!.presetName).toBeUndefined();
  });
});

describe('v1 → v2 migration', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  // A realistic historical record: full retained Q&A, exactly what v2 drops.
  const v1Entry = {
    id: 'att_old_1',
    attemptNumber: 3,
    completedAt: '2026-07-01T10:00:00.000Z',
    score: 7,
    totalQuestions: 10,
    percentage: 70,
    completionReason: 'submitted',
    durationSeconds: 540,
    configuredDifficulty: 'beginner',
    selectedTopicIds: ['rxjs', 'signals'],
    topicPerformance: [
      { topicId: 'rxjs', topicName: 'RxJS', correct: 4, total: 5, percentage: 80 }
    ],
    review: [
      {
        questionText: 'Which operator flattens?',
        explanation: 'switchMap cancels the previous inner observable.',
        type: 'single',
        sourceQuizId: 'rxjs',
        options: [
          { optionId: 1, text: 'switchMap', correct: true },
          { optionId: 2, text: 'tap', correct: false }
        ],
        selectedOptionIds: [1]
      }
    ]
  };

  function seedV1(attempts: unknown[]): void {
    localStorage.setItem(
      'interviewAttemptHistory:v1',
      JSON.stringify({ version: 1, attempts })
    );
  }

  it('preserves analytics, drops the retained Q&A, and removes v1', () => {
    seedV1([v1Entry]);
    const svc = freshService();

    const [entry] = svc.history();
    expect(entry).toMatchObject({
      id: 'att_old_1', attemptNumber: 3, score: 7, totalQuestions: 10,
      percentage: 70, configuredDifficulty: 'beginner'
    });
    expect(entry!.topicPerformance[0]).toMatchObject({ topicId: 'rxjs', topicName: 'RxJS' });

    // The answer key is gone from the record AND from storage.
    expect('review' in entry!).toBe(false);
    const raw = localStorage.getItem(SK_INTERVIEW_HISTORY) ?? '';
    expect(raw).not.toContain('switchMap');
    expect(raw).not.toContain('explanation');
    expect(raw).not.toContain('correct":true');

    // v1 is removed only after v2 exists.
    expect(localStorage.getItem('interviewAttemptHistory:v1')).toBeNull();
    expect(JSON.parse(raw).version).toBe(2);
  });

  it('keeps recoverable summaries and discards records too broken to trust', () => {
    seedV1([
      v1Entry,
      { ...v1Entry, id: 'att_old_2', review: 'not-an-array' },   // recoverable
      { id: 'att_bad', completedAt: 'nonsense', score: 1, totalQuestions: 2, percentage: 50 },
      { review: [{ questionText: 'orphan' }] }                    // no id → dropped
    ]);
    const svc = freshService();

    expect(svc.history().map((e) => e.id)).toEqual(['att_old_1', 'att_old_2']);
    expect(localStorage.getItem(SK_INTERVIEW_HISTORY)).not.toContain('orphan');
  });

  it('is idempotent and leaves unrelated storage alone', () => {
    seedV1([v1Entry]);
    localStorage.setItem('quizBestScores', '{"typescript":90}');

    freshService();
    const afterFirst = localStorage.getItem(SK_INTERVIEW_HISTORY);

    const second = freshService();

    expect(localStorage.getItem(SK_INTERVIEW_HISTORY)).toBe(afterFirst);
    expect(second.history()).toHaveLength(1);
    expect(localStorage.getItem('quizBestScores')).toBe('{"typescript":90}');
  });

  it('does NOT resurrect v1 over an existing v2 store', () => {
    const svc = freshService();
    svc.recordAttempt(sanitized({ sessionId: 'is_new' }));
    seedV1([v1Entry]);

    const reloaded = freshService();
    expect(reloaded.history().map((e) => e.sessionId)).toEqual(['is_new']);
  });
});

describe('validateHistoryStore / validateAttemptEntry', () => {
  it('9. invalid JSON fails safely (returns [])', () => {
    localStorage.clear();
    localStorage.setItem(SK_INTERVIEW_HISTORY, '{ not valid json');
    const svc = freshService();   // load() → readLocalJson swallows → validate(null) → []
    expect(svc.history()).toEqual([]);
    localStorage.clear();
  });

  it('10. unsupported storage version fails safely', () => {
    // v1 is not read directly any more — it goes through the migration.
    expect(validateHistoryStore({ version: 1, attempts: [entry(70)] })).toEqual([]);
    expect(validateHistoryStore({ version: 'x', attempts: [entry(70)] })).toEqual([]);
  });

  it('11. malformed entries are ignored, valid ones kept, without crashing', () => {
    const out = validateHistoryStore({
      version: 2,
      attempts: [entry(70), null, 42, { id: '', completedAt: 'x', score: 1, totalQuestions: 1, percentage: 1 }, entry(90)]
    });
    expect(out.map((e) => e.percentage)).toEqual([70, 90]);
  });

  it('11b. a non-array attempts field fails safely', () => {
    expect(validateHistoryStore({ version: 2, attempts: 'nope' })).toEqual([]);
    expect(validateHistoryStore(null)).toEqual([]);
    expect(validateHistoryStore('str')).toEqual([]);
  });

  it('12. numeric fields are validated and impossible percentages clamped', () => {
    expect(validateAttemptEntry(entry(70, { percentage: 175 }))?.percentage).toBe(100);
    expect(validateAttemptEntry(entry(70, { percentage: -20 }))?.percentage).toBe(0);
    expect(validateAttemptEntry(entry(70, { score: Number.NaN as unknown as number }))).toBeNull();
    expect(validateAttemptEntry(entry(70, { totalQuestions: 0 }))).toBeNull();
    expect(validateAttemptEntry(entry(70, { percentage: 'nope' as unknown as number }))).toBeNull();
  });

  it('honours the retention window when loading an over-long store', () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(i + 1, { id: `e${i}` }));
    expect(validateHistoryStore({ version: 2, attempts: many })).toHaveLength(INTERVIEW_HISTORY_MAX);
  });

  it('rejects internally-inconsistent records (score > totalQuestions)', () => {
    expect(validateAttemptEntry(entry(70, { score: 150, totalQuestions: 100 }))).toBeNull();
  });

  it('rejects an unparseable completedAt', () => {
    expect(validateAttemptEntry(entry(70, { completedAt: 'not a date' }))).toBeNull();
    expect(validateAttemptEntry(entry(70, { completedAt: '' }))).toBeNull();
  });

  it('treats a negative duration as not recorded (undefined)', () => {
    expect(validateAttemptEntry(entry(70, { durationSeconds: -5 }))?.durationSeconds).toBeUndefined();
    expect(validateAttemptEntry(entry(70, { durationSeconds: 120 }))?.durationSeconds).toBe(120);
  });

  it('drops topics with non-positive total or out-of-range correct', () => {
    const out = validateAttemptEntry(entry(70, {
      topicPerformance: [
        { topicId: 'ok', topicName: 'OK', correct: 2, total: 4, percentage: 50 },
        { topicId: 'zero', topicName: 'Z', correct: 0, total: 0, percentage: 0 },
        { topicId: 'over', topicName: 'O', correct: 5, total: 3, percentage: 100 }
      ]
    }));
    expect(out?.topicPerformance.map((t) => t.topicId)).toEqual(['ok']);
  });

  it('defensively orders entries chronologically by completedAt', () => {
    const out = validateHistoryStore({
      version: 2,
      attempts: [
        entry(70, { id: 'late', completedAt: '2026-07-20T10:00:00.000Z' }),
        entry(80, { id: 'early', completedAt: '2026-07-10T10:00:00.000Z' })
      ]
    });
    expect(out.map((e) => e.id)).toEqual(['early', 'late']);
  });

  it('de-duplicates entries by id on load (keeps the first)', () => {
    const out = validateHistoryStore({
      version: 2,
      attempts: [entry(70, { id: 'same' }), entry(90, { id: 'same' }), entry(60, { id: 'other' })]
    });
    expect(out.map((e) => e.id)).toEqual(['same', 'other']);
    expect(out[0].percentage).toBe(70);
  });

  it('preserves a valid persisted attemptNumber', () => {
    expect(validateAttemptEntry(entry(70, { attemptNumber: 7 }))?.attemptNumber).toBe(7);
    expect(validateAttemptEntry(entry(70, { attemptNumber: -1 }))?.attemptNumber).toBeUndefined();
  });
});

describe('InterviewHistoryService — attemptNumber migration', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('migrates legacy records (no attemptNumber) by chronological position and persists', () => {
    // Seed legacy entries WITHOUT attemptNumber.
    seed([entry(70, { id: 'a' }), entry(80, { id: 'b' }), entry(90, { id: 'c' })]);
    const svc = freshService();
    expect(svc.history().map((e) => e.attemptNumber)).toEqual([1, 2, 3]);
    // Persisted back so numbering is stable on the next load.
    const stored = JSON.parse(localStorage.getItem(SK_INTERVIEW_HISTORY)!);
    expect(stored.attempts.every((a: { attemptNumber?: number }) => typeof a.attemptNumber === 'number')).toBe(true);
  });

  it('continues numbering from the migrated max', () => {
    seed([entry(70, { id: 'a' }), entry(80, { id: 'b' })]);   // → 1, 2
    const svc = freshService();
    svc.record(makeResult(95));
    expect(svc.history().map((e) => e.attemptNumber)).toEqual([1, 2, 3]);
  });
});

describe('filterAttempts (client-side)', () => {
  const submitted1 = entry(70, { id: 's1', completionReason: 'submitted' });
  const expired = entry(50, { id: 'e1', completionReason: 'time-expired' });
  const submitted2 = entry(90, { id: 's2', completionReason: 'submitted' });
  const list = [submitted1, expired, submitted2];

  it('6. submitted only', () => {
    expect(filterAttempts(list, 'submitted').map((a) => a.id)).toEqual(['s1', 's2']);
  });

  it('7. time expired only', () => {
    expect(filterAttempts(list, 'time-expired').map((a) => a.id)).toEqual(['e1']);
  });

  it('8. all interviews (order preserved)', () => {
    expect(filterAttempts(list, 'all').map((a) => a.id)).toEqual(['s1', 'e1', 's2']);
  });

  it('returns a copy (does not mutate input)', () => {
    const out = filterAttempts(list, 'all');
    expect(out).not.toBe(list);
    expect(out).toEqual(list);
  });
});

describe('summarizeTrends — calculations', () => {
  it('13/14/15/16. latest, best, average and change are correct', () => {
    const t = summarizeTrends([entry(70), entry(90), entry(84)]);
    expect(t.latest).toBe(84);
    expect(t.best).toBe(90);
    expect(t.average).toBe(Math.round((70 + 90 + 84) / 3));  // 81
    expect(t.change).toBe(84 - 90);                           // -6 percentage points
  });

  it('17. different question counts compare correctly via percentages', () => {
    // 7/10 (70%) then 17/20 (85%) → +15 pts despite different counts.
    const t = summarizeTrends([
      entry(70, { score: 7, totalQuestions: 10 }),
      entry(85, { score: 17, totalQuestions: 20 })
    ]);
    expect(t.change).toBe(15);
    expect(t.direction).toBe('improving');
  });

  it('18. a first attempt makes no trend claim', () => {
    const t = summarizeTrends([entry(80)]);
    expect(t.count).toBe(1);
    expect(t.change).toBeNull();
    expect(t.direction).toBe('none');
    expect(t.interpretation).toBe('');
  });

  it('empty history summarizes to nulls', () => {
    const t = summarizeTrends([]);
    expect(t).toMatchObject({ count: 0, latest: null, best: null, average: null, change: null, direction: 'none' });
  });

  it('interpretation follows the ±5 point thresholds', () => {
    expect(summarizeTrends([entry(70), entry(76)]).direction).toBe('improving');   // +6
    expect(summarizeTrends([entry(70), entry(72)]).direction).toBe('steady');      // +2
    expect(summarizeTrends([entry(80), entry(72)]).direction).toBe('declining');   // -8
    expect(summarizeTrends([entry(70), entry(74)]).direction).toBe('steady');      // +4 (dead band)
    expect(summarizeTrends([entry(70), entry(75)]).direction).toBe('improving');   // +5 (threshold)
  });

  describe('isPersonalBest', () => {
    it('is true when the latest strictly beats every previous attempt', () => {
      expect(summarizeTrends([entry(70), entry(80), entry(92)]).isPersonalBest).toBe(true);
    });

    it('is false when the latest merely ties the previous best', () => {
      expect(summarizeTrends([entry(90), entry(70), entry(90)]).isPersonalBest).toBe(false);
    });

    it('is false when the latest is not the highest', () => {
      expect(summarizeTrends([entry(95), entry(80)]).isPersonalBest).toBe(false);
    });

    it('is false for a first attempt (nothing to beat)', () => {
      expect(summarizeTrends([entry(100)]).isPersonalBest).toBe(false);
    });

    it('is false for empty history', () => {
      expect(summarizeTrends([]).isPersonalBest).toBe(false);
    });
  });

  it('marks only the last point as latest and numbers points 1-based', () => {
    const t = summarizeTrends([entry(70), entry(80), entry(90)]);
    expect(t.points.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(t.points.map((p) => p.isLatest)).toEqual([false, false, true]);
  });
});
