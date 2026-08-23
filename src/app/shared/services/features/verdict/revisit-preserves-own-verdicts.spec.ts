import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';

import { QuestionVerdictService } from './question-verdict.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from './verdict-adapter';
import { canonicalize } from './local-verdict.adapter';
import type { QuestionCheckResult } from './question-verdict.types';

/**
 * A VERDICT ON THE PLAYER'S OWN PICK SURVIVES A REVISIT.
 *
 * ── The regression this pins ──────────────────────────────────────
 *
 * Answering a single-answer question WRONGLY, navigating away and coming back
 * left the remembered pick painted neutral instead of red.
 *
 * The cause was a data loss, not a painting bug. Revisiting re-submits, and the
 * live bindings on a revisit carry no selection, so `/check` takes the
 * single-select empty-selection branch (`answer-check.ts:184`) and answers
 * `incomplete` with an EMPTY verdict list. The client then REPLACED its stored
 * `selectedVerdicts` with that empty map, destroying the verdict the player had
 * already earned. `option-item` asks `selectedVerdictFor`, receives `undefined`
 * — which correctly means "nothing has been said", not "wrong" — and clears the
 * option to neutral.
 *
 * The reveal (`correctOptionTexts`) was already preserved across this exact
 * transition for the same reason. These pin the other half.
 *
 * ── Why merging is authorized ─────────────────────────────────────
 *
 * Every preserved entry came from a prior `/check`. Nothing is invented, and a
 * newer verdict for the same option still wins. This is emphatically NOT a
 * local answer key: an option the server has never ruled on stays absent, which
 * the last test here pins.
 */

const QUIZ = 'dependency-injection';
const QUESTION = 'Which of the following benefit from dependency injection?';

let service: QuestionVerdictService;
let nextResult: QuestionCheckResult;

/** The store keys verdicts canonically, so look them up the same way. */
const verdictOf = (text: string): boolean | undefined =>
  service.verdictFor(QUIZ, QUESTION).selectedVerdicts.get(canonicalize(text));

/** Records one `/check` round trip with a scripted server answer. */
async function check(selected: readonly string[], result: QuestionCheckResult): Promise<void> {
  nextResult = result;
  await firstValueFrom(service.checkAnswer(QUIZ, QUESTION, selected));
}

const wrongPickResolved: QuestionCheckResult = {
  status: 'resolved',
  correct: false,
  correctOptionTexts: ['Services'],
  explanation: 'Services are injectable.'
};

/** What a revisit produces: no selection, so no verdicts and nothing revealed. */
const emptyRevisit: QuestionCheckResult = {
  status: 'incomplete',
  selectedVerdicts: [],
  remainingCorrectCount: 1
};

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      QuestionVerdictService,
      {
        provide: TOPIC_QUIZ_VERDICT_ADAPTER,
        useValue: { check: () => of(nextResult) }
      }
    ]
  });
  service = TestBed.inject(QuestionVerdictService);
});

describe('a revisit does not erase the verdicts a player earned', () => {
  it('keeps a WRONG pick wrong after an empty re-check', async () => {
    await check(['Components'], wrongPickResolved);
    expect(verdictOf('Components')).toBe(false);

    await check([], emptyRevisit);

    // Was `undefined` before the fix, which the painter reads as "no claim"
    // and renders neutral — the remembered red disappeared.
    expect(verdictOf('Components')).toBe(false);
  });

  it('keeps a CORRECT pick correct after an empty re-check', async () => {
    await check(['Services'], {
      status: 'resolved',
      correct: true,
      correctOptionTexts: ['Services'],
      explanation: 'Services are injectable.'
    });
    expect(verdictOf('Services')).toBe(true);

    await check([], emptyRevisit);

    expect(verdictOf('Services')).toBe(true);
  });

  it('lets a NEWER verdict for the same option win', async () => {
    await check(['Components'], wrongPickResolved);

    await check(['Components'], {
      status: 'incomplete',
      selectedVerdicts: [{ text: 'Components', correct: true }],
      remainingCorrectCount: 0
    });

    expect(verdictOf('Components')).toBe(true);
  });

  it('accumulates verdicts across separate partial submissions', async () => {
    await check(['map'], {
      status: 'incomplete',
      selectedVerdicts: [{ text: 'map', correct: true }],
      remainingCorrectCount: 1
    });
    await check(['filter'], {
      status: 'incomplete',
      selectedVerdicts: [{ text: 'filter', correct: true }],
      remainingCorrectCount: 0
    });

    
    expect(verdictOf('map')).toBe(true);
    expect(verdictOf('filter')).toBe(true);
  });

  it('still says NOTHING about an option the server never ruled on', async () => {
    await check(['Components'], wrongPickResolved);
    await check([], emptyRevisit);

    // The whole point of the migration: merging preserves earned facts, it does
    // not manufacture them. An untouched option has no verdict, ever.
    expect(verdictOf('Directives')).toBeUndefined();
    expect(service.verdictFor(QUIZ, QUESTION).selectedVerdicts.has(canonicalize('Services'))).toBe(false);
  });

  it('still replaces the outstanding count, which IS current', async () => {
    await check(['map'], {
      status: 'incomplete',
      selectedVerdicts: [{ text: 'map', correct: true }],
      remainingCorrectCount: 2
    });
    await check(['map', 'filter'], {
      status: 'incomplete',
      selectedVerdicts: [
        { text: 'map', correct: true },
        { text: 'filter', correct: true }
      ],
      remainingCorrectCount: 1
    });

    expect(service.verdictFor(QUIZ, QUESTION).remainingCorrectCount).toBe(1);
  });
});
