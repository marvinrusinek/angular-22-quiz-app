import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { AnswerBindingsService } from './answer-bindings.service';
import { AnswerOptionsService } from './answer-options.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { QuizService } from '../../data/quiz.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from '../verdict/question-verdict.types';
import type { OptionBindings } from '../../../models/OptionBindings.model';
import type { SelectedOption } from '../../../models/SelectedOption.model';

/**
 * What a wrong answer is allowed to reveal about the options you did NOT pick.
 *
 * The old rule disabled every unselected option once anything was clicked, and
 * then exempted whichever one the bank marked correct. After a wrong guess that
 * left the right answer as the only enabled option on screen — readable from
 * the DOM without clicking. Retry was the justification; disclosure was the
 * effect.
 *
 * Now unselected options are locked only when the question is authorized as
 * answered CORRECTLY, which disables all of them alike and so distinguishes
 * none of them. A wrong pick leaves them all selectable, which is also what
 * keeps retry-until-correct working.
 *
 * Every fixture's `correct` flags lie, or are absent entirely.
 */

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

const QUESTION = 'Which operator maps values?';

let service: AnswerBindingsService;
let verdictState: QuestionVerdictState;

const state = (over: Partial<QuestionVerdictState>): QuestionVerdictState =>
  ({ ...IDLE_VERDICT_STATE, ...over });

beforeEach(() => {
  verdictState = IDLE_VERDICT_STATE;

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      AnswerBindingsService,
      AnswerOptionsService,
      {
        provide: QuizService,
        useValue: {
          quizId: 'rxjs',
          currentQuestionIndex: 0,
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION }],
          questions: [{ questionText: QUESTION }],
          isShuffleEnabled: () => false,
          shuffledQuestions: []
        }
      },
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });
  service = TestBed.inject(AnswerBindingsService);
});

/** Three options; `correct` flags are deliberately unreliable. */
function bindings(withCorrectFlags = true): OptionBindings[] {
  const mk = (id: number, text: string, correct?: boolean) =>
    ({
      option: { optionId: id, text, ...(correct === undefined ? {} : { correct }) },
      index: id - 1,
      isSelected: false,
      isCorrect: null,
      disabled: false
    }) as unknown as OptionBindings;

  return withCorrectFlags
    // 'map' is the real answer and is flagged; the others are not.
    ? [mk(1, 'map', true), mk(2, 'Subject', false), mk(3, 'Observable', false)]
    // No `correct` property anywhere — the shape /questions returns.
    : [mk(1, 'map'), mk(2, 'Subject'), mk(3, 'Observable')];
}

const clicked = (optionId: number): SelectedOption =>
  ({ optionId, selected: true }) as unknown as SelectedOption;

const disabledOf = (bs: OptionBindings[]) => bs.map((b) => b.disabled);

describe('a wrong single-answer pick reveals nothing about the rest', () => {
  it('leaves every unselected option selectable — including the right one', () => {
    // The user picked 'Subject' (wrong). The verdict resolved, incorrectly.
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Subject', false]])
    });

    const result = service.updateVisualBindings(bindings(), clicked(2), 'single');

    // 'map' must not stand out from 'Observable' in any way.
    expect(result[0].disabled).toBe(false);   // map (the answer)
    expect(result[2].disabled).toBe(false);   // Observable (also wrong)
    expect(disabledOf(result)).toEqual([false, false, false]);
  });

  it('does not make the answer the uniquely enabled option', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Subject', false]])
    });

    const result = service.updateVisualBindings(bindings(), clicked(2), 'single');
    const enabledUnselected = result.filter((b, i) => i !== 1 && !b.disabled);

    // THE LEAK: previously exactly one unselected option stayed enabled.
    expect(enabledUnselected.length).toBeGreaterThan(1);
  });

  it('behaves identically when the bank has no correctness at all', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Subject', false]])
    });

    const result = service.updateVisualBindings(bindings(false), clicked(2), 'single');

    expect(disabledOf(result)).toEqual([false, false, false]);
  });

  it('ignores a LYING correct flag on an unselected option', () => {
    // Bank says 'Observable' is correct; it is not, and either way the UI must
    // not treat it differently from any other unselected option.
    const lying = bindings();
    (lying[2].option as any).correct = true;

    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Subject', false]])
    });

    const result = service.updateVisualBindings(lying, clicked(2), 'single');

    expect(result[2].disabled).toBe(false);
    expect(disabledOf(result)).toEqual([false, false, false]);
  });

  it('still lets the user try again after a wrong pick', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Subject', false]])
    });
    const afterWrong = service.updateVisualBindings(bindings(), clicked(2), 'single');

    // Now they pick the real answer; nothing blocked them from doing so.
    expect(afterWrong[0].disabled).toBe(false);
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map'],
      selectedVerdicts: new Map([['map', true]])
    });
    const afterRight = service.updateVisualBindings(afterWrong, clicked(1), 'single');

    expect(afterRight[0].isSelected).toBe(true);
  });
});

describe('an unresolved question locks nothing', () => {
  it.each([['idle'], ['checking'], ['error']] as const)(
    'leaves options selectable while %s — absence is not a wrong answer',
    (phase) => {
      verdictState = state({ phase });
      const result = service.updateVisualBindings(bindings(), clicked(2), 'single');

      expect(disabledOf(result)).toEqual([false, false, false]);
    }
  );
});

describe('a correct answer still locks the rest', () => {
  it('disables every unselected option once resolved correctly', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map'],
      selectedVerdicts: new Map([['map', true]])
    });

    const result = service.updateVisualBindings(bindings(), clicked(1), 'single');

    expect(result[0].isSelected).toBe(true);    // the pick stays live
    expect(result[1].disabled).toBe(true);
    expect(result[2].disabled).toBe(true);
  });

  it('locks them all alike, so none is distinguishable', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map'],
      selectedVerdicts: new Map([['map', true]])
    });

    const result = service.updateVisualBindings(bindings(), clicked(1), 'single');
    const unselected = result.filter((_, i) => i !== 0);

    expect(unselected.every((b) => b.disabled === true)).toBe(true);
  });
});

describe('multi-answer questions are untouched by this path', () => {
  it('returns other bindings unchanged', () => {
    verdictState = state({ phase: 'incomplete', remainingCorrectCount: 1 });
    const input = bindings();
    const result = service.updateVisualBindings(input, clicked(2), 'multiple');

    expect(result[0]).toBe(input[0]);
    expect(result[2]).toBe(input[2]);
  });
});

describe('option order does not matter', () => {
  it('is driven by the clicked option id, not its position', () => {
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map'],
      selectedVerdicts: new Map([['map', true]])
    });

    // Reversed display order; the answer sits last.
    const reversed = [...bindings()].reverse();
    const result = service.updateVisualBindings(reversed, clicked(1), 'single');
    const answer = result.find((b) => b.option.text === 'map')!;

    expect(answer.isSelected).toBe(true);
    expect(result.filter((b) => b.option.text !== 'map').every((b) => b.disabled)).toBe(true);
  });
});
