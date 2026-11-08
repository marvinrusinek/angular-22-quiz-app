import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { Observable, of } from 'rxjs';

import { OptionInteractionService } from './option-interaction.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from '@shared/services/features/verdict/verdict-adapter';
import type { QuestionCheckResult } from '@shared/services/features/verdict/question-verdict.types';
import { QuizService } from '@shared/services/data/quiz.service';
import { setQuizDataCache } from '@shared/quiz-data-cache';
import { QuestionType } from '@shared/models';
import type { Quiz } from '@shared/models';
import { selectionForSubmission } from '@shared/utils/question-type-authority';

/**
 * REVISITING A WRONG-ANSWERED SINGLE-ANSWER QUESTION. Answer Q2 wrongly, leave it, come back and pick a DIFFERENT option: the click
 * handler used to publish the new pick UNIONED with the first-visit revisit snapshot, so POST /check carried both options for a
 * single-answer question, the backend replied 400 "Invalid submission", the check was recorded as failed, and the notice "An earlier
 * answer couldn't be verified, so Results is unavailable" appeared. A declared single-answer question must submit only its newest
 * pick; a multi-answer question must keep the union of its live picks and the revisit snapshot.
 */

const QUIZ = 'dependency-injection';
const Q1 = 'What is Dependency Injection (DI) in Angular?';
const Q2 = 'Which of the following benefit from dependency injection?'; // single answer, correct: All of the above.
const Q3 = 'Select every operator'; // multi answer, correct: map, filter

const BANK = [
  {
    quizId: QUIZ,
    milestone: 'DI',
    questions: [
      {
        questionText: Q1,
        type: QuestionType.SingleAnswer,
        explanation: 'e1',
        options: [{ text: 'A design pattern', correct: true }, { text: 'A method for animations' }]
      },
      {
        questionText: Q2,
        type: QuestionType.SingleAnswer,
        explanation: 'e2',
        options: [
          { text: 'Maintainability' },
          { text: 'Testability' },
          { text: 'Loose coupling' },
          { text: 'All of the above.', correct: true }
        ]
      },
      {
        questionText: Q3,
        type: QuestionType.MultipleAnswer,
        explanation: 'e3',
        options: [{ text: 'map', correct: true }, { text: 'filter', correct: true }, { text: 'Observable' }]
      }
    ]
  }
] as unknown as Quiz[];

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

const RESOLVED_INCORRECT = {
  status: 'resolved',
  correct: false,
  correctOptionTexts: ['All of the above.'],
  explanation: 'e2'
} as QuestionCheckResult;
const RESOLVED_CORRECT = {
  status: 'resolved',
  correct: true,
  correctOptionTexts: ['All of the above.'],
  explanation: 'e2'
} as QuestionCheckResult;
const INCOMPLETE = {
  status: 'incomplete',
  selectedVerdicts: [{ text: 'map', correct: true }],
  remainingCorrectCount: 1
} as QuestionCheckResult;

let service: OptionInteractionService;
let selected: SelectedOptionService;
let verdicts: QuestionVerdictService;
let adapterCheck: jest.Mock;
let quizService: QuizService;

beforeEach(() => {
  setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);
  adapterCheck = jest.fn();

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useValue: { check: adapterCheck, revealExpired: jest.fn() } }
    ]
  });
  quizService = TestBed.inject(QuizService);
  (quizService as any).quizId = QUIZ;
  quizService.questions = JSON.parse(JSON.stringify(BANK[0]!.questions)) as never;

  service = TestBed.inject(OptionInteractionService);
  selected = TestBed.inject(SelectedOptionService);
  verdicts = TestBed.inject(QuestionVerdictService);
});

afterEach(() => setQuizDataCache([], []));

/** The click handler's hand-off to the single submission owner (phase 2 -> verdict), as the real click path calls it. */
function click(qIdx: number, picked: string[]): void {
  const question = quizService.questions[qIdx]!;
  (service as any).submitSelectionForVerdict({
    qIdx,
    question,
    futureSelection: picked.map((text) => ({ text }))
  });
}

describe('single-answer question: wrong answer, leave, return, pick a different option', () => {
  it('submits exactly one selection, belonging to Q2, and receives normal verification (no failed-check record)', () => {
    // First visit: the wrong pick is verified normally.
    adapterCheck.mockReturnValueOnce(of(RESOLVED_INCORRECT));
    click(1, ['Maintainability']);
    expect(adapterCheck).toHaveBeenCalledTimes(1);
    expect(verdicts.verdictFor(QUIZ, Q2).phase).toBe('resolved');

    // Leaving Q2 snapshots its first-visit pick for the revisit display (what navigation does).
    selected.captureRevisitDisplay(1, ['Maintainability']);

    // Back on Q2 the user picks a DIFFERENT option.
    adapterCheck.mockReturnValueOnce(of(RESOLVED_CORRECT));
    click(1, ['Testability']);

    expect(adapterCheck).toHaveBeenCalledTimes(2);
    const [quizId, questionText, texts] = adapterCheck.mock.calls[1]!;
    expect(quizId).toBe(QUIZ);
    expect(questionText).toBe(Q2);
    expect(texts).toEqual(['testability']); // exactly one selection, the new one - not ['testability', 'maintainability']
    const q2Options = ((BANK[0] as any).questions[1].options as { text: string }[]).map((o) => o.text.toLowerCase());
    expect(q2Options).toContain((texts as string[])[0]!);

    // Normal verification: resolved, no error, nothing that could block Results.
    expect(verdicts.verdictFor(QUIZ, Q2).phase).toBe('resolved');
    expect(verdicts.hasFailedVerdicts(QUIZ)).toBe(false);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });

  it('a genuine verification failure is still recorded (error handling intact)', () => {
    adapterCheck.mockReturnValueOnce(of(RESOLVED_INCORRECT));
    click(1, ['Maintainability']);
    selected.captureRevisitDisplay(1, ['Maintainability']);

    adapterCheck.mockReturnValueOnce(new Observable<never>((s) => s.error(new Error('network down'))));
    click(1, ['Testability']);

    expect(verdicts.verdictFor(QUIZ, Q2).phase).toBe('error');
    expect(verdicts.hasFailedVerdicts(QUIZ)).toBe(true);
  });
});

describe('multiple-answer question: revisit keeps the valid multiple selection', () => {
  it('unions the live pick with the revisit snapshot (a partial selection can be completed)', () => {
    adapterCheck.mockReturnValueOnce(of(INCOMPLETE));
    click(2, ['map']);
    selected.captureRevisitDisplay(2, ['map']);

    adapterCheck.mockReturnValueOnce(of(RESOLVED_CORRECT));
    click(2, ['filter']);

    const [, questionText, texts] = adapterCheck.mock.calls[1]!;
    expect(questionText).toBe(Q3);
    expect(new Set(texts as string[])).toEqual(new Set(['filter', 'map']));
    expect((texts as string[]).length).toBe(2);
  });
});

describe('selectionForSubmission (the one rule both submission paths use)', () => {
  it('single-answer / true-false: only the newest pick, the snapshot is ignored', () => {
    expect(selectionForSubmission(false, ['old', 'new'], ['old'])).toEqual(['new']);
    expect(selectionForSubmission(false, ['new'], ['old'])).toEqual(['new']);
    expect(selectionForSubmission(false, [], ['old'])).toEqual([]);
  });

  it('multi-answer and undeclared types keep the union with the snapshot', () => {
    expect(selectionForSubmission(true, ['b'], ['a'])).toEqual(['b', 'a']);
    expect(selectionForSubmission(null, ['b'], ['a'])).toEqual(['b', 'a']);
    expect(selectionForSubmission(true, ['b'], undefined)).toEqual(['b']);
    expect(selectionForSubmission(null, [], null)).toEqual([]);
  });
});
