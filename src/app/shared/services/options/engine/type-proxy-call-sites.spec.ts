import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { OptionInteractionService } from './option-interaction.service';
import { QuestionType } from '../../../models/question-type.enum';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import type { QuizQuestion } from '../../../models/QuizQuestion.model';

/**
 * THE CALL SITES, NOT THE HELPER.
 *
 * `question-type-authority.spec.ts` already proves `resolveIsMultiAnswer`
 * subordinates a counted guess to the declared type. What that cannot prove is
 * that the places deciding single-vs-multiple actually ASK it.
 *
 * Both sites migrated here previously read:
 *
 *     type === 'multiple' || isMultiMode || … || correctCount > 1
 *
 * where the trailing count is an OR — so the local answer key could PROMOTE a
 * declared single-answer question to multiple whenever the bank drifted or was
 * tampered with. Demotion to a fallback is the whole point, and only a fixture
 * where the two DISAGREE can detect it.
 *
 * Every question below therefore carries `correct` flags that contradict its
 * declared type. A fixture where they agree would pass either way.
 */

// jsdom has no structuredClone; QuizService clones the bank at construction.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

const q = (type: QuestionType | undefined, correctCount: number): QuizQuestion => ({
  questionText: 'Which of these?',
  type,
  options: Array.from({ length: 4 }, (_, i) => ({
    optionId: i + 1,
    text: `opt${i + 1}`,
    ...(i < correctCount ? { correct: true } : {})
  }))
} as unknown as QuizQuestion);

let service: OptionInteractionService;

/** Reaches the migrated private resolver on the real service instance. */
const isMultiMode = (
  question: QuizQuestion,
  countInBindings: number,
  pristineCount: number,
  type: 'single' | 'multiple' = 'single'
): boolean =>
  (service as any).resolveIsMultipleMode(
    { currentQuestion: question, type, isMultiMode: false },
    countInBindings,
    pristineCount
  );

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });
  service = TestBed.inject(OptionInteractionService);
});

describe('interaction mode follows the DECLARED type, not the answer key', () => {
  it('stays SINGLE when declared single but the bank shows 3 correct', () => {
    // THE REGRESSION THIS PINS. The old OR-chain returned true from the counts.
    expect(isMultiMode(q(QuestionType.SingleAnswer, 3), 3, 3)).toBe(false);
  });

  it('stays MULTIPLE when declared multiple but the bank shows only 1 correct', () => {
    expect(isMultiMode(q(QuestionType.MultipleAnswer, 1), 1, 1)).toBe(true);
  });

  it('stays MULTIPLE when declared multiple and the bank shows NO correct at all', () => {
    // The shape the API returns once the answer key stops shipping.
    expect(isMultiMode(q(QuestionType.MultipleAnswer, 0), 0, 0)).toBe(true);
  });

  it('treats a declared trueFalse question as single-SELECTION', () => {
    // Interaction mode is single; the DECLARED type stays trueFalse elsewhere —
    // this helper answers only the narrower cardinality question.
    expect(isMultiMode(q(QuestionType.TrueFalse, 2), 2, 2)).toBe(false);
  });

  it('MODE INPUT still promotes: `type: multiple` overrides a declared single', () => {
    // CORRECTED after a LIVE highlighting regression. This previously asserted
    // `false`. Passing `state.type` as resolveIsMultiAnswer's fallback ARGUMENT
    // made a declared type discard it, and a click on a declared-single question
    // then cleared the other options' highlight. Declared type replaces the
    // COUNT only; an explicit mode input keeps its voice.
    expect(isMultiMode(q(QuestionType.SingleAnswer, 1), 1, 1, 'multiple')).toBe(true);
  });

  it('works when options carry no `correct` property whatsoever', () => {
    const bare = {
      questionText: 'Which of these?',
      type: QuestionType.MultipleAnswer,
      options: [{ optionId: 1, text: 'a' }, { optionId: 2, text: 'b' }]
    } as unknown as QuizQuestion;

    expect(isMultiMode(bare, 0, 0)).toBe(true);
  });
});

describe('an UNDECLARED type still falls back to the counted guess', () => {
  it('counts as multiple when the bank shows more than one correct', () => {
    // REMOVE WITH THE /questions CONTENT CUTOVER. Undeclared is not "single":
    // treating a miss as single would turn multi-answer questions single while
    // the type request is in flight.
    expect(isMultiMode(q(undefined, 3), 3, 3)).toBe(true);
  });

  it('counts as single when the bank shows one correct', () => {
    expect(isMultiMode(q(undefined, 1), 1, 1)).toBe(false);
  });

  it('still honours the explicit-multi question-text heuristic', () => {
    const selectAll = {
      questionText: 'Select all that apply',
      options: [{ optionId: 1, text: 'a' }]
    } as unknown as QuizQuestion;

    expect(isMultiMode(selectAll, 1, 1)).toBe(true);
  });

  it('the explicit-multi TEXT heuristic still promotes a declared single', () => {
    // CORRECTED with the mode-input fix. The wording heuristic sits alongside
    // `type`/`isMultiMode` in the same OR-chain, so subordinating it to the
    // declared type discarded it too. It is a runtime signal, not a count, and
    // the COUNT is the only thing the declared type replaces.
    const selectAllButSingle = {
      questionText: 'Select all that apply',
      type: QuestionType.SingleAnswer,
      options: [{ optionId: 1, text: 'a' }]
    } as unknown as QuizQuestion;

    expect(isMultiMode(selectAllButSingle, 1, 1)).toBe(true);
  });
});

describe('no literal correct-count is fabricated from the type', () => {
  it('multiple does not imply exactly two correct answers', () => {
    // A multi-answer question may have 2, 3 or 4 correct options. The migrated
    // sites ask only "is this multiple", never "how many" — the count remains
    // blocked on the API supplying it.
    const three = q(QuestionType.MultipleAnswer, 3);
    expect(isMultiMode(three, 3, 3)).toBe(true);
    expect(isMultiMode(q(QuestionType.MultipleAnswer, 2), 2, 2)).toBe(true);
    expect(isMultiMode(q(QuestionType.MultipleAnswer, 4), 4, 4)).toBe(true);
  });
});
