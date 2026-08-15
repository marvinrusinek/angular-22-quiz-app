import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';

import { QuestionType } from '../models/question-type.enum';
import type { Option } from '../models/Option.model';
import type { QuizQuestion } from '../models/QuizQuestion.model';

import { QuizQuestionManagerService } from '../services/flow/quizquestionmgr.service';
import { QqcOrchQuestionLoadService } from '../services/features/qqc/qqc-orch-question-load.service';
import { API_BASE_URL } from '../tokens/api-base-url.token';

/**
 * CLASS C GROUP 3 — SPLITTING INTERACTION TYPE FROM THE BANNER'S COUNT.
 *
 * One resolver used to answer two different questions:
 *
 *   "how is this question answered?"      -> which component to instantiate
 *   "how many answers are correct?"       -> the "(N answers are correct)" gate
 *
 * Only the first is a TYPE question. Migrating the shared resolver in place
 * would have silently re-gated the banner, which belongs to a later slice, so
 * the two were split instead.
 *
 * These tests therefore prove BOTH halves: that interaction mode now follows
 * the declared type, and that the banner path deliberately still does NOT.
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

/** Options with no `correct` property at all — the post-cutover shape. */
const bare = (type: QuestionType | undefined): QuizQuestion => ({
  questionText: 'No answer key at all',
  explanation: 'e',
  type,
  options: [
    { optionId: 1, text: 'a', value: 1 },
    { optionId: 2, text: 'b', value: 2 }
  ]
} as unknown as QuizQuestion);

describe('interaction mode follows the DECLARED type', () => {
  let mgr: QuizQuestionManagerService;

  const interaction = (question: QuizQuestion): Promise<boolean> =>
    firstValueFrom(mgr.isMultipleAnswerInteraction(question));

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [QuizQuestionManagerService] });
    mgr = TestBed.inject(QuizQuestionManagerService);
  });

  it('declared MULTIPLE is multi even when the bank flags only one correct', async () => {
    expect(await interaction(q(QuestionType.MultipleAnswer, 1))).toBe(true);
  });

  it('declared SINGLE stays single even when the bank flags three correct', async () => {
    // THE REGRESSION THIS PINS — the count promoted unconditionally.
    expect(await interaction(q(QuestionType.SingleAnswer, 3))).toBe(false);
  });

  it('declared TRUEFALSE is single-SELECTION despite a misleading count', async () => {
    // The declared type on the question is not rewritten; this answers only
    // the narrower "one pick or several" question.
    expect(await interaction(q(QuestionType.TrueFalse, 3))).toBe(false);
  });

  it('declared MULTIPLE works with NO `correct` fields present', async () => {
    expect(await interaction(bare(QuestionType.MultipleAnswer))).toBe(true);
  });

  it('UNDECLARED falls back to the legacy count', async () => {
    // REMOVE WITH THE /questions CONTENT CUTOVER. Unknown is not "single".
    expect(await interaction(q(undefined, 3))).toBe(true);
    expect(await interaction(q(undefined, 1))).toBe(false);
    expect(await interaction(q(undefined, 0))).toBe(false);
  });

  it('survives a malformed question without throwing', async () => {
    expect(await interaction(null as unknown as QuizQuestion)).toBe(false);
    expect(await interaction({ questionText: 'x' } as unknown as QuizQuestion)).toBe(false);
  });

  it('the sync form agrees with the observable form', async () => {
    const question = q(QuestionType.SingleAnswer, 3);
    expect(mgr.isMultipleAnswerInteractionSync(question)).toBe(false);
    expect(await interaction(question)).toBe(false);
  });
});

describe('the BANNER path is deliberately still count-based', () => {
  let mgr: QuizQuestionManagerService;

  const bannerGate = (question: QuizQuestion): Promise<boolean> =>
    firstValueFrom(mgr.isMultipleAnswerQuestion(question));

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [QuizQuestionManagerService] });
    mgr = TestBed.inject(QuizQuestionManagerService);
  });

  it('a declared SINGLE with three flagged correct still gates the banner OPEN', async () => {
    // NOT A BUG TO FIX HERE. cqc-orchestrator uses this to decide whether to
    // print "(N answers are correct)". Making it declared-first would change
    // literal correct-count DISCLOSURE, which belongs to the banner slice with
    // the Class B survivors. This test exists to catch an accidental migration.
    expect(await bannerGate(q(QuestionType.SingleAnswer, 3))).toBe(true);
  });

  it('a declared MULTIPLE with one flagged correct still gates the banner SHUT', async () => {
    expect(await bannerGate(q(QuestionType.MultipleAnswer, 1))).toBe(false);
  });

  it('the two resolvers DISAGREE on purpose — that is the split', async () => {
    const declaredSingleButFlaggedMulti = q(QuestionType.SingleAnswer, 3);
    expect(await bannerGate(declaredSingleButFlaggedMulti)).toBe(true);    // count
    expect(await interactionOf(mgr, declaredSingleButFlaggedMulti)).toBe(false);  // declared
  });
});

const interactionOf = (
  mgr: QuizQuestionManagerService,
  question: QuizQuestion
): Promise<boolean> => firstValueFrom(mgr.isMultipleAnswerInteraction(question));

describe('cold-load chain: BOTH primary and fallback are declared-first', () => {
  let service: QqcOrchQuestionLoadService;
  let mgr: QuizQuestionManagerService;
  let loadedAsMulti: boolean | null;

  /**
   * Drives the real loader. `primary: 'real'` exercises the migrated PRIMARY
   * path through QuizQuestionManagerService; 'throws' forces the catch, which
   * Group 2 already made declared-first.
   */
  const coldLoad = async (
    question: QuizQuestion,
    primary: 'real' | 'throws' = 'real'
  ): Promise<boolean | null> => {
    loadedAsMulti = null;

    const host: any = {
      dynamicAnswerContainer: () => ({ clear: () => {} }),
      quizQuestionManagerService:
        primary === 'real'
          ? mgr
          : {
            isMultipleAnswerInteraction: () =>
              throwError(() => new Error('cold load: no emission'))
          },
      dynamicComponentService: {
        loadComponent: (_c: unknown, isMulti: boolean) => {
          loadedAsMulti = isMulti;
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
        QuizQuestionManagerService,
        { provide: API_BASE_URL, useValue: 'https://api.test/api' },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
      ]
    });
    service = TestBed.inject(QqcOrchQuestionLoadService);
    mgr = TestBed.inject(QuizQuestionManagerService);
  });

  it('PRIMARY path loads single for a declared single flagged 3 correct', async () => {
    // Before this slice the primary counted, so this loaded the MULTI component.
    expect(await coldLoad(q(QuestionType.SingleAnswer, 3))).toBe(false);
  });

  it('PRIMARY path loads multi for a declared multiple flagged 1 correct', async () => {
    expect(await coldLoad(q(QuestionType.MultipleAnswer, 1))).toBe(true);
  });

  it('PRIMARY path keeps trueFalse single-selection', async () => {
    expect(await coldLoad(q(QuestionType.TrueFalse, 3))).toBe(false);
  });

  it('PRIMARY path falls back to the count when UNDECLARED', async () => {
    expect(await coldLoad(q(undefined, 3))).toBe(true);
    expect(await coldLoad(q(undefined, 1))).toBe(false);
  });

  it('FALLBACK path is declared-first too when the primary throws', async () => {
    expect(await coldLoad(q(QuestionType.SingleAnswer, 3), 'throws')).toBe(false);
    expect(await coldLoad(q(QuestionType.MultipleAnswer, 1), 'throws')).toBe(true);
  });

  it('uses the question PASSED IN, so shuffle position is irrelevant', async () => {
    // The loader receives the question object directly — no index, nothing a
    // shuffled display order could point at the wrong neighbour.
    const displayed = q(QuestionType.SingleAnswer, 3, 'displayed at slot 0');
    const canonical = q(QuestionType.MultipleAnswer, 1, 'canonical at slot 0');

    expect(await coldLoad(displayed)).toBe(false);
    expect(await coldLoad(canonical)).toBe(true);
  });
});
