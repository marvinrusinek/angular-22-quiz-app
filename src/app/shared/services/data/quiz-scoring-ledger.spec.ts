import { TestBed } from '@angular/core/testing';

import { QuizScoringService } from './quiz-scoring.service';
import { QuizService } from './quiz.service';
import { QuizShuffleService } from '@shared/services/flow/quiz-shuffle.service';

/**
 * The correctness ledger (`questionCorrectness`) is the single source of truth
 * for the live correct-answer count.
 *
 * Regression: the count used to be a free-running `± 1`, and restore adopted
 * `max(storedCounter, ledger)`. A stored counter that was ahead of the ledger
 * (a previous run's value left behind when Results removes the ledger, or
 * another tab's write) was therefore carried forward and added to — seven
 * stored plus seven real credits displayed "14 out of 7 (200%)" while the
 * ledger held exactly seven keys.
 */
const QUIZ = 'dependency-injection';
const TEXTS = Array.from({ length: 7 }, (_, i) => `Q${i + 1}`);

function service(): QuizScoringService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: QuizShuffleService, useValue: { toOriginalIndex: () => -1 } },
      {
        provide: QuizService,
        useValue: {
          getQuestionsInDisplayOrder: () => TEXTS.map((t) => ({ questionText: t })),
          isShuffleEnabled: () => false
        }
      }
    ]
  });
  return TestBed.inject(QuizScoringService);
}

const ledgerTrue = (s: QuizScoringService): number =>
  [...s.questionCorrectness.values()].filter((v) => v === true).length;

const credit = (s: QuizScoringService, ...idx: number[]): void =>
  idx.forEach((i) => s.creditResolvedQuestion(QUIZ, TEXTS[i]));

const storedCount = (): number => Number(localStorage.getItem('correctAnswersCount'));

/** A page refresh: a brand-new service instance over the SAME localStorage. */
const refresh = (): QuizScoringService => {
  const s = service();
  s.restoreScoreFromPersistence(QUIZ);
  return s;
};

describe('QuizScoringService — the ledger is the single source of the count', () => {
  beforeEach(() => localStorage.clear());

  it('clean Dependency Injection run: 7 correct answers -> 7/7', () => {
    const s = service();
    s.restoreScoreFromPersistence(QUIZ);
    credit(s, 0, 1, 2, 3, 4, 5, 6);
    expect(s.correctAnswersCountSig()).toBe(7);
    expect(ledgerTrue(s)).toBe(7);
    expect(storedCount()).toBe(7);
  });

  describe('a stale stored counter', () => {
    beforeEach(() => {
      // What a finished run leaves behind: Results removes the stored ledger
      // when it is left, but the counter and its quiz id stay.
      localStorage.setItem('correctAnswersCount', '7');
      localStorage.setItem('scoreQuizId', QUIZ);
      localStorage.removeItem('questionCorrectness');
    });

    it('is NOT adopted when the ledger is empty', () => {
      const s = refresh();
      expect(s.correctAnswersCountSig()).toBe(0);
      expect(s.correctCountSig()).toBe(0);
      expect(storedCount()).toBe(0);
    });

    it('seven correct answers afterwards give 7/7, not 14/7', () => {
      const s = refresh(); // runs on every question-route load
      credit(s, 0, 1, 2, 3, 4, 5, 6);
      expect(ledgerTrue(s)).toBe(7);
      expect(s.correctAnswersCountSig()).toBe(7);
      expect(s.correctCountSig()).toBe(7);
      expect(storedCount()).toBe(7);
    });

    it('through incrementScore (click-time path) as well: 7/7', () => {
      const s = refresh();
      TEXTS.forEach((_, i) => s.incrementScore([], true, false, i, false, QUIZ));
      expect(ledgerTrue(s)).toBe(7);
      expect(s.correctAnswersCountSig()).toBe(7);
    });
  });

  describe('a foreign counter value introduced during an attempt', () => {
    it('is ignored at the next restore: 7/7 at the end, never 13/7', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      credit(s, 0);
      localStorage.setItem('correctAnswersCount', '7'); // another tab
      s.restoreScoreFromPersistence(QUIZ); // next question load
      expect(s.correctAnswersCountSig()).toBe(1);
      credit(s, 1, 2, 3, 4, 5, 6);
      expect(ledgerTrue(s)).toBe(7);
      expect(s.correctAnswersCountSig()).toBe(7);
    });

    it('and is overwritten, not kept, in storage', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      credit(s, 0, 1);
      localStorage.setItem('correctAnswersCount', '99');
      s.restoreScoreFromPersistence(QUIZ);
      expect(storedCount()).toBe(2);
    });
  });

  describe('duplicate credit for the same question', () => {
    it('never counts twice, however many times it arrives', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      for (let n = 0; n < 3; n++) credit(s, 0, 1, 2, 3, 4, 5, 6);
      expect(s.correctAnswersCountSig()).toBe(7);
    });

    it('click-time and verdict-arrival credit for one question count once', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      s.incrementScore([], true, false, 2, false, QUIZ);
      credit(s, 2);
      s.incrementScore([], true, false, 2, false, QUIZ);
      expect(s.correctAnswersCountSig()).toBe(1);
      expect(ledgerTrue(s)).toBe(1);
    });
  });

  describe('mid-quiz refresh and restoration', () => {
    it('restores exactly the credited questions from the ledger', () => {
      const before = service();
      before.restoreScoreFromPersistence(QUIZ);
      credit(before, 0, 1, 2, 3); // four answered correctly, then F5
      const after = refresh();
      expect(after.correctAnswersCountSig()).toBe(4);
      expect(after.correctCountSig()).toBe(4);
      expect(ledgerTrue(after)).toBe(4);
    });

    it('then continues to 7/7 without double counting the restored ones', () => {
      const before = service();
      before.restoreScoreFromPersistence(QUIZ);
      credit(before, 0, 1, 2, 3);
      const after = refresh();
      credit(after, 3, 4, 5, 6); // Q4 is replayed after the refresh
      expect(after.correctAnswersCountSig()).toBe(7);
    });

    it('a refresh with a stale larger counter still restores the ledger value', () => {
      const before = service();
      before.restoreScoreFromPersistence(QUIZ);
      credit(before, 0, 1, 2, 3);
      localStorage.setItem('correctAnswersCount', '12');
      expect(refresh().correctAnswersCountSig()).toBe(4);
    });

    it('repeated route loads (restore) do not change the count', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      credit(s, 0, 1, 2);
      for (let n = 0; n < 5; n++) s.restoreScoreFromPersistence(QUIZ);
      expect(s.correctAnswersCountSig()).toBe(3);
    });

    it('switching to another quiz wipes the score and the ledger', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      credit(s, 0, 1, 2);
      s.restoreScoreFromPersistence('router');
      expect(s.correctAnswersCountSig()).toBe(0);
      expect(ledgerTrue(s)).toBe(0);
    });
  });

  describe('incorrect and timed-out questions', () => {
    it('an incorrect answer adds nothing; the rest still total correctly', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      s.incrementScore([], false, false, 0, false, QUIZ); // Q1 wrong
      credit(s, 1, 2, 3, 4, 5, 6);
      expect(s.correctAnswersCountSig()).toBe(6);
      expect(s.questionCorrectness.get(0)).toBe(false);
    });

    it('a timed-out (never credited) question adds nothing', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      credit(s, 0, 1, 2, 3, 4); // Q6 times out, Q7 is left unanswered
      expect(s.correctAnswersCountSig()).toBe(5);
      expect(ledgerTrue(s)).toBe(5);
    });

    it('survives a refresh with incorrect and timed-out questions', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      s.incrementScore([], false, false, 0, false, QUIZ); // wrong
      credit(s, 1, 2, 3); // Q5-Q7 timed out
      const after = refresh();
      expect(after.correctAnswersCountSig()).toBe(3);
      expect(after.questionCorrectness.get(0)).toBe(false);
    });

    it('a correct answer later judged incorrect is taken back from the ledger count', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      s.incrementScore([], true, false, 0, false, QUIZ);
      credit(s, 1);
      expect(s.correctAnswersCountSig()).toBe(2);
      s.incrementScore([], false, false, 0, false, QUIZ);
      expect(s.correctAnswersCountSig()).toBe(1);
      expect(ledgerTrue(s)).toBe(1);
    });

    it('the count can never exceed the number of credited questions', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      for (let n = 0; n < 4; n++) {
        credit(s, 0, 1, 2, 3, 4, 5, 6);
        s.incrementScore([], true, false, n, false, QUIZ);
      }
      expect(s.correctAnswersCountSig()).toBeLessThanOrEqual(TEXTS.length);
    });
  });

  describe('Results keeps its own snapshot display', () => {
    it('sendCorrectCountToResults still sets the shown count from the snapshot', () => {
      const s = service();
      s.sendCorrectCountToResults(5, QUIZ); // Results applying a persisted snapshot
      expect(s.correctAnswersCountSig()).toBe(5);
      expect(s.correctCountSig()).toBe(5);
    });

    it('a zero from navigation still cannot erase credited questions', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      credit(s, 0, 1, 2);
      s.sendCorrectCountToResults(0, QUIZ);
      expect(s.correctAnswersCountSig()).toBe(3);
    });

    it('a restart (resetScore) clears both the ledger and the count', () => {
      const s = service();
      s.restoreScoreFromPersistence(QUIZ);
      credit(s, 0, 1, 2);
      s.resetScore(QUIZ);
      expect(s.correctAnswersCountSig()).toBe(0);
      expect(ledgerTrue(s)).toBe(0);
      expect(storedCount()).toBe(0);
    });
  });
});
