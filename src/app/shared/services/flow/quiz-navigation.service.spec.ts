import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { of } from 'rxjs';

import { QuizNavigationService } from './quiz-navigation.service';
import { ExplanationTextService } from '@shared/services/features/explanation/explanation-text.service';
import { NextButtonStateService } from '@shared/services/state/next-button-state.service';
import { OptionLockStateService } from '@shared/services/state/option-lock-state.service';
import { QqcQuestionLoaderService } from '@shared/services/features/qqc/qqc-question-loader.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import { QuizDataService } from '@shared/services/data/quizdata.service';
import { QuizQuestionManagerService } from '@shared/services/flow/quizquestionmgr.service';
import { TopicQuizTypeRegistry } from '@shared/services/api/topic-quiz-type-registry.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';

/** A stand-in whose every method is a jest.fn() unless overridden (QuizNavigationService has 13 collaborators, most irrelevant here). */
function stub<T extends object>(overrides: T = {} as T): any {
  return new Proxy(overrides as any, {
    get: (target, prop) => {
      if (prop === 'then') return undefined;
      if (!(prop in target)) target[prop] = typeof prop === 'string' ? jestFn() : undefined;
      return target[prop];
    }
  });
}
function jestFn(): any {
  return jest.fn();
}

/**
 * Dot-jump regression. A forward dot beyond the next unlocked question asks for Q5; QuizGuard redirects that navigation to the
 * furthest unlocked question (Q2) and the redirected navigation still RESOLVES as a success. Before the fix the service committed the
 * REQUESTED index (Q5) after navigating, so the app held Q5 as the current question while the route and view showed Q2; the next
 * answer was then verified with Q5's text and the backend answered 400 "Invalid submission", which marked a question as failed and
 * hid Results. Committed state must come from the question the router actually reached.
 */
describe('QuizNavigationService dot-jump redirect', () => {
  const questions = [
    { questionText: 'Q1 text', options: [{ text: 'a1' }] },
    { questionText: 'Q2 text', options: [{ text: 'maintainability' }, { text: 'All of the above.' }] },
    { questionText: 'Q3 text', options: [{ text: 'a3' }] },
    { questionText: 'Q4 text', options: [{ text: 'a4' }] },
    { questionText: 'Q5 text', options: [{ text: 'a5' }] }
  ];

  let service: QuizNavigationService;
  let router: { url: string; navigateByUrl: jest.Mock };
  let quizService: any;
  let timer: any;
  let loader: any;
  let verdicts: any;

  function setup(landOn: (requestedUrl: string) => string): void {
    router = {
      url: '/quiz/question/dependency-injection/1',
      navigateByUrl: jest.fn().mockImplementation(async (url: string) => {
        router.url = landOn(url);
        return true; // a guard redirect still resolves as a successful navigation
      })
    };
    quizService = stub({
      quizId: 'dependency-injection',
      questionCorrectness: new Map(),
      getCurrentQuestionIndex: jest.fn().mockReturnValue(0),
      getQuestionByIndex: jest.fn((i: number) => of(questions[i]))
    });
    timer = stub();
    loader = stub({ waitForDomStable: jest.fn().mockResolvedValue(undefined), quietZoneUntilSig: { set: jest.fn() }, questionToDisplaySig: { set: jest.fn() } });
    verdicts = stub();

    TestBed.configureTestingModule({
      providers: [
        QuizNavigationService,
        { provide: Router, useValue: router },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } } } },
        { provide: ExplanationTextService, useValue: stub({ _byIndex: null, _gate: null, formattedExplanationSig: { set: jest.fn() }, shouldDisplayExplanationSubject: null, isExplanationTextDisplayedSubject: null }) },
        { provide: NextButtonStateService, useValue: stub() },
        { provide: OptionLockStateService, useValue: stub() },
        { provide: QqcQuestionLoaderService, useValue: loader },
        { provide: QuestionVerdictService, useValue: verdicts },
        { provide: QuizDataService, useValue: stub() },
        { provide: QuizQuestionManagerService, useValue: stub() },
        { provide: TopicQuizTypeRegistry, useValue: stub() },
        { provide: QuizService, useValue: quizService },
        { provide: QuizStateService, useValue: stub() },
        { provide: SelectedOptionService, useValue: stub({ getSelectionHistoryTextsForQuestion: () => [], uiSelectedTextsForQuestion: () => null, getSelectedOptionsForQuestion: () => [] }) },
        { provide: TimerService, useValue: timer }
      ]
    });
    service = TestBed.inject(QuizNavigationService);
  }

  it('after a guard redirect from Q5 to Q2, commits Q2 (index, timer, fetch, emitted text), never Q5', async () => {
    setup(() => '/quiz/question/dependency-injection/2'); // asked for /5, guard sent the user to /2

    await service.navigateToQuestion(4);

    expect(router.navigateByUrl).toHaveBeenCalledWith('/quiz/question/dependency-injection/5');
    expect(quizService.getQuestionByIndex).toHaveBeenCalledTimes(1);
    expect(quizService.getQuestionByIndex).toHaveBeenCalledWith(1);
    expect(quizService.setCurrentQuestionIndex).toHaveBeenCalled();
    for (const call of quizService.setCurrentQuestionIndex.mock.calls) expect(call[0]).toBe(1);
    expect(timer.resetTimerFlagsFor).toHaveBeenCalledWith(1);
    expect(loader.emitQuestionTextSafely).toHaveBeenCalledWith('Q2 text', 1);
    expect(loader.emitQuestionTextSafely).not.toHaveBeenCalledWith('Q5 text', expect.anything());
  });

  it('a rejected jump creates no verdict record for the locked target (nothing that could later block Results)', async () => {
    setup(() => '/quiz/question/dependency-injection/2');

    await service.navigateToQuestion(4);

    // Navigation never dispatches or records an answer check; no verdict is created or failed for any question here.
    expect(verdicts.checkAnswer).not.toHaveBeenCalled();
    for (const [name, fn] of Object.entries(verdicts as Record<string, any>)) {
      if (/check|start|apply|submit|retry/i.test(name) && fn?.mock) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('keeps the normal case: when the router lands where it was asked, that index is committed', async () => {
    setup((url) => url);

    await service.navigateToQuestion(2);

    expect(quizService.getQuestionByIndex).toHaveBeenCalledWith(2);
    for (const call of quizService.setCurrentQuestionIndex.mock.calls) expect(call[0]).toBe(2);
    expect(loader.emitQuestionTextSafely).toHaveBeenCalledWith('Q3 text', 2);
  });

  it('keeps a backward revisit working (lands on the earlier question it asked for)', async () => {
    setup((url) => url);
    quizService.getCurrentQuestionIndex.mockReturnValue(3);

    await service.navigateToQuestion(0);

    expect(quizService.getQuestionByIndex).toHaveBeenCalledWith(0);
    expect(loader.emitQuestionTextSafely).toHaveBeenCalledWith('Q1 text', 0);
  });
});
