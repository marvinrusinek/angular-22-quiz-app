import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { provideRouter, Router } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { QuizSelectionComponent } from './quiz-selection.component';
import { QuizService } from '../../shared/services/data/quiz.service';
import { AchievementService } from '../../shared/services/achievements/achievement.service';
import { ProgressService } from '../../shared/services/progress/progress.service';
import { BestScoreService } from '../../shared/services/progress/best-score.service';
import { LearningPathService } from '../../shared/services/features/learning-path/learning-path.service';
import { DifficultyRecommendationService } from '../../shared/services/features/learning-path/difficulty-recommendation.service';
import { SessionEngagementService } from '../../shared/services/state/session-engagement.service';
import { TopicQuizMetadataService } from '../../shared/services/api/topic-quiz-metadata.service';
import { QuizStatus } from '../../shared/models/quiz-status.enum';

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
        { provide: TopicQuizMetadataService, useValue: makeMetadataApi() }
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
