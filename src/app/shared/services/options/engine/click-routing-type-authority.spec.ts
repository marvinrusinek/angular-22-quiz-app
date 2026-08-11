import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SharedOptionClickService } from './shared-option-click.service';
import { QuizService } from '../../data/quiz.service';
import { TopicQuizTypeRegistry } from '../../api/topic-quiz-type-registry.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';

/**
 * SINGLE vs MULTI IS A TYPE QUESTION, NOT AN ANSWER-KEY ONE.
 *
 * `resolveEffectiveCorrectIndices` decided it with
 *
 *     ... || effectiveCorrectCount > 1 || pristineCorrectCount > 1
 *
 * which makes question TYPE a derivative of the answer key. It selects the
 * click path for EVERY click, so with correctness absent — the shape
 * `/questions` returns — both counts collapse to 0 and every multi-answer
 * question routes to the single-answer path. That is a silent behaviour
 * change, not a visible failure, which is the worst kind.
 *
 * The declared type now decides. These tests give the local bank a
 * cardinality that CONTRADICTS the declared type, so anything still counting
 * correct options fails.
 */

const QUESTION = 'Which are RxJS operators?';

let service: SharedOptionClickService;
let declared: boolean | null;

/** `mode` decides what the local bank's cardinality claims. */
function makeComp(mode: 'one-correct' | 'many-correct' | 'no-correct') {
  const opts = ['map', 'Subject', 'filter'].map((text, i) => {
    if (mode === 'no-correct') return { optionId: i + 1, text };
    if (mode === 'one-correct') return { optionId: i + 1, text, correct: text === 'map' };
    return { optionId: i + 1, text, correct: text !== 'Subject' };
  });

  return {
    _correctIndicesByQuestion: new Map<number, number[]>(),
    optionBindings: () => opts.map((o, i) => ({ option: { ...o }, index: i })),
    currentQuestion: () => ({ questionText: QUESTION, options: opts }),
    getQuestionAtDisplayIndex: () => ({ questionText: QUESTION, options: opts }),
    isMultiMode: false,
    type: 'single'
  };
}

beforeEach(() => {
  declared = null;

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      { provide: TopicQuizTypeRegistry, useValue: { isMultiAnswer: () => declared, load: () => of(null) } },
      {
        provide: QuizService,
        useValue: {
          quizId: 'rxjs',
          questions: [{ questionText: QUESTION, options: [] }],
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION, options: [] }],
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          quizInitialState: [],
          getPristineCorrectTextsForQuestion: () => new Set<string>(),
          quizReset$: of(undefined)
        }
      }
    ]
  });

  service = TestBed.inject(SharedOptionClickService);
});

const resolve = (c: any) => (service as any).resolveEffectiveCorrectIndices(c, 0);

describe('the declared type decides the click path', () => {
  it('routes MULTI even when the bank shows only ONE correct option', () => {
    declared = true;

    expect(resolve(makeComp('one-correct')).isMultiFromQ).toBe(true);
  });

  it('routes SINGLE even when the bank shows MANY correct options', () => {
    // The old `correctCount > 1` term would have said multi here.
    declared = false;

    expect(resolve(makeComp('many-correct')).isMultiFromQ).toBe(false);
  });

  it('routes MULTI with `correct` structurally absent — the /questions shape', () => {
    // THE POINT OF THE SLICE. Every count is 0 here; only the declared type
    // can answer, and it must not silently downgrade to single.
    declared = true;
    const result = resolve(makeComp('no-correct'));

    expect(result.isMultiFromQ).toBe(true);
    expect(result.effectiveCorrectCount).toBe(0);
  });
});

describe('a registry MISS falls back to the component type, never to counting', () => {
  it('does not infer multi from a bank showing many correct options', () => {
    declared = null;                    // registry has not answered
    const c = makeComp('many-correct'); // bank says 2 correct
    c.isMultiMode = false;
    c.type = 'single';

    // The old code returned true here purely from cardinality.
    expect(resolve(c).isMultiFromQ).toBe(false);
  });

  it('honours the component type when it says multiple', () => {
    declared = null;
    const c = makeComp('one-correct');
    c.type = 'multiple';

    expect(resolve(c).isMultiFromQ).toBe(true);
  });

  it('honours isMultiMode when set', () => {
    declared = null;
    const c = makeComp('no-correct');
    c.isMultiMode = true;

    expect(resolve(c).isMultiFromQ).toBe(true);
  });
});

describe('identity is the question, not its position', () => {
  it('asks the registry with the LIVE question text', () => {
    let askedWith: string | undefined;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
        {
          provide: TopicQuizTypeRegistry,
          useValue: { isMultiAnswer: (t: string) => { askedWith = t; return true; }, load: () => of(null) }
        },
        {
          provide: QuizService,
          useValue: {
            quizId: 'rxjs',
            questions: [],
            getQuestionsInDisplayOrder: () => [],
            isShuffleEnabled: () => true,          // shuffled: index would be wrong
            shuffledQuestions: [{ questionText: 'a different question' }],
            quizInitialState: [],
            getPristineCorrectTextsForQuestion: () => new Set<string>(),
            quizReset$: of(undefined)
          }
        }
      ]
    });
    const svc = TestBed.inject(SharedOptionClickService);

    (svc as any).resolveEffectiveCorrectIndices(makeComp('no-correct'), 0);

    expect(askedWith).toBe(QUESTION);
  });
});
