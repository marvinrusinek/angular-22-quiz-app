import { TestBed } from '@angular/core/testing';
import { NEVER, of } from 'rxjs';

import { QclQuestionFetchService } from './qcl-question-fetch.service';
import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { QqcQuestionLoaderService } from '../features/qqc/qqc-question-loader.service';
import { QuizDataService } from '../data/quizdata.service';
import { QuizDotStatusService } from './quiz-dot-status.service';
import { QuizQuestionDataService } from './quiz-question-data.service';
import { QuizService } from '../data/quiz.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { SelectionMessageService } from '../features/selection-message/selection-message.service';

/**
 * S6n regression coverage for loadQuestionFromRouteChange().
 *
 * ROOT CAUSE this guards against: the method used to resolve its question
 * collection via `await firstValueFrom(quizDataService.getQuiz(quizId)...)`,
 * an observable sourced from QuizDataService's `quizzes$` — populated ONLY by
 * ensureQuizzesLoaded()/loadQuizzes() (the full client-bank preload). Once a
 * caller (Introduction, migrated to API metadata) stops calling those, that
 * observable never emits, so every Next-navigation's `await` on it hung
 * forever — proven live via instrumented Playwright traces: the resolved
 * branch never printed for any of 3 consecutive navigations in a real quiz
 * run. The fix resolves same-quiz navigation entirely from QuizService's
 * own, already-populated (API-sourced) `questions` field, never touching
 * `getQuiz()`/`quizzes$` at all for the common case.
 */
describe('QclQuestionFetchService — loadQuestionFromRouteChange (S6n)', () => {
  let service: QclQuestionFetchService;
  let quizDataService: any;
  let quizService: any;
  let quizQuestionLoaderService: any;

  const realQuestions = [
    { questionText: 'Q1 text', options: [{ optionId: 101, text: 'Q1-A' }] },
    { questionText: 'Q2 text', options: [{ optionId: 201, text: 'Q2-A' }] },
    { questionText: 'Q3 text', options: [{ optionId: 301, text: 'Q3-A' }] }
  ];

  beforeEach(() => {
    quizDataService = {
      // A hung observable — this must NEVER be subscribed to for a same-quiz
      // navigation. If it were, `await firstValueFrom(NEVER)` would hang the
      // test past its timeout, failing red exactly like the live defect did.
      getQuiz: jest.fn(() => NEVER),
      prepareQuizSession: jest.fn(() => of([...realQuestions]))
    };

    quizService = {
      quizId: 'dependency-injection',
      questions: [...realQuestions],
      shuffledQuestions: [],
      isShuffleEnabled: () => false,
      getCurrentQuizId: () => 'dependency-injection',
      updateCurrentQuestion: jest.fn()
    };

    quizQuestionLoaderService = {
      activeQuizId: '',
      totalQuestions: 0,
      loadQuestionAndOptions: jest.fn().mockResolvedValue(true),
      loadQA: jest.fn().mockResolvedValue(true),
      resetHeadlineStreams: jest.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        QclQuestionFetchService,
        { provide: QuizDotStatusService, useValue: {} },
        { provide: ExplanationTextService, useValue: {} },
        { provide: QuizDataService, useValue: quizDataService },
        { provide: QuizQuestionDataService, useValue: {} },
        { provide: QqcQuestionLoaderService, useValue: quizQuestionLoaderService },
        { provide: QuizService, useValue: quizService },
        { provide: QuizStateService, useValue: {} },
        { provide: SelectedOptionService, useValue: { getSelectedOptionsForQuestion: () => [] } },
        { provide: SelectionMessageService, useValue: {} }
      ]
    });
    service = TestBed.inject(QclQuestionFetchService);
  });

  it('resolves Q2 content without ever calling the client-bank-backed getQuiz() when the quiz is already active', async () => {
    const result = await service.loadQuestionFromRouteChange({
      quizId: 'dependency-injection',
      index: 1
    });

    expect(quizDataService.getQuiz).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.question?.questionText).toBe('Q2 text');
    expect(result.options).toEqual(realQuestions[1].options);
  });

  it('does not hang: resolves within the test timeout even with an unpopulated client-bank observable', async () => {
    // The regression itself: prior to the fix, this awaited getQuiz(quizId)
    // (mocked here as NEVER, matching the real unpopulated-quizzes$ state)
    // and would never resolve. jest's default timeout would fail this test
    // red without the fix.
    await expect(
      service.loadQuestionFromRouteChange({ quizId: 'dependency-injection', index: 2 })
    ).resolves.toEqual(
      expect.objectContaining({ success: true, question: expect.objectContaining({ questionText: 'Q3 text' }) })
    );
  });

  it('falls back to the safe, API-backed prepareQuizSession (never getQuiz) on a genuine quiz switch', async () => {
    quizService.quizId = 'other-quiz';
    quizService.getCurrentQuizId = () => 'other-quiz';
    quizService.questions = [];

    const result = await service.loadQuestionFromRouteChange({
      quizId: 'dependency-injection',
      index: 0
    });

    expect(quizDataService.getQuiz).not.toHaveBeenCalled();
    expect(quizDataService.prepareQuizSession).toHaveBeenCalledWith('dependency-injection');
    expect(result.success).toBe(true);
    expect(result.question?.questionText).toBe('Q1 text');
  });

  it('returns the empty result (not a throw/hang) when neither in-session questions nor the API fetch produce anything', async () => {
    quizService.quizId = 'other-quiz';
    quizService.getCurrentQuizId = () => 'other-quiz';
    quizService.questions = [];
    quizDataService.prepareQuizSession = jest.fn(() => of([]));

    const result = await service.loadQuestionFromRouteChange({
      quizId: 'dependency-injection',
      index: 0
    });

    expect(result).toEqual({
      success: false,
      question: null,
      options: [],
      explanation: '',
      totalQuestions: 0,
      hasValidSelections: false
    });
  });
});
