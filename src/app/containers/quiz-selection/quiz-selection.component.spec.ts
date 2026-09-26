import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { provideRouter, Router } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
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
    load: jest.fn(() => of([
      { quizId: 'create-first-app' },
      { quizId: 'dependency-injection' },
      { quizId: 'performance' }
    ])),
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
          provide: QuizService, useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
            quizCompleted: false
          }
        },
        { provide: AchievementService, useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() } },
        { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        { provide: LearningPathService, useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => false, markEngaged: jest.fn() } },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } },
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
    const byId = new Map(list.map(q => [q.quizId, q]));
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
    expect(comp.displayedQuizzes().map(q => q.quizId)).toEqual(['dependency-injection']);

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
    expect(comp.displayedQuizzes().map(q => q.quizId)).toEqual([
      'create-first-app', 'dependency-injection', 'performance'
    ]);

    comp.sortDifficulty.set('desc');
    expect(comp.displayedQuizzes().map(q => q.quizId)).toEqual([
      'performance', 'dependency-injection', 'create-first-app'
    ]);
  });

  it('reads completed/started status from sessionStorage alone, never a bank Quiz.status', () => {
    const comp = setup();
    sessionStorage.setItem('completedQuizIds', JSON.stringify(['create-first-app']));
    sessionStorage.setItem('startedQuizIds', JSON.stringify(['dependency-injection']));
    comp.ngOnInit();

    const byId = new Map(comp.quizzes().map(q => [q.quizId, q]));
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
          provide: QuizService, useValue: {
            setQuizId: jest.fn(), setQuizStatus: jest.fn(), setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
            quizCompleted: false
          }
        },
        {
          provide: AchievementService,
          useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: opts.earnedAchievements ?? 0, total: 6 }), earnedIds: () => new Set() }
        },
        { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        { provide: LearningPathService, useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => opts.engaged ?? false, markEngaged: jest.fn() } },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } },
        { provide: Router, useValue: router }
        // InterviewHistoryService: intentionally NOT stubbed — the real,
        // root-provided, localStorage-backed service is used, so a seeded
        // `interviewAttemptHistory:v2` is read exactly as production does.
      ]
    });
  }

  // Clears storage, configures TestBed, THEN instantiates — mirrors the
  // bank-absence block's setup() so a test can seed localStorage beforehand.
  function setup(opts?: { engaged?: boolean; earnedAchievements?: number }): QuizSelectionComponent {
    configureTestBed(opts);
    const comp = TestBed.inject(QuizSelectionComponent);
    comp.ngOnInit();
    return comp;
  }

  /** A minimal, valid interviewAttemptHistory:v2 store `validateAttemptEntry` accepts. */
  function seedInterviewHistory(over: Record<string, unknown> = {}): void {
    localStorage.setItem('interviewAttemptHistory:v2', JSON.stringify({
      version: 2,
      attempts: [{
        id: 'att_1', completedAt: '2026-08-01T10:00:00.000Z',
        score: 7, totalQuestions: 10, percentage: 70, completionReason: 'submitted',
        ...over
      }]
    }));
  }

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
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
    seedInterviewHistory({ configKind: 'preset', presetId: 'junior', presetName: 'Junior Angular Developer', configuredDifficulty: undefined });
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
    localStorage.setItem('interviewAttemptHistory:v2', JSON.stringify({ version: 2, attempts: [] }));
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

  function render(opts: { engaged?: boolean; seed?: () => void } = {}): ComponentFixture<QuizSelectionComponent> {
    sessionStorage.clear();
    localStorage.clear();
    markEngaged.mockClear();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: QuizService, useValue: {
            setQuizId: jest.fn(), setQuizStatus: jest.fn(), setCompletedQuizId: jest.fn(), setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
            quizCompleted: false
          }
        },
        { provide: AchievementService, useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() } },
        { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        { provide: LearningPathService, useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => opts.engaged ?? false, markEngaged } },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } }
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
    localStorage.setItem('interviewAttemptHistory:v2', JSON.stringify({
      version: 2,
      attempts: [{
        id: 'att_1', completedAt: '2026-08-01T10:00:00.000Z', score: 7, totalQuestions: 10,
        percentage: 70, completionReason: 'submitted', ...over
      }]
    }));
  };
  const q = (f: ComponentFixture<QuizSelectionComponent>, sel: string): HTMLElement | null =>
    f.nativeElement.querySelector(sel);

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  describe('the entry link', () => {
    it('is present with NO progress at all — a new user can reach /progress', () => {
      const f = render();
      const link = q(f, 'a.progress-entry__link') as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect((link.textContent ?? '').trim()).toBe('View Your Progress');
      expect(link.getAttribute('href')).toBe('/progress');
      // ...while the gated content is (correctly) still hidden for that same user.
      expect(q(f, '.achievements-summary-row')).toBeNull();
    });

    it('is present WITH progress too', () => {
      const f = render({ engaged: true });
      expect(q(f, 'a.progress-entry__link')).not.toBeNull();
      expect(q(f, '.achievements-summary-row')).not.toBeNull();
    });

    it('is a real link, and appears exactly once', () => {
      const f = render({ engaged: true });
      const links = f.nativeElement.querySelectorAll('a.progress-entry__link');
      expect(links).toHaveLength(1);
      expect(links[0].tagName).toBe('A');
    });

    it('navigates to /progress with NO side effects: no engagement, no storage, no history change', () => {
      const f = render();
      const before = { local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) };

      (q(f, 'a.progress-entry__link') as HTMLAnchorElement).click();

      expect(navigateByUrl).toHaveBeenCalledTimes(1);
      expect(navigateByUrl.mock.calls[0][0].toString()).toBe('/progress');
      expect(markEngaged).not.toHaveBeenCalled();
      expect(JSON.stringify({ ...localStorage })).toBe(before.local);
      expect(JSON.stringify({ ...sessionStorage })).toBe(before.session);
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
      const f = render({ seed: () => seedInterview({ configKind: 'preset', presetId: 'junior', presetName: 'Junior Angular Developer' }) });
      expect(q(f, '.achievements-summary-row')).not.toBeNull();
    });

    it('an empty Interview store does NOT open the gate (no false positive)', () => {
      const f = render({ seed: () => localStorage.setItem('interviewAttemptHistory:v2', JSON.stringify({ version: 2, attempts: [] })) });
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

  function render(): { fixture: ComponentFixture<QuizSelectionComponent>; comp: QuizSelectionComponent } {
    sessionStorage.clear();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: QuizService, useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
            quizCompleted: false
          }
        },
        { provide: AchievementService, useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() } },
        { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        { provide: LearningPathService, useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => false, markEngaged: jest.fn() } },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } }
      ]
    });

    // Real Router (via provideRouter) so RouterLink/RouterLinkActive on the
    // status-icon link and the tile work exactly as they do in the app;
    // navigate() itself is spied rather than replaced, so onSelect()'s real
    // call still resolves.
    router = { navigate: jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true) as any };

    const fixture = TestBed.createComponent(QuizSelectionComponent);
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance };
  }

  it('renders the tile\'s activation control as a real native <button>, not a non-semantic clickable container', () => {
    const { fixture } = render();
    const activateBtn: HTMLElement | null =
      fixture.nativeElement.querySelector('.quiz-tile:not(.interview-tile) .quiz-tile__activate');

    expect(activateBtn).not.toBeNull();
    expect(activateBtn!.tagName).toBe('BUTTON');
    expect(activateBtn!.getAttribute('type')).toBe('button');
  });

  it('the button\'s accessible name is derived from the tile\'s own visible title and summary', () => {
    const { fixture } = render();
    const activateBtn: HTMLElement =
      fixture.nativeElement.querySelector('.quiz-tile:not(.interview-tile) .quiz-tile__activate');
    const labelledBy = (activateBtn.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean);

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
    const activateBtn: HTMLElement =
      fixture.nativeElement.querySelector('.quiz-tile:not(.interview-tile) .quiz-tile__activate');

    activateBtn.click();

    expect(spy).toHaveBeenCalledWith('create-first-app', 0);
  });

  it('the outer tile container itself no longer owns the click handler — only the button does', () => {
    const { fixture, comp } = render();
    const spy = jest.spyOn(comp, 'onSelect');
    const tile: HTMLElement = fixture.nativeElement.querySelector('.quiz-tile:not(.interview-tile)');

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
    'typescript', 'create-first-app', 'templates', 'dependency-injection',
    'component-tree', 'router', 'material', 'forms', 'performance'
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

  function render(): { fixture: ComponentFixture<QuizSelectionComponent>; comp: QuizSelectionComponent } {
    sessionStorage.clear();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        {
          provide: QuizService, useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
            quizCompleted: false
          }
        },
        { provide: AchievementService, useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() } },
        { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        { provide: LearningPathService, useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => false, markEngaged: jest.fn() } },
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } }
      ]
    });

    router = { navigate: jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true) as any };

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
    const tile: HTMLElement = fixture.nativeElement.querySelector('.quiz-tile:not(.interview-tile)');
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

  it('sort still renders each tile\'s image matched to ITS OWN quiz, not a stale/shifted index', () => {
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
  function render(): { fixture: ComponentFixture<QuizSelectionComponent>; http: HttpTestingController } {
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
          provide: QuizService, useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
            quizCompleted: false
          }
        },
        { provide: AchievementService, useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() } },
        { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        { provide: LearningPathService, useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => false, markEngaged: jest.fn() } }
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

    http.match((req) => req.url === 'http://node.test/api/quizzes').forEach((r) => r.flush({ quizzes: [] }));
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
      healthReq.error(new ProgressEvent('error'), { status: 503, statusText: 'Service Unavailable' })
    ).not.toThrow();

    // Nothing on this Node-owned page reacts to it at all.
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.quiz-grid')).not.toBeNull();

    http.match((req) => req.url === 'http://node.test/api/quizzes').forEach((r) => r.flush({ quizzes: [] }));
  });

  it('destroying QuizSelectionComponent does NOT cancel the app-scoped in-flight warm-up', () => {
    const { fixture, http } = render();
    fixture.detectChanges();

    const healthReq = http.expectOne((req) => req.url === 'http://spring.test/api/health');
    expect(() => fixture.destroy()).not.toThrow();
    expect(healthReq.cancelled).toBe(false);

    // Still resolvable after destruction, with no observable effect.
    expect(() => healthReq.flush({ status: 'UP' })).not.toThrow();

    http.match((req) => req.url === 'http://node.test/api/quizzes').forEach((r) => r.flush({ quizzes: [] }));
  });

  it('the warm-up never goes to Node, and Node metadata never goes to Spring', () => {
    const { fixture, http } = render();
    fixture.detectChanges();

    expect(http.match((req) => req.url === 'http://node.test/api/health')).toHaveLength(0);
    expect(http.match((req) => req.url === 'http://spring.test/api/quizzes')).toHaveLength(0);

    http.expectOne((req) => req.url === 'http://spring.test/api/health').flush({ status: 'UP' });
    http.match((req) => req.url === 'http://node.test/api/quizzes').forEach((r) => r.flush({ quizzes: [] }));
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
  const DESC_AZ = ['architecture', 'performance', 'directives', 'signals', 'bindings', 'components'];
  const DESC_ZA = ['performance', 'architecture', 'signals', 'directives', 'components', 'bindings'];

  const titleOf = (id: string): string => CATALOG.find(([qid]) => qid === id)![1];
  const AZ = 'A–Z';
  const ZA = 'Z–A';

  function render(seed?: () => void): { fixture: ComponentFixture<QuizSelectionComponent>; comp: QuizSelectionComponent } {
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
          provide: QuizService, useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
            quizCompleted: false
          }
        },
        { provide: AchievementService, useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() } },
        { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        { provide: LearningPathService, useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => false, markEngaged: jest.fn() } },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } }
      ]
    });

    const fixture = TestBed.createComponent(QuizSelectionComponent);
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance };
  }

  // ── reading and driving the REAL rendered controls / tiles ─────────
  type Ctx = ReturnType<typeof render>;
  const el = ({ fixture }: Ctx): HTMLElement => fixture.nativeElement;
  const difficultyBtn = (c: Ctx): HTMLButtonElement => el(c).querySelector('.toolbar .sort-btn--difficulty')!;
  const alphaBtn = (c: Ctx): HTMLButtonElement => el(c).querySelector('.toolbar .sort-btn--alpha')!;
  const btnText = (b: HTMLButtonElement): string => b.querySelector('.sort-btn__text')!.textContent!.trim();
  const arrow = (c: Ctx): string => difficultyBtn(c).querySelector('mat-icon')!.textContent!.trim();
  /** The tile order the USER sees, as quiz ids (via the rendered titles). */
  const renderedIds = (c: Ctx): string[] =>
    Array.from(el(c).querySelectorAll('.quiz-title')).map((t) => {
      const title = t.textContent!.trim();
      return CATALOG.find(([, ttl]) => ttl === title)![0];
    });
  const click = (c: Ctx, btn: HTMLButtonElement): void => { btn.click(); c.fixture.detectChanges(); };

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
      expect(c.comp.displayedQuizzes().map((q) => q.difficulty))
        .toEqual(['beginner', 'beginner', 'intermediate', 'intermediate', 'advanced', 'advanced']);
    });

    it('Difficulty ↓: Advanced → Intermediate → Beginner', () => {
      const c = render();
      click(c, difficultyBtn(c));

      expect(renderedIds(c)).toEqual(DESC_AZ);
      expect(c.comp.displayedQuizzes().map((q) => q.difficulty))
        .toEqual(['advanced', 'advanced', 'intermediate', 'intermediate', 'beginner', 'beginner']);
    });

    it('is NOT a plain alphabetical sort of the strings (that would put "advanced" before "beginner")', () => {
      const c = render();

      const firstGroup = c.comp.displayedQuizzes().slice(0, 2).map((q) => q.difficulty);
      expect(firstGroup).toEqual(['beginner', 'beginner']);
      const alphabeticalStrings = [...CATALOG.map(([, , d]) => d)].sort();
      expect(alphabeticalStrings[0]).toBe('advanced');   // what a string sort would have led with
      expect(c.comp.displayedQuizzes()[0].difficulty).not.toBe(alphabeticalStrings[0]);
    });
  });

  describe('the buttons toggle', () => {
    it('Difficulty: ↑ ↔ ↓ — arrow, accessible name and tile order all follow', () => {
      const c = render();
      expect([arrow(c), difficultyBtn(c).getAttribute('aria-label')]).toEqual(['arrow_upward', 'Sort by difficulty ascending']);

      click(c, difficultyBtn(c));
      expect([arrow(c), difficultyBtn(c).getAttribute('aria-label')]).toEqual(['arrow_downward', 'Sort by difficulty descending']);
      expect(renderedIds(c)).toEqual(DESC_AZ);
      expect(c.comp.sortDifficulty()).toBe('desc');

      click(c, difficultyBtn(c));
      expect([arrow(c), difficultyBtn(c).getAttribute('aria-label')]).toEqual(['arrow_upward', 'Sort by difficulty ascending']);
      expect(renderedIds(c)).toEqual(ASC_AZ);
      expect(c.comp.sortDifficulty()).toBe('asc');
    });

    it('A–Z ↔ Z–A still works — reverses order WITHIN each difficulty and leaves the groups where they are', () => {
      const c = render();
      expect([btnText(alphaBtn(c)), alphaBtn(c).getAttribute('aria-label')]).toEqual([AZ, 'Sort alphabetically A to Z']);

      click(c, alphaBtn(c));
      expect([btnText(alphaBtn(c)), alphaBtn(c).getAttribute('aria-label')]).toEqual([ZA, 'Sort alphabetically Z to A']);
      expect(renderedIds(c)).toEqual(ASC_ZA);
      // Same three groups in the same order — only the order inside each changed.
      expect(c.comp.displayedQuizzes().map((q) => q.difficulty))
        .toEqual(['beginner', 'beginner', 'intermediate', 'intermediate', 'advanced', 'advanced']);
      expect(c.comp.sortAlpha()).toBe('za');

      click(c, alphaBtn(c));
      expect(btnText(alphaBtn(c))).toBe(AZ);
      expect(renderedIds(c)).toEqual(ASC_AZ);
      expect(c.comp.sortAlpha()).toBe('az');
    });

    it('switching between the two: each button changes only its own dimension, and the rendered order composes correctly every time', () => {
      const c = render();
      const step = (btn: HTMLButtonElement, expected: string[], difficulty: string, alpha: string, arrowIcon: string, alphaText: string): void => {
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
      document.body.appendChild(el(c));   // focus needs an attached element
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
      c.comp.searchTerm.set('angular');   // word-start match: everything except "Performance Tuning"
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
      click(c, difficultyBtn(c));   // desc / az

      c.comp.searchTerm.set('zzz-no-such-topic');
      c.fixture.detectChanges();
      expect(renderedIds(c)).toEqual([]);
      click(c, alphaBtn(c));        // buttons keep working over an empty result

      c.comp.searchTerm.set('');
      c.fixture.detectChanges();
      expect(renderedIds(c)).toEqual(DESC_ZA);
    });

    it('search matches only the title (not the difficulty), exactly as before', () => {
      const c = render();
      c.comp.searchTerm.set('advanced');   // a difficulty, not a title word
      c.fixture.detectChanges();

      expect(renderedIds(c)).toEqual([]);
    });
  });

  describe('persistence is unchanged', () => {
    it('still stores the same two keys with the same values', () => {
      const c = render();
      expect([localStorage.getItem('quizSortDifficulty'), localStorage.getItem('quizSortAlpha')]).toEqual(['asc', 'az']);

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
  const DESC_AZ = ['architecture', 'performance', 'directives', 'signals', 'bindings', 'components'];
  const DESC_ZA = ['performance', 'architecture', 'signals', 'directives', 'components', 'bindings'];
  // … and the members of each single difficulty, A–Z then Z–A.
  const ONLY: Record<'beginner' | 'intermediate' | 'advanced', { az: string[]; za: string[] }> = {
    beginner: { az: ['bindings', 'components'], za: ['components', 'bindings'] },
    intermediate: { az: ['directives', 'signals'], za: ['signals', 'directives'] },
    advanced: { az: ['architecture', 'performance'], za: ['performance', 'architecture'] }
  };
  const LABEL: Record<string, string> = {
    all: 'All Difficulties', beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced'
  };

  async function render(catalog: ReadonlyArray<Row> = CATALOG) {
    sessionStorage.clear();
    localStorage.clear();

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
          provide: QuizService, useValue: {
            setQuizId: jest.fn(),
            setQuizStatus: jest.fn(),
            setCompletedQuizId: jest.fn(),
            setCheckedShuffle: jest.fn(),
            returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
            quizCompleted: false
          }
        },
        { provide: AchievementService, useValue: { evaluate: jest.fn(() => []), summary: () => ({ earned: 0, total: 6 }), earnedIds: () => new Set() } },
        { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
        { provide: BestScoreService, useValue: { getBestScores: () => ({}) } },
        { provide: LearningPathService, useValue: { recommend: jest.fn(() => ({ recommendation: null, allComplete: false, totalCount: 0 })) } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => false, markEngaged: jest.fn() } },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } }
      ]
    });

    const fixture = TestBed.createComponent(QuizSelectionComponent);
    fixture.detectChanges();
    await fixture.whenStable();   // MatSelect applies its initial selection in a microtask
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance, catalog };
  }

  type Ctx = Awaited<ReturnType<typeof render>>;
  const el = (c: Ctx): HTMLElement => c.fixture.nativeElement;
  const selectHost = (c: Ctx): HTMLElement => el(c).querySelector('.toolbar app-quiz-difficulty-filter mat-select')!;
  const selectShows = (c: Ctx): string =>
    (el(c).querySelector('.toolbar .mat-mdc-select-value')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const difficultyBtn = (c: Ctx): HTMLButtonElement => el(c).querySelector('.toolbar .sort-btn--difficulty')!;
  const alphaBtn = (c: Ctx): HTMLButtonElement => el(c).querySelector('.toolbar .sort-btn--alpha')!;
  const searchInput = (c: Ctx): HTMLInputElement => el(c).querySelector('.toolbar app-quiz-search input')!;
  const titles = (c: Ctx): string[] =>
    Array.from(el(c).querySelectorAll('.quiz-title')).map((t) => t.textContent!.trim());
  const renderedIds = (c: Ctx): string[] =>
    titles(c).map((title) => c.catalog.find(([, ttl]) => ttl === title)![0]);
  const noResults = (c: Ctx): HTMLElement[] => Array.from(el(c).querySelectorAll<HTMLElement>('.no-results'));
  const announcement = (c: Ctx): string | null =>
    el(c).querySelector('.visually-hidden[role="status"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

  async function settle(c: Ctx): Promise<void> {
    c.fixture.detectChanges();
    await c.fixture.whenStable();
    c.fixture.detectChanges();
  }
  /** Choose an option in the REAL select, the way a user does. */
  async function chooseDifficulty(c: Ctx, value: 'all' | 'beginner' | 'intermediate' | 'advanced'): Promise<void> {
    (el(c).querySelector('.toolbar .mat-mdc-select-trigger') as HTMLElement).click();
    c.fixture.detectChanges();
    const option = Array.from(document.querySelectorAll<HTMLElement>('mat-option'))
      .find((o) => o.textContent!.trim() === LABEL[value])!;
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
      expect(Array.from(group.children).map((e) => e.tagName.toLowerCase()))
        .toEqual(['app-quiz-difficulty-filter', 'app-quiz-sort']);
      expect(el(c).querySelectorAll('.toolbar app-quiz-sort button')).toHaveLength(2);   // the sort control is unchanged
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
    it.each(['beginner', 'intermediate', 'advanced'] as const)('%s + A–Z: only that difficulty, alphabetical', async (difficulty) => {
      const c = await render();
      await chooseDifficulty(c, difficulty);

      expect(c.comp.sortAlpha()).toBe('az');
      expect(renderedIds(c)).toEqual(ONLY[difficulty].az);
    });

    it.each(['beginner', 'intermediate', 'advanced'] as const)('%s + Z–A: only that difficulty, reverse-alphabetical', async (difficulty) => {
      const c = await render();
      await press(c, alphaBtn(c));            // → Z–A
      await chooseDifficulty(c, difficulty);

      expect(c.comp.sortAlpha()).toBe('za');
      expect(renderedIds(c)).toEqual(ONLY[difficulty].za);
    });

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

      await press(c, difficultyBtn(c));   // ↓
      expect(c.comp.sortDifficulty()).toBe('desc');
      expect(renderedIds(c)).toEqual(ONLY.intermediate.az);   // same single group, same order
      await press(c, difficultyBtn(c));   // ↑
      expect(c.comp.sortDifficulty()).toBe('asc');
      expect(renderedIds(c)).toEqual(ONLY.intermediate.az);
      expect(selectShows(c)).toBe('Intermediate');

      // The direction chosen meanwhile is remembered: back on All it groups accordingly.
      await press(c, difficultyBtn(c));   // ↓ again
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
      await press(c, alphaBtn(c));   // desc / za
      const sortKeys = { d: localStorage.getItem('quizSortDifficulty'), a: localStorage.getItem('quizSortAlpha') };
      expect(sortKeys).toEqual({ d: 'desc', a: 'za' });

      for (const d of ['beginner', 'advanced', 'intermediate', 'all'] as const) {
        await chooseDifficulty(c, d);
        expect([c.comp.sortDifficulty(), c.comp.sortAlpha()]).toEqual(['desc', 'za']);
        expect([localStorage.getItem('quizSortDifficulty'), localStorage.getItem('quizSortAlpha')]).toEqual(['desc', 'za']);
      }
    });
  });

  describe('composes with search', () => {
    it.each([
      ['intermediate', 'angular', ['directives', 'signals']],
      ['beginner', 'angular', ['bindings', 'components']],
      ['advanced', 'angular', ['architecture']],   // "Performance Tuning" fails the search
      ['advanced', 'perf', ['performance']],
      ['beginner', 'perf', []]                     // the search matches, but not in this difficulty
    ] as const)('%s + search "%s" keeps only quizzes that satisfy BOTH', async (difficulty, term, expectedIds) => {
      const c = await render();
      await chooseDifficulty(c, difficulty);
      await search(c, term);

      expect(renderedIds(c)).toEqual(expectedIds);
    });

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
    it('search AND filter together: names both', async () => {
      const c = await render();
      await chooseDifficulty(c, 'beginner');
      await search(c, 'perf');

      expect(renderedIds(c)).toEqual([]);
      expect(noResults(c)).toHaveLength(1);
      expect(noResults(c)[0].textContent!.trim()).toBe('No quizzes match your search and difficulty filter.');
    });

    it('search alone: the existing message, unchanged', async () => {
      const c = await render();
      await search(c, 'zzz-no-such-topic');

      expect(noResults(c)).toHaveLength(1);
      expect(noResults(c)[0].textContent!.trim()).toBe('No quizzes match your search.');
    });

    it('filter alone (a difficulty with no quizzes): names the difficulty filter', async () => {
      const c = await render(CATALOG.filter(([, , d]) => d !== 'advanced'));
      await chooseDifficulty(c, 'advanced');

      expect(renderedIds(c)).toEqual([]);
      expect(noResults(c)).toHaveLength(1);
      expect(noResults(c)[0].textContent!.trim()).toBe('No quizzes match the selected difficulty.');
    });

    it('keeps its existing live-region semantics, and goes away when the results come back', async () => {
      const c = await render();
      await chooseDifficulty(c, 'beginner');
      await search(c, 'perf');
      const message = noResults(c)[0];
      expect([message.getAttribute('role'), message.getAttribute('aria-live')]).toEqual(['status', 'polite']);

      await chooseDifficulty(c, 'all');   // "perf" now matches Performance Tuning
      expect(noResults(c)).toHaveLength(0);
      expect(renderedIds(c)).toEqual(['performance']);
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
  });

  describe('persistence', () => {
    it('is NOT persisted: nothing about the filter reaches storage, and every visit starts on "All Difficulties"', async () => {
      const c = await render();
      await chooseDifficulty(c, 'advanced');

      const keys = [...Object.keys(localStorage), ...Object.keys(sessionStorage)];
      expect(keys.filter((k) => /filter/i.test(k))).toEqual([]);
      expect(Object.values({ ...localStorage, ...sessionStorage })).not.toContain('advanced');

      TestBed.resetTestingModule();   // a fresh visit
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
      expect(selectShows(c)).toBe('Advanced');   // the state is text, not just colour
    });

    it('can be operated from the keyboard: the arrow keys change the filter and the list follows', async () => {
      const c = await render();
      selectHost(c).focus();
      expect(document.activeElement).toBe(selectHost(c));

      selectHost(c).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true, cancelable: true }));
      await settle(c);

      expect(c.comp.difficultyFilter()).toBe('beginner');
      expect(renderedIds(c)).toEqual(ONLY.beginner.az);
      expect(document.activeElement).toBe(selectHost(c));   // focus is kept
    });

    it('sits in the normal tab order alongside the search box and the two sort buttons', async () => {
      const c = await render();
      const focusable = [searchInput(c), selectHost(c), difficultyBtn(c), alphaBtn(c)];

      expect(focusable.every((e) => e.tabIndex >= 0)).toBe(true);
      const order = Array.from(el(c).querySelectorAll('.toolbar input, .toolbar mat-select, .toolbar .sort-btn'));
      expect(order.slice(0, 4)).toEqual(focusable);
    });
  });
});
