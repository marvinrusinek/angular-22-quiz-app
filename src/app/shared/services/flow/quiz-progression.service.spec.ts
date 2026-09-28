import { TestBed } from '@angular/core/testing';

import { QuizProgressionService } from './quiz-progression.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { SK_FURTHEST_UNLOCKED } from '@shared/constants/session-keys';

/**
 * Direct-route progression bypass fix — the single source of truth for how
 * far the current attempt has legitimately reached. See the service's own
 * doc comment for the full design rationale (attempt scoping, LAZY ATTEMPT
 * CREATION, and the one-step cap); this spec exercises every fail-closed
 * path plus the ordinary unlock/read/clear lifecycle.
 *
 * The mock below is STATEFUL — `startNewAttempt()` actually changes what
 * `getCurrentAttemptId()` subsequently returns, exactly like the real
 * `quiz-scoring.service.ts`. A mock that returns a fixed value forever would
 * make every lazily-minted write look like it "disappeared" on the next
 * read (the written record's attemptId would never match what
 * `getCurrentAttemptId()` reports), which is not the real bug and not what
 * these tests are for.
 */
describe('QuizProgressionService', () => {
  let service: QuizProgressionService;
  let quizService: { getCurrentAttemptId: jest.Mock; startNewAttempt: jest.Mock };
  let currentAttemptId: string;
  let mintCount: number;

  const ATTEMPT_A = 'att_1000_abc';
  const ATTEMPT_B = 'att_2000_xyz';

  beforeEach(() => {
    sessionStorage.clear();
    currentAttemptId = ATTEMPT_A;
    mintCount = 0;

    quizService = {
      getCurrentAttemptId: jest.fn(() => currentAttemptId),
      startNewAttempt: jest.fn(() => {
        mintCount += 1;
        currentAttemptId = `att_lazy_${mintCount}`;
        return currentAttemptId;
      }),
    };

    TestBed.configureTestingModule({
      providers: [QuizProgressionService, { provide: QuizService, useValue: quizService }],
    });
    service = TestBed.inject(QuizProgressionService);
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  describe('new attempt', () => {
    it('a brand-new attempt with nothing stored reports furthest unlocked = 1', () => {
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });

    it('a brand-new attempt allows unlockThrough(1, ...) as a no-op-equivalent (stays at 1)', () => {
      service.unlockThrough('angular', 1, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });
  });

  describe('legitimate progression', () => {
    it('unlockThrough advances the furthest index by one step', () => {
      service.unlockThrough('angular', 2, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(2);
    });

    it('unlockThrough is monotonic — a lower/equal request never lowers an already-higher marker', () => {
      // Three legitimate one-step calls, matching real sequential Next clicks.
      service.unlockThrough('angular', 2, 6);
      service.unlockThrough('angular', 3, 6);
      service.unlockThrough('angular', 4, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(4);

      // A later call asking for less than the current furthest is a no-op.
      service.unlockThrough('angular', 2, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(4);
    });

    it('unlockThrough clamps to totalQuestions at the boundary — cannot unlock past the last question', () => {
      // Walk to the last question one step at a time...
      for (let i = 2; i <= 6; i++) service.unlockThrough('angular', i, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(6);

      // ...and a further call, even asking for something absurd, cannot
      // exceed the real count.
      service.unlockThrough('angular', 99, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(6);
    });

    it('sequential unlockThrough calls (simulating Next through every question) reach the last index in order', () => {
      for (let i = 2; i <= 6; i++) {
        service.unlockThrough('angular', i, 6);
        expect(service.getFurthestUnlocked('angular', 6)).toBe(i);
      }
    });

    it('unlockThrough is a no-op when quizId is empty', () => {
      service.unlockThrough('', 3, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });

    it('unlockThrough is a no-op when throughIndex is not a positive integer', () => {
      service.unlockThrough('angular', 0, 6);
      service.unlockThrough('angular', -1, 6);
      service.unlockThrough('angular', 1.5, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });
  });

  /**
   * ── Root Cause A fix: lazy attempt creation ──────────────────────────
   * Maps directly to the P1's Gate 2 items 1–5, 11–12, plus the
   * idempotence/concurrency proofs.
   */
  describe('lazy attempt creation (direct/bookmarked entry with no attempt yet)', () => {
    beforeEach(() => {
      // A direct/bookmarked entry to question 1: no attempt has ever been
      // minted for this session (Introduction's Start button was skipped).
      currentAttemptId = '';
    });

    it('1. direct entry to valid question 1 initially has no attempt, and reading alone never creates one', () => {
      expect(quizService.getCurrentAttemptId()).toBe('');
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
      // A pure READ must never mint — only an approved unlock call may.
      expect(quizService.startNewAttempt).not.toHaveBeenCalled();
    });

    it('2. correct completion plus an approved Next creates exactly one attempt', () => {
      service.unlockThrough('angular', 2, 6);
      expect(quizService.startNewAttempt).toHaveBeenCalledTimes(1);
      expect(quizService.getCurrentAttemptId()).not.toBe('');
    });

    it('3. question 2 becomes available after that first approved unlock', () => {
      service.unlockThrough('angular', 2, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(2);
    });

    it('4. question 3 remains locked after only one approved unlock from question 1', () => {
      service.unlockThrough('angular', 2, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(2);
      expect(service.getFurthestUnlocked('angular', 6)).not.toBe(3);
    });

    it('5. a direct call attempting to unlock question 3 straight from question 1 fails closed to 2 — the one-step cap applies even to a lazily-minted attempt', () => {
      service.unlockThrough('angular', 3, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(2);
      expect(quizService.startNewAttempt).toHaveBeenCalledTimes(1); // still exactly one mint
    });

    it('11. an EXISTING Start-via-Introduction attempt is reused, never replaced', () => {
      currentAttemptId = ATTEMPT_A; // Introduction's Start button already ran
      service.unlockThrough('angular', 2, 6);
      expect(quizService.startNewAttempt).not.toHaveBeenCalled();
      expect(quizService.getCurrentAttemptId()).toBe(ATTEMPT_A);
    });

    it('12. rapid duplicate progression calls create exactly one attempt, not two', () => {
      service.unlockThrough('angular', 2, 6);
      service.unlockThrough('angular', 2, 6); // immediate duplicate — same target
      expect(quizService.startNewAttempt).toHaveBeenCalledTimes(1);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(2);
    });

    it('idempotence: repeated calls for the same next index change nothing further', () => {
      service.unlockThrough('angular', 2, 6);
      const afterFirst = service.getFurthestUnlocked('angular', 6);
      service.unlockThrough('angular', 2, 6);
      service.unlockThrough('angular', 2, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(afterFirst);
    });

    it('a failed persistence write does not leave an apparently unlocked in-memory state', () => {
      const setItemSpy = jest
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('quota exceeded');
        });
      try {
        expect(() => service.unlockThrough('angular', 2, 6)).not.toThrow();
        // The write failed — there is no separate in-memory cache to drift,
        // so the very next read must still reflect the unwritten (fresh) state.
        expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
      } finally {
        setItemSpy.mockRestore();
      }
    });

    it('malformed inputs fail closed even with no attempt yet — no mint is attempted', () => {
      service.unlockThrough('', 2, 6);
      service.unlockThrough('angular', 0, 6);
      service.unlockThrough('angular', -1, 6);
      expect(quizService.startNewAttempt).not.toHaveBeenCalled();
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });
  });

  describe('17-18. bounds — requested indexes cannot skip beyond furthest+1, and always respect the real question count', () => {
    it('17. an existing attempt already at question 3 cannot be asked to skip to question 10 in one call', () => {
      service.unlockThrough('angular', 2, 10);
      service.unlockThrough('angular', 3, 10);
      expect(service.getFurthestUnlocked('angular', 10)).toBe(3);

      service.unlockThrough('angular', 10, 10);
      expect(service.getFurthestUnlocked('angular', 10)).toBe(4); // capped to 3+1, not 10
    });

    it('18. bounds respect the real question count even at the very last step', () => {
      for (let i = 2; i <= 5; i++) service.unlockThrough('angular', i, 5);
      expect(service.getFurthestUnlocked('angular', 5)).toBe(5);

      service.unlockThrough('angular', 5, 5); // already there
      expect(service.getFurthestUnlocked('angular', 5)).toBe(5);
    });
  });

  describe('revisit and refresh', () => {
    it('13. the marker (and the attempt it was lazily minted under) survives across a fresh service instance for the same attempt (simulating a refresh of question 2)', () => {
      currentAttemptId = ''; // direct entry, no attempt yet
      service.unlockThrough('angular', 2, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(2);
      const mintedId = quizService.getCurrentAttemptId();
      expect(mintedId).not.toBe('');

      // A refresh re-runs bootstrap DI — simulate with a brand-new instance
      // reading the same (unchanged) sessionStorage and the same attemptId
      // (sessionStorage — and therefore the minted attemptId — survives an
      // in-tab reload).
      const fresh = TestBed.inject(QuizProgressionService);
      expect(fresh.getFurthestUnlocked('angular', 6)).toBe(2);
    });

    it('getFurthestUnlocked never exceeds totalQuestions even if a stored index is larger than a subsequently-shrunk count', () => {
      for (let i = 2; i <= 6; i++) service.unlockThrough('angular', i, 6);
      expect(service.getFurthestUnlocked('angular', 4)).toBe(4);
    });
  });

  describe('14. Restart creates a fresh attempt and relocks future questions', () => {
    it('after clear() (Restart), the old marker is gone and a subsequent legitimate unlock starts over from 1', () => {
      service.unlockThrough('angular', 2, 6);
      service.unlockThrough('angular', 3, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(3);

      // Restart: a fresh attemptId is minted (real Restart calls
      // startNewAttempt() itself) and the marker is explicitly cleared.
      currentAttemptId = 'att_restarted_1';
      service.clear();

      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);

      // The old furthest (3) does not carry over — only one legitimate
      // one-step unlock is available again.
      service.unlockThrough('angular', 3, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(2);
    });
  });

  describe('attempt isolation', () => {
    it('a different attemptId invalidates the stored record — fails closed to 1, not the old attempt’s progress', () => {
      service.unlockThrough('angular', 2, 6);
      currentAttemptId = ATTEMPT_B;
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });

    it('15. a different quizId under the SAME attemptId does not inherit unlocked progress — quiz A does not unlock quiz B', () => {
      service.unlockThrough('angular', 2, 6);
      service.unlockThrough('angular', 3, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(3);

      // A brand-new quiz (still the same attemptId, matching how a single
      // in-progress-quiz session behaves) starts fully locked.
      expect(service.getFurthestUnlocked('react', 6)).toBe(1);

      // And progressing quiz B does not retroactively touch quiz A's own
      // stored record (there is only one record; quiz A's marker is simply
      // superseded, never merged or combined).
      service.unlockThrough('react', 2, 6);
      expect(service.getFurthestUnlocked('react', 6)).toBe(2);
    });

    it('clear() removes the marker so the next read fails closed to 1', () => {
      service.unlockThrough('angular', 2, 6);
      service.clear();
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });

    it('clear() is safe to call when nothing is stored', () => {
      expect(() => service.clear()).not.toThrow();
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });

    it('unlockThrough after clear() re-establishes a fresh record under the current attempt', () => {
      service.unlockThrough('angular', 2, 6);
      service.clear();
      service.unlockThrough('angular', 2, 6);
      expect(service.getFurthestUnlocked('angular', 6)).toBe(2);
    });
  });

  describe('16. fail-closed on corrupt/stale state', () => {
    it('corrupt JSON in storage fails closed to 1', () => {
      sessionStorage.setItem(SK_FURTHEST_UNLOCKED, '{not json');
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });

    it('a non-object value in storage fails closed to 1', () => {
      sessionStorage.setItem(SK_FURTHEST_UNLOCKED, '"just a string"');
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });

    it('a stale schema version fails closed to 1', () => {
      sessionStorage.setItem(
        SK_FURTHEST_UNLOCKED,
        JSON.stringify({ v: 999, quizId: 'angular', attemptId: ATTEMPT_A, index: 5 })
      );
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });

    it('a non-integer or out-of-range index fails closed to 1', () => {
      sessionStorage.setItem(
        SK_FURTHEST_UNLOCKED,
        JSON.stringify({ v: 1, quizId: 'angular', attemptId: ATTEMPT_A, index: 0 })
      );
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);

      sessionStorage.setItem(
        SK_FURTHEST_UNLOCKED,
        JSON.stringify({ v: 1, quizId: 'angular', attemptId: ATTEMPT_A, index: 2.5 })
      );
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);

      sessionStorage.setItem(
        SK_FURTHEST_UNLOCKED,
        JSON.stringify({ v: 1, quizId: 'angular', attemptId: ATTEMPT_A, index: -3 })
      );
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });

    it('a missing/empty attemptId in the stored record fails closed to 1', () => {
      sessionStorage.setItem(
        SK_FURTHEST_UNLOCKED,
        JSON.stringify({ v: 1, quizId: 'angular', attemptId: '', index: 5 })
      );
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
    });

    it('a corrupt stored record under no current attempt still fails closed to 1 and does not itself mint an attempt (a pure read never mints)', () => {
      currentAttemptId = '';
      sessionStorage.setItem(SK_FURTHEST_UNLOCKED, '{not json');
      expect(service.getFurthestUnlocked('angular', 6)).toBe(1);
      expect(quizService.startNewAttempt).not.toHaveBeenCalled();
    });
  });
});
