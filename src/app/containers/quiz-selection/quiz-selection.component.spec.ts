import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { Router } from '@angular/router';

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
