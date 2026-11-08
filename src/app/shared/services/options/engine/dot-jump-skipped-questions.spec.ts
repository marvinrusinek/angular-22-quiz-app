import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { Observable, of, Subject } from 'rxjs';

import { OptionInteractionService } from './option-interaction.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from '@shared/services/features/verdict/verdict-adapter';
import type { QuestionCheckResult } from '@shared/services/features/verdict/question-verdict.types';
import { QuizService } from '@shared/services/data/quiz.service';
import { setQuizDataCache } from '@shared/quiz-data-cache';
import { QuestionType } from '@shared/models';
import type { Quiz } from '@shared/models';

/**
 * DOT JUMPS OPEN THE EXACT QUESTION. Jumping from Q1 to Q4 / Q5 leaves the questions in between UNANSWERED: no submission, no
 * verdict, no failed-verification record. Answers given after a jump belong to the question that was answered, a verification still in
 * flight when the user jumps stays attached to its original question, and Results is not blocked by skipped questions - only by a
 * genuine failed or pending check.
 */

const QUIZ = 'dependency-injection';
const TEXTS = ['Q1 text', 'Q2 text', 'Q3 text', 'Q4 text', 'Q5 text'];
const BANK = [
  {
    quizId: QUIZ,
    milestone: 'DI',
    questions: TEXTS.map((questionText, i) => ({
      questionText,
      type: QuestionType.SingleAnswer,
      explanation: 'e' + i,
      options: [{ text: 'a' + i, correct: true }, { text: 'b' + i }, { text: 'c' + i }]
    }))
  }
] as unknown as Quiz[];

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

const resolved = (correct: boolean) =>
  ({ status: 'resolved', correct, correctOptionTexts: ['a'], explanation: 'e' }) as QuestionCheckResult;

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

function click(qIdx: number, picked: string[]): void {
  (service as any).submitSelectionForVerdict({
    qIdx,
    question: quizService.questions[qIdx]!,
    futureSelection: picked.map((text) => ({ text }))
  });
}

const submittedQuestions = () => adapterCheck.mock.calls.map((c) => c[1]);
const phase = (i: number) => verdicts.verdictFor(QUIZ, TEXTS[i]!).phase;

describe('direct dot jumps leave skipped questions unanswered', () => {
  it.each([3, 4])('answering Q1 then jumping to question index %i submits only the answered questions', (target) => {
    adapterCheck.mockReturnValue(of(resolved(true)));
    click(0, ['a0']);
    click(target, ['a' + target]);

    expect(submittedQuestions()).toEqual([TEXTS[0], TEXTS[target]]); // never the questions in between
    for (let skipped = 1; skipped < target; skipped++) {
      expect(phase(skipped)).toBe('idle');
      expect(verdicts.verdictFor(QUIZ, TEXTS[skipped]!).selectedOptionTexts).toEqual([]);
    }
    expect(phase(target)).toBe('resolved');
  });

  it('answering after a jump sends that question own text and exactly one selection', () => {
    adapterCheck.mockReturnValue(of(resolved(false)));
    click(3, ['b3']);

    const [quizId, questionText, texts] = adapterCheck.mock.calls[0]!;
    expect([quizId, questionText, texts]).toEqual([QUIZ, TEXTS[3], ['b3']]);
  });

  it('skipped questions create no failed-verification record and do not block Results', () => {
    adapterCheck.mockReturnValue(of(resolved(true)));
    click(0, ['a0']);
    click(4, ['a4']);

    expect(verdicts.hasFailedVerdicts(QUIZ)).toBe(false);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });

  it('a genuine verification failure after a jump is still recorded and still blocks', () => {
    adapterCheck.mockReturnValueOnce(new Observable<never>((s) => s.error(new Error('network down'))));
    click(3, ['a3']);

    expect(phase(3)).toBe('error');
    expect(verdicts.hasFailedVerdicts(QUIZ)).toBe(true);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);
    expect(phase(1)).toBe('idle'); // the skipped question is not dragged into the failure
  });
});

describe('a pending verification stays with its original question across a jump', () => {
  it('Q2 is in flight when the user jumps to Q4: each response lands on its own question', () => {
    const q2 = new Subject<QuestionCheckResult>();
    const q4 = new Subject<QuestionCheckResult>();
    adapterCheck.mockReturnValueOnce(q2).mockReturnValueOnce(q4);

    click(1, ['b1']);
    expect(phase(1)).toBe('checking');
    click(3, ['a3']); // jump + answer while Q2's check is still pending
    q4.next(resolved(true));
    expect(phase(3)).toBe('resolved');
    expect(phase(1)).toBe('checking'); // Q4's response did not touch Q2

    q2.next(resolved(false));
    expect(phase(1)).toBe('resolved');
    expect(verdicts.verdictFor(QUIZ, TEXTS[1]!).isResolvedCorrect).toBe(false);
    expect(verdicts.verdictFor(QUIZ, TEXTS[3]!).isResolvedCorrect).toBe(true);
  });

  it('a pending check that FAILS after the jump marks its own question, not the one jumped to', () => {
    const q2 = new Subject<QuestionCheckResult>();
    adapterCheck.mockReturnValueOnce(q2).mockReturnValueOnce(of(resolved(true)));
    click(1, ['b1']);
    click(3, ['a3']);

    q2.error(new Error('late failure'));

    expect(phase(1)).toBe('error');
    expect(phase(3)).toBe('resolved');
  });
});

describe('backward revisits after a jump keep answers and highlights', () => {
  it('Q4 answered wrong, then revisited with another pick: the earlier wrong pick keeps its red and the request has one selection', () => {
    adapterCheck.mockReturnValueOnce(of(resolved(false)));
    click(3, ['b3']);
    selected.captureRevisitDisplay(3, ['b3']); // leaving Q4

    adapterCheck.mockReturnValueOnce(of(resolved(false)));
    click(3, ['c3']);

    expect(adapterCheck.mock.calls[1]![2]).toEqual(['c3']);
    const state = verdicts.verdictFor(QUIZ, TEXTS[3]!);
    expect(state.earlierPickVerdicts?.get('b3')).toBe(false);
    expect(verdicts.hasFailedVerdicts(QUIZ)).toBe(false);
  });

  it('an answer given before the jump is preserved on the way back', () => {
    adapterCheck.mockReturnValue(of(resolved(true)));
    click(0, ['a0']);
    click(4, ['a4']);

    const q1 = verdicts.verdictFor(QUIZ, TEXTS[0]!);
    expect(q1.isResolvedCorrect).toBe(true);
    expect(q1.selectedOptionTexts).toEqual(['a0']);
  });
});
