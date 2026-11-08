import { TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';

import { QuestionVerdictService } from './question-verdict.service';
import type { QuestionCheckResult } from './question-verdict.types';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from './verdict-adapter';
import { QuestionResolutionService } from '@shared/services/options/engine/question-resolution.service';

/**
 * EARLIER PICKS KEEP THEIR RED (display history), WITHOUT CHANGING THE VERDICT MAP'S MEANING.
 *
 * Revisit a single-answer question you answered wrongly and choose a different option: the earlier wrong pick used to lose its red
 * because the `resolved` write replaced `selectedVerdicts` with only the new selection. `earlierPickVerdicts` keeps how earlier picks
 * were judged as DISPLAY history only. `selectedVerdicts` still holds just the current selection, so every reader of the whole map
 * (counters, strict/perfect checks, sounds) is unchanged, and a multi-answer deselection can never paint a stale verdict.
 */

const QUIZ = 'dependency-injection';
const SINGLE = 'Which of the following benefit from dependency injection?';
const MULTI = 'Select every operator';

const wrong = (correct: string[]): QuestionCheckResult =>
  ({ status: 'resolved', correct: false, correctOptionTexts: correct, explanation: 'e' }) as QuestionCheckResult;
const right = (correct: string[]): QuestionCheckResult =>
  ({ status: 'resolved', correct: true, correctOptionTexts: correct, explanation: 'e' }) as QuestionCheckResult;

let verdicts: QuestionVerdictService;
let responses: Subject<QuestionCheckResult>[];

function mockAdapterCheck(): Observable<QuestionCheckResult> {
  const subject = new Subject<QuestionCheckResult>();
  responses.push(subject);
  return subject.asObservable();
}

beforeEach(() => {
  responses = [];
  TestBed.configureTestingModule({
    providers: [
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useValue: { check: mockAdapterCheck, revealExpired: mockAdapterCheck } }
    ]
  });
  verdicts = TestBed.inject(QuestionVerdictService);
});

function answer(question: string, texts: string[], result: QuestionCheckResult): void {
  verdicts.checkAnswer(QUIZ, question, texts).subscribe({ error: () => undefined });
  responses[responses.length - 1]!.next(result);
}

const keys = (m: ReadonlyMap<string, boolean> | undefined) => [...(m ?? new Map()).keys()].sort();

describe('single-answer: earlier wrong picks stay in the display history', () => {
  it('a different answer after a wrong one keeps the earlier wrong pick; the verdict map still holds only the current selection', () => {
    answer(SINGLE, ['Maintainability'], wrong(['All of the above.']));
    answer(SINGLE, ['Testability'], wrong(['All of the above.']));

    const state = verdicts.verdictFor(QUIZ, SINGLE);
    expect(state.earlierPickVerdicts?.get('maintainability')).toBe(false);
    // The verdict map keeps its existing meaning: the CURRENT selection only.
    expect(keys(state.selectedVerdicts)).toEqual(['testability']);
    expect(state.selectedOptionTexts).toEqual(['Testability']);
  });

  it('a subsequent CORRECT answer keeps every earlier wrong pick and resolves correct', () => {
    answer(SINGLE, ['Maintainability'], wrong(['All of the above.']));
    answer(SINGLE, ['Testability'], wrong(['All of the above.']));
    answer(SINGLE, ['All of the above.'], right(['All of the above.']));

    const state = verdicts.verdictFor(QUIZ, SINGLE);
    expect(state.isResolvedCorrect).toBe(true);
    expect(keys(state.earlierPickVerdicts)).toEqual(['maintainability', 'testability']);
    expect(state.earlierPickVerdicts?.get('maintainability')).toBe(false);
    expect(state.earlierPickVerdicts?.get('testability')).toBe(false);
    // Whole-map readers (counts, strict/perfect, sounds) see only the current selection, exactly as before.
    expect(keys(state.selectedVerdicts)).toEqual(['all of the above.']);
    expect([...state.selectedVerdicts.values()]).toEqual([true]);
  });

  it('picking an earlier wrong option again makes it current again (it leaves the history)', () => {
    answer(SINGLE, ['Maintainability'], wrong(['All of the above.']));
    answer(SINGLE, ['Testability'], wrong(['All of the above.']));
    answer(SINGLE, ['Maintainability'], wrong(['All of the above.']));

    const state = verdicts.verdictFor(QUIZ, SINGLE);
    expect(keys(state.selectedVerdicts)).toEqual(['maintainability']);
    expect(keys(state.earlierPickVerdicts)).toEqual(['testability']);
  });

  it('history is per question', () => {
    answer(SINGLE, ['Maintainability'], wrong(['All of the above.']));
    answer(SINGLE, ['Testability'], wrong(['All of the above.']));
    expect(verdicts.verdictFor(QUIZ, 'Another question').earlierPickVerdicts).toBeUndefined();
  });
});

describe('attempt reset clears the history', () => {
  it('clearAll (restart / new attempt) drops it', () => {
    answer(SINGLE, ['Maintainability'], wrong(['All of the above.']));
    answer(SINGLE, ['Testability'], wrong(['All of the above.']));
    expect(keys(verdicts.verdictFor(QUIZ, SINGLE).earlierPickVerdicts)).toEqual(['maintainability']);

    verdicts.clearAll();

    const state = verdicts.verdictFor(QUIZ, SINGLE);
    expect(state.phase).toBe('idle');
    expect(state.earlierPickVerdicts).toBeUndefined();
  });

  it('clearQuestion drops that question\'s history', () => {
    answer(SINGLE, ['Maintainability'], wrong(['All of the above.']));
    answer(SINGLE, ['Testability'], wrong(['All of the above.']));

    verdicts.clearQuestion(QUIZ, SINGLE);

    expect(verdicts.verdictFor(QUIZ, SINGLE).earlierPickVerdicts).toBeUndefined();
  });

  it('a new answer after a reset starts a fresh history (nothing from the old attempt)', () => {
    answer(SINGLE, ['Maintainability'], wrong(['All of the above.']));
    answer(SINGLE, ['Testability'], wrong(['All of the above.']));
    verdicts.clearAll();

    answer(SINGLE, ['Loose coupling'], wrong(['All of the above.']));

    const state = verdicts.verdictFor(QUIZ, SINGLE);
    expect(keys(state.selectedVerdicts)).toEqual(['loose coupling']);
    expect(state.earlierPickVerdicts?.size ?? 0).toBe(0);
  });
});

describe('multi-answer deselection is checked explicitly, not assumed harmless', () => {
  const INCOMPLETE_AB = {
    status: 'incomplete',
    selectedVerdicts: [
      { text: 'a', correct: false },
      { text: 'b', correct: true }
    ],
    remainingCorrectCount: 1
  } as QuestionCheckResult;

  it('deselecting a wrong pick and completing the answer leaves NO stale verdict in the verdict map', () => {
    answer(MULTI, ['a', 'b'], INCOMPLETE_AB); // a (wrong) + b (right): incomplete, map accumulates
    answer(MULTI, ['b', 'c'], right(['b', 'c'])); // a deselected, c added: resolved correct

    const state = verdicts.verdictFor(QUIZ, MULTI);
    expect(state.isResolvedCorrect).toBe(true);
    // The whole-map readers (strict/perfect, counts) must not see the deselected wrong pick.
    expect(keys(state.selectedVerdicts)).toEqual(['b', 'c']);
    expect([...state.selectedVerdicts.values()].every((v) => v === true)).toBe(true);
    // The deselected pick is only in the display history ...
    expect(state.earlierPickVerdicts?.get('a')).toBe(false);
  });

  it('... and the painter rule never uses that history for a multi-answer (or undeclared) question', () => {
    const resolution: QuestionResolutionService = Object.create(QuestionResolutionService.prototype);
    const history = new Map<string, boolean>([['a', false]]);

    expect(resolution.isEarlierWrongSinglePick({ text: 'a' }, true, history)).toBe(false); // multi-answer
    expect(resolution.isEarlierWrongSinglePick({ text: 'a' }, true, new Map())).toBe(false);
    expect(resolution.isEarlierWrongSinglePick({ text: 'a' }, false, history)).toBe(true); // declared single
    expect(resolution.isEarlierWrongSinglePick({ text: 'A ' }, false, history)).toBe(true); // normalized lookup
    expect(resolution.isEarlierWrongSinglePick({ text: 'b' }, false, history)).toBe(false); // other option
    expect(resolution.isEarlierWrongSinglePick({ text: 'a' }, false, new Map([['a', true]]))).toBe(false); // only WRONG stays red
    expect(resolution.isEarlierWrongSinglePick({ text: 'a' }, false, undefined)).toBe(false);
  });

  it('the incomplete branch carries any existing history forward unchanged (multi-answer policy intact)', () => {
    answer(SINGLE, ['Maintainability'], wrong(['x']));
    answer(SINGLE, ['Testability'], wrong(['x']));
    const before = keys(verdicts.verdictFor(QUIZ, SINGLE).earlierPickVerdicts);

    answer(SINGLE, ['Testability'], {
      status: 'incomplete',
      selectedVerdicts: [],
      remainingCorrectCount: 1
    } as QuestionCheckResult);

    expect(keys(verdicts.verdictFor(QUIZ, SINGLE).earlierPickVerdicts)).toEqual(before);
  });
});
