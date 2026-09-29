import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { of, Subject } from 'rxjs';
import { ChangeDetectorRef, signal } from '@angular/core';

import { ResultsComponent } from './results.component';
import { QuizDotStatusService } from '@shared/services/flow/quiz-dot-status.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { TimerService } from '@shared/services/features/timer/timer.service';
import { ScoreAnalysisService } from '@shared/services/features/results/score-analysis.service';
import { AchievementService } from '@shared/services/achievements/achievement.service';
import { TopicPerformanceHistoryService } from '@shared/services/progress/topic-performance-history.service';
import { ThemeService } from '@shared/services/ui/theme.service';
import { TopicQuizMetadataService } from '@shared/services/api/topic-quiz-metadata.service';
import type { FinalResult } from '@shared/models';

/**
 * Regression coverage for the `finalResultStream` constructor effect —
 * a SECOND path (independent of ngOnInit's snapshot logic and of
 * QuizResultGuard) that reacts to QuizService.finalResultSig, a public
 * writable signal. Nothing stops an external write to it from carrying a
 * DIFFERENT quiz's result than the one the route is currently showing; the
 * effect used to trust that result's own `quizId` unconditionally
 * (`if (r.quizId) this.quizId.set(r.quizId);`) and always ran
 * persistResultsToSession() + finalizeCompletion() (topic performance +
 * achievements) for it. This tests the REACHABLE case directly against the
 * component class (constructor + ngOnInit called directly, no router/guard
 * involved) rather than relying on QuizResultGuard, which cannot see this
 * path at all.
 */
/** Anything not explicitly stubbed becomes a harmless no-op function. */
function lenient<T extends object>(known: T): T {
  return new Proxy(known, {
    get: (target, prop) => {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
      if (prop === 'then') return undefined;
      return jest.fn();
    },
  }) as T;
}

describe('ResultsComponent — finalResultStream constructor effect', () => {
  let finalResult$: Subject<FinalResult | null>;
  let quizService: any;
  let topicPerformanceHistory: any;
  let achievementService: any;

  function setup(routeQuizId: string): ResultsComponent {
    finalResult$ = new Subject<FinalResult | null>();
    topicPerformanceHistory = { record: jest.fn() };
    achievementService = {
      recordQuizResult: jest.fn(),
      evaluate: jest.fn().mockReturnValue([]),
      catalog: jest.fn().mockReturnValue([]),
    };

    quizService = lenient({
      finalResult$,
      totalQuestions: signal(0),
      correctAnswersCountSig: signal(0),
      getQuestionsInDisplayOrder: jest.fn().mockReturnValue([]),
      isShuffleEnabled: jest.fn().mockReturnValue(false),
      getFinalResultSnapshot: jest.fn().mockReturnValue(null),
      // Simulates: this route's quiz has NOT been legitimately completed —
      // exactly the state a direct/stale navigation would leave, so ngOnInit
      // never sets hasSnapshot, leaving the constructor effect as the only
      // thing that could still act.
      hasValidResultFor: jest.fn().mockReturnValue(false),
      sendCorrectCountToResults: jest.fn(),
      recordCompletedQuizScore: jest.fn(),
    });

    const metadataApi = lenient({
      load: jest.fn().mockReturnValue(of([])),
      difficultyByQuiz: jest.fn().mockReturnValue(new Map()),
      factsByQuiz: jest.fn().mockReturnValue(new Map()),
      factsFor: jest.fn().mockReturnValue([]),
      milestoneFor: jest.fn().mockReturnValue(''),
    });

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: QuizDotStatusService, useValue: lenient({}) },
        { provide: QuizService, useValue: quizService },
        { provide: QuizStateService, useValue: lenient({}) },
        { provide: SelectedOptionService, useValue: lenient({ recoverAnswersForResults: jest.fn() }) },
        { provide: TimerService, useValue: lenient({ elapsedTimes: [], completionTime: 0 }) },
        { provide: ScoreAnalysisService, useValue: lenient({ buildAnalysis: jest.fn().mockReturnValue([]) }) },
        { provide: AchievementService, useValue: achievementService },
        { provide: TopicPerformanceHistoryService, useValue: topicPerformanceHistory },
        { provide: ThemeService, useValue: lenient({}) },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ quizId: routeQuizId })) } },
        { provide: Router, useValue: lenient({}) },
        { provide: ChangeDetectorRef, useValue: lenient({ markForCheck: jest.fn() }) },
        { provide: TopicQuizMetadataService, useValue: metadataApi },
      ],
    });

    // Constructed via runInInjectionContext (real constructor + effects, real
    // inject() resolution) rather than TestBed.createComponent(), which would
    // also render ResultsComponent's full template — cascading into child
    // components (ReturnComponent's RouterLink, etc.) that need a real
    // router. None of that is relevant to the constructor effect under test.
    const component = TestBed.runInInjectionContext(() => new ResultsComponent());
    TestBed.flushEffects(); // let the effect's initial (no-op) run happen
    component.ngOnInit(); // sets quizId = routeQuizId; hasSnapshot stays false (no valid result)
    return component;
  }

  afterEach(() => {
    sessionStorage.clear();
  });

  it("a result for a DIFFERENT quiz than the route must not persist, record topic performance, or evaluate achievements", () => {
    setup('quizA');
    sessionStorage.removeItem('finalResult');

    finalResult$.next({
      quizId: 'quizB',
      correct: 3,
      total: 3,
      percentage: 100,
      analysis: [],
      completedAt: Date.now(),
    });
    TestBed.flushEffects();

    expect(topicPerformanceHistory.record).not.toHaveBeenCalled();
    expect(achievementService.recordQuizResult).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('finalResult')).toBeNull();
  });

  it('a result that DOES match the current route quiz is still processed normally', () => {
    setup('quizA');
    sessionStorage.removeItem('finalResult');

    finalResult$.next({
      quizId: 'quizA',
      correct: 2,
      total: 2,
      percentage: 100,
      analysis: [],
      completedAt: Date.now(),
    });
    TestBed.flushEffects();

    expect(topicPerformanceHistory.record).toHaveBeenCalledTimes(1);
    expect(achievementService.recordQuizResult).toHaveBeenCalledWith('quizA', 100);
    expect(sessionStorage.getItem('finalResult')).not.toBeNull();
  });

  it('a result with no quizId at all is ignored (never adopted as "the" result)', () => {
    setup('quizA');
    sessionStorage.removeItem('finalResult');

    finalResult$.next({
      quizId: '',
      correct: 1,
      total: 1,
      percentage: 100,
      analysis: [],
      completedAt: Date.now(),
    } as FinalResult);
    TestBed.flushEffects();

    expect(topicPerformanceHistory.record).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('finalResult')).toBeNull();
  });
});
