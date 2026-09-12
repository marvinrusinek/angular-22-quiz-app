import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, ReplaySubject, Subject } from 'rxjs';
import { ActivatedRoute, Router } from '@angular/router';

import { IntroductionComponent } from './introduction.component';
import { Quiz, QuizDifficulty } from '../../shared/models/Quiz.model';
import { QuizQuestion } from '../../shared/models/QuizQuestion.model';
import { QuizDotStatusService } from '../../shared/services/flow/quiz-dot-status.service';
import { TopicQuizMetadataService } from '../../shared/services/api/topic-quiz-metadata.service';
import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { QuizNavigationService } from '../../shared/services/flow/quiz-navigation.service';
import { QuizPersistenceService } from '../../shared/services/state/quiz-persistence.service';
import { QuizService } from '../../shared/services/data/quiz.service';
import { QuizShuffleService } from '../../shared/services/flow/quiz-shuffle.service';
import { SelectedOptionService } from '../../shared/services/state/selectedoption.service';
import { TimerService } from '../../shared/services/features/timer/timer.service';
import { QuizStartSpinnerService } from '../../shared/services/ui/quiz-start-spinner.service';

/**
 * Stage 14 regression A: after Introduction moved to API-backed metadata
 * (13123098 "remove introduction bank dependency"), the "Test your wits with
 * N questions" paragraph kept reading `quiz.questions?.length ?? 0` — but
 * `buildQuizFromMetadata()` never sets `questions` at all, so that expression
 * is unconditionally 0 regardless of the real, correctly-loaded count already
 * sitting in `questionCountSig()` (used correctly by the meta row above it).
 * No spec previously rendered this component's template, so the mismatch
 * between the two paragraphs went uncaught.
 */
describe('IntroductionComponent — API-backed question count (Stage 14 regression A)', () => {
  const questionCountMap = new Map<string, number | null>([['typescript', 10]]);
  const milestoneMap = new Map<string, string>([['typescript', 'TypeScript']]);
  const difficultyMap = new Map<string, string | null>([['typescript', 'beginner']]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();

  const makeMetadataApi = (): any => ({
    load: jest.fn(() => of([{ quizId: 'typescript' }])),
    questionCountByQuiz: signal(questionCountMap),
    milestoneByQuiz: signal(milestoneMap),
    difficultyByQuiz: signal(difficultyMap),
    imageByQuiz: signal(imageMap),
    factsByQuiz: signal(factsMap),
    milestoneFor: (id: string) => milestoneMap.get(id) ?? id,
    imageFor: (id: string) => imageMap.get(id) ?? '',
    factsFor: (id: string) => factsMap.get(id) ?? []
  });

  function configureTestBed(): void {
    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: {} },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        { provide: QuizDataService, useValue: { clearQuizQuestionCache: jest.fn() } },
        { provide: QuizNavigationService, useValue: {} },
        { provide: QuizPersistenceService, useValue: {} },
        {
          provide: QuizService,
          useValue: { clearStoredCorrectAnswersText: jest.fn(), setCheckedShuffle: jest.fn() }
        },
        { provide: QuizShuffleService, useValue: {} },
        { provide: SelectedOptionService, useValue: {} },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        { provide: QuizStartSpinnerService, useValue: {} },
        { provide: ActivatedRoute, useValue: { params: of({ quizId: 'typescript' }) } },
        { provide: Router, useValue: { navigate: jest.fn().mockResolvedValue(true) } }
      ]
    });
  }

  it('renders the REAL API question count in the "Test your wits" paragraph, not 0', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Test your wits with');
    expect(text).toMatch(/Test your wits with\s*10\s*timed multiple-choice/);
    expect(text).not.toMatch(/Test your wits with\s*0\s*timed multiple-choice/);
  });

  it('the meta row and the intro paragraph agree on the same count', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const component = fixture.componentInstance;
    expect(component.questionCountSig()).toBe(10);

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toMatch(/10\s*Questions/);
  });

  it('never reads quiz.questions?.length — buildQuizFromMetadata never sets it', () => {
    configureTestBed();
    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedQuiz()?.questions).toBeUndefined();
  });
});

/**
 * Stage 15 follow-up: Introduction used to gate its first paint on
 * `metadataApi.load()`'s HTTP round trip, so a cold `GET /api/quizzes` (e.g. a
 * cold Render backend) left the page on the template's `Loading…` branch for
 * however long that took — even though `TopicQuizMetadataService` already
 * seeds its public-metadata signals synchronously from `QUIZ_CATALOG_METADATA`,
 * the exact mechanism QuizSelection's tiles already rely on to paint instantly.
 * `load()` here is a controllable Subject that never emits on its own, so these
 * specs can assert what renders WHILE the request is still pending.
 */
describe('IntroductionComponent — instant first paint from seeded metadata (Stage 15 follow-up)', () => {
  const questionCountMap = new Map<string, number | null>([['typescript', 10]]);
  const milestoneMap = new Map<string, string>([['typescript', 'TypeScript']]);
  const difficultyMap = new Map<string, string | null>([['typescript', 'beginner']]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();

  function makeMetadataApi(loadSource: Subject<any[]>): any {
    return {
      load: jest.fn(() => loadSource.asObservable()),
      questionCountByQuiz: signal(questionCountMap),
      milestoneByQuiz: signal(milestoneMap),
      difficultyByQuiz: signal(difficultyMap),
      imageByQuiz: signal(imageMap),
      factsByQuiz: signal(factsMap),
      milestoneFor: (id: string) => milestoneMap.get(id) ?? id,
      imageFor: (id: string) => imageMap.get(id) ?? '',
      factsFor: (id: string) => factsMap.get(id) ?? []
    };
  }

  function configureTestBed(metadataApi: any, quizId: string): void {
    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: {} },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
        { provide: QuizDataService, useValue: { clearQuizQuestionCache: jest.fn() } },
        { provide: QuizNavigationService, useValue: {} },
        { provide: QuizPersistenceService, useValue: {} },
        {
          provide: QuizService,
          useValue: { clearStoredCorrectAnswersText: jest.fn(), setCheckedShuffle: jest.fn() }
        },
        { provide: QuizShuffleService, useValue: {} },
        { provide: SelectedOptionService, useValue: {} },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        { provide: QuizStartSpinnerService, useValue: {} },
        { provide: ActivatedRoute, useValue: { params: of({ quizId }) } },
        { provide: Router, useValue: { navigate: jest.fn().mockResolvedValue(true) } }
      ]
    });
  }

  it('renders the card immediately from seeded metadata, before /api/quizzes resolves', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'typescript');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    // `pending` has not emitted — the metadata request is still in flight.
    expect(fixture.componentInstance.selectedQuiz()?.quizId).toBe('typescript');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('TypeScript');
  });

  it('shows no request-status text for a known quiz while the metadata refresh is in flight', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'typescript');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    const loadingEl = (fixture.nativeElement as HTMLElement).querySelector('.loading-message');
    expect(loadingEl).toBeNull();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Loading');
  });

  it('the HTTP metadata refresh still lands and updates state once it resolves', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'typescript');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    pending.next([{ quizId: 'typescript', milestone: 'TypeScript', questionCount: 10 }]);
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedQuiz()?.quizId).toBe('typescript');
    expect(fixture.componentInstance.questionCountSig()).toBe(10);
  });

  it('an unknown quiz id absent from both the seed and the live response stays on Loading — no fabrication', () => {
    const pending = new Subject<any[]>();
    configureTestBed(makeMetadataApi(pending), 'not-a-real-quiz');

    const fixture = TestBed.createComponent(IntroductionComponent);
    fixture.detectChanges();

    // Not in the bundled seed, so no immediate paint.
    expect(fixture.componentInstance.selectedQuiz()).toBeNull();
    const beforeText = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(beforeText).toContain('Loading');

    // The live response arrives but still doesn't include it — still no
    // fabricated quiz; selectedQuiz stays null.
    pending.next([{ quizId: 'typescript', milestone: 'TypeScript', questionCount: 10 }]);
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedQuiz()).toBeNull();
  });
});

/**
 * Cold-start "Start the Quiz looks dead" regression coverage.
 *
 * Root cause (confirmed via a live browser reproduction against the real
 * production Spring service with an 11s-delayed response): the spinner
 * overlay used to hide itself on its OWN fixed 1600ms timer, independent of
 * whether onStartQuiz's real fetch (prepareAndSetCurrentQuiz) had actually
 * finished — so on a cold Render/Neon backend the overlay vanished ~1.6s in
 * while the real work kept running silently for several more seconds,
 * making a working click look broken.
 *
 * QuizStartSpinnerService now separates "minimum elapsed" (still 1600ms,
 * unchanged) from "hide requested" (an explicit hide() call) — the overlay
 * only disappears once BOTH are true. These specs drive the REAL service
 * (not a stub) so the two are exercised together, the way production does.
 */
describe('IntroductionComponent — Start Quiz spinner lifecycle (cold-start fix)', () => {
  let prepareQuizSession$: ReplaySubject<QuizQuestion[]>;
  let quizDataService: {
    clearQuizQuestionCache: jest.Mock;
    setSelectedQuiz: jest.Mock;
    setCurrentQuiz: jest.Mock;
    prepareQuizSession: jest.Mock;
  };
  let quizNavigationService: {
    resolveEffectiveQuizId: jest.Mock;
    ensureSessionQuestions: jest.Mock;
    tryResolveQuestion: jest.Mock;
    resetUIAndNavigate: jest.Mock;
  };
  let routerNavigate: jest.Mock;
  let spinner: QuizStartSpinnerService;
  let component: IntroductionComponent;
  let fixture: ReturnType<typeof TestBed.createComponent<IntroductionComponent>>;

  const ACTIVE_QUIZ: Quiz = {
    quizId: 'typescript',
    milestone: 'TypeScript',
    summary: '',
    image: '',
    difficulty: 'beginner' as QuizDifficulty,
    facts: []
  };

  // A real (non-empty) result — prepareAndSetCurrentQuiz treats an EMPTY
  // array as the failure signal (see its own doc comment), so every test
  // representing a genuine SUCCESS must resolve with at least one question.
  const FAKE_QUESTIONS = [{ questionText: 'Q1', options: [] }] as unknown as QuizQuestion[];

  function configureTestBed(): void {
    prepareQuizSession$ = new ReplaySubject<QuizQuestion[]>(1);
    quizDataService = {
      clearQuizQuestionCache: jest.fn(),
      setSelectedQuiz: jest.fn(),
      setCurrentQuiz: jest.fn(),
      prepareQuizSession: jest.fn(() => prepareQuizSession$.asObservable())
    };
    quizNavigationService = {
      resolveEffectiveQuizId: jest.fn((override?: string) => override ?? 'typescript'),
      ensureSessionQuestions: jest.fn().mockResolvedValue(undefined),
      tryResolveQuestion: jest.fn().mockResolvedValue(null),
      resetUIAndNavigate: jest.fn().mockResolvedValue(true)
    };
    routerNavigate = jest.fn().mockResolvedValue(true);

    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: { clearAllMaps: jest.fn() } },
        {
          provide: TopicQuizMetadataService,
          useValue: {
            load: jest.fn(() => of([])),
            questionCountByQuiz: signal(new Map()),
            milestoneByQuiz: signal(new Map()),
            difficultyByQuiz: signal(new Map()),
            imageByQuiz: signal(new Map()),
            factsByQuiz: signal(new Map()),
            milestoneFor: (id: string) => id,
            imageFor: () => '',
            factsFor: () => []
          }
        },
        { provide: QuizDataService, useValue: quizDataService },
        { provide: QuizNavigationService, useValue: quizNavigationService },
        {
          provide: QuizPersistenceService,
          useValue: {
            clearClickConfirmedDotStatus: jest.fn(),
            clearAllPersistedDotStatus: jest.fn(),
            clearAllForFreshStart: jest.fn()
          }
        },
        {
          provide: QuizService,
          useValue: {
            clearStoredCorrectAnswersText: jest.fn(),
            setCheckedShuffle: jest.fn(),
            resetQuizSessionState: jest.fn(),
            startNewAttempt: jest.fn(),
            resetScore: jest.fn(),
            questionCorrectness: { clear: jest.fn() },
            selectedOptionsMap: { clear: jest.fn() },
            userAnswers: [],
            answers: [],
            setSelectedQuiz: jest.fn(),
            setActiveQuiz: jest.fn(),
            setQuizId: jest.fn(),
            setCurrentQuestionIndex: jest.fn()
          }
        },
        { provide: QuizShuffleService, useValue: { clear: jest.fn() } },
        {
          provide: SelectedOptionService,
          useValue: {
            clearAllSelectionsForQuiz: jest.fn(),
            clearRefreshBackup: jest.fn(),
            clickConfirmedDotStatus: { clear: jest.fn() },
            lastClickedCorrectByQuestion: { clear: jest.fn() }
          }
        },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        // The REAL service — this suite exists specifically to prove ITS
        // behavior, unlike the describe blocks above which stub it out.
        QuizStartSpinnerService,
        { provide: ActivatedRoute, useValue: { params: of({ quizId: 'typescript' }) } },
        { provide: Router, useValue: { navigate: routerNavigate } }
      ]
    });

    fixture = TestBed.createComponent(IntroductionComponent);
    component = fixture.componentInstance;
    spinner = TestBed.inject(QuizStartSpinnerService);
    // AFTER detectChanges(): ngOnInit's own route-params pipeline resolves
    // against the (empty) metadata mock and would otherwise overwrite this
    // right back to null via handleLoadedQuiz(null).
    fixture.detectChanges();
    component.selectedQuiz.set(ACTIVE_QUIZ); // resolveActiveQuiz short-circuits to this
  }

  beforeEach(() => {
    jest.useFakeTimers();
    configureTestBed();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('warm response (finishes well before 1600ms): spinner remains visible for the minimum, then hides', async () => {
    const started = component.onStartQuiz('typescript');

    // Resolve the "fetch" almost immediately — far under the 1600ms floor.
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await Promise.resolve();
    await Promise.resolve();

    expect(spinner.visible()).toBe(true); // minimum not yet elapsed

    await jest.advanceTimersByTimeAsync(1600);
    await started;

    expect(spinner.visible()).toBe(false);
    expect(routerNavigate).not.toHaveBeenCalled(); // resetUIAndNavigate succeeded, no fallback needed
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1);
  });

  it('cold response (exceeds 1600ms): spinner remains visible until the response AND navigation complete — no dead gap', async () => {
    const started = component.onStartQuiz('typescript');

    // Let the minimum elapse WHILE the "fetch" is still pending.
    await jest.advanceTimersByTimeAsync(1600);
    expect(spinner.visible()).toBe(true); // must still be up — this is the fixed bug

    // Now the cold backend finally answers.
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await started;

    expect(spinner.visible()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1);
  });

  it('request failure (thrown error): spinner clears, Retry is shown, and navigation is NOT attempted (no duplicate fetch)', async () => {
    const started = component.onStartQuiz('typescript');

    prepareQuizSession$.error(new Error('cold backend timed out'));
    await jest.advanceTimersByTimeAsync(1600);
    await started;

    expect(spinner.visible()).toBe(false);
    // prepareAndSetCurrentQuiz's own catch falls back to the already-known
    // quiz for display purposes, but reports failure so onStartQuiz stops
    // here — it must NOT proceed to navigateToFirstQuestion, which is what
    // used to silently re-issue a second real fetch via ensureSessionQuestions.
    expect(quizDataService.setCurrentQuiz).toHaveBeenCalledWith(ACTIVE_QUIZ);
    expect(quizNavigationService.resetUIAndNavigate).not.toHaveBeenCalled();
    expect(quizNavigationService.ensureSessionQuestions).not.toHaveBeenCalled();
    expect(component.startFailed()).toBe(true);
    expect(component.isStartingQuiz()).toBe(false);
  });

  it('request "succeeds" with an empty question array (the same failure signal QuizDataService.prepareQuizSession resolves to on a caught fetch error): treated identically to a thrown error', async () => {
    const started = component.onStartQuiz('typescript');

    prepareQuizSession$.next([]); // empty, not an error — matches prepareQuizSession's own catchError(() => of([]))
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await started;

    expect(spinner.visible()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).not.toHaveBeenCalled();
    expect(component.startFailed()).toBe(true);
  });

  it('a Retry click after a failure clears the failed state and completes normally on success', async () => {
    const started = component.onStartQuiz('typescript');
    prepareQuizSession$.error(new Error('cold backend timed out'));
    await jest.advanceTimersByTimeAsync(1600);
    await started;
    expect(component.startFailed()).toBe(true);
    expect(quizNavigationService.resetUIAndNavigate).not.toHaveBeenCalled();

    // Retry: same button, same handler ("Retry" calls onStartQuiz() exactly
    // like "Start the Quiz!" does), a fresh Subject standing in for the
    // backend now actually responding.
    prepareQuizSession$ = new ReplaySubject<QuizQuestion[]>(1);
    quizDataService.prepareQuizSession.mockImplementation(() => prepareQuizSession$.asObservable());

    const retried = component.onStartQuiz('typescript');
    expect(component.startFailed()).toBe(false); // cleared immediately on the new attempt

    prepareQuizSession$.next(FAKE_QUESTIONS); // this time the backend genuinely answers
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await retried;

    expect(component.startFailed()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1); // the retry completed the start
  });

  it('navigation failure/cancellation: spinner still clears', async () => {
    quizNavigationService.resetUIAndNavigate.mockResolvedValue(false);
    routerNavigate.mockResolvedValue(false);

    const started = component.onStartQuiz('typescript');
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await started;

    expect(spinner.visible()).toBe(false);
    expect(routerNavigate).toHaveBeenCalledTimes(1); // the fallback path ran
  });

  it('repeated clicks while pending create only one request and one navigation', async () => {
    const first = component.onStartQuiz('typescript');
    const second = component.onStartQuiz('typescript'); // no-op: isStartingQuiz() guard

    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await Promise.all([first, second]);

    expect(quizDataService.prepareQuizSession).toHaveBeenCalledTimes(1);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1);
  });

  it('component destruction while a request is still pending does not leave the GLOBAL overlay stuck', () => {
    void component.onStartQuiz('typescript'); // prepareQuizSession$ never resolves in this test

    expect(spinner.visible()).toBe(true);

    fixture.destroy(); // triggers this component's DestroyRef.onDestroy

    expect(spinner.visible()).toBe(false);
  });
});

/**
 * Bounded 45s client-side timeout on the Start-Quiz question-loading
 * operation. A hung `/questions` request (observed directly against the real
 * production Spring/Render backend for 2+ minutes) previously left the
 * spinner and the isStartingQuiz() guard stuck forever — no error, no
 * Retry, nothing the user could act on. `prepareAndSetCurrentQuiz` now pipes
 * `prepareQuizSession(...)` through `timeout(45_000)` and returns a distinct
 * 'timeout' outcome so the UI can show "server is still waking up" instead
 * of the generic unreachable-service message.
 *
 * Per explicit product clarification, Retry does NOT always have to issue a
 * fresh HTTP request: TopicQuizQuestionsService's cache multicasts via
 * `shareReplay({ refCount: false })`, so if the real request is STILL in
 * flight when the user retries, Retry should safely reuse it; only once the
 * request has actually failed (and the cache entry evicted) should Retry
 * create a new one. These specs model that distinction at the
 * QuizDataService.prepareQuizSession boundary: reusing the SAME mock source
 * across the retry represents "still in flight, reused"; swapping in a NEW
 * mock source after erroring the old one represents "failed, evicted, fresh
 * request".
 */
describe('IntroductionComponent — bounded 45s Start Quiz timeout', () => {
  let prepareQuizSession$: ReplaySubject<QuizQuestion[]>;
  let quizDataService: {
    clearQuizQuestionCache: jest.Mock;
    setSelectedQuiz: jest.Mock;
    setCurrentQuiz: jest.Mock;
    prepareQuizSession: jest.Mock;
  };
  let quizNavigationService: {
    resolveEffectiveQuizId: jest.Mock;
    ensureSessionQuestions: jest.Mock;
    tryResolveQuestion: jest.Mock;
    resetUIAndNavigate: jest.Mock;
  };
  let routerNavigate: jest.Mock;
  let spinner: QuizStartSpinnerService;
  let component: IntroductionComponent;
  let fixture: ReturnType<typeof TestBed.createComponent<IntroductionComponent>>;

  const ACTIVE_QUIZ: Quiz = {
    quizId: 'typescript',
    milestone: 'TypeScript',
    summary: '',
    image: '',
    difficulty: 'beginner' as QuizDifficulty,
    facts: []
  };

  const FAKE_QUESTIONS = [{ questionText: 'Q1', options: [] }] as unknown as QuizQuestion[];

  function configureTestBed(): void {
    prepareQuizSession$ = new ReplaySubject<QuizQuestion[]>(1);
    quizDataService = {
      clearQuizQuestionCache: jest.fn(),
      setSelectedQuiz: jest.fn(),
      setCurrentQuiz: jest.fn(),
      prepareQuizSession: jest.fn(() => prepareQuizSession$.asObservable())
    };
    quizNavigationService = {
      resolveEffectiveQuizId: jest.fn((override?: string) => override ?? 'typescript'),
      ensureSessionQuestions: jest.fn().mockResolvedValue(undefined),
      tryResolveQuestion: jest.fn().mockResolvedValue(null),
      resetUIAndNavigate: jest.fn().mockResolvedValue(true)
    };
    routerNavigate = jest.fn().mockResolvedValue(true);

    TestBed.configureTestingModule({
      imports: [IntroductionComponent],
      providers: [
        { provide: QuizDotStatusService, useValue: { clearAllMaps: jest.fn() } },
        {
          provide: TopicQuizMetadataService,
          useValue: {
            load: jest.fn(() => of([])),
            questionCountByQuiz: signal(new Map()),
            milestoneByQuiz: signal(new Map()),
            difficultyByQuiz: signal(new Map()),
            imageByQuiz: signal(new Map()),
            factsByQuiz: signal(new Map()),
            milestoneFor: (id: string) => id,
            imageFor: () => '',
            factsFor: () => []
          }
        },
        { provide: QuizDataService, useValue: quizDataService },
        { provide: QuizNavigationService, useValue: quizNavigationService },
        {
          provide: QuizPersistenceService,
          useValue: {
            clearClickConfirmedDotStatus: jest.fn(),
            clearAllPersistedDotStatus: jest.fn(),
            clearAllForFreshStart: jest.fn()
          }
        },
        {
          provide: QuizService,
          useValue: {
            clearStoredCorrectAnswersText: jest.fn(),
            setCheckedShuffle: jest.fn(),
            resetQuizSessionState: jest.fn(),
            startNewAttempt: jest.fn(),
            resetScore: jest.fn(),
            questionCorrectness: { clear: jest.fn() },
            selectedOptionsMap: { clear: jest.fn() },
            userAnswers: [],
            answers: [],
            setSelectedQuiz: jest.fn(),
            setActiveQuiz: jest.fn(),
            setQuizId: jest.fn(),
            setCurrentQuestionIndex: jest.fn()
          }
        },
        { provide: QuizShuffleService, useValue: { clear: jest.fn() } },
        {
          provide: SelectedOptionService,
          useValue: {
            clearAllSelectionsForQuiz: jest.fn(),
            clearRefreshBackup: jest.fn(),
            clickConfirmedDotStatus: { clear: jest.fn() },
            lastClickedCorrectByQuestion: { clear: jest.fn() }
          }
        },
        { provide: TimerService, useValue: { timePerQuestion: 30 } },
        QuizStartSpinnerService,
        { provide: ActivatedRoute, useValue: { params: of({ quizId: 'typescript' }) } },
        { provide: Router, useValue: { navigate: routerNavigate } }
      ]
    });

    fixture = TestBed.createComponent(IntroductionComponent);
    component = fixture.componentInstance;
    spinner = TestBed.inject(QuizStartSpinnerService);
    fixture.detectChanges();
    component.selectedQuiz.set(ACTIVE_QUIZ);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    configureTestBed();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('success just under the 45s boundary still completes normally — the timeout never fires', async () => {
    const started = component.onStartQuiz('typescript');

    await jest.advanceTimersByTimeAsync(44_000);
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600); // let the (already-elapsed) spinner minimum settle
    await started;

    expect(component.startFailed()).toBe(false);
    expect(component.startTimedOut()).toBe(false);
    expect(spinner.visible()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1);
  });

  it('a request that never responds within 45s hits the bounded timeout: Retry is shown with the "still waking up" state, not the generic error', async () => {
    const started = component.onStartQuiz('typescript');

    await jest.advanceTimersByTimeAsync(45_000);
    await started;

    expect(component.startFailed()).toBe(true);
    expect(component.startTimedOut()).toBe(true);
    expect(spinner.visible()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).not.toHaveBeenCalled();
    expect(quizNavigationService.ensureSessionQuestions).not.toHaveBeenCalled();
  });

  it('a late response arriving on the original source AFTER the 45s timeout already fired is ignored', async () => {
    const started = component.onStartQuiz('typescript');

    await jest.advanceTimersByTimeAsync(45_000);
    await started;
    expect(component.startFailed()).toBe(true);
    expect(component.startTimedOut()).toBe(true);

    // The real backend eventually answers anyway, on the SAME (already
    // timed-out, from this component's perspective) source.
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);

    expect(component.startFailed()).toBe(true); // unchanged — the outcome already settled
    expect(component.startTimedOut()).toBe(true);
    expect(spinner.visible()).toBe(false); // did not reopen
    expect(quizNavigationService.resetUIAndNavigate).not.toHaveBeenCalled();
  });

  it('Retry after a timeout, while the original request is STILL in flight, safely reuses it instead of racing a second concurrent request', async () => {
    const started = component.onStartQuiz('typescript');
    await jest.advanceTimersByTimeAsync(45_000);
    await started;
    expect(component.startTimedOut()).toBe(true);

    // Retry — the cache entry was never evicted (the real request never
    // failed; only this component's own bounded wait gave up), so
    // QuizDataService/TopicQuizQuestionsService's shareReplay({refCount:false})
    // would hand back the SAME still-in-flight source. Modeled here by NOT
    // changing quizDataService.prepareQuizSession's implementation.
    const retried = component.onStartQuiz('typescript');
    expect(component.startFailed()).toBe(false); // cleared immediately on retry

    // The one real, still-in-flight request finally answers.
    prepareQuizSession$.next(FAKE_QUESTIONS);
    prepareQuizSession$.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await retried;

    expect(component.startFailed()).toBe(false);
    expect(component.startTimedOut()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1); // exactly one successful start
    expect(quizDataService.prepareQuizSession).toHaveBeenCalledTimes(2); // one call per attempt — same underlying source both times
  });

  it('Retry after a timeout, once the original request has since FAILED and its cache entry was evicted, issues exactly one fresh request', async () => {
    const started = component.onStartQuiz('typescript');
    await jest.advanceTimersByTimeAsync(45_000);
    await started;
    expect(component.startTimedOut()).toBe(true);

    // The original request eventually fails for real; TopicQuizQuestionsService's
    // own catchError deletes the cache entry (see its doc comment) — modeled
    // here by erroring the original source.
    prepareQuizSession$.error(new Error('cold backend eventually failed'));

    // Retry — a fresh cache entry means a fresh Observable this time.
    const freshSource = new ReplaySubject<QuizQuestion[]>(1);
    quizDataService.prepareQuizSession.mockImplementation(() => freshSource.asObservable());

    const retried = component.onStartQuiz('typescript');
    expect(component.startFailed()).toBe(false);

    freshSource.next(FAKE_QUESTIONS);
    freshSource.complete();
    await jest.advanceTimersByTimeAsync(1600);
    await retried;

    expect(component.startFailed()).toBe(false);
    expect(component.startTimedOut()).toBe(false);
    expect(quizNavigationService.resetUIAndNavigate).toHaveBeenCalledTimes(1);
    expect(quizDataService.prepareQuizSession).toHaveBeenCalledTimes(2); // exactly one fresh call on retry
  });

  it('duplicate clicks while the 45s timeout is still pending create only one request', async () => {
    const first = component.onStartQuiz('typescript');
    const second = component.onStartQuiz('typescript'); // no-op: isStartingQuiz() guard

    await jest.advanceTimersByTimeAsync(45_000);
    await Promise.all([first, second]);

    expect(quizDataService.prepareQuizSession).toHaveBeenCalledTimes(1);
    expect(component.startTimedOut()).toBe(true);
  });

  it('destruction while the 45s timeout is still pending clears the spinner immediately; the timeout later firing is a harmless no-op', async () => {
    void component.onStartQuiz('typescript');
    expect(spinner.visible()).toBe(true);

    fixture.destroy();
    expect(spinner.visible()).toBe(false);

    // Let the bounded timeout actually fire after destruction — must not
    // throw or surface as an unhandled rejection.
    await jest.advanceTimersByTimeAsync(45_000);
  });
});
