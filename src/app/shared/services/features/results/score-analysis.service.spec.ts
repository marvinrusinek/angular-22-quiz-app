import { TestBed } from '@angular/core/testing';

import { QuizQuestion } from '@shared/models';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { IDLE_VERDICT_STATE } from '@shared/services/features/verdict/question-verdict.types';
import { ScoreAnalysisService } from './score-analysis.service';

const QUIZ_ID = 'test-quiz';

// Minimal stub exposing only the two selection maps buildAnalysis() reads.
class SelectedOptionStub {
  rawSelectionsMap = new Map<number, { optionId?: number; text?: string }[]>();
  selectedOptionsMap = new Map<number, { optionId?: number; text?: string }[]>();
}

/**
 * Stands in for the BACKEND, which legitimately knows the answers.
 *
 * These tests are about selection matching and id capture, not about where
 * correctness comes from — but buildAnalysis no longer reads `option.correct`,
 * so a question with no authorized verdict is now treated as unanswered and
 * reveals nothing. Each test therefore authorizes its question explicitly,
 * which is also a more honest description of the runtime: the reveal exists
 * because the server released it, not because the bank was in memory.
 */
class VerdictStub {
  private readonly reveals = new Map<string, string[]>();

  authorize(questionText: string, correctOptionTexts: string[]): void {
    this.reveals.set(questionText, correctOptionTexts);
  }

  verdictFor(_quizId: string, questionText: string) {
    const correctOptionTexts = this.reveals.get(questionText);
    if (!correctOptionTexts) return IDLE_VERDICT_STATE;

    return {
      ...IDLE_VERDICT_STATE,
      phase: 'resolved' as const,
      correctOptionTexts,
      explanation: 'authorized explanation'
    };
  }
}

/** Authorize every question using the `correct` flags the fixture declares. */
function authorizeAll(verdicts: VerdictStub, questions: QuizQuestion[]): void {
  for (const question of questions) {
    verdicts.authorize(
      question.questionText ?? '',
      (question.options ?? []).filter((o) => o.correct === true).map((o) => o.text)
    );
  }
}

function q(questionText: string, opts: { text: string; correct?: boolean; optionId?: number }[]): QuizQuestion {
  return {
    questionText,
    options: opts.map((o, i) => ({
      optionId: o.optionId ?? i,
      text: o.text,
      correct: o.correct === true
    }))
  } as unknown as QuizQuestion;
}

describe('ScoreAnalysisService', () => {
  let service: ScoreAnalysisService;
  let selection: SelectedOptionStub;
  let verdicts: VerdictStub;

  /** Run buildAnalysis with every question's reveal authorized. */
  function analyse(questions: QuizQuestion[]) {
    authorizeAll(verdicts, questions);
    return service.buildAnalysis(questions);
  }

  beforeEach(() => {
    selection = new SelectedOptionStub();
    verdicts = new VerdictStub();
    TestBed.configureTestingModule({
      providers: [
        { provide: SelectedOptionService, useValue: selection },
        { provide: QuestionVerdictService, useValue: verdicts },
        { provide: QuizService, useValue: { quizId: QUIZ_ID } }
      ]
    });
    service = TestBed.inject(ScoreAnalysisService);
  });

  it('marks a single-answer question correct when the correct option is selected', () => {
    const questions = [q('Q1?', [{ text: 'A', correct: true }, { text: 'B' }])];
    selection.rawSelectionsMap.set(0, [{ optionId: 0, text: 'A' }]);

    const [item] = analyse(questions);
    expect(item.wasCorrect).toBe(true);
    expect(item.questionText).toBe('Q1?');
    expect(item.questionIndex).toBe(0);
  });

  it('marks a single-answer question incorrect when the wrong option is selected', () => {
    const questions = [q('Q1?', [{ text: 'A', correct: true }, { text: 'B' }])];
    selection.rawSelectionsMap.set(0, [{ optionId: 1, text: 'B' }]);

    expect(analyse(questions)[0].wasCorrect).toBe(false);
  });

  it('requires ALL correct options for a multi-answer question', () => {
    const questions = [
      q('Q?', [{ text: 'A', correct: true }, { text: 'B', correct: true }, { text: 'C' }])
    ];
    // Only one of the two correct answers selected.
    selection.rawSelectionsMap.set(0, [{ optionId: 0, text: 'A' }]);
    expect(analyse(questions)[0].wasCorrect).toBe(false);

    // Both correct answers selected.
    selection.rawSelectionsMap.set(0, [{ optionId: 0, text: 'A' }, { optionId: 1, text: 'B' }]);
    expect(analyse(questions)[0].wasCorrect).toBe(true);
  });

  it('matches selections by TEXT when option ids differ (shuffle-safe)', () => {
    const questions = [q('Q?', [{ text: 'Right', correct: true, optionId: 42 }, { text: 'Wrong', optionId: 7 }])];
    // Stored selection has a stale id but the right text.
    selection.rawSelectionsMap.set(0, [{ optionId: 999, text: 'Right' }]);
    expect(analyse(questions)[0].wasCorrect).toBe(true);
  });

  it('falls back to selectedOptionsMap when rawSelectionsMap has no entry', () => {
    const questions = [q('Q?', [{ text: 'A', correct: true }, { text: 'B' }])];
    selection.selectedOptionsMap.set(0, [{ optionId: 0, text: 'A' }]);
    expect(analyse(questions)[0].wasCorrect).toBe(true);
  });

  it('captures selected + correct option ids', () => {
    const questions = [q('Q?', [{ text: 'A', correct: true, optionId: 5 }, { text: 'B', optionId: 6 }])];
    selection.rawSelectionsMap.set(0, [{ optionId: 5, text: 'A' }]);

    const [item] = analyse(questions);
    expect(item.selectedOptionIds).toEqual(['5']);
    expect(item.correctOptionIds).toEqual(['5']);
  });

  describe('an UNANSWERED question reveals nothing', () => {
    // Deliberately NOT authorized — no verdict was ever recorded, which is what
    // a skipped question looks like. The fixture still carries `correct: true`
    // flags, so any reversion to scanning the bank fails these.
    const unanswered = () => [q('Skipped?', [{ text: 'A', correct: true }, { text: 'B' }])];

    it('does not credit it, even though the local flags say A is correct', () => {
      selection.rawSelectionsMap.set(0, [{ optionId: 0, text: 'A' }]);

      const [item] = service.buildAnalysis(unanswered());
      expect(item.wasCorrect).toBe(false);
    });

    it('discloses no correct answers and no explanation', () => {
      const [item] = service.buildAnalysis(unanswered());

      expect(item.correctOptionTexts).toEqual([]);
      expect(item.correctOptionIds).toEqual([]);
      expect(item.explanation).toBeNull();
    });

    it('leaks nothing through the serialized item', () => {
      const [item] = service.buildAnalysis(unanswered());
      // 'A' is the withheld answer; it must not appear under any key.
      expect(JSON.stringify(item)).not.toContain('authorized explanation');
      expect(item.correctOptionTexts).not.toContain('A');
    });

    it('still records what the user selected', () => {
      selection.rawSelectionsMap.set(0, [{ optionId: 0, text: 'A' }]);
      const [item] = service.buildAnalysis(unanswered());

      // The user's own choice is theirs; only the answer key is withheld.
      expect(item.selectedOptionTexts).toEqual(['A']);
    });
  });

  it('handles empty / missing input safely', () => {
    expect(service.buildAnalysis([])).toEqual([]);
    expect(service.buildAnalysis(undefined as unknown as QuizQuestion[])).toEqual([]);
  });
});
