import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER } from 'rxjs';

import { QuizSetupService } from './quiz-setup.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';

/**
 * A LITERAL, real `KeyboardEvent` dispatched through the REAL
 * `QuizSetupService.runOnGlobalKey` (the exact method QuizComponent's
 * `(window:keydown)` host binding calls) — not a read of the signal the
 * handler happens to consult. Proves ArrowRight/Enter cannot advance while
 * the shared progression gate says no, and that they CAN once it says yes.
 */

/** Anything not explicitly stubbed becomes a harmless no-op function. */
function lenient<T extends object>(known: T): T {
  return new Proxy(known, {
    get: (target, prop) => {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
      if (prop === 'then') return undefined;
      return jest.fn();
    }
  });
}

const QUIZ = 'fixture';
let service: QuizSetupService;
let host: {
  activatedRoute: unknown;
  shouldShowNextButton: jest.Mock;
  nextButtonEnabled: jest.Mock;
  advanceToNextQuestion: jest.Mock;
  shouldShowResultsButton: boolean;
  advanceToResults: jest.Mock;
};

function mount(): void {
  const perf = performance as unknown as { getEntriesByType?: () => unknown[] };
  perf.getEntriesByType ??= () => [];

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: QuizService,
        useValue: lenient({
          quizId: QUIZ,
          quizReset$: NEVER,
          questions$: NEVER,
          currentQuestionIndex$: NEVER,
          questionsSig: signal([]),
          questions: [],
          selectedOptionsMap: new Map(),
          questionCorrectness: new Map(),
          getQuestionsInDisplayOrder: () => [],
          isShuffleEnabled: () => false,
          getCurrentQuizId: () => QUIZ,
          getCurrentQuestionIndex: () => 0
        })
      }
    ]
  });

  service = TestBed.inject(QuizSetupService);
  TestBed.inject(QuizStateService).setDisplayState({ mode: 'question', answered: true });
  TestBed.inject(SelectedOptionService); // constructs; nothing further needed
  host = {
    activatedRoute: { snapshot: { paramMap: { get: () => null } } },
    shouldShowNextButton: jest.fn(() => true),
    nextButtonEnabled: jest.fn(() => false),   // the shared gate's current verdict
    advanceToNextQuestion: jest.fn(async () => undefined),
    shouldShowResultsButton: false,
    advanceToResults: jest.fn()
  };
}

function keydown(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key });
}

beforeEach(mount);

describe('ArrowRight/Enter via a REAL KeyboardEvent through runOnGlobalKey', () => {
  it('does NOT advance while the shared progression gate blocks (nextButtonEnabled() false)', async () => {
    host.nextButtonEnabled.mockReturnValue(false);
    await service.runOnGlobalKey(host as never, keydown('ArrowRight'));
    expect(host.advanceToNextQuestion).not.toHaveBeenCalled();

    await service.runOnGlobalKey(host as never, keydown('Enter'));
    expect(host.advanceToNextQuestion).not.toHaveBeenCalled();
  });

  it('DOES advance once the shared gate allows it (nextButtonEnabled() true, question answered)', async () => {
    host.nextButtonEnabled.mockReturnValue(true);
    TestBed.inject(QuizStateService).setDisplayState({ mode: 'question', answered: true });
    const verdicts = TestBed.inject(QuestionVerdictService);
    jest.spyOn(TestBed.inject(SelectedOptionService), 'isQuestionAnswered').mockReturnValue(true);
    void verdicts;

    await service.runOnGlobalKey(host as never, keydown('ArrowRight'));
    expect(host.advanceToNextQuestion).toHaveBeenCalledTimes(1);
  });

  it('a KeyboardEvent from a text input is ignored entirely (no advance attempt either way)', async () => {
    const input = document.createElement('input');
    host.nextButtonEnabled.mockReturnValue(true);
    jest.spyOn(TestBed.inject(SelectedOptionService), 'isQuestionAnswered').mockReturnValue(true);

    const event = keydown('ArrowRight');
    Object.defineProperty(event, 'target', { value: input });
    await service.runOnGlobalKey(host as never, event);
    expect(host.advanceToNextQuestion).not.toHaveBeenCalled();
  });
});
