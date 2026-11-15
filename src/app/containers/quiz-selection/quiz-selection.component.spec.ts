import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WeakAreasService } from '@shared/services/progress/weak-areas.service';
import { TopicPerformanceHistoryService } from '@shared/services/progress/topic-performance-history.service';
import { PracticeSessionService } from '@shared/services/features/practice/practice-session.service';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { provideRouter, Router } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { API_BASE_URL, INTERVIEW_API_BASE_URL } from '@shared/tokens/api-base-url.token';

import { QuizSelectionComponent } from './quiz-selection.component';
import { QuizService } from '@shared/services/data/quiz.service';
import { AchievementService } from '@shared/services/achievements/achievement.service';
import { ProgressService } from '@shared/services/progress/progress.service';
import { BestScoreService } from '@shared/services/progress/best-score.service';
import { LearningPathService } from '@shared/services/features/learning-path/learning-path.service';
import { DifficultyRecommendationService } from '@shared/services/features/learning-path/difficulty-recommendation.service';
import { SessionEngagementService } from '@shared/services/state/session-engagement.service';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { InterviewWarmupCoordinatorService } from '@shared/services/interview/interview-warmup-coordinator.service';
import { QuizStatus } from '@shared/models';

/**
 * S6o bank-absence regression coverage for QuizSelectionComponent.
 *
 * ROOT DEFECT this guards against: the catalog previously came from
 * `QuizDataService.quizzesSig`, populated only by `loadQuizzes()` — a full
 * fetch of the answer-bearing `quiz.json`. This spec never touches
 * QuizDataService/`quizzesSig`/`loadQuizzes()` at all — only
 * TopicQuizMetadataService (mocked as real API metadata would arrive) plus
 * sessionStorage, proving the catalog, search, sort, question counts, and
 * status all work with the client bank completely absent.
 */
describe('QuizSelectionComponent — bank-absence catalog (S6o)', () => {
  let router: { navigate: jest.Mock };

  const difficultyMap = new Map<string, string | null>([
    ['create-first-app', 'beginner'],
    ['dependency-injection', 'intermediate'],
    ['performance', 'advanced']
  ]);
  const milestoneMap = new Map<string, string>([
    ['create-first-app', 'Create Your First App'],
    ['dependency-injection', 'Dependency Injection'],
    ['performance', 'Performance']
  ]);
  const summaryMap = new Map<string, string>([
    ['create-first-app', 'Get started with Angular.'],
    ['dependency-injection', 'Learn DI.'],
    ['performance', 'Optimize your app.']
  ]);
  const questionCountMap = new Map<string, number | null>([
    ['create-first-app', 5],
    ['dependency-injection', 7],
    ['performance', 9]
  ]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();

  const makeMetadataApi = (): any => ({
    load: jest.fn(() =>
      of([
        { quizId: 'create-first-app' },
        { quizId: 'dependency-injection' },
        { quizId: 'performance' }
      ])
    ),
    difficultyByQuiz: signal(difficultyMap),
    milestoneByQuiz: signal(milestoneMap),
    summaryByQuiz: signal(summaryMap),
    imageByQuiz: signal(imageMap),
    factsByQuiz: signal(factsMap),
    questionCountByQuiz: signal(questionCountMap),
    imageFor: (id: string) => imageMap.get(id) ?? '',
    factsFor: (id: string) => factsMap.get(id) ?? []
  });

  function configureTestBed(): void {
    router = { navigate: jest.fn().mockResolvedValue(true) };

    TestBed.configureTestingModule({
      providers: [
        QuizSelectionComponent,
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: {
            evaluate: jest.fn(() => []),
            summary: () => ({ earned: 0, total: 6 }),
            earnedIds: () => new Set()
          }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        {
          provide: LearningPathService,
          useValue: {
            recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 }))
          }
        },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        {
          provide: SessionEngagementService,
          useValue: { engaged: () => false, markEngaged: jest.fn() }
        },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        {
          provide: InterviewWarmupCoordinatorService,
          useValue: { warmUp: jest.fn(() => of(undefined)) }
        },
        { provide: Router, useValue: router }
      ]
    });
  }

  // Clears storage, configures TestBed, THEN instantiates — so a test can
  // seed sessionStorage/localStorage after this and before ngOnInit() runs.
  function setup(): QuizSelectionComponent {
    sessionStorage.clear();
    localStorage.clear();
    configureTestBed();
    return TestBed.inject(QuizSelectionComponent);
  }

  it('renders the full catalog from metadata alone — no QuizDataService/quizzesSig ever touched', () => {
    const comp = setup();
    comp.ngOnInit();

    const list = comp.quizzes();
    expect(list.length).toBe(3);
    const byId = new Map(list.map((q) => [q.quizId, q]));
    expect(byId.get('dependency-injection')?.milestone).toBe('Dependency Injection');
    expect(byId.get('dependency-injection')?.summary).toBe('Learn DI.');
    expect(byId.get('dependency-injection')?.difficulty).toBe('intermediate');
  });

  it('derives question counts from metadata questionCount, not .questions.length', () => {
    const comp = setup();
    comp.ngOnInit();

    expect(comp.quizStats().questionCount).toBe(5 + 7 + 9);
    expect(comp.quizStats().quizCount).toBe(3);
  });

  it('search matches by milestone word-start, case-insensitively', () => {
    const comp = setup();
    comp.ngOnInit();

    comp.searchTerm.set('dep');
    expect(comp.displayedQuizzes().map((q) => q.quizId)).toEqual(['dependency-injection']);

    comp.searchTerm.set('');
    expect(comp.displayedQuizzes().length).toBe(3);

    comp.searchTerm.set('nonexistent-topic');
    expect(comp.displayedQuizzes().length).toBe(0);
  });

  it('sorts by difficulty rank then alphabetically within each group', () => {
    const comp = setup();
    comp.ngOnInit();

    comp.sortDifficulty.set('asc');
    comp.sortAlpha.set('az');
    expect(comp.displayedQuizzes().map((q) => q.quizId)).toEqual([
      'create-first-app',
      'dependency-injection',
      'performance'
    ]);

    comp.sortDifficulty.set('desc');
    expect(comp.displayedQuizzes().map((q) => q.quizId)).toEqual([
      'performance',
      'dependency-injection',
      'create-first-app'
    ]);
  });

  it('reads completed/started status from sessionStorage alone, never a bank Quiz.status', () => {
    const comp = setup();
    sessionStorage.setItem('completedQuizIds', JSON.stringify(['create-first-app']));
    sessionStorage.setItem('startedQuizIds', JSON.stringify(['dependency-injection']));
    comp.ngOnInit();

    const byId = new Map(comp.quizzes().map((q) => [q.quizId, q]));
    expect(byId.get('create-first-app')?.status).toBe(QuizStatus.COMPLETED);
    expect(byId.get('dependency-injection')?.status).toBe(QuizStatus.STARTED);
    expect(byId.get('performance')?.status).toBeUndefined();

    expect(comp.isCompleted(byId.get('create-first-app'))).toBe(true);
    expect(comp.isCompleted(byId.get('dependency-injection'))).toBe(false);
  });

  it('onSelect marks a not-started quiz STARTED (sessionStorage-derived, no bank write) and navigates to Introduction', async () => {
    const comp = setup();
    comp.ngOnInit();

    await comp.onSelect('performance', 0);

    expect(router.navigate).toHaveBeenCalledWith(['intro/', 'performance']);
    const started = JSON.parse(sessionStorage.getItem('startedQuizIds') ?? '[]');
    expect(started).toContain('performance');
  });

  it('onSelect routes a completed quiz to Results instead of Introduction', async () => {
    const comp = setup();
    sessionStorage.setItem('completedQuizIds', JSON.stringify(['create-first-app']));
    comp.ngOnInit();

    await comp.onSelect('create-first-app', 0);

    expect(router.navigate).toHaveBeenCalledWith(['results/', 'create-first-app']);
  });
});

/**
 * Your Progress visibility gate — `showSelectionProgress`.
 *
 * ROOT DEFECT this guards against: a Custom or preset Interview completed
 * WITHOUT ever touching a Topic Quiz tile left "Your Progress" (and the
 * Performance Insights section inside it) hidden, despite the attempt already
 * being durably recorded in `interviewAttemptHistory:v2` and ready to display.
 * The Interview Mode entry point on this page (the promo card's "Start
 * Building") is plain navigation and deliberately never calls
 * `sessionEngagement.markEngaged()` or touches Topic-Quiz sessionStorage, so
 * the pre-fix gate — `engaged() || hasAccessedQuizzes() ||
 * achievementsEarned() > 0` — had no path to becoming true from Interview
 * activity alone.
 *
 * The fix adds one more OR clause reading the EXISTING, already-reactive
 * `InterviewHistoryService.history()` signal — no new storage key, no
 * duplicated state, no synchronization mechanism. These tests use the REAL
 * `InterviewHistoryService` (root-provided, localStorage-backed, no HTTP
 * dependency) rather than a stub, so "persisted" here means genuinely
 * persisted through the same store Performance Insights reads.
 */
describe('QuizSelectionComponent — Your Progress visibility gate', () => {
  let router: { navigate: jest.Mock };

  const makeMetadataApi = (): any => ({
    load: jest.fn(() => of([{ quizId: 'create-first-app' }])),
    difficultyByQuiz: signal(new Map([['create-first-app', 'beginner']])),
    milestoneByQuiz: signal(new Map([['create-first-app', 'Create Your First App']])),
    summaryByQuiz: signal(new Map([['create-first-app', 'Get started with Angular.']])),
    imageByQuiz: signal(new Map()),
    factsByQuiz: signal(new Map()),
    questionCountByQuiz: signal(new Map([['create-first-app', 5]])),
    imageFor: () => '',
    factsFor: () => []
  });

  /** `engaged`/`achievementsEarned` are the ONLY two OR clauses stubbed per test; the
   *  rest of the gate — hasAccessedQuizzes() (sessionStorage) and the new Interview
   *  clause (the REAL, unstubbed InterviewHistoryService) — is driven by real storage. */
  function configureTestBed(opts: { engaged?: boolean; earnedAchievements?: number } = {}): void {
    router = { navigate: jest.fn().mockResolvedValue(true) };
    // Reset first so setup() may be called more than once per test — needed
    // for the "reinitialization" case, which deliberately builds a second,
    // independent component/service graph to prove the Interview record
    // (not any in-memory state) is what keeps the gate open.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        QuizSelectionComponent,
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: {
            evaluate: jest.fn(() => []),
            summary: () => ({ earned: opts.earnedAchievements ?? 0, total: 6 }),
            earnedIds: () => new Set()
          }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        {
          provide: LearningPathService,
          useValue: {
            recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 }))
          }
        },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        {
          provide: SessionEngagementService,
          useValue: { engaged: () => opts.engaged ?? false, markEngaged: jest.fn() }
        },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        {
          provide: InterviewWarmupCoordinatorService,
          useValue: { warmUp: jest.fn(() => of(undefined)) }
        },
        { provide: Router, useValue: router }
        // InterviewHistoryService: intentionally NOT stubbed — the real,
        // root-provided, localStorage-backed service is used, so a seeded
        // `interviewAttemptHistory:v2` is read exactly as production does.
      ]
    });
  }

  // Clears storage, configures TestBed, THEN instantiates — mirrors the
  // bank-absence block's setup() so a test can seed localStorage beforehand.
  function setup(opts?: {
    engaged?: boolean;
    earnedAchievements?: number;
  }): QuizSelectionComponent {
    configureTestBed(opts);
    const comp = TestBed.inject(QuizSelectionComponent);
    comp.ngOnInit();
    return comp;
  }

  /** A minimal, valid interviewAttemptHistory:v2 store `validateAttemptEntry` accepts. */
  function seedInterviewHistory(over: Record<string, unknown> = {}): void {
    localStorage.setItem(
      'interviewAttemptHistory:v2',
      JSON.stringify({
        version: 2,
        attempts: [
          {
            id: 'att_1',
            completedAt: '2026-08-01T10:00:00.000Z',
            score: 7,
            totalQuestions: 10,
            percentage: 70,
            completionReason: 'submitted',
            ...over
          }
        ]
      })
    );
  }

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  describe('Weak Areas card handler (guarded route)', () => {
    type Wire = {
      weak?: boolean;
      attempts?: number;
      insufficient?: boolean;
      start?: () => Promise<boolean>;
    };
    const wire = (o: Wire = {}) => {
      const comp = setup();
      const wa = TestBed.inject(WeakAreasService);
      jest.spyOn(wa, 'hasWeakTopics').mockReturnValue(o.weak ?? false);
      jest
        .spyOn(wa, 'mergedAttempts')
        .mockReturnValue(new Array(o.attempts ?? 0).fill({}) as never);
      jest.spyOn(wa, 'hasInsufficientData').mockReturnValue(o.insufficient ?? false);
      const start = jest
        .spyOn(TestBed.inject(PracticeSessionService), 'start')
        .mockImplementation(o.start ?? (() => Promise.resolve(true)));
      const announce = jest
        .spyOn(TestBed.inject(LiveAnnouncer), 'announce')
        .mockResolvedValue(undefined);
      return { comp, start, announce };
    };
    const neverToProgress = () =>
      expect(router.navigate).not.toHaveBeenCalledWith(['/progress']);

    it('starts the session BEFORE navigating to the guarded route', async () => {
      const order: string[] = [];
      const { comp, start } = wire({
        weak: true,
        attempts: 3,
        start: async () => {
          order.push('start');
          return true;
        }
      });
      router.navigate.mockImplementation(async () => {
        order.push('navigate');
        return true;
      });
      await comp.onPracticeWeakAreas();
      expect(start).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['start', 'navigate']);
      expect(router.navigate).toHaveBeenCalledWith(['/practice/weak-areas']);
      expect(comp.weakAreasMessage()).toBe('');
      expect(comp.weakAreasBusy()).toBe(false);
    });

    it('classifies the four availability states from existing signals', () => {
      expect(wire({ weak: true, attempts: 2 }).comp.weakAreasState()).toBe('ready');
      expect(wire({ attempts: 0 }).comp.weakAreasState()).toBe('no-history');
      expect(wire({ attempts: 2, insufficient: true }).comp.weakAreasState()).toBe(
        'insufficient'
      );
      expect(wire({ attempts: 2, insufficient: false }).comp.weakAreasState()).toBe(
        'no-weak'
      );
    });

    it.each([
      ['no-history', { attempts: 0 }, /no quiz history/i],
      ['insufficient', { attempts: 2, insufficient: true }, /at least 3 questions/i],
      ['no-weak', { attempts: 2, insufficient: false }, /No weak areas right now/i]
    ] as [string, Wire, RegExp][])(
      'stays on the dashboard with a clear message: %s',
      async (_name, o, text) => {
        const { comp, start, announce } = wire(o);
        await comp.onPracticeWeakAreas();
        expect(start).not.toHaveBeenCalled();
        expect(router.navigate).not.toHaveBeenCalled();
        expect(comp.weakAreasMessage()).toMatch(text);
        expect(announce).toHaveBeenCalledWith(comp.weakAreasMessage(), 'polite');
      }
    );

    it('start() returning false shows the failure message and stays put', async () => {
      const { comp, announce } = wire({
        weak: true,
        attempts: 3,
        start: () => Promise.resolve(false)
      });
      await comp.onPracticeWeakAreas();
      expect(router.navigate).not.toHaveBeenCalled();
      neverToProgress();
      expect(comp.weakAreasMessage()).toMatch(/could not load your practice questions/i);
      expect(announce).toHaveBeenCalledWith(comp.weakAreasMessage(), 'polite');
      expect(comp.weakAreasBusy()).toBe(false);
    });

    it('start() throwing is handled the same way and clears busy', async () => {
      const { comp } = wire({
        weak: true,
        attempts: 3,
        start: () => Promise.reject(new Error('boom'))
      });
      await expect(comp.onPracticeWeakAreas()).resolves.toBeUndefined();
      expect(router.navigate).not.toHaveBeenCalled();
      expect(comp.weakAreasMessage()).toMatch(/could not load your practice questions/i);
      expect(comp.weakAreasBusy()).toBe(false);
    });

    it('is busy while starting and ignores duplicate clicks', async () => {
      let release!: (v: boolean) => void;
      const { comp, start, announce } = wire({
        weak: true,
        attempts: 3,
        start: () => new Promise<boolean>((r) => (release = r))
      });
      const first = comp.onPracticeWeakAreas();
      expect(comp.weakAreasBusy()).toBe(true);
      await comp.onPracticeWeakAreas(); // ignored
      await comp.onPracticeWeakAreas(); // ignored
      expect(start).toHaveBeenCalledTimes(1);
      expect(announce).toHaveBeenCalledWith('Preparing your practice session', 'polite');
      release(true);
      await first;
      expect(comp.weakAreasBusy()).toBe(false);
      expect(router.navigate).toHaveBeenCalledTimes(1);
    });

    it('allows a retry after a failure and clears the old message', async () => {
      let ok = false;
      const { comp, start } = wire({
        weak: true,
        attempts: 3,
        start: () => Promise.resolve(ok)
      });
      await comp.onPracticeWeakAreas();
      expect(comp.weakAreasMessage()).not.toBe('');
      ok = true;
      await comp.onPracticeWeakAreas();
      expect(start).toHaveBeenCalledTimes(2);
      expect(comp.weakAreasMessage()).toBe('');
      expect(router.navigate).toHaveBeenCalledWith(['/practice/weak-areas']);
    });
  });

  describe('Star on GitHub thank-you', () => {
    afterEach(() => jest.useRealTimers());

    it('starts hidden, shows after a click, then clears itself', () => {
      jest.useFakeTimers();
      const comp = setup();
      expect(comp.starThanks()).toBe(false);
      comp.onStarClick();
      expect(comp.starThanks()).toBe(true);
      jest.advanceTimersByTime(8000);
      expect(comp.starThanks()).toBe(false);
    });

    it('a second click restarts the timer instead of clearing early', () => {
      jest.useFakeTimers();
      const comp = setup();
      comp.onStarClick();
      jest.advanceTimersByTime(5000);
      comp.onStarClick();
      jest.advanceTimersByTime(5000);
      expect(comp.starThanks()).toBe(true);
      jest.advanceTimersByTime(3000);
      expect(comp.starThanks()).toBe(false);
    });
  });

  it('is HIDDEN with no qualifying state at all', () => {
    const comp = setup();
    expect(comp.showSelectionProgress()).toBe(false);
  });

  it('remains VISIBLE on session engagement alone (existing behavior, untouched)', () => {
    const comp = setup({ engaged: true });
    expect(comp.showSelectionProgress()).toBe(true);
  });

  it('remains VISIBLE on accessed Topic Quiz sessionStorage alone (existing behavior, untouched)', () => {
    sessionStorage.setItem('startedQuizIds', JSON.stringify(['create-first-app']));
    const comp = setup();
    expect(comp.showSelectionProgress()).toBe(true);
  });

  it('is VISIBLE with a persisted Interview attempt alone — no Topic Quiz required (THE FIX)', () => {
    seedInterviewHistory();
    const comp = setup();
    expect(comp.showSelectionProgress()).toBe(true);
  });

  it('does NOT distinguish a preset Interview attempt from a custom one', () => {
    seedInterviewHistory({
      configKind: 'preset',
      presetId: 'junior',
      presetName: 'Junior Angular Developer',
      configuredDifficulty: undefined
    });
    const comp = setup();
    expect(comp.showSelectionProgress()).toBe(true);
  });

  it('stays sufficient across a fresh reinitialization (durable, not session-scoped, state)', () => {
    seedInterviewHistory();
    // First "load" of the page.
    expect(setup().showSelectionProgress()).toBe(true);
    // A second, independent instantiation — as a page reload creates a brand
    // new component/service graph — reads the SAME persisted store, with
    // sessionEngagement back to its default false and no sessionStorage
    // survived a real reload. Only the durable Interview record is why this
    // stays true.
    expect(setup().showSelectionProgress()).toBe(true);
  });

  it('a malformed/empty Interview store is NOT sufficient (no false positive)', () => {
    localStorage.setItem(
      'interviewAttemptHistory:v2',
      JSON.stringify({ version: 2, attempts: [] })
    );
    expect(setup().showSelectionProgress()).toBe(false);

    localStorage.setItem('interviewAttemptHistory:v2', 'not json');
    expect(setup().showSelectionProgress()).toBe(false);
  });
});

/**
 * "View Your Progress" — the entry point that REPLACED the embedded dashboard.
 *
 * Your Progress is now its own page (/progress, ProgressPageComponent), which has
 * an empty state, so its entry here is ALWAYS available and deliberately not
 * behind `showSelectionProgress`. That gate is KEPT — including the Step 1
 * Interview-history clause — because it still governs what remains on this
 * screen: the achievements row, the Recommended Next Quiz, the difficulty
 * recommendation and the per-tile progress lines.
 *
 * These render the real template (fixture), with the REAL, unstubbed
 * InterviewHistoryService so "persisted Interview history" is genuinely read
 * from storage, seeded BEFORE the component exists (the history loads once).
 */
describe('QuizSelectionComponent — Your Progress entry point', () => {
  let navigateByUrl: jest.SpyInstance;
  const markEngaged = jest.fn();

  const makeMetadataApi = (): any => ({
    load: jest.fn(() => of([{ quizId: 'create-first-app' }])),
    difficultyByQuiz: signal(new Map([['create-first-app', 'beginner']])),
    milestoneByQuiz: signal(new Map([['create-first-app', 'Create Your First App']])),
    summaryByQuiz: signal(new Map([['create-first-app', 'Get started with Angular.']])),
    imageByQuiz: signal(new Map<string, string>()),
    factsByQuiz: signal(new Map<string, readonly string[]>()),
    questionCountByQuiz: signal(new Map([['create-first-app', 5]])),
    imageFor: () => '',
    factsFor: () => []
  });

  function render(
    opts: { engaged?: boolean; seed?: () => void } = {}
  ): ComponentFixture<QuizSelectionComponent> {
    sessionStorage.clear();
    localStorage.clear();
    markEngaged.mockClear();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: {
            evaluate: jest.fn(() => []),
            summary: () => ({ earned: 0, total: 6 }),
            earnedIds: () => new Set()
          }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        {
          provide: LearningPathService,
          useValue: {
            recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 }))
          }
        },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        {
          provide: SessionEngagementService,
          useValue: { engaged: () => opts.engaged ?? false, markEngaged }
        },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        {
          provide: InterviewWarmupCoordinatorService,
          useValue: { warmUp: jest.fn(() => of(undefined)) }
        }
        // InterviewHistoryService: intentionally NOT stubbed.
      ]
    });
    opts.seed?.();
    navigateByUrl = jest.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    const fixture = TestBed.createComponent(QuizSelectionComponent);
    fixture.detectChanges();
    return fixture;
  }

  const seedInterview = (over: Record<string, unknown> = {}): void => {
    localStorage.setItem(
      'interviewAttemptHistory:v2',
      JSON.stringify({
        version: 2,
        attempts: [
          {
            id: 'att_1',
            completedAt: '2026-08-01T10:00:00.000Z',
            score: 7,
            totalQuestions: 10,
            percentage: 70,
            completionReason: 'submitted',
            ...over
          }
        ]
      })
    );
  };
  const q = (f: ComponentFixture<QuizSelectionComponent>, sel: string): HTMLElement | null =>
    f.nativeElement.querySelector(sel);

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  describe('the old "View Your Progress" link is gone', () => {
    it('is not rendered, with no progress or with progress', () => {
      for (const opts of [{}, { engaged: true }]) {
        const f = render(opts);
        expect(q(f, 'a.progress-entry__link')).toBeNull();
        expect(q(f, '.progress-entry')).toBeNull();
        expect(f.nativeElement.textContent).not.toContain('View Your Progress');
      }
    });

    it('a user with no progress has no /progress link on this screen', () => {
      const f = render();
      expect(q(f, 'codelab-dashboard-progress')).toBeNull();
      expect(f.nativeElement.querySelectorAll('a[href="/progress"]')).toHaveLength(0);
    });
  });

  describe('the Your Progress card keeps its "View Progress" link', () => {
    it('is the single /progress link, a real link to /progress', () => {
      const f = render({ engaged: true });
      const links = f.nativeElement.querySelectorAll('a[href="/progress"]');
      expect(links).toHaveLength(1);
      expect(links[0].tagName).toBe('A');
      expect(links[0].classList.contains('dp__link')).toBe(true);
      expect((links[0].textContent ?? '').replace(/\s+/g, ' ')).toContain('View Progress');
      expect(q(f, 'codelab-dashboard-progress')?.contains(links[0])).toBe(true);
    });

    it('navigates to /progress with NO side effects: no engagement, no storage, no history change', () => {
      const f = render({ engaged: true });
      const before = {
        local: JSON.stringify({ ...localStorage }),
        session: JSON.stringify({ ...sessionStorage })
      };

      (q(f, 'a.dp__link') as HTMLAnchorElement).click();

      expect(navigateByUrl).toHaveBeenCalledTimes(1);
      expect(navigateByUrl.mock.calls[0][0].toString()).toBe('/progress');
      expect(markEngaged).not.toHaveBeenCalled();
      expect(JSON.stringify({ ...localStorage })).toBe(before.local);
      expect(JSON.stringify({ ...sessionStorage })).toBe(before.session);
    });

    it('still appears with persisted Interview history alone', () => {
      const f = render({ seed: () => seedInterview() });
      expect(q(f, 'a.dp__link')).not.toBeNull();
      expect(q(f, '.achievements-summary-row')).not.toBeNull();
    });
  });

  describe('no "You accessed N quizzes" message', () => {
    const quizzesAccessed = (f: ComponentFixture<QuizSelectionComponent>, n: number, of: number) => {
      f.componentInstance.totalQuizCountSig.set(of);
      f.componentInstance.accessedCount.set(n);
      f.detectChanges();
    };

    it('is never rendered, however many quizzes were accessed', () => {
      const f = render({ engaged: true });
      for (const [n, of] of [[0, 20], [1, 20], [5, 20], [19, 20]]) {
        quizzesAccessed(f, n, of);
        expect(q(f, '.accessed-banner')).toBeNull();
        expect(f.nativeElement.textContent).not.toMatch(/You accessed|Keep going/);
      }
    });

    it('does not appear next to the Your Progress card (the reported case)', () => {
      const f = render({ engaged: true });
      quizzesAccessed(f, 1, 20);
      expect(q(f, 'codelab-dashboard-progress')).not.toBeNull();
      expect(f.nativeElement.textContent).not.toContain('You accessed');
    });

    it('the accessed count still drives the progress gate', () => {
      const f = render({
        seed: () => sessionStorage.setItem('startedQuizIds', JSON.stringify(['create-first-app']))
      });
      expect(f.componentInstance.accessedCount()).toBe(1);
      expect(f.componentInstance.hasAccessedQuizzes()).toBe(true);
      expect(f.componentInstance.showSelectionProgress()).toBe(true);
      expect(q(f, 'codelab-dashboard-progress')).not.toBeNull();
    });

    it('keeps the achievement completion message once ALL quizzes are accessed', () => {
      const f = render({ engaged: true });
      quizzesAccessed(f, 20, 20);
      const banner = q(f, '.accessed-banner');
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toBe(f.componentInstance.completionParts().headline);
      expect(banner!.textContent).not.toMatch(/You accessed|Keep going/);
    });
  });

  describe('the embedded dashboard is gone', () => {
    it.each([
      ['a new user', {}],
      ['an engaged user', { engaged: true }],
      ['a user with Interview history', { seed: () => seedInterview() }]
    ] as [string, { engaged?: boolean; seed?: () => void }][])(
      'is not rendered for %s',
      (_label, opts) => {
        const f = render(opts);
        expect(q(f, 'codelab-progress-panel')).toBeNull();
        expect(q(f, 'mat-expansion-panel')).toBeNull();
        expect(q(f, 'codelab-progress-summary')).toBeNull();
        expect(q(f, 'codelab-performance-insights')).toBeNull();
      }
    );
  });

  describe('showSelectionProgress still gates the content that remains on this screen', () => {
    it('hides it all for a new user', () => {
      const f = render();
      expect(q(f, '.achievements-summary-row')).toBeNull();
      expect(q(f, 'codelab-recommended-next-quiz')).toBeNull();
      expect(q(f, 'codelab-difficulty-recommendation')).toBeNull();
      expect(q(f, 'codelab-quiz-card-progress')).toBeNull();
    });

    it('shows it all on session engagement (existing behavior, untouched)', () => {
      const f = render({ engaged: true });
      expect(q(f, '.achievements-summary-row')).not.toBeNull();
      expect(q(f, 'codelab-recommended-next-quiz')).not.toBeNull();
      expect(q(f, 'codelab-difficulty-recommendation')).not.toBeNull();
      expect(q(f, 'codelab-quiz-card-progress')).not.toBeNull();
    });

    it('shows it all on persisted Interview history alone — the Step 1 fix, intact', () => {
      const f = render({ seed: () => seedInterview() });
      expect(q(f, '.achievements-summary-row')).not.toBeNull();
      expect(q(f, 'codelab-recommended-next-quiz')).not.toBeNull();
      expect(q(f, 'codelab-quiz-card-progress')).not.toBeNull();
    });

    it('treats a preset Interview attempt the same as a custom one', () => {
      const f = render({
        seed: () =>
          seedInterview({
            configKind: 'preset',
            presetId: 'junior',
            presetName: 'Junior Angular Developer'
          })
      });
      expect(q(f, '.achievements-summary-row')).not.toBeNull();
    });

    it('an empty Interview store does NOT open the gate (no false positive)', () => {
      const f = render({
        seed: () =>
          localStorage.setItem(
            'interviewAttemptHistory:v2',
            JSON.stringify({ version: 2, attempts: [] })
          )
      });
      expect(q(f, '.achievements-summary-row')).toBeNull();
    });
  });
});

/**
 * Accessibility regression coverage for the quiz-tile keyboard-operability fix.
 *
 * ROOT DEFECT this guards against: the tile's ENTIRE clickable surface was a
 * plain `<div class="quiz-tile" (click)="onSelect(...)">` with no `tabindex`,
 * `role`, or keydown handler — a keyboard-only or screen-reader user could not
 * reach or activate it at all. The fix adds a real `<button type="button">`
 * (`.quiz-tile__activate`) as a full-tile overlay, so native browser semantics
 * (Tab reachability, Enter/Space activation) apply for free.
 *
 * Native Enter/Space-to-click activation for a real <button> is supplied by
 * the BROWSER's own interaction layer, which jsdom does not simulate — a
 * dispatched `keydown` on a jsdom button does not synthesize a `click`. That
 * half of the contract is verified in Playwright
 * (e2e/quiz-selection-tile-a11y.spec.ts), not here. This spec proves the
 * structural/DOM-level half: a real, focusable, correctly-labelled button
 * exists and drives the exact same onSelect() path a click always has.
 */
describe('QuizSelectionComponent — tile keyboard accessibility', () => {
  let router: { navigate: jest.Mock };

  const difficultyMap = new Map<string, string | null>([['create-first-app', 'beginner']]);
  const milestoneMap = new Map<string, string>([['create-first-app', 'Create Your First App']]);
  const summaryMap = new Map<string, string>([['create-first-app', 'Get started with Angular.']]);
  const questionCountMap = new Map<string, number | null>([['create-first-app', 5]]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();

  const makeMetadataApi = (): any => ({
    load: jest.fn(() => of([{ quizId: 'create-first-app' }])),
    difficultyByQuiz: signal(difficultyMap),
    milestoneByQuiz: signal(milestoneMap),
    summaryByQuiz: signal(summaryMap),
    imageByQuiz: signal(imageMap),
    factsByQuiz: signal(factsMap),
    questionCountByQuiz: signal(questionCountMap),
    imageFor: (id: string) => imageMap.get(id) ?? '',
    factsFor: (id: string) => factsMap.get(id) ?? []
  });

  function render(): {
    fixture: ComponentFixture<QuizSelectionComponent>;
    comp: QuizSelectionComponent;
  } {
    sessionStorage.clear();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: {
            evaluate: jest.fn(() => []),
            summary: () => ({ earned: 0, total: 6 }),
            earnedIds: () => new Set()
          }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        {
          provide: LearningPathService,
          useValue: {
            recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 }))
          }
        },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        {
          provide: SessionEngagementService,
          useValue: { engaged: () => false, markEngaged: jest.fn() }
        },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        {
          provide: InterviewWarmupCoordinatorService,
          useValue: { warmUp: jest.fn(() => of(undefined)) }
        }
      ]
    });

    // Real Router (via provideRouter) so RouterLink/RouterLinkActive on the
    // status-icon link and the tile work exactly as they do in the app;
    // navigate() itself is spied rather than replaced, so onSelect()'s real
    // call still resolves.
    router = {
      navigate: jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true) as any
    };

    const fixture = TestBed.createComponent(QuizSelectionComponent);
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance };
  }

  it("renders the tile's activation control as a real native <button>, not a non-semantic clickable container", () => {
    const { fixture } = render();
    const activateBtn: HTMLElement | null = fixture.nativeElement.querySelector(
      '.quiz-tile:not(.interview-tile) .quiz-tile__activate'
    );

    expect(activateBtn).not.toBeNull();
    expect(activateBtn!.tagName).toBe('BUTTON');
    expect(activateBtn!.getAttribute('type')).toBe('button');
  });

  it("the button's accessible name is derived from the tile's own visible title and summary", () => {
    const { fixture } = render();
    const activateBtn: HTMLElement = fixture.nativeElement.querySelector(
      '.quiz-tile:not(.interview-tile) .quiz-tile__activate'
    );
    const labelledBy = (activateBtn.getAttribute('aria-labelledby') ?? '')
      .split(' ')
      .filter(Boolean);

    expect(labelledBy.length).toBe(2);
    const labelText = labelledBy
      .map((id) => fixture.nativeElement.querySelector(`#${id}`)?.textContent?.trim())
      .join(' ');
    expect(labelText).toContain('Create Your First App');
    expect(labelText).toContain('Get started with Angular.');
  });

  it('activating the tile button invokes the SAME onSelect() path a mouse click always has', () => {
    const { fixture, comp } = render();
    const spy = jest.spyOn(comp, 'onSelect');
    const activateBtn: HTMLElement = fixture.nativeElement.querySelector(
      '.quiz-tile:not(.interview-tile) .quiz-tile__activate'
    );

    activateBtn.click();

    expect(spy).toHaveBeenCalledWith('create-first-app', 0);
  });

  it('the outer tile container itself no longer owns the click handler — only the button does', () => {
    const { fixture, comp } = render();
    const spy = jest.spyOn(comp, 'onSelect');
    const tile: HTMLElement = fixture.nativeElement.querySelector(
      '.quiz-tile:not(.interview-tile)'
    );

    // Dispatched directly on the container, NOT the button — before the fix
    // this alone called onSelect(); after the fix, activation lives solely on
    // .quiz-tile__activate, so this must NOT fire it.
    tile.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * Tile-image loading regression coverage for the CSS-background -> real
 * <img>/NgOptimizedImage conversion, and its later HYBRID revision.
 *
 * ROOT DEFECT #1 this guards against: a live-production, throttled-mobile
 * measurement found all 20 tile CSS background-images firing within an 83ms
 * window regardless of scroll position — a CSS background has no
 * lazy-loading hook.
 *
 * ROOT DEFECT #2 (found on a REAL phone after the all-lazy fix shipped):
 * all-lazy was too conservative — images appeared one at a time while
 * scrolling. A three-way cold-cache mobile comparison (0 / 3 / 6 eager
 * tiles) showed N=3 still left `first-6-decoded` timing out (only 3 of the
 * first 6 were eager) while N=6 resolved it (~9.7s vs. never) with no
 * material header-logo LCP regression. A FOURTH comparison then found
 * `loading="eager"` (fetchpriority stays "auto") beats Angular `priority`
 * (fetchpriority="high") at the same N=6: the 6 tiles no longer contend
 * with the header logo — the only `priority`/"high" image and the real LCP
 * element — for the browser's elevated-priority queue, dropping
 * first-six-decoded further to ~8.4s with no LCP regression — see the
 * commit message for the full numbers.
 *
 * `priorityTileCount` is the resulting hybrid: the first N tiles of
 * whatever is CURRENTLY DISPLAYED (bound to the live `@for` index, so
 * search/sort correctly re-targets) load eagerly; the rest stay lazy.
 */
describe('QuizSelectionComponent — tile image loading (NgOptimizedImage conversion)', () => {
  let router: { navigate: jest.Mock };

  // 9 quizzes so priorityTileCount's default (6) has both a priority side
  // (indices 0-5) and a lazy side (6-8) to assert against in the same fixture.
  const quizIds = [
    'typescript',
    'create-first-app',
    'templates',
    'dependency-injection',
    'component-tree',
    'router',
    'material',
    'forms',
    'performance'
  ];
  const difficultyMap = new Map<string, string | null>([
    ['typescript', 'beginner'],
    ['create-first-app', 'beginner'],
    ['templates', 'beginner'],
    ['dependency-injection', 'intermediate'],
    ['component-tree', 'intermediate'],
    ['router', 'intermediate'],
    ['material', 'intermediate'],
    ['forms', 'intermediate'],
    ['performance', 'advanced']
  ]);
  const milestoneMap = new Map<string, string>([
    ['typescript', 'TypeScript'],
    ['create-first-app', 'Create Your First App'],
    ['templates', 'Templates'],
    ['dependency-injection', 'Dependency Injection'],
    ['component-tree', 'Component Trees'],
    ['router', 'Angular Router'],
    ['material', 'Angular Material'],
    ['forms', 'Angular Forms'],
    ['performance', 'Performance']
  ]);
  const summaryMap = new Map<string, string>([
    ['typescript', 'Types make JS safer.'],
    ['create-first-app', 'Get started with Angular.'],
    ['templates', 'Expressive templates.'],
    ['dependency-injection', 'Learn DI.'],
    ['component-tree', 'A tree of components.'],
    ['router', 'Navigate between views.'],
    ['material', 'Material Design components.'],
    ['forms', 'Template-driven and reactive forms.'],
    ['performance', 'Optimize your app.']
  ]);
  const questionCountMap = new Map<string, number | null>([
    ['typescript', 10],
    ['create-first-app', 5],
    ['templates', 10],
    ['dependency-injection', 7],
    ['component-tree', 7],
    ['router', 7],
    ['material', 7],
    ['forms', 11],
    ['performance', 9]
  ]);
  const imageMap = new Map<string, string>([
    ['typescript', 'assets/images/typescript.webp'],
    ['create-first-app', 'assets/images/create-first-app.webp'],
    ['templates', 'assets/images/templates.webp'],
    ['dependency-injection', 'assets/images/dependency-injection.webp'],
    ['component-tree', 'assets/images/component-tree.webp'],
    ['router', 'assets/images/router.webp'],
    ['material', 'assets/images/material.webp'],
    ['forms', 'assets/images/forms.webp'],
    ['performance', 'assets/images/performance.svg']
  ]);
  const factsMap = new Map<string, readonly string[]>();

  const makeMetadataApi = (): any => ({
    load: jest.fn(() => of(quizIds.map((quizId) => ({ quizId })))),
    difficultyByQuiz: signal(difficultyMap),
    milestoneByQuiz: signal(milestoneMap),
    summaryByQuiz: signal(summaryMap),
    imageByQuiz: signal(imageMap),
    factsByQuiz: signal(factsMap),
    questionCountByQuiz: signal(questionCountMap),
    imageFor: (id: string) => imageMap.get(id) ?? '',
    factsFor: (id: string) => factsMap.get(id) ?? []
  });

  function render(): {
    fixture: ComponentFixture<QuizSelectionComponent>;
    comp: QuizSelectionComponent;
  } {
    sessionStorage.clear();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: {
            evaluate: jest.fn(() => []),
            summary: () => ({ earned: 0, total: 6 }),
            earnedIds: () => new Set()
          }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        {
          provide: LearningPathService,
          useValue: {
            recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 }))
          }
        },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        {
          provide: SessionEngagementService,
          useValue: { engaged: () => false, markEngaged: jest.fn() }
        },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        {
          provide: InterviewWarmupCoordinatorService,
          useValue: { warmUp: jest.fn(() => of(undefined)) }
        }
      ]
    });

    router = {
      navigate: jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true) as any
    };

    const fixture = TestBed.createComponent(QuizSelectionComponent);
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance };
  }

  function tileImages(fixture: ComponentFixture<QuizSelectionComponent>): HTMLImageElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.quiz-tile:not(.interview-tile) .quiz-tile__image')
    );
  }

  it('renders a real <img> per tile, not a CSS background — no [style.background]/[style.background-image] on the tile', () => {
    const { fixture } = render();
    const tile: HTMLElement = fixture.nativeElement.querySelector(
      '.quiz-tile:not(.interview-tile)'
    );
    const img = tileImages(fixture)[0];

    expect(img).toBeTruthy();
    expect(img.tagName).toBe('IMG');
    // jsdom reflects an unset inline background as '', never a url(...).
    expect(tile.style.backgroundImage).toBeFalsy();
  });

  it('exactly the first priorityTileCount tiles are loading="eager" (fetchpriority stays "auto"); the rest stay lazy', () => {
    const { fixture, comp } = render();
    const imgs = tileImages(fixture);

    expect(imgs.length).toBe(quizIds.length);
    expect(comp.priorityTileCount).toBe(6);

    imgs.forEach((img, i) => {
      // Deliberately loading="eager", NOT Angular `priority` — measured to
      // free the header logo (the only `priority`/fetchpriority="high"
      // image on the page) from contending with 6 tile fetches for the
      // browser's elevated-priority queue. No tile should ever read
      // fetchpriority="high" — that would mean `priority` crept back in.
      expect(img.getAttribute('fetchpriority')).not.toBe('high');
      if (i < comp.priorityTileCount) {
        expect(img.getAttribute('loading')).toBe('eager');
      } else {
        expect(img.getAttribute('loading')).toBe('lazy');
      }
    });
  });

  it('tile images are purely decorative: alt="" and aria-hidden, never a repeated quiz title', () => {
    const { fixture } = render();
    for (const img of tileImages(fixture)) {
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('tile images carry the .quiz-tile__image class the pointer-events: none SCSS rule targets', () => {
    // jsdom does not load/compile component SCSS (see this file's own note
    // above on native browser interaction not being simulated) — the actual
    // computed pointer-events: none is verified live in Playwright, alongside
    // the click-target/overlay-stacking check. This asserts the structural
    // hook the CSS rule depends on: the class is present on every tile image.
    const { fixture } = render();
    for (const img of tileImages(fixture)) {
      expect(img.classList.contains('quiz-tile__image')).toBe(true);
    }
  });

  it('tileImageUrl() passes a safe local/https path through unchanged', () => {
    const { comp } = render();
    const quiz: any = { quizId: 'dependency-injection' };
    expect(comp.tileImageUrl(quiz)).toBe('assets/images/dependency-injection.webp');
  });

  it('tileImageUrl() fails closed to the local placeholder for an unsafe/injection-shaped value', () => {
    const { comp } = render();
    const unsafe: any = { quizId: 'unsafe', image: 'javascript:alert(1)' };
    expect(comp.tileImageUrl(unsafe)).toBe('assets/images/quiz-placeholder.svg');

    const injection: any = { quizId: 'injection', image: 'assets/x.png"); background:red; --x:("' };
    expect(comp.tileImageUrl(injection)).toBe('assets/images/quiz-placeholder.svg');
  });

  it('search still renders the CORRECT image for whichever quiz remains displayed', () => {
    const { fixture, comp } = render();
    comp.searchTerm.set('dep');
    fixture.detectChanges();

    const imgs = tileImages(fixture);
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute('ngSrc') ?? imgs[0].src).toContain('dependency-injection.webp');
  });

  it("sort still renders each tile's image matched to ITS OWN quiz, not a stale/shifted index", () => {
    const { fixture, comp } = render();
    comp.sortDifficulty.set('asc');
    comp.sortAlpha.set('az');
    fixture.detectChanges();

    const order = comp.displayedQuizzes().map((q) => q.quizId);
    const imgs = tileImages(fixture);
    expect(imgs.length).toBe(order.length);

    for (let i = 0; i < order.length; i++) {
      const expected = imageMap.get(order[i])!;
      const actual = imgs[i].getAttribute('ngSrc') ?? imgs[i].src;
      expect(actual).toContain(expected.split('/').pop()!);
    }
  });

  it('eager loading follows the CURRENT DISPLAYED POSITION after a sort, not the original quiz identity', () => {
    const { fixture, comp } = render();

    // Whichever quiz sorts into position 0 pre-sort was NOT necessarily
    // eager (e.g. 'performance' starts last, index 8, lazy). After sorting
    // it to the front, it must become eager — this is a property of the
    // SLOT, not of a particular quizId.
    comp.sortDifficulty.set('desc'); // advanced first -> 'performance' moves to index 0
    comp.sortAlpha.set('az');
    fixture.detectChanges();

    const order = comp.displayedQuizzes().map((q) => q.quizId);
    expect(order[0]).toBe('performance');

    const imgs = tileImages(fixture);
    imgs.forEach((img, i) => {
      const expectedEager = i < comp.priorityTileCount;
      expect(img.getAttribute('loading') === 'eager').toBe(expectedEager);
      expect(img.getAttribute('fetchpriority')).not.toBe('high');
    });
  });

  it('eager loading follows the CURRENT DISPLAYED POSITION after a search narrows the list', () => {
    const { fixture, comp } = render();

    // Narrow to fewer results than priorityTileCount — every remaining tile
    // should be eager (all positions are < 6), none should be stranded
    // on lazy just because of its ORIGINAL, pre-filter index.
    comp.searchTerm.set('a'); // matches several milestones containing "a"
    fixture.detectChanges();

    const order = comp.displayedQuizzes().map((q) => q.quizId);
    expect(order.length).toBeGreaterThan(0);
    expect(order.length).toBeLessThanOrEqual(6);

    const imgs = tileImages(fixture);
    for (const img of imgs) {
      expect(img.getAttribute('loading')).toBe('eager');
      expect(img.getAttribute('fetchpriority')).not.toBe('high');
    }
  });
});

/**
 * Early Spring warm-up: QuizSelectionComponent is the earliest screen a user
 * reaches, so it now starts InterviewWarmupCoordinatorService's `/health`
 * ping on its OWN `ngOnInit`, well before Interview Mode's own Builder.
 * Uses REAL HttpClient (via HttpTestingController) and the REAL
 * TopicQuizMetadataService/InterviewWarmupCoordinatorService — unlike the
 * describe blocks above (which mock both) — so these tests can observe the
 * ACTUAL, independent HTTP requests this component fires on init: one to
 * Node (topic metadata) and one to Spring (the warm-up ping), and prove
 * neither blocks the other or this component's own rendering.
 */
describe('QuizSelectionComponent — early Spring warm-up', () => {
  function render(): {
    fixture: ComponentFixture<QuizSelectionComponent>;
    http: HttpTestingController;
  } {
    sessionStorage.clear();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'http://node.test/api' },
        { provide: INTERVIEW_API_BASE_URL, useValue: 'http://spring.test/api' },
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: {
            evaluate: jest.fn(() => []),
            summary: () => ({ earned: 0, total: 6 }),
            earnedIds: () => new Set()
          }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        {
          provide: LearningPathService,
          useValue: {
            recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 }))
          }
        },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        {
          provide: SessionEngagementService,
          useValue: { engaged: () => false, markEngaged: jest.fn() }
        }
      ]
    });

    const fixture = TestBed.createComponent(QuizSelectionComponent);
    const http = TestBed.inject(HttpTestingController);
    return { fixture, http };
  }

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('initiates the Spring warm-up exactly once on init', () => {
    const { fixture, http } = render();
    fixture.detectChanges(); // ngOnInit

    const healthReqs = http.match((req) => req.url === 'http://spring.test/api/health');
    expect(healthReqs).toHaveLength(1);
    expect(healthReqs[0].request.method).toBe('GET');
    healthReqs[0].flush({ status: 'UP' });

    http
      .match((req) => req.url === 'http://node.test/api/quizzes')
      .forEach((r) => r.flush({ quizzes: [] }));
  });

  it('rendering and Node /quizzes metadata loading are not blocked by the Spring warm-up — both outstanding at once, warm-up left unresolved', () => {
    const { fixture, http } = render();
    fixture.detectChanges();

    // Both requests exist simultaneously, before either is flushed.
    const healthReq = http.expectOne((req) => req.url === 'http://spring.test/api/health');
    const metadataReq = http.expectOne((req) => req.url === 'http://node.test/api/quizzes');

    // Resolve Node's FIRST, while Spring's warm-up is left deliberately
    // unresolved — the page must already be fully rendered regardless.
    metadataReq.flush({ quizzes: [] });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.quiz-grid')).not.toBeNull();

    // Clean up the still-open warm-up so afterEach's verify() passes.
    healthReq.flush({ status: 'UP' });
  });

  it('a Spring warm-up failure never surfaces an error outside Interview Mode', () => {
    const { fixture, http } = render();
    fixture.detectChanges();

    const healthReq = http.expectOne((req) => req.url === 'http://spring.test/api/health');
    expect(() =>
      healthReq.error(new ProgressEvent('error'), {
        status: 503,
        statusText: 'Service Unavailable'
      })
    ).not.toThrow();

    // Nothing on this Node-owned page reacts to it at all.
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.quiz-grid')).not.toBeNull();

    http
      .match((req) => req.url === 'http://node.test/api/quizzes')
      .forEach((r) => r.flush({ quizzes: [] }));
  });

  it('destroying QuizSelectionComponent does NOT cancel the app-scoped in-flight warm-up', () => {
    const { fixture, http } = render();
    fixture.detectChanges();

    const healthReq = http.expectOne((req) => req.url === 'http://spring.test/api/health');
    expect(() => fixture.destroy()).not.toThrow();
    expect(healthReq.cancelled).toBe(false);

    // Still resolvable after destruction, with no observable effect.
    expect(() => healthReq.flush({ status: 'UP' })).not.toThrow();

    http
      .match((req) => req.url === 'http://node.test/api/quizzes')
      .forEach((r) => r.flush({ quizzes: [] }));
  });

  it('the warm-up never goes to Node, and Node metadata never goes to Spring', () => {
    const { fixture, http } = render();
    fixture.detectChanges();

    expect(http.match((req) => req.url === 'http://node.test/api/health')).toHaveLength(0);
    expect(http.match((req) => req.url === 'http://spring.test/api/quizzes')).toHaveLength(0);

    http.expectOne((req) => req.url === 'http://spring.test/api/health').flush({ status: 'UP' });
    http
      .match((req) => req.url === 'http://node.test/api/quizzes')
      .forEach((r) => r.flush({ quizzes: [] }));
  });
});

/**
 * Sort controls: the toolbar now has ONE Difficulty toggle button and ONE
 * alphabetical toggle button (`[ Difficulty ↑ ]  [ A–Z ]`) in place of a label,
 * an ↑/↓ button pair and an A–Z / Z–A dropdown. The ORDERING is unchanged and
 * so is the state: two independent dimensions the component already owned —
 * difficulty is the primary grouping (by RANK, not by the difficulty strings) and
 * A–Z / Z–A orders quizzes WITHIN each difficulty group. Everything below drives
 * the REAL rendered buttons and reads the REAL rendered tile order.
 *
 * Two quizzes per difficulty, listed in an order that is neither sorted nor
 * reversed, so "within each difficulty" is genuinely exercised.
 */
describe('QuizSelectionComponent — sort controls (Difficulty / A–Z toggle buttons)', () => {
  const CATALOG: ReadonlyArray<readonly [id: string, title: string, difficulty: string]> = [
    ['components', 'Angular Components', 'beginner'],
    ['bindings', 'Angular Bindings', 'beginner'],
    ['signals', 'Angular Signals', 'intermediate'],
    ['directives', 'Angular Directives', 'intermediate'],
    ['performance', 'Performance Tuning', 'advanced'],
    ['architecture', 'Angular Architecture', 'advanced']
  ];

  // Difficulty direction first, alphabetical direction second. Worked out by
  // hand: rank groups Beginner < Intermediate < Advanced, then title A–Z / Z–A.
  const ASC_AZ = ['bindings', 'components', 'directives', 'signals', 'architecture', 'performance'];
  const ASC_ZA = ['components', 'bindings', 'signals', 'directives', 'performance', 'architecture'];
  const DESC_AZ = [
    'architecture',
    'performance',
    'directives',
    'signals',
    'bindings',
    'components'
  ];
  const DESC_ZA = [
    'performance',
    'architecture',
    'signals',
    'directives',
    'components',
    'bindings'
  ];

  const titleOf = (id: string): string => CATALOG.find(([qid]) => qid === id)![1];
  const AZ = 'A–Z';
  const ZA = 'Z–A';

  function render(seed?: () => void): {
    fixture: ComponentFixture<QuizSelectionComponent>;
    comp: QuizSelectionComponent;
  } {
    sessionStorage.clear();
    localStorage.clear();
    seed?.();

    const metadataApi: any = {
      load: jest.fn(() => of(CATALOG.map(([quizId]) => ({ quizId })))),
      difficultyByQuiz: signal(new Map<string, string | null>(CATALOG.map(([id, , d]) => [id, d]))),
      milestoneByQuiz: signal(new Map<string, string>(CATALOG.map(([id, t]) => [id, t]))),
      summaryByQuiz: signal(new Map<string, string>(CATALOG.map(([id]) => [id, `About ${id}.`]))),
      imageByQuiz: signal(new Map<string, string>()),
      factsByQuiz: signal(new Map<string, readonly string[]>()),
      questionCountByQuiz: signal(new Map<string, number | null>(CATALOG.map(([id]) => [id, 5]))),
      imageFor: () => '',
      factsFor: () => []
    };

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: {
            evaluate: jest.fn(() => []),
            summary: () => ({ earned: 0, total: 6 }),
            earnedIds: () => new Set()
          }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        {
          provide: LearningPathService,
          useValue: {
            recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 }))
          }
        },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        {
          provide: SessionEngagementService,
          useValue: { engaged: () => false, markEngaged: jest.fn() }
        },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
        {
          provide: InterviewWarmupCoordinatorService,
          useValue: { warmUp: jest.fn(() => of(undefined)) }
        }
      ]
    });

    const fixture = TestBed.createComponent(QuizSelectionComponent);
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance };
  }

  // ── reading and driving the REAL rendered controls / tiles ─────────
  type Ctx = ReturnType<typeof render>;
  const el = ({ fixture }: Ctx): HTMLElement => fixture.nativeElement;
  const difficultyBtn = (c: Ctx): HTMLButtonElement =>
    el(c).querySelector('.toolbar .sort-btn--difficulty')!;
  const alphaBtn = (c: Ctx): HTMLButtonElement => el(c).querySelector('.toolbar .sort-btn--alpha')!;
  const btnText = (b: HTMLButtonElement): string =>
    b.querySelector('.sort-btn__text')!.textContent!.trim();
  const arrow = (c: Ctx): string => difficultyBtn(c).querySelector('mat-icon')!.textContent!.trim();
  /** The tile order the USER sees, as quiz ids (via the rendered titles). */
  const renderedIds = (c: Ctx): string[] =>
    Array.from(el(c).querySelectorAll('.quiz-title')).map((t) => {
      const title = t.textContent!.trim();
      return CATALOG.find(([, ttl]) => ttl === title)![0];
    });
  const click = (c: Ctx, btn: HTMLButtonElement): void => {
    btn.click();
    c.fixture.detectChanges();
  };

  it('renders ONE Difficulty button and ONE alphabetical button — no "Sort by difficulty:" label, no ↑/↓ pair, no dropdown', () => {
    const c = render();
    const toolbarSort = el(c).querySelector('.toolbar app-quiz-sort')!;

    expect(toolbarSort.querySelectorAll('button')).toHaveLength(2);
    expect(toolbarSort.querySelector('select')).toBeNull();
    expect(toolbarSort.textContent).not.toContain('Sort by difficulty:');
    expect(btnText(difficultyBtn(c))).toBe('Difficulty');
    expect(arrow(c)).toBe('arrow_upward');
    expect(btnText(alphaBtn(c))).toBe(AZ);
  });

  describe('Difficulty ordering — by RANK, never by the difficulty strings', () => {
    it('Difficulty ↑: Beginner → Intermediate → Advanced', () => {
      const c = render();

      expect(renderedIds(c)).toEqual(ASC_AZ);
      expect(c.comp.displayedQuizzes().map((q) => q.difficulty)).toEqual([
        'beginner',
        'beginner',
        'intermediate',
        'intermediate',
        'advanced',
        'advanced'
      ]);
    });

    it('Difficulty ↓: Advanced → Intermediate → Beginner', () => {
      const c = render();
      click(c, difficultyBtn(c));

      expect(renderedIds(c)).toEqual(DESC_AZ);
      expect(c.comp.displayedQuizzes().map((q) => q.difficulty)).toEqual([
        'advanced',
        'advanced',
        'intermediate',
        'intermediate',
        'beginner',
        'beginner'
      ]);
    });

    it('is NOT a plain alphabetical sort of the strings (that would put "advanced" before "beginner")', () => {
      const c = render();

      const firstGroup = c.comp
        .displayedQuizzes()
        .slice(0, 2)
        .map((q) => q.difficulty);
      expect(firstGroup).toEqual(['beginner', 'beginner']);
      const alphabeticalStrings = [...CATALOG.map(([, , d]) => d)].sort();
      expect(alphabeticalStrings[0]).toBe('advanced'); // what a string sort would have led with
      expect(c.comp.displayedQuizzes()[0].difficulty).not.toBe(alphabeticalStrings[0]);
    });
  });

  describe('the buttons toggle', () => {
    it('Difficulty: ↑ ↔ ↓ — arrow, accessible name and tile order all follow', () => {
      const c = render();
      expect([arrow(c), difficultyBtn(c).getAttribute('aria-label')]).toEqual([
        'arrow_upward',
        'Sort by difficulty ascending'
      ]);

      click(c, difficultyBtn(c));
      expect([arrow(c), difficultyBtn(c).getAttribute('aria-label')]).toEqual([
        'arrow_downward',
        'Sort by difficulty descending'
      ]);
      expect(renderedIds(c)).toEqual(DESC_AZ);
      expect(c.comp.sortDifficulty()).toBe('desc');

      click(c, difficultyBtn(c));
      expect([arrow(c), difficultyBtn(c).getAttribute('aria-label')]).toEqual([
        'arrow_upward',
        'Sort by difficulty ascending'
      ]);
      expect(renderedIds(c)).toEqual(ASC_AZ);
      expect(c.comp.sortDifficulty()).toBe('asc');
    });

    it('A–Z ↔ Z–A still works — reverses order WITHIN each difficulty and leaves the groups where they are', () => {
      const c = render();
      expect([btnText(alphaBtn(c)), alphaBtn(c).getAttribute('aria-label')]).toEqual([
        AZ,
        'Sort alphabetically A to Z'
      ]);

      click(c, alphaBtn(c));
      expect([btnText(alphaBtn(c)), alphaBtn(c).getAttribute('aria-label')]).toEqual([
        ZA,
        'Sort alphabetically Z to A'
      ]);
      expect(renderedIds(c)).toEqual(ASC_ZA);
      // Same three groups in the same order — only the order inside each changed.
      expect(c.comp.displayedQuizzes().map((q) => q.difficulty)).toEqual([
        'beginner',
        'beginner',
        'intermediate',
        'intermediate',
        'advanced',
        'advanced'
      ]);
      expect(c.comp.sortAlpha()).toBe('za');

      click(c, alphaBtn(c));
      expect(btnText(alphaBtn(c))).toBe(AZ);
      expect(renderedIds(c)).toEqual(ASC_AZ);
      expect(c.comp.sortAlpha()).toBe('az');
    });

    it('switching between the two: each button changes only its own dimension, and the rendered order composes correctly every time', () => {
      const c = render();
      const step = (
        btn: HTMLButtonElement,
        expected: string[],
        difficulty: string,
        alpha: string,
        arrowIcon: string,
        alphaText: string
      ): void => {
        click(c, btn);
        expect(renderedIds(c)).toEqual(expected);
        expect([c.comp.sortDifficulty(), c.comp.sortAlpha()]).toEqual([difficulty, alpha]);
        expect([arrow(c), btnText(alphaBtn(c))]).toEqual([arrowIcon, alphaText]);
      };

      expect(renderedIds(c)).toEqual(ASC_AZ);
      step(difficultyBtn(c), DESC_AZ, 'desc', 'az', 'arrow_downward', AZ);
      step(alphaBtn(c), DESC_ZA, 'desc', 'za', 'arrow_downward', ZA);
      step(difficultyBtn(c), ASC_ZA, 'asc', 'za', 'arrow_upward', ZA);
      step(alphaBtn(c), ASC_AZ, 'asc', 'az', 'arrow_upward', AZ);
    });

    it('keeps keyboard focus on the pressed button after it re-renders (the old ↑/↓ pair disabled the pressed button)', () => {
      const c = render();
      document.body.appendChild(el(c)); // focus needs an attached element
      const btn = difficultyBtn(c);
      btn.focus();
      click(c, btn);

      expect(difficultyBtn(c).disabled).toBe(false);
      expect(document.activeElement).toBe(difficultyBtn(c));
      el(c).remove();
    });
  });

  describe('search and sorting together', () => {
    it('search narrows the list and every sort combination still orders the survivors correctly', () => {
      const c = render();
      c.comp.searchTerm.set('angular'); // word-start match: everything except "Performance Tuning"
      c.fixture.detectChanges();

      expect(renderedIds(c)).toEqual(ASC_AZ.filter((id) => id !== 'performance'));
      click(c, difficultyBtn(c));
      expect(renderedIds(c)).toEqual(DESC_AZ.filter((id) => id !== 'performance'));
      click(c, alphaBtn(c));
      expect(renderedIds(c)).toEqual(DESC_ZA.filter((id) => id !== 'performance'));
      click(c, difficultyBtn(c));
      expect(renderedIds(c)).toEqual(ASC_ZA.filter((id) => id !== 'performance'));
    });

    it('sorting never changes the search term, and the search never changes the sort state', () => {
      const c = render();
      c.comp.searchTerm.set('angular');
      c.fixture.detectChanges();

      click(c, difficultyBtn(c));
      click(c, alphaBtn(c));
      expect(c.comp.searchTerm()).toBe('angular');

      c.comp.searchTerm.set('');
      c.fixture.detectChanges();
      expect([c.comp.sortDifficulty(), c.comp.sortAlpha()]).toEqual(['desc', 'za']);
    });

    it('a search with no matches shows nothing; clearing it restores the list in the CURRENT sort order', () => {
      const c = render();
      click(c, difficultyBtn(c)); // desc / az

      c.comp.searchTerm.set('zzz-no-such-topic');
      c.fixture.detectChanges();
      expect(renderedIds(c)).toEqual([]);
      click(c, alphaBtn(c)); // buttons keep working over an empty result

      c.comp.searchTerm.set('');
      c.fixture.detectChanges();
      expect(renderedIds(c)).toEqual(DESC_ZA);
    });

    it('search matches only the title (not the difficulty), exactly as before', () => {
      const c = render();
      c.comp.searchTerm.set('advanced'); // a difficulty, not a title word
      c.fixture.detectChanges();

      expect(renderedIds(c)).toEqual([]);
    });
  });

  describe('persistence is unchanged', () => {
    it('still stores the same two keys with the same values', () => {
      const c = render();
      expect([
        localStorage.getItem('quizSortDifficulty'),
        localStorage.getItem('quizSortAlpha')
      ]).toEqual(['asc', 'az']);

      click(c, difficultyBtn(c));
      click(c, alphaBtn(c));
      c.fixture.detectChanges();

      expect(localStorage.getItem('quizSortDifficulty')).toBe('desc');
      expect(localStorage.getItem('quizSortAlpha')).toBe('za');
    });

    it('restores a saved preference and the buttons show it', () => {
      const c = render(() => {
        localStorage.setItem('quizSortDifficulty', 'desc');
        localStorage.setItem('quizSortAlpha', 'za');
      });

      expect(renderedIds(c)).toEqual(DESC_ZA);
      expect([arrow(c), btnText(alphaBtn(c))]).toEqual(['arrow_downward', ZA]);
      expect(difficultyBtn(c).getAttribute('aria-label')).toBe('Sort by difficulty descending');
      expect(alphaBtn(c).getAttribute('aria-label')).toBe('Sort alphabetically Z to A');
    });

    it('ignores a corrupt saved value and falls back to the defaults', () => {
      const c = render(() => {
        localStorage.setItem('quizSortDifficulty', 'sideways');
        localStorage.setItem('quizSortAlpha', 'qq');
      });

      expect(renderedIds(c)).toEqual(ASC_AZ);
    });
  });
});

/**
 * Difficulty FILTER: a Material select beside the sort buttons —
 * `[ All Difficulties ▾ ] [ Difficulty ↑ ] [ A–Z ]` — that decides WHICH quizzes
 * are shown. It is independent of the two sort dimensions (which decide their
 * ORDER, unchanged: difficulty is the primary grouping, A–Z / Z–A orders within
 * each difficulty) and composes with search: a quiz must satisfy both.
 *
 * Everything below drives the REAL rendered select, search box and sort buttons
 * and reads the REAL rendered tile order. Two quizzes per difficulty, listed
 * unsorted, so "within a difficulty" is genuinely exercised.
 */
describe('QuizSelectionComponent — difficulty filter', () => {
  type Row = readonly [id: string, title: string, difficulty: string];
  const CATALOG: ReadonlyArray<Row> = [
    ['components', 'Angular Components', 'beginner'],
    ['bindings', 'Angular Bindings', 'beginner'],
    ['signals', 'Angular Signals', 'intermediate'],
    ['directives', 'Angular Directives', 'intermediate'],
    ['performance', 'Performance Tuning', 'advanced'],
    ['architecture', 'Angular Architecture', 'advanced']
  ];

  // Worked out by hand. Sort orders when ALL difficulties are shown …
  const ASC_AZ = ['bindings', 'components', 'directives', 'signals', 'architecture', 'performance'];
  const ASC_ZA = ['components', 'bindings', 'signals', 'directives', 'performance', 'architecture'];
  const DESC_AZ = [
    'architecture',
    'performance',
    'directives',
    'signals',
    'bindings',
    'components'
  ];
  const DESC_ZA = [
    'performance',
    'architecture',
    'signals',
    'directives',
    'components',
    'bindings'
  ];
  // … and the members of each single difficulty, A–Z then Z–A.
  const ONLY: Record<'beginner' | 'intermediate' | 'advanced', { az: string[]; za: string[] }> = {
    beginner: { az: ['bindings', 'components'], za: ['components', 'bindings'] },
    intermediate: { az: ['directives', 'signals'], za: ['signals', 'directives'] },
    advanced: { az: ['architecture', 'performance'], za: ['performance', 'architecture'] }
  };
  const LABEL: Record<string, string> = {
    all: 'All Difficulties',
    beginner: 'Beginner',
    intermediate: 'Intermediate',
    advanced: 'Advanced'
  };

  // Test double for Angular CDK's LiveAnnouncer (2026-10-17): the real
  // service appends its own singleton element to `document.body`, outside
  // any component's template, and writes to it asynchronously (its own
  // internal 100ms timer, run outside the Angular zone) — not something a
  // synchronous `fixture.detectChanges()` can observe directly. Mocking it
  // lets tests assert exactly what the COMPONENT is responsible for (did
  // it ask to announce the right message, at the right time, and never a
  // stale one) without claiming anything about whether an AT actually
  // speaks it — that remains a manual-only claim.
  function createLiveAnnouncerMock() {
    const calls: Array<{ type: 'announce' | 'clear'; message?: string }> = [];
    return {
      announce: jest.fn((message: string) => {
        calls.push({ type: 'announce', message });
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        calls.push({ type: 'clear' });
      }),
      _calls: calls
    };
  }
  type LiveAnnouncerMock = ReturnType<typeof createLiveAnnouncerMock>;

  async function render(catalog: ReadonlyArray<Row> = CATALOG) {
    sessionStorage.clear();
    localStorage.clear();
    const liveAnnouncer = createLiveAnnouncerMock();

    const metadataApi: any = {
      load: jest.fn(() => of(catalog.map(([quizId]) => ({ quizId })))),
      difficultyByQuiz: signal(new Map<string, string | null>(catalog.map(([id, , d]) => [id, d]))),
      milestoneByQuiz: signal(new Map<string, string>(catalog.map(([id, t]) => [id, t]))),
      summaryByQuiz: signal(new Map<string, string>(catalog.map(([id]) => [id, `About ${id}.`]))),
      imageByQuiz: signal(new Map<string, string>()),
      factsByQuiz: signal(new Map<string, readonly string[]>()),
      questionCountByQuiz: signal(new Map<string, number | null>(catalog.map(([id]) => [id, 5]))),
      imageFor: () => '',
      factsFor: () => []
    };

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: {
            evaluate: jest.fn(() => []),
            summary: () => ({ earned: 0, total: 6 }),
            earnedIds: () => new Set()
          }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        {
          provide: LearningPathService,
          useValue: {
            recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 }))
          }
        },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        {
          provide: SessionEngagementService,
          useValue: { engaged: () => false, markEngaged: jest.fn() }
        },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
        {
          provide: InterviewWarmupCoordinatorService,
          useValue: { warmUp: jest.fn(() => of(undefined)) }
        },
        { provide: LiveAnnouncer, useValue: liveAnnouncer }
      ]
    });

    const fixture = TestBed.createComponent(QuizSelectionComponent);
    fixture.detectChanges();
    await fixture.whenStable(); // MatSelect applies its initial selection in a microtask
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance, catalog, liveAnnouncer };
  }

  type Ctx = Awaited<ReturnType<typeof render>>;
  const el = (c: Ctx): HTMLElement => c.fixture.nativeElement;
  const selectHost = (c: Ctx): HTMLElement =>
    el(c).querySelector('.toolbar app-quiz-difficulty-filter mat-select')!;
  const selectShows = (c: Ctx): string =>
    (el(c).querySelector('.toolbar .mat-mdc-select-value')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const difficultyBtn = (c: Ctx): HTMLButtonElement =>
    el(c).querySelector('.toolbar .sort-btn--difficulty')!;
  const alphaBtn = (c: Ctx): HTMLButtonElement => el(c).querySelector('.toolbar .sort-btn--alpha')!;
  const searchInput = (c: Ctx): HTMLInputElement =>
    el(c).querySelector('.toolbar app-quiz-search input')!;
  const titles = (c: Ctx): string[] =>
    Array.from(el(c).querySelectorAll('.quiz-title')).map((t) => t.textContent!.trim());
  const renderedIds = (c: Ctx): string[] =>
    titles(c).map((title) => c.catalog.find(([, ttl]) => ttl === title)![0]);
  const noResults = (c: Ctx): HTMLElement[] =>
    Array.from(el(c).querySelectorAll<HTMLElement>('.no-results'));
  // The CURRENT announcement state (2026-10-17): the component now calls
  // Angular CDK's LiveAnnouncer, mocked above, instead of writing to its
  // own DOM span. "Not announcing" means the LAST call was `.clear()` (or
  // nothing has been called yet), not that some element's text is empty.
  const announcement = (c: Ctx): string | null => {
    const calls = c.liveAnnouncer._calls;
    const last = calls[calls.length - 1];
    return last && last.type === 'announce' ? (last.message ?? '').replace(/\s+/g, ' ').trim() || null : null;
  };

  async function settle(c: Ctx): Promise<void> {
    c.fixture.detectChanges();
    await c.fixture.whenStable();
    c.fixture.detectChanges();
  }
  /** Choose an option in the REAL select, the way a user does. */
  async function chooseDifficulty(
    c: Ctx,
    value: 'all' | 'beginner' | 'intermediate' | 'advanced'
  ): Promise<void> {
    (el(c).querySelector('.toolbar .mat-mdc-select-trigger') as HTMLElement).click();
    c.fixture.detectChanges();
    const option = Array.from(document.querySelectorAll<HTMLElement>('mat-option')).find(
      (o) => o.textContent!.trim() === LABEL[value]
    )!;
    option.click();
    await settle(c);
  }
  /** Type into the REAL search box. */
  async function search(c: Ctx, term: string): Promise<void> {
    const input = searchInput(c);
    input.value = term;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(c);
  }
  async function press(c: Ctx, btn: HTMLButtonElement): Promise<void> {
    btn.click();
    await settle(c);
  }

  describe('default', () => {
    it('starts on "All Difficulties" and shows every quiz, exactly as before the filter existed', async () => {
      const c = await render();

      expect(c.comp.difficultyFilter()).toBe('all');
      expect(selectShows(c)).toBe('All Difficulties');
      expect(renderedIds(c)).toEqual(ASC_AZ);
      expect(renderedIds(c)).toHaveLength(6);
    });

    it('sits with the sort controls — [ filter ] [ Difficulty ] [ A–Z ] — and is independent of them', async () => {
      const c = await render();

      const group = el(c).querySelector('.toolbar .toolbar-controls')!;
      expect(Array.from(group.children).map((e) => e.tagName.toLowerCase())).toEqual([
        'app-quiz-difficulty-filter',
        'app-quiz-sort'
      ]);
      expect(el(c).querySelectorAll('.toolbar app-quiz-sort button')).toHaveLength(2); // the sort control is unchanged
    });
  });

  describe('filtering by a single difficulty', () => {
    it.each([
      ['beginner', ['bindings', 'components']],
      ['intermediate', ['directives', 'signals']],
      ['advanced', ['architecture', 'performance']]
    ] as const)('%s shows ONLY %s quizzes', async (difficulty, expectedIds) => {
      const c = await render();
      await chooseDifficulty(c, difficulty);

      expect(c.comp.difficultyFilter()).toBe(difficulty);
      expect(selectShows(c)).toBe(LABEL[difficulty]);
      expect(renderedIds(c)).toEqual(expectedIds);
      expect(c.comp.displayedQuizzes().every((q) => q.difficulty === difficulty)).toBe(true);
    });

    it('returning to "All Difficulties" restores every quiz, in the current two-dimensional order', async () => {
      const c = await render();
      await chooseDifficulty(c, 'advanced');
      expect(renderedIds(c)).toHaveLength(2);

      await chooseDifficulty(c, 'all');
      expect(selectShows(c)).toBe('All Difficulties');
      expect(renderedIds(c)).toEqual(ASC_AZ);

      // …and it is still the full two-dimensional sort, not something the filter flattened.
      await press(c, difficultyBtn(c));
      await press(c, alphaBtn(c));
      expect(renderedIds(c)).toEqual(DESC_ZA);
    });

    it('a quiz with no difficulty shows under "All Difficulties" only', async () => {
      const c = await render([...CATALOG, ['mystery', 'Mystery Topic', '']]);
      expect(renderedIds(c)).toContain('mystery');

      for (const d of ['beginner', 'intermediate', 'advanced'] as const) {
        await chooseDifficulty(c, d);
        expect(renderedIds(c)).not.toContain('mystery');
      }
      await chooseDifficulty(c, 'all');
      expect(renderedIds(c)).toContain('mystery');
    });
  });

  describe('composes with the sort dimensions', () => {
    it.each(['beginner', 'intermediate', 'advanced'] as const)(
      '%s + A–Z: only that difficulty, alphabetical',
      async (difficulty) => {
        const c = await render();
        await chooseDifficulty(c, difficulty);

        expect(c.comp.sortAlpha()).toBe('az');
        expect(renderedIds(c)).toEqual(ONLY[difficulty].az);
      }
    );

    it.each(['beginner', 'intermediate', 'advanced'] as const)(
      '%s + Z–A: only that difficulty, reverse-alphabetical',
      async (difficulty) => {
        const c = await render();
        await press(c, alphaBtn(c)); // → Z–A
        await chooseDifficulty(c, difficulty);

        expect(c.comp.sortAlpha()).toBe('za');
        expect(renderedIds(c)).toEqual(ONLY[difficulty].za);
      }
    );

    it('toggling A–Z / Z–A while a difficulty is selected reorders within it and keeps the selection', async () => {
      const c = await render();
      await chooseDifficulty(c, 'intermediate');

      await press(c, alphaBtn(c));
      expect(renderedIds(c)).toEqual(ONLY.intermediate.za);
      await press(c, alphaBtn(c));
      expect(renderedIds(c)).toEqual(ONLY.intermediate.az);
      expect(selectShows(c)).toBe('Intermediate');
    });

    it('changing Difficulty ↑/↓ while one difficulty is selected does not break the filtered results', async () => {
      const c = await render();
      await chooseDifficulty(c, 'intermediate');

      await press(c, difficultyBtn(c)); // ↓
      expect(c.comp.sortDifficulty()).toBe('desc');
      expect(renderedIds(c)).toEqual(ONLY.intermediate.az); // same single group, same order
      await press(c, difficultyBtn(c)); // ↑
      expect(c.comp.sortDifficulty()).toBe('asc');
      expect(renderedIds(c)).toEqual(ONLY.intermediate.az);
      expect(selectShows(c)).toBe('Intermediate');

      // The direction chosen meanwhile is remembered: back on All it groups accordingly.
      await press(c, difficultyBtn(c)); // ↓ again
      await chooseDifficulty(c, 'all');
      expect(renderedIds(c)).toEqual(DESC_AZ);
    });

    it('with All Difficulties the two-dimensional sort behaves exactly as before, in every combination', async () => {
      const c = await render();
      await chooseDifficulty(c, 'all');

      expect(renderedIds(c)).toEqual(ASC_AZ);
      await press(c, difficultyBtn(c));
      expect(renderedIds(c)).toEqual(DESC_AZ);
      await press(c, alphaBtn(c));
      expect(renderedIds(c)).toEqual(DESC_ZA);
      await press(c, difficultyBtn(c));
      expect(renderedIds(c)).toEqual(ASC_ZA);
    });

    it('choosing a filter never alters either sort dimension — in memory or in storage', async () => {
      const c = await render();
      await press(c, difficultyBtn(c));
      await press(c, alphaBtn(c)); // desc / za
      const sortKeys = {
        d: localStorage.getItem('quizSortDifficulty'),
        a: localStorage.getItem('quizSortAlpha')
      };
      expect(sortKeys).toEqual({ d: 'desc', a: 'za' });

      for (const d of ['beginner', 'advanced', 'intermediate', 'all'] as const) {
        await chooseDifficulty(c, d);
        expect([c.comp.sortDifficulty(), c.comp.sortAlpha()]).toEqual(['desc', 'za']);
        expect([
          localStorage.getItem('quizSortDifficulty'),
          localStorage.getItem('quizSortAlpha')
        ]).toEqual(['desc', 'za']);
      }
    });
  });

  describe('composes with search', () => {
    it.each([
      ['intermediate', 'angular', ['directives', 'signals']],
      ['beginner', 'angular', ['bindings', 'components']],
      ['advanced', 'angular', ['architecture']], // "Performance Tuning" fails the search
      ['advanced', 'perf', ['performance']],
      ['beginner', 'perf', []] // the search matches, but not in this difficulty
    ] as const)(
      '%s + search "%s" keeps only quizzes that satisfy BOTH',
      async (difficulty, term, expectedIds) => {
        const c = await render();
        await chooseDifficulty(c, difficulty);
        await search(c, term);

        expect(renderedIds(c)).toEqual(expectedIds);
      }
    );

    it('the order of the two actions does not matter', async () => {
      const a = await render();
      await search(a, 'angular');
      await chooseDifficulty(a, 'intermediate');
      const searchFirst = renderedIds(a);
      TestBed.resetTestingModule();

      const b = await render();
      await chooseDifficulty(b, 'intermediate');
      await search(b, 'angular');

      expect(searchFirst).toEqual(['directives', 'signals']);
      expect(renderedIds(b)).toEqual(searchFirst);
    });

    it('clearing the search keeps the selected difficulty (it does not fall back to everything)', async () => {
      const c = await render();
      await chooseDifficulty(c, 'intermediate');
      await search(c, 'sig');
      expect(renderedIds(c)).toEqual(['signals']);

      await search(c, '');

      expect(renderedIds(c)).toEqual(ONLY.intermediate.az);
      expect(selectShows(c)).toBe('Intermediate');
      expect(c.comp.difficultyFilter()).toBe('intermediate');
    });

    it('changing the difficulty never clears or alters the search field', async () => {
      const c = await render();
      await search(c, 'angular');

      for (const d of ['beginner', 'advanced', 'all'] as const) {
        await chooseDifficulty(c, d);
        expect(c.comp.searchTerm()).toBe('angular');
        expect(searchInput(c).value).toBe('angular');
      }
    });

    it('the search box still works with the default filter exactly as before', async () => {
      const c = await render();
      await search(c, 'angular');

      expect(renderedIds(c)).toEqual(ASC_AZ.filter((id) => id !== 'performance'));
    });
  });

  describe('empty results use the ONE existing no-results element', () => {
    it('search AND filter together: names both in the VISIBLE text, and the SAME announcer (LiveAnnouncer) carries that message — no second, competing live region', async () => {
      const c = await render();
      await chooseDifficulty(c, 'beginner');
      await search(c, 'perf');

      expect(renderedIds(c)).toEqual([]);
      expect(noResults(c)).toHaveLength(1);
      expect(noResults(c)[0].textContent!.trim()).toBe(
        'No quizzes match your search and difficulty filter.'
      );
      // .no-results is no longer its own live region (no role/aria-live) —
      // it's purely the visible text. The ONE announcer says the same
      // message, consolidating what used to be two competing regions.
      expect([noResults(c)[0].getAttribute('role'), noResults(c)[0].getAttribute('aria-live')]).toEqual([
        null,
        null
      ]);
      expect(announcement(c)).toBe('No quizzes match your search and difficulty filter.');
    });

    it('search alone: the existing visible message, unchanged, and the announcer carries it too', async () => {
      const c = await render();
      await search(c, 'zzz-no-such-topic');

      expect(noResults(c)).toHaveLength(1);
      expect(noResults(c)[0].textContent!.trim()).toBe('No quizzes match your search.');
      expect(announcement(c)).toBe('No quizzes match your search.');
    });

    it('filter alone (a difficulty with no quizzes): names the difficulty filter', async () => {
      const c = await render(CATALOG.filter(([, , d]) => d !== 'advanced'));
      await chooseDifficulty(c, 'advanced');

      expect(renderedIds(c)).toEqual([]);
      expect(noResults(c)).toHaveLength(1);
      expect(noResults(c)[0].textContent!.trim()).toBe('No quizzes match the selected difficulty.');
      expect(announcement(c)).toBe('No quizzes match the selected difficulty.');
    });

    it('is purely visible text now (no role/aria-live of its own), and goes away when the results come back', async () => {
      const c = await render();
      await chooseDifficulty(c, 'beginner');
      await search(c, 'perf');
      const message = noResults(c)[0];
      expect([message.getAttribute('role'), message.getAttribute('aria-live')]).toEqual([null, null]);

      await chooseDifficulty(c, 'all'); // "perf" now matches Performance Tuning
      expect(noResults(c)).toHaveLength(0);
      expect(renderedIds(c)).toEqual(['performance']);
      expect(announcement(c)).toBe('1 quiz found');
    });

    it('is not shown when there is simply nothing to filter yet (catalog empty)', async () => {
      const c = await render([]);
      expect(noResults(c)).toHaveLength(0);
    });
  });

  describe('announcing the result count', () => {
    it('is silent on a normal page load (default filter, no search)', async () => {
      const c = await render();
      expect(announcement(c)).toBeNull();
    });

    it('announces the count when the difficulty filter narrows the list', async () => {
      const c = await render();
      await chooseDifficulty(c, 'beginner');
      expect(announcement(c)).toBe('2 quizzes found');

      await chooseDifficulty(c, 'all');
      expect(announcement(c)).toBeNull();
    });

    it('still announces while searching, as before', async () => {
      const c = await render();
      await search(c, 'sig');
      expect(announcement(c)).toBe('1 quiz found');
    });

    /**
     * HISTORY, 2026-10-17: the previous hand-rolled span's own DOM-node
     * identity (destroyed/recreated vs. persistent) was tested directly
     * here, because that span lived in THIS component's own template and
     * an earlier confirmed defect involved exactly that (an `@if`-wrapped
     * span getting its first content inserted atomically). Angular CDK's
     * `LiveAnnouncer` makes that defect class structurally impossible:
     * its live element is a singleton appended directly to
     * `document.body` by the SERVICE itself, never part of ANY Angular
     * component's template — there is nothing for this component's own
     * change detection to destroy or recreate. That guarantee now comes
     * from the library, not from an assertion in this file.
     */
    it('preserves input focus while typing', async () => {
      const c = await render();
      const input = searchInput(c);
      input.focus();
      expect(document.activeElement).toBe(input);

      await search(c, 'sig');

      expect(document.activeElement).toBe(input);
    });

    it('announces exactly once for a single search, not once per unrelated change-detection pass', async () => {
      const c = await render();
      await search(c, 'sig');
      expect(announcement(c)).toBe('1 quiz found');
      const announceCallsAfterSearch = c.liveAnnouncer.announce.mock.calls.length;

      // Trigger a change-detection pass with nothing relevant different
      // (same search term, same results) — effect()s only re-run when a
      // TRACKED signal's value actually changes, so this must not add
      // another announce() call.
      c.fixture.detectChanges();

      expect(c.liveAnnouncer.announce.mock.calls.length).toBe(announceCallsAfterSearch);
      expect(announcement(c)).toBe('1 quiz found');
    });

    it('clearing via keyboard (select-all + delete) silences the announcement', async () => {
      const c = await render();
      await search(c, 'sig');
      expect(announcement(c)).toBe('1 quiz found');

      await search(c, '');
      expect(announcement(c)).toBeNull();
    });

    it('clearing via the clear button silences the announcement (a different entry point into the same handler)', async () => {
      const c = await render();
      await search(c, 'sig');
      expect(announcement(c)).toBe('1 quiz found');

      const clearBtn = el(c).querySelector('.toolbar app-quiz-search .clear-btn') as HTMLButtonElement;
      expect(clearBtn).not.toBeNull();
      await press(c, clearBtn);
      expect(announcement(c)).toBeNull();
      expect(c.comp.searchTerm()).toBe('');
    });

    it('combines search AND difficulty filter correctly when results remain — uses the real combined count, not either filter alone', async () => {
      const c = await render();
      await chooseDifficulty(c, 'beginner');
      expect(announcement(c)).toBe('2 quizzes found'); // difficulty alone

      await search(c, 'comp');
      expect(announcement(c)).toBe('1 quiz found'); // narrowed further by search too
      expect(renderedIds(c)).toEqual(['components']);
    });

    it('re-announces the same text when the search term changes but the resulting count does not — intentional with LiveAnnouncer, unlike the old raw-span idempotent guard', async () => {
      const c = await render();
      await search(c, 'sig'); // matches exactly 'signals'
      expect(announcement(c)).toBe('1 quiz found');
      const callsAfterFirst = c.liveAnnouncer.announce.mock.calls.length;

      await search(c, 'signa'); // still matches exactly 'signals' — same count, same text
      expect(announcement(c)).toBe('1 quiz found');
      // `searchTerm` itself changed value, so the effect re-runs and calls
      // announce() again with the identical message — CDK's own
      // clear-then-set pattern is specifically designed to make even a
      // repeated, unchanged message reliably re-announced by ATs that
      // might not notice an unchanged live-region text node.
      expect(c.liveAnnouncer.announce.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('preserves input focus when selecting a difficulty too', async () => {
      const c = await render();
      await chooseDifficulty(c, 'beginner');
      // chooseDifficulty's own click flow moves focus into the option list
      // and back to the trigger — confirm the trigger (not some other
      // element) ends up focused, not the toolbar being disrupted.
      expect(document.activeElement).toBe(selectHost(c).querySelector('[role="combobox"]') ?? selectHost(c));
    });

    /**
     * The gap found during final review, 2026-10-17: `restoreSortPreference()`
     * restores a saved search term from sessionStorage via `searchTerm.set()`
     * directly — bypassing `onSearchTermChange()` entirely. Without
     * `syncSearchAnnouncementEffect`, the announcement span would stay
     * empty even though the grid correctly shows the restored, filtered
     * results. NOT manually Narrator-retested — this only proves the
     * DOM ends up correct, per the component's own comment on that effect.
     */
    it('a search term restored from a previous session (not typed) still populates the announcement, via the sync effect', async () => {
      // render()'s own setup clears sessionStorage before creating the
      // component — seeding it has to happen AFTER that clear but
      // BEFORE ngOnInit reads it, so this builds the fixture directly
      // rather than through the shared helper.
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('quizSearchTerm', 'sig');

      const metadataApi: any = {
        load: jest.fn(() => of(CATALOG.map(([quizId]) => ({ quizId })))),
        difficultyByQuiz: signal(new Map<string, string | null>(CATALOG.map(([id, , d]) => [id, d]))),
        milestoneByQuiz: signal(new Map<string, string>(CATALOG.map(([id, t]) => [id, t]))),
        summaryByQuiz: signal(new Map<string, string>(CATALOG.map(([id]) => [id, `About ${id}.`]))),
        imageByQuiz: signal(new Map<string, string>()),
        factsByQuiz: signal(new Map<string, readonly string[]>()),
        questionCountByQuiz: signal(new Map<string, number | null>(CATALOG.map(([id]) => [id, 5]))),
        imageFor: () => '',
        factsFor: () => []
      };

      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          provideNoopAnimations(),
          {
            provide: QuizService,
            useValue: {
              setQuizId: jest.fn(),
              setQuizStatus: jest.fn(),
              setCompletedQuizId: jest.fn(),
              setCheckedShuffle: jest.fn(),
              returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
              quizCompleted: false
            }
          },
          {
            provide: AchievementService,
            useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() }
          },
          { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
          { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
          { provide: LearningPathService, useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) } },
          { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
          { provide: SessionEngagementService, useValue: { engaged: () => false, markEngaged: jest.fn() } },
          { provide: TopicQuizMetadataService, useValue: metadataApi },
          { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } },
          { provide: LiveAnnouncer, useValue: createLiveAnnouncerMock() }
        ]
      });

      const fixture = TestBed.createComponent(QuizSelectionComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const root = fixture.nativeElement as HTMLElement;
      const input = root.querySelector('.toolbar app-quiz-search input') as HTMLInputElement;
      const liveAnnouncer = TestBed.inject(LiveAnnouncer) as unknown as LiveAnnouncerMock;

      expect(input.value).toBe('sig');
      const last = liveAnnouncer._calls[liveAnnouncer._calls.length - 1];
      expect(last).toEqual({ type: 'announce', message: '1 quiz found' });
    });

    /**
     * Second half of the same gap: the catalog itself loads
     * asynchronously. A restored search term can be set before real
     * quiz data exists, so the announcement must catch up once the
     * catalog actually arrives — not stay stuck on whatever was true
     * (nothing) at restore time.
     */
    it('catches up once the catalog arrives asynchronously, for a search term already restored', async () => {
      sessionStorage.setItem('quizSearchTerm', 'sig');

      const metadataApi: any = {
        load: jest.fn(() => of(CATALOG.map(([quizId]) => ({ quizId })))),
        difficultyByQuiz: signal(new Map<string, string | null>()),
        milestoneByQuiz: signal(new Map<string, string>()),
        summaryByQuiz: signal(new Map<string, string>()),
        imageByQuiz: signal(new Map<string, string>()),
        factsByQuiz: signal(new Map<string, readonly string[]>()),
        questionCountByQuiz: signal(new Map<string, number | null>()),
        imageFor: () => '',
        factsFor: () => []
      };

      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          provideNoopAnimations(),
          {
            provide: QuizService,
            useValue: {
              setQuizId: jest.fn(),
              setQuizStatus: jest.fn(),
              setCompletedQuizId: jest.fn(),
              setCheckedShuffle: jest.fn(),
              returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
              quizCompleted: false
            }
          },
          {
            provide: AchievementService,
            useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() }
          },
          { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
          { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
          { provide: LearningPathService, useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) } },
          { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
          { provide: SessionEngagementService, useValue: { engaged: () => false, markEngaged: jest.fn() } },
          { provide: TopicQuizMetadataService, useValue: metadataApi },
          { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } },
          { provide: LiveAnnouncer, useValue: createLiveAnnouncerMock() }
        ]
      });

      const fixture = TestBed.createComponent(QuizSelectionComponent);
      fixture.detectChanges();
      const liveAnnouncer = TestBed.inject(LiveAnnouncer) as unknown as LiveAnnouncerMock;

      // Catalog is still empty at this point — restored search term, but
      // no matching quizzes exist yet, so the announcement is correctly
      // silent (not a wrong non-zero count): the last call, if any, must
      // not be an `announce()` with real text.
      const lastBefore = liveAnnouncer._calls[liveAnnouncer._calls.length - 1];
      expect(lastBefore?.type).not.toBe('announce');

      // The catalog "arrives" now.
      metadataApi.difficultyByQuiz.set(new Map(CATALOG.map(([id, , d]) => [id, d])));
      metadataApi.milestoneByQuiz.set(new Map(CATALOG.map(([id, t]) => [id, t])));
      metadataApi.questionCountByQuiz.set(new Map(CATALOG.map(([id]) => [id, 5])));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const lastAfter = liveAnnouncer._calls[liveAnnouncer._calls.length - 1];
      expect(lastAfter).toEqual({ type: 'announce', message: '1 quiz found' });
    });

    it('navigate-away/back safety: destroying and recreating the component leaves a correct, working announcer (fresh state, no stale carryover)', async () => {
      const first = await render();
      await search(first, 'sig');
      expect(announcement(first)).toBe('1 quiz found');

      first.fixture.destroy();
      TestBed.resetTestingModule();

      const second = await render();
      expect(announcement(second)).toBeNull(); // fresh instance, fresh mock, fresh state

      await search(second, 'sig');
      expect(announcement(second)).toBe('1 quiz found');
    });
  });

  describe('persistence', () => {
    it('is NOT persisted: nothing about the filter reaches storage, and every visit starts on "All Difficulties"', async () => {
      const c = await render();
      await chooseDifficulty(c, 'advanced');

      const keys = [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
      expect(keys.filter((k) => /filter/i.test(k))).toEqual([]);
      expect(Object.values({ ...localStorage, ...sessionStorage })).not.toContain('advanced');

      TestBed.resetTestingModule(); // a fresh visit
      const fresh = await render();
      expect(fresh.comp.difficultyFilter()).toBe('all');
      expect(selectShows(fresh)).toBe('All Difficulties');
      expect(renderedIds(fresh)).toEqual(ASC_AZ);
    });
  });

  describe('keyboard and accessibility', () => {
    it('is a combobox named "Filter quizzes by difficulty" that exposes the selected value and its open state', async () => {
      const c = await render();

      expect(selectHost(c).getAttribute('role')).toBe('combobox');
      expect(selectHost(c).getAttribute('aria-label')).toBe('Filter quizzes by difficulty');
      expect(selectHost(c).getAttribute('aria-expanded')).toBe('false');
      expect(selectShows(c)).toBe('All Difficulties');

      await chooseDifficulty(c, 'advanced');
      expect(selectShows(c)).toBe('Advanced'); // the state is text, not just colour
    });

    it('can be operated from the keyboard: the arrow keys change the filter and the list follows', async () => {
      const c = await render();
      selectHost(c).focus();
      expect(document.activeElement).toBe(selectHost(c));

      selectHost(c).dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          code: 'ArrowDown',
          keyCode: 40,
          bubbles: true,
          cancelable: true
        })
      );
      await settle(c);

      expect(c.comp.difficultyFilter()).toBe('beginner');
      expect(renderedIds(c)).toEqual(ONLY.beginner.az);
      expect(document.activeElement).toBe(selectHost(c)); // focus is kept
    });

    it('sits in the normal tab order alongside the search box and the two sort buttons', async () => {
      const c = await render();
      const focusable = [searchInput(c), selectHost(c), difficultyBtn(c), alphaBtn(c)];

      expect(focusable.every((e) => e.tabIndex >= 0)).toBe(true);
      const order = Array.from(
        el(c).querySelectorAll('.toolbar input, .toolbar mat-select, .toolbar .sort-btn')
      );
      expect(order.slice(0, 4)).toEqual(focusable);
    });
  });
});

/**
 * Catalog stats accessible phrase — real Narrator scan-mode retest
 * CONFIRMED PASSING, localhost:4200, 2026-10-16 (see quiz-selection.
 * component.ts's own comment on `quizCountAccessibleLabelSig` for the
 * two reverted candidates and why this is the one that shipped).
 */
describe('QuizSelectionComponent — catalog stats accessible phrase (2026-10-16 candidate)', () => {
  const difficultyMap = new Map<string, string | null>([
    ['create-first-app', 'beginner'],
    ['dependency-injection', 'intermediate'],
    ['performance', 'advanced']
  ]);
  const milestoneMap = new Map<string, string>([
    ['create-first-app', 'Create Your First App'],
    ['dependency-injection', 'Dependency Injection'],
    ['performance', 'Performance']
  ]);
  const summaryMap = new Map<string, string>([
    ['create-first-app', 'Get started with Angular.'],
    ['dependency-injection', 'Learn DI.'],
    ['performance', 'Optimize your app.']
  ]);
  const questionCountMap = new Map<string, number | null>([
    ['create-first-app', 5],
    ['dependency-injection', 7],
    ['performance', 9]
  ]);
  const imageMap = new Map<string, string>();
  const factsMap = new Map<string, readonly string[]>();

  function render(): {
    fixture: ComponentFixture<QuizSelectionComponent>;
    comp: QuizSelectionComponent;
    metadataApi: any;
  } {
    sessionStorage.clear();
    localStorage.clear();

    const metadataApi: any = {
      load: jest.fn(() =>
        of([
          { quizId: 'create-first-app' },
          { quizId: 'dependency-injection' },
          { quizId: 'performance' }
        ])
      ),
      difficultyByQuiz: signal(difficultyMap),
      milestoneByQuiz: signal(milestoneMap),
      summaryByQuiz: signal(summaryMap),
      imageByQuiz: signal(imageMap),
      factsByQuiz: signal(factsMap),
      questionCountByQuiz: signal(questionCountMap),
      imageFor: (id: string) => imageMap.get(id) ?? '',
      factsFor: (id: string) => factsMap.get(id) ?? []
    };

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: {
            evaluate: jest.fn(() => []),
            summary: () => ({ earned: 0, total: 6 }),
            earnedIds: () => new Set()
          }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        {
          provide: LearningPathService,
          useValue: {
            recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 }))
          }
        },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        {
          provide: SessionEngagementService,
          useValue: { engaged: () => false, markEngaged: jest.fn() }
        },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
        {
          provide: InterviewWarmupCoordinatorService,
          useValue: { warmUp: jest.fn(() => of(undefined)) }
        }
      ]
    });

    const fixture = TestBed.createComponent(QuizSelectionComponent);
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance, metadataApi };
  }

  function statEl(fixture: ComponentFixture<QuizSelectionComponent>, labelText: string): HTMLElement {
    const stats = Array.from(fixture.nativeElement.querySelectorAll('.quiz-stats .stat')) as HTMLElement[];
    const match = stats.find((s) => s.querySelector('.stat-label')?.textContent?.trim() === labelText);
    if (!match) throw new Error(`No .stat found with label "${labelText}"`);
    return match;
  }

  it('exposes each number+label as one real, non-hidden, readable text node — not merely an attribute name', () => {
    const { fixture } = render();

    const quizzesStat = statEl(fixture, 'Quizzes');
    const hidden = quizzesStat.querySelector('.visually-hidden');
    expect(hidden).not.toBeNull();
    expect(hidden!.getAttribute('role')).toBe('group');
    expect(hidden!.getAttribute('aria-hidden')).not.toBe('true');
    expect(hidden!.textContent).toBe('3 Quizzes');

    const questionsStat = statEl(fixture, 'Questions');
    expect(questionsStat.querySelector('.visually-hidden')!.textContent).toBe('21 Questions');

    const beginnerStat = statEl(fixture, 'Beginner');
    expect(beginnerStat.querySelector('.visually-hidden')!.textContent).toBe('1 Beginner');
  });

  it('excludes the visible duplicate text from the accessibility tree via aria-hidden, without hiding it visually', () => {
    const { fixture } = render();
    const quizzesStat = statEl(fixture, 'Quizzes');

    const num = quizzesStat.querySelector('.stat-num') as HTMLElement;
    const label = quizzesStat.querySelector('.stat-label') as HTMLElement;
    expect(num.getAttribute('aria-hidden')).toBe('true');
    expect(label.getAttribute('aria-hidden')).toBe('true');
    // Visually present: no display:none/visibility:hidden on either —
    // only the duplicate TEXT is excluded from the accessibility tree,
    // never the real rendered content sighted users see.
    expect(num.style.display).not.toBe('none');
    expect(label.style.display).not.toBe('none');
    expect(num.hasAttribute('hidden')).toBe(false);
    expect(label.hasAttribute('hidden')).toBe(false);
  });

  it('adds no new Tab stop anywhere in the stats row', () => {
    const { fixture } = render();
    const focusable = fixture.nativeElement.querySelectorAll('.quiz-stats [tabindex]');
    expect(focusable.length).toBe(0);
    const groupRoles = Array.from(
      fixture.nativeElement.querySelectorAll('.quiz-stats [role="group"]')
    ) as HTMLElement[];
    // role="group" exists (on the visually-hidden text spans) but none of
    // them carry a tabindex — a role alone never adds focusability.
    expect(groupRoles.length).toBeGreaterThan(0);
    expect(groupRoles.every((el) => !el.hasAttribute('tabindex'))).toBe(true);
  });

  it('stays synchronized when the underlying catalog changes after first render', () => {
    const { fixture, metadataApi } = render();
    expect(statEl(fixture, 'Quizzes').querySelector('.visually-hidden')!.textContent).toBe('3 Quizzes');

    // Simulate a catalog update: a NEW quiz lands in the metadata signals.
    const newDifficulty = new Map(difficultyMap);
    newDifficulty.set('rxjs', 'advanced');
    const newQuestionCount = new Map(questionCountMap);
    newQuestionCount.set('rxjs', 12);
    const newMilestone = new Map(milestoneMap);
    newMilestone.set('rxjs', 'RxJS');
    metadataApi.difficultyByQuiz.set(newDifficulty);
    metadataApi.questionCountByQuiz.set(newQuestionCount);
    metadataApi.milestoneByQuiz.set(newMilestone);
    fixture.detectChanges();

    expect(statEl(fixture, 'Quizzes').querySelector('.visually-hidden')!.textContent).toBe('4 Quizzes');
    expect(statEl(fixture, 'Questions').querySelector('.visually-hidden')!.textContent).toBe('33 Questions');
    const advancedStats = Array.from(
      fixture.nativeElement.querySelectorAll('.quiz-stats .stat.level-advanced')
    ) as HTMLElement[];
    expect(advancedStats).toHaveLength(1);
    expect(advancedStats[0].querySelector('.visually-hidden')!.textContent).toBe('2 Advanced');
  });

  it('preserves appCountUp ownership of the visible .stat-num text', () => {
    const { fixture } = render();
    const quizzesStat = statEl(fixture, 'Quizzes');
    const num = quizzesStat.querySelector('.stat-num');
    expect(num?.getAttribute('appCountUp')).toBeNull(); // Angular input, not a static attr
    // appCountUp is still bound on the same element — confirmed by the
    // directive's own selector matching; the element wasn't replaced or
    // moved by this change (same two visible children, same order).
    const childFirstClass = Array.from(quizzesStat.children).map(
      (c) => c.className.split(' ')[0]
    );
    expect(childFirstClass).toEqual(['visually-hidden', 'stat-num', 'stat-label']);
  });
});

/**
 * Search: token matching (any order, non-consecutive, distinct title words).
 *
 * Every search word must be the START of its own title word; order and adjacency no longer matter
 * ("angular f" and "forms angular" both find "Angular Forms"; "forms" does not match inside "Platforms").
 * Driven through the component's own `searchTerm` / `difficultyFilter` signals and read back from `displayedQuizzes()`.
 */
describe('QuizSelectionComponent — search (token matching)', () => {
  const catalog: Array<[id: string, title: string, difficulty: string]> = [
    ['forms', 'Angular Forms', 'intermediate'],
    ['change-detection', 'Change Detection', 'advanced'],
    ['create-first-app', 'Create Your First App', 'beginner'],
    ['dependency-injection-advanced', 'Dependency Injection Advanced', 'advanced'],
    ['getting-started', 'Getting Started with Angular Forms', 'beginner'],
    ['platforms', 'Cross Platforms Guide', 'beginner']
  ];
  const ALL = catalog.map(([id]) => id).sort();

  function setup(): QuizSelectionComponent {
    sessionStorage.clear();
    localStorage.clear();
    const metadata: any = {
      load: jest.fn(() => of(catalog.map(([quizId]) => ({ quizId })))),
      difficultyByQuiz: signal(new Map(catalog.map(([id, , d]) => [id, d]))),
      milestoneByQuiz: signal(new Map(catalog.map(([id, t]) => [id, t]))),
      summaryByQuiz: signal(new Map(catalog.map(([id]) => [id, `About ${id}.`]))),
      imageByQuiz: signal(new Map<string, string>()),
      factsByQuiz: signal(new Map<string, readonly string[]>()),
      questionCountByQuiz: signal(new Map(catalog.map(([id]) => [id, 5]))),
      imageFor: () => '',
      factsFor: () => []
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        QuizSelectionComponent,
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() }
        },
        { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        {
          provide: LearningPathService,
          useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) }
        },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => false, markEngaged: jest.fn() } },
        { provide: TopicQuizMetadataService, useValue: metadata },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } },
        { provide: Router, useValue: { navigate: jest.fn().mockResolvedValue(true) } }
      ]
    });
    const comp = TestBed.inject(QuizSelectionComponent);
    comp.ngOnInit();
    return comp;
  }

  const found = (comp: QuizSelectionComponent, term: string): string[] => {
    comp.searchTerm.set(term);
    return comp.displayedQuizzes().map((q) => q.quizId).sort();
  };
  const ANGULAR_FORMS = ['forms', 'getting-started'];

  it('an empty search shows every quiz', () => {
    const comp = setup();
    expect(found(comp, '')).toEqual(ALL);
  });

  it.each([
    ['ang', ANGULAR_FORMS],
    ['angular', ANGULAR_FORMS],
    ['forms', ANGULAR_FORMS],
    ['dep', ['dependency-injection-advanced']],
    ['inj', ['dependency-injection-advanced']],
    ['adv', ['dependency-injection-advanced']],
    ['change', ['change-detection']]
  ])('single-word prefix "%s" still matches the start of ANY title word', (term, expected) => {
    expect(found(setup(), term)).toEqual(expected);
  });

  it.each([
    ['angular f', ANGULAR_FORMS],
    ['angular for', ANGULAR_FORMS],
    ['angular forms', ANGULAR_FORMS],
    ['ang for', ANGULAR_FORMS],
    ['dependency inj', ['dependency-injection-advanced']],
    ['injection adv', ['dependency-injection-advanced']],
    ['change det', ['change-detection']]
  ])('multi-word "%s" matches word prefixes', (term, expected) => {
    expect(found(setup(), term)).toEqual(expected);
  });

  it('a multi-word search can match words that start LATER in a longer title', () => {
    const comp = setup();
    expect(found(comp, 'with angular f')).toEqual(['getting-started']);
    expect(found(comp, 'started with angular')).toEqual(['getting-started']);
    expect(found(comp, 'with ang')).toEqual(['getting-started']);
  });

  it('is case-insensitive', () => {
    const comp = setup();
    expect(found(comp, 'ANGULAR F')).toEqual(ANGULAR_FORMS);
    expect(found(comp, 'Angular Forms')).toEqual(ANGULAR_FORMS);
    expect(found(comp, 'DEPENDENCY inj')).toEqual(['dependency-injection-advanced']);
  });

  it('ignores leading, trailing and repeated whitespace', () => {
    const comp = setup();
    expect(found(comp, ' angular f ')).toEqual(ANGULAR_FORMS);
    expect(found(comp, '   angular    f   ')).toEqual(ANGULAR_FORMS);
    expect(found(comp, '\tangular\tf\n')).toEqual(ANGULAR_FORMS);
  });

  it('keeps word boundaries: a search word must START a title word', () => {
    const comp = setup();
    expect(found(comp, 'ange')).toEqual([]); // inside "cHANGE Detection"
    expect(found(comp, 'orms')).toEqual([]); // inside "Angular fORMS"
    expect(found(comp, 'forms')).not.toContain('platforms'); // "Platforms" contains "forms" but does not start with it
    // "angularf" is "Angular" + the start of "Forms": an EXACT joined match.
    expect(found(comp, 'angularf')).toEqual(ANGULAR_FORMS);
    expect(comp.searchMatchMode()).toBe('exact');
  });

  it('INTENTIONAL CHANGE: word order and adjacency no longer matter', () => {
    const comp = setup();
    expect(found(comp, 'forms angular')).toEqual(ANGULAR_FORMS);
    expect(found(comp, 'started angular')).toEqual(['getting-started']);
    expect(found(comp, 'detection change')).toEqual(['change-detection']);
    expect(found(comp, 'getting forms')).toEqual(['getting-started']);
  });

  it('each search word needs its OWN title word', () => {
    const comp = setup();
    expect(found(comp, 'angular angular')).toEqual([]);
    expect(found(comp, 'forms forms')).toEqual([]);
  });

  it('empty, whitespace-only and punctuation-only searches match all', () => {
    const comp = setup();
    expect(found(comp, '   ')).toEqual(ALL);
    expect(found(comp, '!!!')).toEqual(ALL);
    expect(found(comp, ' - . , ')).toEqual(ALL);
  });

  it('a punctuation-only search is inactive: no result announcement', () => {
    const comp = setup();
    comp.searchTerm.set('!!!');
    expect(comp.searchResultAnnouncementSig()).toBe('');
    comp.searchTerm.set('   ');
    expect(comp.searchResultAnnouncementSig()).toBe('');
    comp.searchTerm.set('angular');
    expect(comp.searchResultAnnouncementSig()).toBe('2 quizzes found');
    // With only the difficulty filter narrowing, punctuation adds nothing.
    comp.difficultyFilter.set('advanced');
    comp.searchTerm.set('!!!');
    expect(comp.searchResultAnnouncementSig()).toBe('2 quizzes found');
    expect(comp.noResultsMessage()).toBe(
      'No quizzes match the selected difficulty.'
    );
  });

  it('a non-matching term shows nothing', () => {
    const comp = setup();
    expect(found(comp, 'nonexistent-topic')).toEqual([]);
    expect(found(comp, 'zzz')).toEqual([]);
    expect(found(comp, 'angular zzz')).toEqual([]);
  });

  it('only the title (milestone) is searched, not the summary or difficulty', () => {
    const comp = setup();
    expect(found(comp, 'about')).toEqual([]); // every summary starts "About ..."
    expect(found(comp, 'intermediate')).toEqual([]);
    expect(found(comp, 'beginner')).toEqual([]);
  });

  it('combines with the difficulty filter (a quiz must satisfy both)', () => {
    const comp = setup();
    comp.searchTerm.set('angular');
    comp.difficultyFilter.set('intermediate');
    expect(comp.displayedQuizzes().map((q) => q.quizId)).toEqual(['forms']);
    comp.difficultyFilter.set('beginner');
    expect(comp.displayedQuizzes().map((q) => q.quizId)).toEqual(['getting-started']);
    comp.difficultyFilter.set('advanced');
    expect(comp.displayedQuizzes()).toEqual([]);

    comp.searchTerm.set('angular f');
    comp.difficultyFilter.set('all');
    expect(comp.displayedQuizzes().map((q) => q.quizId).sort()).toEqual(ANGULAR_FORMS);

    comp.searchTerm.set('');
    comp.difficultyFilter.set('advanced');
    expect(comp.displayedQuizzes().map((q) => q.quizId).sort()).toEqual(['change-detection', 'dependency-injection-advanced']);
  });

  describe('typo fallback (close matches)', () => {
    it('shows close matches only when nothing matches exactly', () => {
      const comp = setup();
      comp.searchTerm.set('dependancy');
      expect(comp.searchMatchMode()).toBe('close');
      expect(comp.showingCloseMatches()).toBe(true);
      expect(comp.displayedQuizzes().map((q) => q.quizId)).toEqual([
        'dependency-injection-advanced'
      ]);
    });

    it('never mixes: an exact hit anywhere suppresses fuzzy results', () => {
      const comp = setup();
      comp.searchTerm.set('angular');
      expect(comp.searchMatchMode()).toBe('exact');
      expect(comp.showingCloseMatches()).toBe(false);
      expect(found(comp, 'angular').sort()).toEqual(ANGULAR_FORMS);
    });

    it('a difficulty filter hiding the exact hit does not trigger fuzzy', () => {
      const comp = setup();
      comp.searchTerm.set('angular');
      comp.difficultyFilter.set('advanced');
      expect(comp.searchMatchMode()).toBe('exact');
      expect(comp.displayedQuizzes()).toEqual([]);
      expect(comp.showingCloseMatches()).toBe(false);
    });

    it('applies the difficulty filter to close matches', () => {
      const comp = setup();
      comp.searchTerm.set('detecton');
      expect(comp.displayedQuizzes().map((q) => q.quizId)).toEqual([
        'change-detection'
      ]);
      comp.difficultyFilter.set('beginner');
      expect(comp.displayedQuizzes()).toEqual([]);
      expect(comp.showingCloseMatches()).toBe(false);
    });

    it('does not fuzzy-match short words or unrelated words', () => {
      const comp = setup();
      expect(found(comp, 'chnage')).toEqual(['change-detection']); // swap, 6
      expect(found(comp, 'fors')).toEqual([]); // 4 letters: swaps only
      expect(found(comp, 'fmo')).toEqual([]); // 3 letters: exact only
      expect(found(comp, 'react')).toEqual([]);
      expect(comp.searchMatchMode()).toBe('exact');
    });

    it('four-letter swaps are close matches (fomr, tmep, cahn)', () => {
      const comp = setup();
      expect(found(comp, 'fomr')).toEqual(ANGULAR_FORMS);
      expect(comp.searchMatchMode()).toBe('close');
      expect(found(comp, 'cahn')).toEqual(['change-detection']);
      expect(comp.searchMatchMode()).toBe('close');
      expect(comp.searchResultAnnouncementSig()).toBe(
        'No exact matches. 1 close match shown'
      );
    });

    it('joined words are exact matches and suppress fuzzy catalog-wide', () => {
      const comp = setup();
      expect(found(comp, 'angularf')).toEqual(ANGULAR_FORMS);
      expect(comp.searchMatchMode()).toBe('exact');
      expect(comp.showingCloseMatches()).toBe(false);
      expect(comp.searchResultAnnouncementSig()).toBe('2 quizzes found');
      expect(found(comp, 'angularfo')).toEqual(ANGULAR_FORMS);
      expect(found(comp, 'changede')).toEqual(['change-detection']);
      expect(comp.searchMatchMode()).toBe('exact');
      // A joined word uses up the words it spans.
      expect(found(comp, 'angularf forms')).toEqual([]);
    });

    it('announces close matches distinctly and exactly once per state', () => {
      const comp = setup();
      comp.searchTerm.set('dependancy');
      expect(comp.searchResultAnnouncementSig()).toBe(
        'No exact matches. 1 close match shown'
      );
      comp.searchTerm.set('angualr');
      expect(comp.searchResultAnnouncementSig()).toBe(
        'No exact matches. 2 close matches shown'
      );
      comp.searchTerm.set('angular');
      expect(comp.searchResultAnnouncementSig()).toBe('2 quizzes found');
      comp.searchTerm.set('');
      expect(comp.searchResultAnnouncementSig()).toBe('');
    });

    it('keeps the empty-state message when even fuzzy finds nothing', () => {
      const comp = setup();
      comp.searchTerm.set('zzzzzz');
      expect(comp.displayedQuizzes()).toEqual([]);
      expect(comp.noResultsMessage()).toBe('No quizzes match your search.');
    });

    it('inactive searches never enter close mode', () => {
      const comp = setup();
      for (const term of ['', '   ', '!!!']) {
        comp.searchTerm.set(term);
        expect(comp.searchMatchMode()).toBe('exact');
        expect(comp.showingCloseMatches()).toBe(false);
      }
    });
  });

  it('the no-results message still names the search when nothing matches', () => {
    const comp = setup();
    comp.searchTerm.set('zzz angular');
    expect(comp.displayedQuizzes()).toEqual([]);
    expect(comp.noResultsMessage()).toBe('No quizzes match your search.');
    comp.difficultyFilter.set('advanced');
    expect(comp.noResultsMessage()).toBe('No quizzes match your search and difficulty filter.');
  });
});

/**
 * Recommendation and tile state never promise a resume. Opening a quiz (tile
 * click / Introduction) is ACCESS tracking only; Topic Quizzes cannot resume,
 * so nothing may say "Continue" or "In Progress" for an unfinished quiz.
 * Question 1 navigation from the Introduction is covered by
 * introduction.component.spec.ts (resetUIAndNavigate(0)).
 */
describe('QuizSelectionComponent — no resume promise (recommendation + tile state)', () => {
  const catalog: Array<[id: string, title: string, difficulty: string]> = [
    ['create-first-app', 'Create Your First App', 'beginner'],
    ['templates', 'Templates', 'beginner'],
    ['directives', 'Directives', 'beginner']
  ];
  let router: { navigate: jest.Mock };

  function setup(): QuizSelectionComponent {
    sessionStorage.clear();
    localStorage.clear();
    router = { navigate: jest.fn().mockResolvedValue(true) };
    const metadata: any = {
      load: jest.fn(() => of(catalog.map(([quizId]) => ({ quizId })))),
      difficultyByQuiz: signal(new Map(catalog.map(([id, , d]) => [id, d]))),
      milestoneByQuiz: signal(new Map(catalog.map(([id, t]) => [id, t]))),
      summaryByQuiz: signal(new Map(catalog.map(([id]) => [id, 'About ' + id]))),
      imageByQuiz: signal(new Map<string, string>()),
      factsByQuiz: signal(new Map<string, readonly string[]>()),
      questionCountByQuiz: signal(new Map(catalog.map(([id]) => [id, 5]))),
      imageFor: () => '',
      factsFor: () => []
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        QuizSelectionComponent,
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: {
            evaluate: jest.fn(() => []),
            summary: () => ({ earned: 0, total: 6 }),
            earnedIds: () => new Set()
          }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => true, markEngaged: jest.fn() } },
        { provide: TopicQuizMetadataService, useValue: metadata },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } },
        { provide: Router, useValue: router }
        // LearningPathService is deliberately REAL: it is the unit under test.
      ]
    });
    const comp = TestBed.inject(QuizSelectionComponent);
    comp.ngOnInit();
    return comp;
  }

  const rec = (comp: QuizSelectionComponent) => comp.learningPath().recommendation;
  const stateOf = (comp: QuizSelectionComponent, id: string) =>
    comp.quizCardProgress().get(id)?.state;
  const noResumeWording = (comp: QuizSelectionComponent): void => {
    const r = rec(comp);
    expect(r?.actionLabel).toBe('Start Quiz');
    expect(r?.reason ?? '').not.toMatch(/left off|continue/i);
  };

  it('never-opened quiz: not started, recommends the intro quiz with "Start Quiz"', () => {
    const comp = setup();
    expect(stateOf(comp, 'directives')).toBe('not-started');
    expect(rec(comp)?.quizId).toBe('create-first-app');
    noResumeWording(comp);
    expect(comp.accessedCount()).toBe(0);
  });

  it('Introduction-only visit: still "Start Quiz"; access is tracked separately', async () => {
    const comp = setup();
    await comp.onSelect('directives', 0);

    // Navigates to the Introduction of that quiz (Start there begins at Q1).
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['intro/', 'directives']);

    // Access tracking is intact: counter + sessionStorage keep the quiz id.
    expect(comp.accessedCount()).toBe(1);
    expect(JSON.parse(sessionStorage.getItem('startedQuizIds') ?? '[]')).toEqual([
      'directives'
    ]);

    // ...but it is NOT presented as a resumable attempt.
    expect(stateOf(comp, 'directives')).toBe('not-started');
    expect(comp.quizCardProgress().get('directives')?.state).not.toBe('in-progress');
    noResumeWording(comp);
    for (const [, entry] of comp.quizCardProgress()) {
      expect(entry.state).not.toBe('in-progress');
    }
  });

  it('partially answered quiz: leftover answer data does not create "Continue"', async () => {
    const comp = setup();
    await comp.onSelect('directives', 0);
    // What an abandoned, half-answered run leaves behind.
    localStorage.setItem('savedQuestionIndex', '3');
    localStorage.setItem('selectedOptionsMap', JSON.stringify({ 0: [1], 1: [2] }));
    sessionStorage.setItem('userAnswers', JSON.stringify([1, 2]));

    expect(stateOf(comp, 'directives')).toBe('not-started');
    noResumeWording(comp);
    // Opening it again still goes to the Introduction, not a question.
    await comp.onSelect('directives', 0);
    expect(router.navigate).toHaveBeenLastCalledWith(['intro/', 'directives']);
  });

  it('completed quiz: unchanged — completed state, follow-up recommendation, Results', async () => {
    const comp = setup();
    sessionStorage.setItem('completedQuizIds', JSON.stringify(['create-first-app']));
    comp.ngOnInit(); // re-read sessionStorage

    expect(stateOf(comp, 'create-first-app')).toBe('completed');
    expect(rec(comp)?.quizId).toBe('templates'); // follow-up of the completed quiz
    noResumeWording(comp);

    await comp.onSelect('create-first-app', 0);
    expect(router.navigate).toHaveBeenLastCalledWith(['results/', 'create-first-app']);
  });

  it('accessed-quizzes counter still counts every opened quiz (and completed ones)', async () => {
    const comp = setup();
    await comp.onSelect('directives', 0);
    await comp.onSelect('templates', 1);
    await comp.onSelect('directives', 0); // same quiz again: no double count
    expect(comp.accessedCount()).toBe(2);
    expect(
      JSON.parse(sessionStorage.getItem('startedQuizIds') ?? '[]').sort()
    ).toEqual(['directives', 'templates']);
    // Nothing is promoted to a resumable state.
    for (const [, entry] of comp.quizCardProgress()) {
      expect(entry.state).toBe('not-started');
    }
  });

  it('the opened quiz is still recommended only on its merits, never as "Continue"', async () => {
    const comp = setup();
    sessionStorage.setItem('completedQuizIds', JSON.stringify(['create-first-app', 'templates']));
    comp.ngOnInit();
    await comp.onSelect('directives', 0); // opened, not completed
    expect(rec(comp)?.quizId).toBe('directives'); // next in the topic order
    noResumeWording(comp);
  });
});

/**
 * "Recommended for Review": once every quiz is complete, the completed quiz
 * whose LATEST valid topic-quiz attempt scored lowest. History only; never a
 * best-score fallback. Pure rules are covered in review-candidate.spec.ts.
 */
describe('QuizSelectionComponent — Recommended for Review', () => {
  const catalog: Array<[id: string, title: string, difficulty: string]> = [
    ['forms', 'Forms', 'intermediate'],
    ['pipes', 'Pipes', 'beginner'],
    ['http', 'HTTP', 'advanced']
  ];
  const IDS = catalog.map(([id]) => id);
  let router: { navigate: jest.Mock };

  const rec = (
    topicId: string,
    correct: number,
    total: number,
    completedAt: string,
    source = 'topic-quiz'
  ) => ({
    attemptId: source + ':' + topicId + ':' + completedAt,
    source,
    completedAt,
    topicId,
    topicName: topicId,
    correct,
    total
  });

  function setup(opts: { completed?: string[]; records?: unknown[] } = {}) {
    sessionStorage.clear();
    localStorage.clear();
    sessionStorage.setItem('completedQuizIds', JSON.stringify(opts.completed ?? IDS));
    if (opts.records) {
      localStorage.setItem(
        'topicPerformanceHistory:v1',
        JSON.stringify({ version: 1, records: opts.records })
      );
    }
    router = { navigate: jest.fn().mockResolvedValue(true) };
    const metadata: any = {
      load: jest.fn(() => of(catalog.map(([quizId]) => ({ quizId })))),
      difficultyByQuiz: signal(new Map(catalog.map(([id, , d]) => [id, d]))),
      milestoneByQuiz: signal(new Map(catalog.map(([id, tt]) => [id, tt]))),
      summaryByQuiz: signal(new Map(catalog.map(([id]) => [id, 'About ' + id]))),
      imageByQuiz: signal(new Map<string, string>()),
      factsByQuiz: signal(new Map<string, readonly string[]>()),
      questionCountByQuiz: signal(new Map(catalog.map(([id]) => [id, 5]))),
      imageFor: () => '',
      factsFor: () => []
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        QuizSelectionComponent,
        {
          provide: QuizService,
          useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({
              startedQuizId: '',
              continueQuizId: '',
              quizCompleted: false
            }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() }
        },
        {
          provide: ProgressService,
          useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) }
        },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => true, markEngaged: jest.fn() } },
        { provide: TopicQuizMetadataService, useValue: metadata },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } },
        { provide: Router, useValue: router }
        // LearningPathService and TopicPerformanceHistoryService are REAL.
      ]
    });
    const comp = TestBed.inject(QuizSelectionComponent);
    comp.ngOnInit();
    return comp;
  }

  const D1 = '2026-10-01T10:00:00.000Z';
  const D2 = '2026-10-02T10:00:00.000Z';
  const D3 = '2026-10-03T10:00:00.000Z';

  it('recommends the lowest latest score when every quiz is complete', () => {
    const comp = setup({
      records: [rec('forms', 9, 10, D1), rec('pipes', 4, 10, D1), rec('http', 7, 10, D1)]
    });
    expect(comp.learningPath().allComplete).toBe(true);
    expect(comp.reviewRecommendation()).toEqual({
      quizId: 'pipes',
      title: 'Pipes',
      difficulty: 'beginner',
      latestPercent: 40,
      completedAt: D1
    });
  });

  it('keeps the Learning Path Complete state (no next-quiz recommendation)', () => {
    const comp = setup({ records: [rec('pipes', 4, 10, D1)] });
    const lp = comp.learningPath();
    expect(lp.allComplete).toBe(true);
    expect(lp.recommendation).toBeNull();
    expect(lp.totalCount).toBe(3);
  });

  it('is absent while any quiz is incomplete', () => {
    const comp = setup({
      completed: ['forms', 'pipes'],
      records: [rec('forms', 1, 10, D1), rec('pipes', 2, 10, D1)]
    });
    expect(comp.learningPath().allComplete).toBe(false);
    expect(comp.reviewRecommendation()).toBeNull();
  });

  it('is absent when there is no valid history (no best-score fallback)', () => {
    expect(setup().reviewRecommendation()).toBeNull();
    expect(
      setup({ records: [rec('pipes', 0, 0, D1), rec('forms', 3, 10, 'nope')] })
        .reviewRecommendation()
    ).toBeNull();
  });

  it('skips completed quizzes without history and ignores malformed records', () => {
    const comp = setup({
      records: [
        rec('forms', 6, 10, D1),
        rec('http', 99, 10, D1), // correct > total: ignored
        { not: 'a record' },
        rec('pipes', 0, 10, D1, 'weak-areas-practice') // excluded source
      ]
    });
    const r = comp.reviewRecommendation();
    expect(r?.quizId).toBe('forms');
    expect(r?.latestPercent).toBe(60);
  });

  it('uses the latest attempt, not the best', () => {
    const comp = setup({
      records: [
        rec('pipes', 10, 10, D1), // best
        rec('pipes', 5, 10, D3), // latest
        rec('forms', 7, 10, D2),
        rec('http', 8, 10, D2)
      ]
    });
    expect(comp.reviewRecommendation()?.quizId).toBe('pipes');
    expect(comp.reviewRecommendation()?.latestPercent).toBe(50);
  });

  it('a retake updates the recommendation reactively', () => {
    const comp = setup({
      records: [rec('forms', 6, 10, D1), rec('pipes', 4, 10, D1), rec('http', 8, 10, D1)]
    });
    expect(comp.reviewRecommendation()?.quizId).toBe('pipes');
    // Pipes retaken and improved; the history signal drives the computed.
    TestBed.inject(TopicPerformanceHistoryService).record(
      'quiz:pipes:retake',
      'topic-quiz',
      [{ topicId: 'pipes', topicName: 'Pipes', correct: 10, total: 10 }]
    );
    expect(comp.reviewRecommendation()?.quizId).toBe('forms');
    expect(comp.reviewRecommendation()?.latestPercent).toBe(60);
  });

  it('breaks ties deterministically', () => {
    const records = [rec('forms', 5, 10, D2), rec('pipes', 5, 10, D1), rec('http', 9, 10, D1)];
    expect(setup({ records }).reviewRecommendation()?.quizId).toBe('pipes');
    expect(setup({ records: [...records].reverse() }).reviewRecommendation()?.quizId).toBe('pipes');
  });

  it('survives a reload: the same result is rebuilt from stored history', () => {
    const records = [rec('forms', 3, 10, D1), rec('pipes', 8, 10, D1), rec('http', 9, 10, D1)];
    const first = setup({ records }).reviewRecommendation();
    const reloaded = setup({ records }).reviewRecommendation();
    expect(reloaded).toEqual(first);
    expect(reloaded?.quizId).toBe('forms');
  });

  it('"Review Quiz" opens the quiz Introduction, never Results', async () => {
    const comp = setup({ records: [rec('pipes', 4, 10, D1)] });
    await comp.onReviewQuiz(comp.reviewRecommendation()!.quizId);
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['intro/', 'pipes']);
    expect(router.navigate).not.toHaveBeenCalledWith(['results/', 'pipes']);
  });

  it('reviewing does not write quiz-access tracking or change progress', async () => {
    const comp = setup({ records: [rec('pipes', 4, 10, D1)] });
    const before = sessionStorage.getItem('startedQuizIds');
    await comp.onReviewQuiz('pipes');
    expect(sessionStorage.getItem('startedQuizIds')).toBe(before);
    expect(comp.learningPath().allComplete).toBe(true);
    expect(comp.reviewRecommendation()?.quizId).toBe('pipes');
  });

  it('ignores an empty quiz id', async () => {
    const comp = setup({ records: [rec('pipes', 4, 10, D1)] });
    await comp.onReviewQuiz('');
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
