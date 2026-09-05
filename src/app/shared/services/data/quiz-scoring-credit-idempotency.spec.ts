import { TestBed } from '@angular/core/testing';

import { QuizScoringService } from './quiz-scoring.service';
import { QuizService } from './quiz.service';

/**
 * Stage 10 — idempotent scoring at the authoritative chokepoint.
 *
 * `creditResolvedQuestion` is the ONLY place a Topic Quiz question's score is
 * ever incremented (called exclusively from
 * SelectedOptionService#submitToVerdictService's `/check` response
 * subscribe, gated on `result.status === 'resolved' && result.correct ===
 * true`). Its own comment already asserts "a replayed verdict, a revisit or a
 * re-render cannot double-count" via the
 * `questionCorrectness.get(scoringKey) === true` guard — but that guarantee
 * had no direct regression test anywhere in the suite. These pin it.
 */
describe('QuizScoringService.creditResolvedQuestion — idempotency (Stage 10)', () => {
  let service: QuizScoringService;
  let quizServiceMock: any;

  const QUIZ = 'dependency-injection';
  const QUESTIONS = [
    { questionText: 'Question one?' },
    { questionText: 'Question two?' },
    { questionText: 'Question three?' }
  ];

  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
    sessionStorage.clear();
    quizServiceMock = {
      getQuestionsInDisplayOrder: jest.fn().mockReturnValue(QUESTIONS),
      isShuffleEnabled: jest.fn().mockReturnValue(false)
    };

    TestBed.configureTestingModule({
      providers: [
        QuizScoringService,
        { provide: QuizService, useValue: quizServiceMock }
      ]
    });
    service = TestBed.inject(QuizScoringService);
  });

  it('calling it twice for the SAME question credits exactly once', () => {
    service.creditResolvedQuestion(QUIZ, QUESTIONS[0]!.questionText);
    expect(service.correctCountSig()).toBe(1);

    service.creditResolvedQuestion(QUIZ, QUESTIONS[0]!.questionText);
    expect(service.correctCountSig()).toBe(1);   // unchanged — not 2
  });

  it('calling it many times (simulating a replayed verdict / repeated effect run) still credits exactly once', () => {
    for (let i = 0; i < 5; i++) {
      service.creditResolvedQuestion(QUIZ, QUESTIONS[0]!.questionText);
    }
    expect(service.correctCountSig()).toBe(1);
    expect(service.questionCorrectness.get(0)).toBe(true);
  });

  it('crediting two DIFFERENT questions increments independently, without cross-contaminating the guard', () => {
    service.creditResolvedQuestion(QUIZ, QUESTIONS[0]!.questionText);
    service.creditResolvedQuestion(QUIZ, QUESTIONS[1]!.questionText);
    expect(service.correctCountSig()).toBe(2);

    // Re-crediting the first again must still not double-count it.
    service.creditResolvedQuestion(QUIZ, QUESTIONS[0]!.questionText);
    expect(service.correctCountSig()).toBe(2);
  });

  it('an unknown question (not in display order) is silently ignored — no credit, no throw', () => {
    expect(() => service.creditResolvedQuestion(QUIZ, 'Not a real question')).not.toThrow();
    expect(service.correctCountSig()).toBe(0);
  });

  it('resetScore clears the guard, so a genuinely fresh attempt can credit the same question again', () => {
    service.creditResolvedQuestion(QUIZ, QUESTIONS[0]!.questionText);
    expect(service.correctCountSig()).toBe(1);

    service.resetScore(QUIZ);
    expect(service.correctCountSig()).toBe(0);
    expect(service.questionCorrectness.size).toBe(0);

    service.creditResolvedQuestion(QUIZ, QUESTIONS[0]!.questionText);
    expect(service.correctCountSig()).toBe(1);
  });
});
