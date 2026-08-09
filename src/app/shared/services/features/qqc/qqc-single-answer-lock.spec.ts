import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QqcOrchClickService } from './qqc-orch-click.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { IDLE_VERDICT_STATE, type QuestionVerdictState } from '../verdict/question-verdict.types';

/**
 * Locking a correctly-answered single-answer question, in the QQC renderer.
 *
 * Unlike the AnswerComponent path, this one never leaked: it only ran after a
 * CORRECT click, so it disclosed nothing the user had not already earned. What
 * it did do was take its authority from the bank — the guard read the clicked
 * option's own `correct` flag, and the lock set was a correct-id set built from
 * `isOptionCorrect`. Both vanish when the answer key stops shipping, and the
 * failure would be silent: a correct answer would simply stop locking anything.
 *
 * Now the verdict decides, and "everything except the correct option" is read
 * as "everything except the option the user got right" — which needs no answer
 * set at all.
 *
 * Fixtures carry `correct` flags that lie, or none.
 */

const QUESTION = 'Which operator maps values?';

let service: QqcOrchClickService;
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
      QqcOrchClickService,
      { provide: QuestionVerdictService, useValue: { verdictFor: () => verdictState } }
    ]
  });
  service = TestBed.inject(QqcOrchClickService);
});

/** Bindings whose `correct` flags are unreliable (or absent when omitted). */
function bindings(withFlags = true): any[] {
  const mk = (id: number, text: string, correct?: boolean) => ({
    option: { optionId: id, text, ...(correct === undefined ? {} : { correct }), active: true },
    isSelected: false,
    disabled: false,
    highlight: false
  });
  return withFlags
    ? [mk(1, 'map', true), mk(2, 'Subject', false), mk(3, 'Observable', false)]
    : [mk(1, 'map'), mk(2, 'Subject'), mk(3, 'Observable')];
}

/** Minimal host exposing only what the lock path reads. */
function host(bs: any[]) {
  return {
    quizService: {
      quizId: 'rxjs',
      getQuestionsInDisplayOrder: () => [{
        questionText: QUESTION,
        options: [{ text: 'map', correct: true }, { text: 'Subject' }, { text: 'Observable' }]
      }],
      questions: [{ questionText: QUESTION }],
      isShuffleEnabled: () => false,
      shuffledQuestions: [],
      quizInitialState: []
    },
    sharedOptionComponent: () => ({ optionBindings: () => bs, cdRef: { markForCheck: () => undefined } }),
    optionBindings: () => bs,
    cdRef: { markForCheck: () => undefined }
  } as any;
}

/** Invoke the private single-answer lock exactly as the click path does. */
const applyLock = (h: any, bs: any[], evtOpt: any) =>
  (service as any).applySingleAnswerDisable(h, 0, { questionText: QUESTION }, evtOpt, 0);

const disabledOf = (bs: any[]) => bs.map((b) => b.disabled);

describe('a correct answer locks the rest', () => {
  it('disables every option except the one the verdict says was right', () => {
    const bs = bindings();
    bs[0].isSelected = true;
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map'],
      selectedVerdicts: new Map([['map', true]])
    });

    applyLock(host(bs), bs, bs[0].option);

    expect(disabledOf(bs)).toEqual([false, true, true]);
    expect(bs[0].option.active).toBe(true);
  });

  it('works when the options carry no `correct` property at all', () => {
    const bs = bindings(false);
    bs[0].isSelected = true;
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map'],
      selectedVerdicts: new Map([['map', true]])
    });

    applyLock(host(bs), bs, bs[0].option);

    expect(disabledOf(bs)).toEqual([false, true, true]);
  });

  it('follows the verdict when the local flags LIE', () => {
    // Bank says 'Observable' is the answer; the verdict says 'map' is.
    const bs = bindings();
    bs[2].option.correct = true;
    bs[0].option.correct = false;
    bs[0].isSelected = true;
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map'],
      selectedVerdicts: new Map([['map', true]])
    });

    applyLock(host(bs), bs, bs[0].option);

    expect(bs[0].disabled).toBe(false);   // map — the real answer
    expect(bs[2].disabled).toBe(true);    // Observable — the lying flag
  });

  it('marks a still-selected earlier wrong guess incorrect', () => {
    const bs = bindings();
    bs[0].isSelected = true;
    bs[1].isSelected = true;   // an earlier wrong pick still showing
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map'],
      selectedVerdicts: new Map([['map', true], ['Subject', false]])
    });

    applyLock(host(bs), bs, bs[0].option);

    expect(bs[1].disabled).toBe(true);
    expect(bs[1].option.showIcon).toBe(true);
  });
});

describe('nothing locks until the verdict authorizes it', () => {
  it('does not lock after a WRONG single-answer pick — retry stays possible', () => {
    const bs = bindings();
    bs[1].isSelected = true;
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Subject', false]])
    });

    applyLock(host(bs), bs, bs[1].option);

    expect(disabledOf(bs)).toEqual([false, false, false]);
  });

  it('does not single out the answer after a wrong pick', () => {
    const bs = bindings();
    bs[1].isSelected = true;
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: false,
      selectedVerdicts: new Map([['Subject', false]])
    });

    applyLock(host(bs), bs, bs[1].option);

    const enabledUnselected = bs.filter((b, i) => i !== 1 && !b.disabled);
    expect(enabledUnselected.length).toBeGreaterThan(1);
  });

  it.each([['idle'], ['checking'], ['error']] as const)(
    'locks nothing while %s — absence is not a wrong answer',
    (phase) => {
      const bs = bindings();
      bs[0].isSelected = true;
      verdictState = state({ phase });

      applyLock(host(bs), bs, bs[0].option);

      expect(disabledOf(bs)).toEqual([false, false, false]);
    }
  );

  it('locks nothing while incomplete', () => {
    const bs = bindings();
    bs[0].isSelected = true;
    verdictState = state({ phase: 'incomplete', remainingCorrectCount: 1 });

    applyLock(host(bs), bs, bs[0].option);

    expect(disabledOf(bs)).toEqual([false, false, false]);
  });
});

describe('identity is textual, not positional', () => {
  it('locks correctly when the options are displayed in a different order', () => {
    const bs = [...bindings()].reverse();   // map is now last
    const answer = bs.find((b) => b.option.text === 'map')!;
    answer.isSelected = true;
    verdictState = state({
      phase: 'resolved',
      isResolvedCorrect: true,
      correctOptionTexts: ['map'],
      selectedVerdicts: new Map([['map', true]])
    });

    applyLock(host(bs), bs, answer.option);

    expect(answer.disabled).toBe(false);
    expect(bs.filter((b) => b.option.text !== 'map').every((b) => b.disabled)).toBe(true);
  });
});
