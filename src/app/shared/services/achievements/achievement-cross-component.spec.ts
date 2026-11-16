import { ChangeDetectorRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';

import { AchievementService } from './achievement.service';
import { AchievementUnlockedComponent } from '../../../components/achievement-unlocked/achievement-unlocked.component';
import { AchievementsCatalogComponent } from '../../../components/achievements-catalog/achievements-catalog.component';
import { AchievementsSummaryComponent } from '../../../components/achievements-summary/achievements-summary.component';
import { QuizSelectionComponent } from '../../../containers/quiz-selection/quiz-selection.component';
import { ResultsComponent } from '../../../containers/results/results.component';
import { SK_QUIZ_ACHIEVEMENTS } from '@shared/constants/session-keys';
import { BestScoreService } from '@shared/services/progress/best-score.service';
import { ProgressService } from '@shared/services/progress/progress.service';
import { InterviewReadinessService } from '@shared/services/features/interview/interview-readiness.service';
import { DifficultyRecommendationService } from '@shared/services/features/learning-path/difficulty-recommendation.service';
import { InterviewWarmupCoordinatorService } from '@shared/services/interview/interview-warmup-coordinator.service';
import { SessionEngagementService } from '@shared/services/state/session-engagement.service';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizDotStatusService } from '@shared/services/flow/quiz-dot-status.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { ScoreAnalysisService } from '@shared/services/features/results/score-analysis.service';
import { TopicPerformanceHistoryService } from '@shared/services/progress/topic-performance-history.service';
import { ThemeService } from '@shared/services/ui/theme.service';

/**
 * Quiz Selection's badge and the Results catalog must agree for the SAME stored
 * state, and both must follow another tab's change without a reload. Both
 * components are built against ONE real AchievementService.
 */
function lenient<T extends object>(known: T): T {
  return new Proxy(known, {
    get: (target, prop) => {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
      if (prop === 'then') return undefined;
      return jest.fn();
    }
  }) as T;
}

describe('Achievement counts — Quiz Selection and Results agree', () => {
  const SIX = [
    'perfect-score',
    'beginner-complete',
    'intermediate-complete',
    'advanced-complete',
    'interview-master',
    'angular-explorer'
  ];
  const TWO = ['perfect-score', 'beginner-complete'];

  let service: AchievementService;
  let selection: QuizSelectionComponent;
  let results: ResultsComponent;
  // Controls what the REAL AchievementService evaluates against.
  let bestScores: Record<string, number>;
  const difficulty = signal(new Map<string, string | null>());

  const seed = (ids: string[]): void =>
    localStorage.setItem(
      SK_QUIZ_ACHIEVEMENTS,
      JSON.stringify(ids.map((id) => ({ id, earnedAt: '2026-11-01T10:00:00.000Z' })))
    );
  const otherTab = (): void => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: SK_QUIZ_ACHIEVEMENTS, storageArea: localStorage })
    );
  };

  /** Quiz Selection's badge text, and Results' catalog heading text. */
  const selectionLabel = (): string => {
    const f = TestBed.createComponent(AchievementsSummaryComponent);
    f.componentRef.setInput('earned', selection.achievementsEarned());
    f.componentRef.setInput('total', selection.achievementsTotal());
    f.detectChanges();
    return f.componentInstance.label();
  };
  const resultsLabel = (): string => {
    const f = TestBed.createComponent(AchievementsCatalogComponent);
    f.componentRef.setInput('achievements', results.achievementsCatalog());
    f.detectChanges();
    return f.componentInstance.toggleLabel();
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    seed(TWO);
    bestScores = {};
    difficulty.set(new Map());

    const metadata: any = lenient({
      load: jest.fn(() => of([])),
      difficultyByQuiz: difficulty,
      milestoneByQuiz: signal(new Map<string, string>()),
      summaryByQuiz: signal(new Map<string, string>()),
      imageByQuiz: signal(new Map<string, string>()),
      factsByQuiz: signal(new Map<string, readonly string[]>()),
      questionCountByQuiz: signal(new Map<string, number>()),
      factsFor: jest.fn(() => []),
      milestoneFor: jest.fn(() => ''),
      imageFor: jest.fn(() => ''),
      selectionImageFor: jest.fn(() => '')
    });
    const quizService: any = lenient({
      finalResult$: of(null),
      totalQuestions: signal(0),
      correctAnswersCountSig: signal(0),
      getQuestionsInDisplayOrder: jest.fn(() => []),
      isShuffleEnabled: jest.fn(() => false),
      getFinalResultSnapshot: jest.fn(() => null),
      hasValidResultFor: jest.fn(() => false),
      returnQuizSelectionParams: () => ({ startedQuizId: '', continueQuizId: '', quizCompleted: false }),
      quizCompleted: false
    });

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        QuizSelectionComponent,
        // The REAL AchievementService; only what it reads from is stubbed.
        {
          provide: InterviewReadinessService,
          useValue: {
            readiness: signal(null),
            coverageVerified: signal(true),
            ensureCatalog: jest.fn(async () => undefined)
          }
        },
        { provide: QuizService, useValue: quizService },
        { provide: ProgressService, useValue: { getProgressSummary: jest.fn(() => ({})), getQuizProgress: jest.fn(() => []) } },
        { provide: BestScoreService, useValue: { getBestScores: () => bestScores, recordBestScore: jest.fn() } },
        { provide: DifficultyRecommendationService, useValue: { recommend: jest.fn(() => null) } },
        { provide: SessionEngagementService, useValue: { engaged: () => false, markEngaged: jest.fn() } },
        { provide: InterviewWarmupCoordinatorService, useValue: { warmUp: jest.fn(() => of(undefined)) } },
        { provide: TopicQuizMetadataService, useValue: metadata },
        { provide: QuizDotStatusService, useValue: lenient({}) },
        { provide: QuizStateService, useValue: lenient({}) },
        { provide: SelectedOptionService, useValue: lenient({ recoverAnswersForResults: jest.fn() }) },
        { provide: TimerService, useValue: lenient({ elapsedTimes: [], completionTime: 0 }) },
        { provide: ScoreAnalysisService, useValue: lenient({ buildAnalysis: jest.fn(() => []) }) },
        { provide: TopicPerformanceHistoryService, useValue: { record: jest.fn() } },
        { provide: ThemeService, useValue: lenient({}) },
        { provide: ChangeDetectorRef, useValue: lenient({ markForCheck: jest.fn() }) },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ quizId: 'q' })) } }
      ]
    });
    jest.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    jest.spyOn(window, 'scrollTo').mockImplementation(() => {});

    service = TestBed.inject(AchievementService);
    // Results first: when both screens react to the same catalog change, the
    // Results evaluation (which reports what was newly earned) runs before Quiz
    // Selection's silent one. In the app only one of them is ever alive.
    results = TestBed.runInInjectionContext(() => new ResultsComponent());
    results.ngOnInit();
    selection = TestBed.inject(QuizSelectionComponent);
  });

  afterEach(() => jest.restoreAllMocks());

  it('both show 2 of 6 for the stored state (and the same wording of the count)', () => {
    expect(selection.achievementsEarned()).toBe(2);
    expect(selection.achievementsTotal()).toBe(6);
    expect(results.achievementsCatalog().filter((a) => a.earned)).toHaveLength(2);
    expect(results.achievementsCatalog()).toHaveLength(6);
    expect(selectionLabel()).toBe('Achievements: 2 of 6 earned');
    expect(resultsLabel()).toBe('Achievements, 2 of 6');
  });

  it('both update after another tab changes quizAchievements, with no reload', () => {
    expect(selection.achievementsEarned()).toBe(2);
    expect(results.achievementsCatalog().filter((a) => a.earned)).toHaveLength(2);

    seed(SIX);
    otherTab();

    expect(selection.achievementsEarned()).toBe(6);
    expect(results.achievementsCatalog().filter((a) => a.earned)).toHaveLength(6);
    expect(selectionLabel()).toBe('Achievements: 6 of 6 earned');
    expect(resultsLabel()).toBe('Achievements, 6 of 6');
  });

  it('the REPORTED case: a stale 6 can no longer outlive a stored 2', () => {
    seed(SIX);
    otherTab();
    expect(resultsLabel()).toBe('Achievements, 6 of 6');
    seed(TWO); // storage reduced elsewhere (reset in another tab)
    otherTab();
    expect(resultsLabel()).toBe('Achievements, 2 of 6');
    expect(selectionLabel()).toBe('Achievements: 2 of 6 earned');
  });

  it('both follow a normal in-tab earn through the service', () => {
    localStorage.setItem(SK_QUIZ_ACHIEVEMENTS, '[]');
    otherTab();
    expect(selection.achievementsEarned()).toBe(0);
    const newly = service.evaluate([]); // nothing qualifies with an empty catalogue
    expect(newly).toEqual([]);
    expect(selection.achievementsEarned()).toBe(results.achievementsCatalog().filter((a) => a.earned).length);
  });

  it('unrelated storage events change neither display', () => {
    expect(selection.achievementsEarned()).toBe(2); // prime both from storage
    expect(results.achievementsCatalog().filter((a) => a.earned)).toHaveLength(2);
    seed(SIX);
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme', storageArea: localStorage }));
    window.dispatchEvent(new StorageEvent('storage', { key: SK_QUIZ_ACHIEVEMENTS, storageArea: sessionStorage }));
    expect(selection.achievementsEarned()).toBe(2);
    expect(results.achievementsCatalog().filter((a) => a.earned)).toHaveLength(2);
  });

  it('the earned ids Quiz Selection uses for its completion message follow the service', () => {
    expect(selection.achievementsEarnedIds().size).toBe(2);
    seed(SIX);
    otherTab();
    expect(selection.achievementsEarnedIds().size).toBe(6);
  });

  describe('internal writes (the service itself earns) update BOTH displays', () => {
    const quizzes = new Map<string, string | null>([
      ['a', 'beginner'],
      ['b', 'beginner']
    ]);

    it('Results evaluation earns, persists, shows the unlock card and updates both', () => {
      seed([]); // nothing earned yet
      otherTab();
      expect(selection.achievementsEarned()).toBe(0);
      expect(results.achievementsCatalog().filter((a) => a.earned)).toHaveLength(0);

      bestScores = { a: 100, b: 80 }; // a perfect score + every Beginner quiz done
      difficulty.set(quizzes);
      (results as any).pendingAchievementResult.set({
        quizId: 'a', correct: 5, total: 5, percentage: 100, analysis: [], completedAt: 1
      });
      TestBed.flushEffects();

      const newly = results.newlyEarnedAchievements().map((d) => d.id).sort();
      expect(newly).toEqual(['beginner-complete', 'perfect-score']);
      // persisted exactly as before (ids + ISO timestamps)
      const stored = JSON.parse(localStorage.getItem(SK_QUIZ_ACHIEVEMENTS)!);
      expect(stored.map((e: any) => e.id).sort()).toEqual(newly);
      expect(stored.every((e: any) => !Number.isNaN(Date.parse(e.earnedAt)))).toBe(true);
      // ...and both displays follow with no reload and no manual refresh
      expect(selection.achievementsEarned()).toBe(2);
      expect(results.achievementsCatalog().filter((a) => a.earned)).toHaveLength(2);
      expect(selectionLabel()).toBe('Achievements: 2 of 6 earned');
      expect(resultsLabel()).toBe('Achievements, 2 of 6');
    });

    it('eligibility is unchanged: nothing is earned without qualifying scores', () => {
      seed([]);
      otherTab();
      bestScores = { a: 60 }; // not perfect, Beginner not complete (b missing)
      difficulty.set(quizzes);
      (results as any).pendingAchievementResult.set({
        quizId: 'a', correct: 3, total: 5, percentage: 60, analysis: [], completedAt: 1
      });
      TestBed.flushEffects();
      expect(results.newlyEarnedAchievements()).toEqual([]);
      expect(selection.achievementsEarned()).toBe(0);
      expect(results.achievementsCatalog().filter((a) => a.earned)).toHaveLength(0);
    });

    it('a later no-op evaluation never erases an earlier unlock card', () => {
      seed([]);
      otherTab();
      bestScores = { a: 100, b: 80 };
      difficulty.set(quizzes);
      (results as any).pendingAchievementResult.set({
        quizId: 'a', correct: 5, total: 5, percentage: 100, analysis: [], completedAt: 1
      });
      TestBed.flushEffects();
      expect(results.newlyEarnedAchievements()).toHaveLength(2);
      difficulty.set(new Map(quizzes)); // catalog re-emits; evaluate() earns nothing new
      TestBed.flushEffects();
      expect(results.newlyEarnedAchievements()).toHaveLength(2);
    });
  });

  describe('Achievement Unlocked card', () => {
    const render = (achievements: unknown) => {
      const f = TestBed.createComponent(AchievementUnlockedComponent);
      f.componentRef.setInput('achievements', achievements);
      f.detectChanges();
      return f.nativeElement as HTMLElement;
    };

    it('lists what Results reports as newly earned, and nothing when none', () => {
      seed([]);
      otherTab();
      bestScores = { a: 100, b: 80 };
      difficulty.set(new Map([['a', 'beginner'], ['b', 'beginner']]));
      (results as any).pendingAchievementResult.set({
        quizId: 'a', correct: 5, total: 5, percentage: 100, analysis: [], completedAt: 1
      });
      TestBed.flushEffects();
      const text = render(results.newlyEarnedAchievements()).textContent ?? '';
      expect(text).toContain('Perfect Score');
      expect(text).toContain('Beginner Complete');
      expect(text).not.toContain('Interview Master');
      expect((render([]).textContent ?? '').trim()).toBe('');
    });
  });
});
