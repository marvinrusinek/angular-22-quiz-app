import { TestBed } from '@angular/core/testing';

import { BestScoreService } from './best-score.service';
import { SK_QUIZ_BEST_SCORES } from '@shared/constants/session-keys';

describe('BestScoreService', () => {
  let service: BestScoreService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(BestScoreService);
  });

  it('records a score and reports completion', () => {
    service.recordBestScore('q1', 70);
    expect(service.isCompleted('q1')).toBe(true);
    expect(service.getBestScore('q1')).toBe(70);
    expect(service.isCompleted('q2')).toBe(false);
    expect(service.getBestScore('q2')).toBeNull();
  });

  it('keeps the highest score and never lowers it on a lower retake', () => {
    service.recordBestScore('q1', 100);
    service.recordBestScore('q1', 40);
    expect(service.getBestScore('q1')).toBe(100);
  });

  it('raises the score when a later attempt is higher', () => {
    service.recordBestScore('q1', 40);
    service.recordBestScore('q1', 90);
    expect(service.getBestScore('q1')).toBe(90);
  });

  it('clamps and rounds out-of-range scores', () => {
    service.recordBestScore('q1', 150);
    service.recordBestScore('q2', -10);
    service.recordBestScore('q3', 66.6);
    expect(service.getBestScore('q1')).toBe(100);
    expect(service.getBestScore('q2')).toBe(0);
    expect(service.getBestScore('q3')).toBe(67);
  });

  it('returns an empty map for malformed stored data', () => {
    localStorage.setItem(SK_QUIZ_BEST_SCORES, '{ broken');
    expect(service.getBestScores()).toEqual({});
  });

  it('seeds best scores from legacy highScoresLocal when empty', () => {
    localStorage.setItem('highScoresLocal', JSON.stringify([
      { quizId: 'q1', score: 88 },
      { quizId: 'q1', score: 60 },  // lower dup — best kept
      { quizId: 'q2', score: 42 }
    ]));
    const best = service.getBestScores();
    expect(best['q1']).toBe(88);
    expect(best['q2']).toBe(42);
  });
});
