import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  SK_INTERVIEW_CERTIFICATE,
  SK_INTERVIEW_CERTIFICATE_QUAL,
  SK_QUIZ_ACHIEVEMENTS,
  SK_INTERVIEW_HISTORY
} from '@shared/constants/session-keys';
import { AchievementService } from '@shared/services/achievements/achievement.service';
import { InterviewHistoryService } from './interview-history.service';
import {
  generateCertificateId,
  InterviewCertificateService,
  isWellFormedCertificateId,
  validateCertificateRecord
} from './interview-certificate.service';

// ── signal-backed stubs ──
const earnedSig = signal<Set<string>>(new Set());
const historySig = signal<{ completedAt: string }[]>([]);

const achievementsStub = { earnedIds: () => earnedSig() } as unknown as AchievementService;
const historyStub = { history: historySig } as unknown as InterviewHistoryService;

const CURRICULUM = ['beginner-complete', 'intermediate-complete', 'advanced-complete'];
const ALL_SIX = [...CURRICULUM, 'perfect-score', 'interview-master', 'angular-explorer'];

function setEarned(ids: string[]): void {
  earnedSig.set(new Set(ids));
}
function setHistory(completedAts: string[]): void {
  historySig.set(completedAts.map((completedAt, i) => ({ id: 'att-' + i, completedAt } as { completedAt: string })));
}
/** ISO offset from a base ISO by ms. */
function offset(baseIso: string, ms: number): string {
  return new Date(Date.parse(baseIso) + ms).toISOString();
}

function freshService(): InterviewCertificateService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: AchievementService, useValue: achievementsStub },
      { provide: InterviewHistoryService, useValue: historyStub }
    ]
  });
  return TestBed.inject(InterviewCertificateService);
}

describe('InterviewCertificateService — qualification period', () => {
  beforeEach(() => { localStorage.clear(); setEarned([]); setHistory([]); });
  afterEach(() => localStorage.clear());

  it('qualification begins only after the final topic-completion achievement', () => {
    setEarned(['beginner-complete', 'intermediate-complete']);   // advanced missing
    const svc = freshService();
    svc.ensureQualificationStarted();
    expect(svc.progress().qualificationStartedAt).toBeUndefined();

    setEarned(CURRICULUM);   // now the curriculum is complete
    svc.ensureQualificationStarted();
    expect(svc.progress().qualificationStartedAt).toBeTruthy();
  });

  it('writes the qualification timestamp only ONCE (never overwritten)', () => {
    setEarned(CURRICULUM);
    const svc = freshService();
    svc.ensureQualificationStarted();
    const first = svc.progress().qualificationStartedAt;
    svc.ensureQualificationStarted();   // again
    setEarned(ALL_SIX);
    svc.ensureQualificationStarted();    // and again with more achievements
    expect(svc.progress().qualificationStartedAt).toBe(first);
  });

  it('qualification timestamp survives a reload', () => {
    setEarned(CURRICULUM);
    freshService().ensureQualificationStarted();
    expect(localStorage.getItem(SK_INTERVIEW_CERTIFICATE_QUAL)).not.toBeNull();
    const reloaded = freshService();
    expect(reloaded.progress().qualificationStartedAt).toBeTruthy();
  });

  it('migration: an existing curriculum-complete user gets the date on the first evaluation', () => {
    // No qualification key persisted yet (pre-feature), but curriculum is done.
    setEarned(ALL_SIX);
    const svc = freshService();
    expect(svc.progress().qualificationStartedAt).toBeUndefined();   // nothing inferred
    svc.ensureQualificationStarted();                                 // first evaluation
    expect(svc.progress().qualificationStartedAt).toBeTruthy();
  });

  it('ignores interviews completed BEFORE qualification (18 historical → 0 / 5)', () => {
    setEarned(ALL_SIX);
    // 18 old interviews predate the (about-to-be-set) qualification date.
    setHistory(Array.from({ length: 18 }, (_, i) => `2020-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
    const svc = freshService();
    svc.ensureQualificationStarted();
    const p = svc.progress();
    expect(p.qualifyingInterviewsCompleted).toBe(0);
    expect(p.interviewsRemaining).toBe(5);
    expect(p.isEligible).toBe(false);
  });

  it('counts interviews completed ON/AFTER qualification', () => {
    setEarned(ALL_SIX);
    const svc = freshService();
    svc.ensureQualificationStarted();
    const qual = svc.progress().qualificationStartedAt!;
    setHistory([
      offset(qual, -60_000),   // before → ignored
      offset(qual, -1),        // before → ignored
      qual,                    // exactly at → counts (>=)
      offset(qual, 60_000),    // after → counts
      offset(qual, 120_000)    // after → counts
    ]);
    expect(svc.progress().qualifyingInterviewsCompleted).toBe(3);
  });

  it('compares INSTANTS, not strings — a non-ISO legacy date cannot sneak past', () => {
    setEarned(ALL_SIX);
    const svc = freshService();
    svc.ensureQualificationStarted();
    const qual = svc.progress().qualificationStartedAt!;   // "2026-…" ISO

    // validateEntry() accepts any Date.parse-able string. This one predates
    // qualification but wins a LEXICOGRAPHIC ">=" because 'J' > '2'.
    const legacyBefore = new Date(Date.parse(qual) - 86_400_000).toDateString();  // "Mon Jul 27 2026"
    expect(legacyBefore >= qual).toBe(true);              // proves the old bug's premise
    setHistory([legacyBefore]);
    expect(svc.progress().qualifyingInterviewsCompleted).toBe(0);   // correctly excluded
  });

  it('ignores history entries whose completedAt is unparseable', () => {
    setEarned(ALL_SIX);
    const svc = freshService();
    svc.ensureQualificationStarted();
    const qual = svc.progress().qualificationStartedAt!;
    setHistory(['not-a-date', offset(qual, 60_000)]);
    expect(svc.progress().qualifyingInterviewsCompleted).toBe(1);
  });

  it('unlocks after five QUALIFYING interviews (Explorer earned)', () => {
    setEarned(ALL_SIX);
    const svc = freshService();
    svc.ensureQualificationStarted();
    const qual = svc.progress().qualificationStartedAt!;
    setHistory([
      offset(qual, -1),                      // pre-qualification → ignored
      ...Array.from({ length: 5 }, (_, i) => offset(qual, (i + 1) * 60_000))
    ]);
    expect(svc.progress().qualifyingInterviewsCompleted).toBe(5);
    expect(svc.progress().isEligible).toBe(true);
    expect(svc.unlock()).not.toBeNull();
  });

  it('regression: NEVER writes Interview History or achievement storage', () => {
    setEarned(ALL_SIX);
    const svc = freshService();
    svc.ensureQualificationStarted();
    setHistory([offset(svc.progress().qualificationStartedAt!, 1000)]);
    svc.unlock();
    // Only the certificate's own keys are touched.
    expect(localStorage.getItem(SK_INTERVIEW_HISTORY)).toBeNull();
    expect(localStorage.getItem(SK_QUIZ_ACHIEVEMENTS)).toBeNull();
    expect(localStorage.getItem('quizBestScores')).toBeNull();
  });
});

describe('InterviewCertificateService — progress model', () => {
  beforeEach(() => { localStorage.clear(); setEarned([]); setHistory([]); });
  afterEach(() => localStorage.clear());

  it('required interview count is five', () => {
    expect(freshService().progress().requiredInterviews).toBe(5);
  });

  it('Angular Explorer status reflects the achievement service', () => {
    setEarned(ALL_SIX);
    expect(freshService().progress().angularExplorerEarned).toBe(true);
    setEarned(CURRICULUM);
    expect(freshService().progress().angularExplorerEarned).toBe(false);
  });

  it('Interview Master status reflects the achievement service', () => {
    setEarned([...CURRICULUM, 'interview-master']);   // Interview Master but not Explorer
    const p = freshService().progress();
    expect(p.interviewMasterEarned).toBe(true);
    expect(p.angularExplorerEarned).toBe(false);
    setEarned(CURRICULUM);
    expect(freshService().progress().interviewMasterEarned).toBe(false);
  });

  it('interviews remaining never becomes negative', () => {
    setEarned(ALL_SIX);
    const svc = freshService();
    svc.ensureQualificationStarted();
    const qual = svc.progress().qualificationStartedAt!;
    setHistory(Array.from({ length: 8 }, (_, i) => offset(qual, (i + 1) * 1000)));
    expect(svc.progress().interviewsRemaining).toBe(0);
  });

  it('isEligible needs BOTH Explorer and five qualifying interviews', () => {
    setEarned(CURRICULUM);   // explorer NOT earned
    const svc = freshService();
    svc.ensureQualificationStarted();
    const qual = svc.progress().qualificationStartedAt!;
    setHistory(Array.from({ length: 6 }, (_, i) => offset(qual, (i + 1) * 1000)));
    expect(svc.progress().isEligible).toBe(false);   // 6 interviews but no Explorer
  });

  it('isUnlocked reflects persisted certificate state', () => {
    setEarned(ALL_SIX);
    const svc = freshService();
    svc.ensureQualificationStarted();
    setHistory(Array.from({ length: 5 }, (_, i) => offset(svc.progress().qualificationStartedAt!, (i + 1) * 1000)));
    expect(svc.progress().isUnlocked).toBe(false);
    svc.unlock();
    expect(svc.progress().isUnlocked).toBe(true);
    expect(freshService().progress().isUnlocked).toBe(true);
  });
});

describe('InterviewCertificateService — unlock persistence', () => {
  beforeEach(() => { localStorage.clear(); setEarned([]); setHistory([]); });
  afterEach(() => localStorage.clear());

  function makeEligible(): InterviewCertificateService {
    setEarned(ALL_SIX);
    const svc = freshService();
    svc.ensureQualificationStarted();
    setHistory(Array.from({ length: 5 }, (_, i) => offset(svc.progress().qualificationStartedAt!, (i + 1) * 1000)));
    return svc;
  }

  it('id + issue date are generated once and survive reload', () => {
    const svc = makeEligible();
    const first = svc.unlock()!;
    const again = svc.unlock()!;
    expect(again.certificateId).toBe(first.certificateId);
    expect(again.unlockedAt).toBe(first.unlockedAt);
    const reloaded = freshService();
    expect(reloaded.record()!.certificateId).toBe(first.certificateId);
    expect(reloaded.record()!.unlockedAt).toBe(first.unlockedAt);
  });

  it('stays unlocked if history later shrinks below five', () => {
    const svc = makeEligible();
    svc.unlock();
    setHistory([]);   // history cleared later
    expect(svc.unlocked()).toBe(true);
  });

  it('reports a FAILED persist instead of silently losing the certificate', () => {
    setEarned(ALL_SIX);
    const svc = freshService();
    svc.ensureQualificationStarted();
    const qual = svc.progress().qualificationStartedAt!;
    setHistory(Array.from({ length: 5 }, (_, i) => offset(qual, (i + 1) * 1000)));

    expect(svc.persistenceFailed()).toBe(false);

    // Simulate private browsing / quota exceeded.
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    try {
      const issued = svc.unlock();
      expect(issued).not.toBeNull();          // the user is not blocked …
      expect(svc.persistenceFailed()).toBe(true);   // … but we know it didn't stick
    } finally {
      setItem.mockRestore();
    }
  });

  it('does not unlock while ineligible + never persists', () => {
    setEarned(CURRICULUM);
    const svc = freshService();
    svc.ensureQualificationStarted();
    expect(svc.unlock()).toBeNull();
    expect(localStorage.getItem(SK_INTERVIEW_CERTIFICATE)).toBeNull();
  });
});

describe('generateCertificateId / validateCertificateRecord', () => {
  it('formats AQ-YYYY-NNNNNN-C, zero-padded, with a check character', () => {
    const id = generateCertificateId('2026-07-24T12:00:00.000Z', () => 0.000128);
    expect(id).toMatch(/^AQ-2026-000128-[0-9A-Z]$/);
    expect(isWellFormedCertificateId(id)).toBe(true);
  });

  it('the checksum rejects a mistyped or transposed id', () => {
    const id = generateCertificateId('2026-07-24T12:00:00.000Z', () => 0.000128);
    const body = id.slice(0, -2);                       // "AQ-2026-000128"
    const check = id.slice(-1);
    // A transposition inside the body no longer matches the check character.
    expect(isWellFormedCertificateId(`AQ-2026-000182-${check}`)).toBe(false);
    // A wrong check character is rejected too.
    const wrong = check === 'Z' ? 'Y' : 'Z';
    expect(isWellFormedCertificateId(`${body}-${wrong}`)).toBe(false);
  });

  it('legacy ids (issued before the checksum) still validate as certificates', () => {
    // isWellFormedCertificateId is a FORMAT check, so a legacy id fails it …
    expect(isWellFormedCertificateId('AQ-2026-000001')).toBe(false);
    // … but the record must still be honoured — never invalidate an issued cert.
    expect(validateCertificateRecord({
      version: 1, unlocked: true, unlockedAt: '2026-07-24T00:00:00.000Z', certificateId: 'AQ-2026-000001'
    })).toMatchObject({ unlocked: true, certificateId: 'AQ-2026-000001' });
  });
  it('validates records', () => {
    expect(validateCertificateRecord({
      version: 1, unlocked: true, unlockedAt: '2026-07-24T00:00:00.000Z', certificateId: 'AQ-2026-000001'
    })).toMatchObject({ unlocked: true, certificateId: 'AQ-2026-000001' });
    expect(validateCertificateRecord(null)).toBeNull();
    expect(validateCertificateRecord({ unlocked: false, certificateId: 'x', unlockedAt: '2026-07-24' })).toBeNull();
  });
});

/**
 * The certificate reads Interview History, which is now SANITIZED (v2): no
 * review, no questions, no answer key — only summary analytics. It consumes
 * exactly one field, `completedAt`, so the migration must not change any
 * qualification outcome.
 */
describe('certificate qualification over SANITIZED v2 history', () => {
  beforeEach(() => { localStorage.clear(); setEarned([]); setHistory([]); });

  /** A v2 record as InterviewResultHistoryAdapter + the store now produce it. */
  function sanitizedAttempt(index: number, completedAt: string) {
    return {
      id: `att_${index}`,
      sessionId: `is_${index}`,
      attemptNumber: index + 1,
      completedAt,
      score: 8,
      totalQuestions: 10,
      percentage: 80,
      completionReason: 'submitted' as const,
      answered: 10,
      unanswered: 0,
      incorrect: 2,
      durationSeconds: 540,
      timeUsedSeconds: 540,
      submittedByExpiry: false,
      focusChanges: 0,
      configKind: 'custom' as const,
      configuredDifficulty: 'beginner',
      selectedTopicIds: ['rxjs'],
      topicPerformance: [
        { topicId: 'rxjs', topicName: 'RxJS', correct: 8, total: 10, percentage: 80 }
      ]
    };
  }

  function setSanitizedHistory(completedAts: string[]): void {
    historySig.set(
      completedAts.map((iso, i) => sanitizedAttempt(i, iso)) as unknown as { completedAt: string }[]
    );
  }

  it('a qualifying sequence still awards the certificate', () => {
    setEarned(ALL_SIX);
    const service = freshService();

    // Qualification starts when the curriculum is finished.
    service.ensureQualificationStarted();
    const start = service.progress().qualificationStartedAt!;

    // Five sanitized attempts completed AFTER that moment.
    setSanitizedHistory([1, 2, 3, 4, 5].map((n) => offset(start, n * 60_000)));

    const progress = service.progress();
    expect(progress.qualifyingInterviewsCompleted).toBe(5);
    expect(progress.isEligible).toBe(true);

    expect(service.unlock()).not.toBeNull();
    expect(service.record()?.unlocked).toBe(true);
  });

  it('sanitized records earlier than the qualification start still do not count', () => {
    setEarned(ALL_SIX);
    const service = freshService();
    service.ensureQualificationStarted();
    const start = service.progress().qualificationStartedAt!;

    setSanitizedHistory([
      offset(start, -60_000),            // before → ignored
      offset(start, -30_000),            // before → ignored
      offset(start, 60_000)              // after  → counts
    ]);

    expect(service.progress().qualifyingInterviewsCompleted).toBe(1);
    expect(service.progress().isEligible).toBe(false);
  });

  it('reads ONLY completedAt — the absent v1 review changes nothing', () => {
    setEarned(ALL_SIX);
    const service = freshService();
    service.ensureQualificationStarted();
    const start = service.progress().qualificationStartedAt!;

    const withoutReview = [1, 2, 3, 4, 5].map((n) => offset(start, n * 60_000));
    setSanitizedHistory(withoutReview);
    const sanitizedProgress = service.progress();

    // The same dates carried on bare records produce the same outcome, proving
    // no other history field participates.
    setHistory(withoutReview);
    expect(service.progress().qualifyingInterviewsCompleted)
      .toBe(sanitizedProgress.qualifyingInterviewsCompleted);
    expect(service.progress().isEligible).toBe(sanitizedProgress.isEligible);
  });
});
