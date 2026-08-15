import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';

import { QuestionType } from '../models/question-type.enum';
import type { Option } from '../models/Option.model';
import type { QuizQuestion } from '../models/QuizQuestion.model';

import { QqcOrchQuestionLoadService } from '../services/features/qqc/qqc-orch-question-load.service';
import { API_BASE_URL } from '../tokens/api-base-url.token';

/**
 * CLASS C GROUP 2 — THE COLD-LOAD TYPE FALLBACK.
 *
 * `runLoadDynamicComponent` asks QuizQuestionManagerService whether the question
 * is multi-answer. On a cold load that observable can complete without emitting,
 * firstValueFrom throws EmptyError, and the catch resolved the question TYPE by
 * counting `correct` flags — which stops working the moment the answer key
 * leaves the browser, and is wrong today whenever the bank disagrees with the
 * declared type.
 *
 * The boolean chooses which component the dynamic loader instantiates, so
 * getting it wrong renders checkboxes for a single-answer question (or the
 * reverse) for the entire life of that question.
 *
 * Every fixture makes the declared type and the bank DISAGREE; one where they
 * agree passes against the old code too and proves nothing.
 */

// jsdom has no structuredClone; QuizService clones the bank at construction.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

const q = (
  type: QuestionType | undefined,
  correctCount: number,
  questionText = 'Which of these apply?'
): QuizQuestion => ({
  questionText,
  explanation: 'e',
  type,
  options: Array.from({ length: 4 }, (_, i) => ({
    optionId: i + 1,
    text: `opt${i + 1}`,
    value: i + 1,
    correct: i < correctCount
  }))
} as unknown as QuizQuestion);

/** A question whose options carry no `correct` property whatsoever. */
const bare = (type: QuestionType | undefined): QuizQuestion => ({
  questionText: 'No answer key at all',
  explanation: 'e',
  type,
  options: [
    { optionId: 1, text: 'a', value: 1 },
    { optionId: 2, text: 'b', value: 2 }
  ]
} as unknown as QuizQuestion);

describe('qqc cold-load fallback: declared type decides which component loads', () => {
  let service: QqcOrchQuestionLoadService;
  let loadedAsMulti: boolean | null;

  /**
   * Drives the real method with the primary resolver FAILING, which is the only
   * way to reach the migrated catch. Returns what the dynamic loader was asked
   * to instantiate.
   */
  const resolveOnColdLoad = async (
    question: QuizQuestion,
    primary: 'throws' | 'empty' = 'throws'
  ): Promise<boolean | null> => {
    loadedAsMulti = null;

    const host: any = {
      dynamicAnswerContainer: () => ({ clear: () => {} }),
      quizQuestionManagerService: {
        // Renamed in the Group 3 split: interaction mode and the banner's
        // correct-count gate are now separate resolvers. The stub MUST track
        // the real name — a missing method would throw and land in the catch,
        // making these tests pass for the wrong reason.
        isMultipleAnswerInteraction: () =>
          primary === 'throws'
            ? throwError(() => new Error('cold load: no emission'))
            : of()   // completes without emitting -> firstValueFrom EmptyError
      },
      dynamicComponentService: {
        loadComponent: (_c: unknown, isMulti: boolean) => {
          loadedAsMulti = isMulti;
          // Abort right after the decision — everything past this point is
          // rendering machinery this test is not about.
          return Promise.reject(new Error('stop after decision'));
        }
      },
      onOptionClicked: () => {},
      containerInitialized: true
    };

    await service.runLoadDynamicComponent(host, question, question.options as Option[]);
    return loadedAsMulti;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    service = TestBed.inject(QqcOrchQuestionLoadService);
  });

  it('declared MULTIPLE loads multi even when the bank flags only one correct', async () => {
    expect(await resolveOnColdLoad(q(QuestionType.MultipleAnswer, 1))).toBe(true);
  });

  it('declared SINGLE loads single even when the bank flags three correct', async () => {
    // THE REGRESSION THIS PINS — the count promoted unconditionally.
    expect(await resolveOnColdLoad(q(QuestionType.SingleAnswer, 3))).toBe(false);
  });

  it('declared TRUEFALSE loads single-selection despite a misleading count', async () => {
    // trueFalse is a single-SELECTION question; the declared type on the
    // question object is not rewritten by this decision.
    expect(await resolveOnColdLoad(q(QuestionType.TrueFalse, 3))).toBe(false);
  });

  it('declared MULTIPLE loads multi with NO `correct` properties present', async () => {
    // The shape the API returns once the answer key stops shipping entirely.
    expect(await resolveOnColdLoad(bare(QuestionType.MultipleAnswer))).toBe(true);
  });

  it('UNDECLARED still falls back to the count', async () => {
    // REMOVE WITH THE /questions CONTENT CUTOVER. Unknown is not "single":
    // treating a miss as single would turn multi-answer questions single while
    // the type request is in flight.
    expect(await resolveOnColdLoad(q(undefined, 3))).toBe(true);
    expect(await resolveOnColdLoad(q(undefined, 1))).toBe(false);
  });

  it('resolves the same way when the primary observable completes EMPTY', async () => {
    // The literal cold-load shape described in the catch comment.
    expect(await resolveOnColdLoad(q(QuestionType.SingleAnswer, 3), 'empty')).toBe(false);
    expect(await resolveOnColdLoad(q(QuestionType.MultipleAnswer, 1), 'empty')).toBe(true);
  });

  it('uses the question PASSED IN, not any positional lookup, under shuffle', async () => {
    // The method receives the question object directly, so a shuffled display
    // order cannot point it at a neighbour. Two questions with contradictory
    // declared types resolve independently of any array position.
    const displayed = q(QuestionType.SingleAnswer, 3, 'displayed at slot 0');
    const canonical = q(QuestionType.MultipleAnswer, 1, 'canonical at slot 0');

    expect(await resolveOnColdLoad(displayed)).toBe(false);
    expect(await resolveOnColdLoad(canonical)).toBe(true);
  });

  it('still prefers the PRIMARY resolver when it emits (fallback not consulted)', async () => {
    // Lifecycle guard: the migration must only affect the catch. A declared
    // SINGLE question whose primary resolver says multi must still load multi,
    // proving the fallback did not quietly become the authority.
    loadedAsMulti = null;
    const host: any = {
      dynamicAnswerContainer: () => ({ clear: () => {} }),
      quizQuestionManagerService: { isMultipleAnswerInteraction: () => of(true) },
      dynamicComponentService: {
        loadComponent: (_c: unknown, isMulti: boolean) => {
          loadedAsMulti = isMulti;
          return Promise.reject(new Error('stop after decision'));
        }
      },
      onOptionClicked: () => {},
      containerInitialized: true
    };

    const question = q(QuestionType.SingleAnswer, 1);
    await service.runLoadDynamicComponent(host, question, question.options as Option[]);
    expect(loadedAsMulti).toBe(true);
  });
});
