import { TestBed } from '@angular/core/testing';

import { ProgressService } from './progress.service';
import { BestScoreService } from './best-score.service';
import { Quiz } from '@shared/models';
import { SK_QUIZ_BEST_SCORES } from '@shared/constants/session-keys';

function quiz(quizId: string, milestone: string, difficulty?: string): Quiz {
  return { quizId, milestone, difficulty } as unknown as Quiz;
}

const BEGINNER = [quiz('b1', 'Beginner One', 'beginner'), quiz('b2', 'Beginner Two', 'beginner')];
const INTERMEDIATE = [quiz('i1', 'Intermediate One', 'intermediate'), quiz('i2', 'Intermediate Two', 'intermediate')];
const ADVANCED = [quiz('a1', 'Advanced One', 'advanced')];
const ALL: Quiz[] = [...BEGINNER, ...INTERMEDIATE, ...ADVANCED];  // 5 quizzes

function setBestScores(scores: Record<string, unknown>): void {
  localStorage.setItem(SK_QUIZ_BEST_SCORES, JSON.stringify(scores));
}

describe('ProgressService', () => {
  let service: ProgressService;
  let bestScores: BestScoreService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(ProgressService);
    bestScores = TestBed.inject(BestScoreService);
  });

  // 1
  it('reports zero completed with no strongest/weakest when nothing is completed', () => {
    const s = service.getProgressSummary(ALL);
    expect(s.completedCount).toBe(0);
    expect(s.totalCount).toBe(5);
    expect(s.completionPercentage).toBe(0);
    expect(s.strongestQuiz).toBeNull();
    expect(s.weakestQuiz).toBeNull();
  });

  // 2
  it('with one completed quiz shows strongest but hides weakest (needs review)', () => {
    setBestScores({ b1: 80 });
    const s = service.getProgressSummary(ALL);
    expect(s.completedCount).toBe(1);
    expect(s.strongestQuiz?.quizId).toBe('b1');
    expect(s.weakestQuiz).toBeNull();
  });

  // 3
  it('counts multiple completed quizzes', () => {
    setBestScores({ b1: 80, i1: 60, a1: 100 });
    expect(service.getProgressSummary(ALL).completedCount).toBe(3);
  });

  // 4
  it('computes overall completion percentage as completed / total x 100 (rounded)', () => {
    setBestScores({ b1: 50, i1: 50 });  // 2 / 5 = 40%
    expect(service.getProgressSummary(ALL).completionPercentage).toBe(40);
    setBestScores({ b1: 50 });          // 1 / 5 = 20%
    expect(service.getProgressSummary(ALL).completionPercentage).toBe(20);
  });

  // 5
  it('computes Beginner difficulty progress', () => {
    setBestScores({ b1: 90 });
    const beginner = service.getProgressSummary(ALL).byDifficulty.find(d => d.difficulty === 'beginner');
    expect(beginner).toEqual({ difficulty: 'beginner', completed: 1, total: 2 });
  });

  // 6
  it('computes Intermediate difficulty progress', () => {
    setBestScores({ i1: 70, i2: 100 });
    const intermediate = service.getProgressSummary(ALL).byDifficulty.find(d => d.difficulty === 'intermediate');
    expect(intermediate).toEqual({ difficulty: 'intermediate', completed: 2, total: 2 });
  });

  // 7
  it('computes Advanced difficulty progress', () => {
    const advanced = service.getProgressSummary(ALL).byDifficulty.find(d => d.difficulty === 'advanced');
    expect(advanced).toEqual({ difficulty: 'advanced', completed: 0, total: 1 });
  });

  // 8
  it('omits a difficulty group that contains zero quizzes', () => {
    const noAdvanced = [...BEGINNER, ...INTERMEDIATE];
    const keys = service.getProgressSummary(noAdvanced).byDifficulty.map(d => d.difficulty);
    expect(keys).toContain('beginner');
    expect(keys).toContain('intermediate');
    expect(keys).not.toContain('advanced');
  });

  // 9
  it('preserves the best score after a lower retake score', () => {
    bestScores.recordBestScore('b1', 100);
    bestScores.recordBestScore('b1', 40);
    const b1 = service.getQuizProgress(ALL).find(p => p.quizId === 'b1');
    expect(b1?.bestScore).toBe(100);
  });

  // 10
  it('picks the strongest quiz by highest best score', () => {
    setBestScores({ b1: 70, i1: 100, a1: 85 });
    expect(service.getProgressSummary(ALL).strongestQuiz?.quizId).toBe('i1');
  });

  // 11
  it('picks the weakest quiz by lowest best score', () => {
    setBestScores({ b1: 70, i1: 100, a1: 45 });
    expect(service.getProgressSummary(ALL).weakestQuiz?.quizId).toBe('a1');
  });

  // 12
  it('excludes uncompleted quizzes from strongest and weakest', () => {
    setBestScores({ b1: 90, i1: 30 });  // only these two completed
    const s = service.getProgressSummary(ALL);
    expect(s.strongestQuiz?.quizId).toBe('b1');
    expect(s.weakestQuiz?.quizId).toBe('i1');
    // a1/b2/i2 are uncompleted and must not be surfaced
    expect(['b1', 'i1']).toContain(s.strongestQuiz?.quizId);
    expect(['b1', 'i1']).toContain(s.weakestQuiz?.quizId);
  });

  // 13
  it('updates totals automatically when a new quiz is added to the list', () => {
    setBestScores({ b1: 80, b2: 80, i1: 80, i2: 80, a1: 80 });  // all 5 done
    expect(service.getProgressSummary(ALL).completionPercentage).toBe(100);
    const withNew = [...ALL, quiz('a2', 'Advanced Two', 'advanced')];  // new, not completed
    const s = service.getProgressSummary(withNew);
    expect(s.totalCount).toBe(6);
    expect(s.completedCount).toBe(5);
    expect(s.completionPercentage).toBe(83);  // 5/6 = 83.3 -> 83
    expect(s.byDifficulty.find(d => d.difficulty === 'advanced')).toEqual({
      difficulty: 'advanced', completed: 1, total: 2
    });
  });

  // 14
  it('handles malformed persisted best-score data safely', () => {
    localStorage.setItem(SK_QUIZ_BEST_SCORES, '{ not valid json');
    expect(() => service.getProgressSummary(ALL)).not.toThrow();
    expect(service.getProgressSummary(ALL).completedCount).toBe(0);
  });

  // 15
  it('handles a completed entry with no reliable score without inventing a value', () => {
    setBestScores({ b1: 'not-a-number', b2: 90 });  // b1 has garbage score
    const progress = service.getQuizProgress(ALL);
    const b1 = progress.find(p => p.quizId === 'b1');
    const b2 = progress.find(p => p.quizId === 'b2');
    expect(b1?.completed).toBe(false);   // dropped safely, no invented score
    expect(b1?.bestScore).toBeNull();
    expect(b2?.bestScore).toBe(90);      // valid entry preserved
    expect(service.getProgressSummary(ALL).strongestQuiz?.quizId).toBe('b2');
  });

  // 16
  it('does not mutate the source quiz list', () => {
    setBestScores({ b1: 80, i1: 60 });
    const input = [...ALL];
    const snapshot = JSON.stringify(input);
    service.getProgressSummary(input);
    service.getQuizProgress(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.length).toBe(5);
  });

  // ── averageScore / perfectScores / questionsCompleted ─────────────
  // All three read the SAME best-score store as everything above, using each
  // quiz's best attempt (best[] already holds the highest recorded percentage).
  const quizN = (quizId: string, difficulty: string, n: number): Quiz =>
    ({
      quizId,
      milestone: quizId,
      difficulty,
      questions: Array.from({ length: n }, () => ({}))
    }) as unknown as Quiz;

  it('reports all three metrics as 0 when nothing is completed', () => {
    const s = service.getProgressSummary(ALL);
    expect(s.averageScore).toBe(0);
    expect(s.perfectScores).toBe(0);
    expect(s.questionsCompleted).toBe(0);
  });

  it('averageScore = mean of best completed scores (rounded), ignoring incomplete', () => {
    setBestScores({ b1: 80, i1: 100 });   // mean 90; the other 3 are incomplete
    expect(service.getProgressSummary(ALL).averageScore).toBe(90);
  });

  it('one completed quiz → averageScore equals that quiz score', () => {
    setBestScores({ b1: 73 });
    expect(service.getProgressSummary(ALL).averageScore).toBe(73);
  });

  it('perfectScores counts only quizzes whose best score is exactly 100%', () => {
    setBestScores({ b1: 100, i1: 100, a1: 90, b2: 99 });
    expect(service.getProgressSummary(ALL).perfectScores).toBe(2);
  });

  it('uses the BEST attempt on retakes for average + perfect (never double-counts)', () => {
    bestScores.recordBestScore('b1', 60);
    bestScores.recordBestScore('b1', 90);   // better retake wins
    bestScores.recordBestScore('b1', 70);   // worse retake ignored
    const s = service.getProgressSummary(ALL);
    expect(s.completedCount).toBe(1);        // one quiz, not three attempts
    expect(s.averageScore).toBe(90);

    bestScores.recordBestScore('i1', 95);
    bestScores.recordBestScore('i1', 100);   // a later perfect retake counts
    expect(service.getProgressSummary(ALL).perfectScores).toBe(1);
    expect(service.getProgressSummary(ALL).averageScore).toBe(95);  // (90 + 100) / 2
  });

  it('questionsCompleted sums questions of completed quizzes (best attempt once)', () => {
    const catalog = [quizN('x1', 'beginner', 10), quizN('x2', 'beginner', 10), quizN('x3', 'advanced', 8)];
    setBestScores({ x1: 100, x2: 50 });      // x3 not completed
    expect(service.getProgressSummary(catalog).questionsCompleted).toBe(20);  // 10 + 10
  });

  it('questionsCompleted does not accumulate repeated attempts of the same quiz', () => {
    const catalog = [quizN('x1', 'beginner', 10)];
    bestScores.recordBestScore('x1', 50);
    bestScores.recordBestScore('x1', 80);    // two attempts, one quiz
    expect(service.getProgressSummary(catalog).questionsCompleted).toBe(10);  // counted once
  });
});
