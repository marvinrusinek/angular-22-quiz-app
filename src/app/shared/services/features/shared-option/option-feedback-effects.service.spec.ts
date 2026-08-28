import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { OptionFeedbackEffectsService } from './option-feedback-effects.service';
import { OptionBindingFactoryService } from '../../options/engine/option-binding-factory.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../timer/timer.service';
import { setQuizDataCache } from '../../../quiz-data-cache';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import type { Quiz } from '../../../models/Quiz.model';
import type { Option } from '../../../models/Option.model';

/**
 * CONVERGENCE — `repaintOnVerdictArrival` must not keep rewriting bindings
 * once nothing paintable is left to change.
 *
 * `verdicts.states()` changes identity on every `/check` round trip — the
 * optimistic `checking` write as well as the terminal one — not only on a
 * genuine reveal. Before this fix, `repaintOnVerdictArrival` cloned and wrote
 * EVERY current binding unconditionally on each of those firings, which
 * re-armed every other effect reading `optionBindings` (the multi-answer
 * auto-disable effect in this same file). On a completing REVISIT click that
 * produced hundreds of synchronous re-entries in tens of milliseconds and
 * froze the tab before the score could ever repaint — confirmed by capping
 * the re-entry count experimentally, which converted the failing test into a
 * pass with the correct score displayed.
 *
 * These tests would FAIL against the unconditional-write implementation: the
 * "settles twice" case would observe a second `.set()` call with nothing new
 * to paint, and the "no-op arrival" case would observe a write even though no
 * binding's `isCorrect` had actually changed.
 */

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

const QUIZ = 'dependency-injection';
const QTEXT = 'Which of these are true about DI?';

const QUESTIONS = [
  {
    questionText: QTEXT,
    explanation: '',
    options: [
      { text: 'Alpha', correct: true },
      { text: 'Beta', correct: false }
    ]
  }
];
const BANK = [{ quizId: QUIZ, milestone: 'DI', questions: QUESTIONS }] as unknown as Quiz[];

function settle(): void {
  const bed = TestBed as unknown as { tick?: () => void; flushEffects?: () => void };
  if (typeof bed.tick === 'function') bed.tick();
  else if (typeof bed.flushEffects === 'function') bed.flushEffects();
}

function freshOptions(): Option[] {
  return JSON.parse(JSON.stringify(QUESTIONS[0].options)) as Option[];
}

describe('OptionFeedbackEffectsService — repaint convergence', () => {
  let service: OptionFeedbackEffectsService;
  let verdicts: QuestionVerdictService;
  let quizService: QuizService;
  let factory: OptionBindingFactoryService;

  beforeEach(() => {
    setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
        { provide: API_BASE_URL, useValue: 'https://api.test/api' }
      ]
    });

    service = TestBed.inject(OptionFeedbackEffectsService);
    verdicts = TestBed.inject(QuestionVerdictService);
    quizService = TestBed.inject(QuizService);
    factory = TestBed.inject(OptionBindingFactoryService);
    (quizService as any).quizId = QUIZ;
  });

  afterEach(() => setQuizDataCache([], []));

  function makeHost(bindingsSignal: ReturnType<typeof signal<any>>) {
    return {
      optionBindings: bindingsSignal,
      cdRef: { markForCheck: jest.fn() },
      currentQuestionIndex: 0,
      quizService,
      selectedOptionService: TestBed.inject(SelectedOptionService),
      timerService: TestBed.inject(TimerService)
    } as any;
  }

  it('does not rewrite bindings a second time when the verdict state has not changed', () => {
    const bindings = signal(
      factory.createBindings({
        optionsToDisplay: freshOptions(),
        type: 'multiple',
        showFeedback: false,
        showFeedbackForOption: {},
        highlightCorrectAfterIncorrect: false,
        shouldResetBackground: false,
        onChange: () => undefined,
        isSelected: () => false
      })
    );
    const setSpy = jest.spyOn(bindings, 'set');
    const host = makeHost(bindings);

    TestBed.runInInjectionContext(() => service.registerFeedbackEffects(host));

    settle();
    const writesAfterFirstSettle = setSpy.mock.calls.length;
    expect(writesAfterFirstSettle).toBeGreaterThan(0);   // first paint still happens

    settle();
    settle();
    // REPEATED STABLE STATE MUST NOT KEEP REWRITING BINDINGS.
    expect(setSpy.mock.calls.length).toBe(writesAfterFirstSettle);
  });

  it('does not repaint when a verdict arrives but no binding correctness actually changed', () => {
    const bindings = signal(
      factory.createBindings({
        optionsToDisplay: freshOptions(),
        type: 'multiple',
        showFeedback: false,
        showFeedbackForOption: {},
        highlightCorrectAfterIncorrect: false,
        shouldResetBackground: false,
        onChange: () => undefined,
        isSelected: () => false
      })
    );
    const setSpy = jest.spyOn(bindings, 'set');
    const host = makeHost(bindings);

    TestBed.runInInjectionContext(() => service.registerFeedbackEffects(host));
    settle();
    const baseline = setSpy.mock.calls.length;

    // A verdict round trip for a DIFFERENT question arrives. `verdicts.states()`
    // changes identity, but nothing about THIS question's bindings changed.
    verdicts.checkAnswer(QUIZ, 'An unrelated question', ['whatever']).subscribe({ error: () => undefined });
    settle();

    expect(setSpy.mock.calls.length).toBe(baseline);   // no-op write must not happen
  });

  it('still repaints once when a binding correctness value genuinely changes', () => {
    const bindings = signal(
      factory.createBindings({
        optionsToDisplay: freshOptions(),
        type: 'multiple',
        showFeedback: false,
        showFeedbackForOption: {},
        highlightCorrectAfterIncorrect: false,
        shouldResetBackground: false,
        onChange: () => undefined,
        isSelected: () => false
      })
    );
    const setSpy = jest.spyOn(bindings, 'set');
    const host = makeHost(bindings);

    TestBed.runInInjectionContext(() => service.registerFeedbackEffects(host));
    settle();
    const baseline = setSpy.mock.calls.length;

    // Simulate option-lock-policy stamping a plain-field correctness change on
    // the SAME binding objects (exactly how production does it — no signal).
    (bindings() as any[])[0].isCorrect = true;
    verdicts.checkAnswer(QUIZ, QTEXT, ['Alpha']).subscribe({ error: () => undefined });
    settle();

    expect(setSpy.mock.calls.length).toBe(baseline + 1);   // genuine change still paints

    // And it must not keep repainting after that either.
    settle();
    settle();
    expect(setSpy.mock.calls.length).toBe(baseline + 1);
  });
});
