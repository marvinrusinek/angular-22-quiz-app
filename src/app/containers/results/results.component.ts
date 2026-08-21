import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NgOptimizedImage, NgTemplateOutlet } from '@angular/common';
import { TopicPerformanceHistoryService } from '../../shared/services/progress/topic-performance-history.service';
import { ActivatedRoute, Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { take } from 'rxjs/operators';

import { QuizStatus } from '../../shared/models/quiz-status.enum';

import {
  SK_COMPLETED_QUIZ_IDS,
  SK_DOT_CONFIRMED,
  SK_RESULTS_REACHED_ATTEMPT,
  SK_SEL_Q,
  SK_SELECTED_OPTIONS_MAP,
  SK_SHUFFLED_QUESTIONS,
  SK_STARTED_QUIZ_IDS,
  SK_USER_ANSWERS,
} from '../../shared/constants/session-keys';
import {
  readSessionJson,
  writeSessionJson,
  writeSessionString,
} from '../../shared/utils/session-storage';

import { FinalResult, ScoreAnalysisItem, toDurableFinalResult } from '../../shared/models/Final-Result.model';
import { Quiz } from '../../shared/models/Quiz.model';
import { QuizQuestion } from '../../shared/models/QuizQuestion.model';

import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { QuizDotStatusService } from '../../shared/services/flow/quiz-dot-status.service';
import { QuizService } from '../../shared/services/data/quiz.service';
import { QuizStateService } from '../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../shared/services/state/selectedoption.service';
import { TimerService } from '../../shared/services/features/timer/timer.service';
import { ScoreAnalysisService } from '../../shared/services/features/results/score-analysis.service';
import { ThemeService } from '../../shared/services/ui/theme.service';

import { AchievementService } from '../../shared/services/achievements/achievement.service';
import { AchievementDefinition, AchievementView } from '../../shared/models/achievement.model';

import { AccordionComponent } from './accordion/accordion.component';
import { AchievementUnlockedComponent } from '../../components/achievement-unlocked/achievement-unlocked.component';
import { AchievementsCatalogComponent } from '../../components/achievements-catalog/achievements-catalog.component';
import { ScrollDownIndicatorComponent } from '../../components/scroll-down-indicator/scroll-down-indicator.component';
import { QuizFactComponent } from '../../components/quiz-fact/quiz-fact.component';
import { ChallengeComponent } from './challenge/challenge.component';
import { ReturnComponent } from './return/return.component';
import { StatisticsComponent } from './statistics/statistics.component';
import { SummaryReportComponent } from './summary-report/summary-report.component';

import { TopicQuizMetadataService } from '../../shared/services/api/topic-quiz-metadata.service';

import { getQuizData } from '../../shared/quiz-data-cache';
import { swallow } from '../../shared/utils/error-logging';

@Component({
  selector: 'codelab-quiz-results',
  standalone: true,
  imports: [
    MatCardModule,
    MatExpansionModule,
    MatIconModule,
    MatTooltipModule,
    NgOptimizedImage,
    NgTemplateOutlet,
    AchievementUnlockedComponent,
    AchievementsCatalogComponent,
    ScrollDownIndicatorComponent,
    QuizFactComponent,
    AccordionComponent,
    ChallengeComponent,
    ReturnComponent,
    StatisticsComponent,
    SummaryReportComponent,
  ],
  templateUrl: './results.component.html',
  styleUrls: ['./results.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onEscapeKey()',
  },
})
export class ResultsComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly dotStatusService = inject(QuizDotStatusService);
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly timerService = inject(TimerService);
  private readonly scoreAnalysisService = inject(ScoreAnalysisService);
  private readonly achievementService = inject(AchievementService);
  private readonly topicPerformanceHistory = inject(TopicPerformanceHistoryService);
  private readonly themeService = inject(ThemeService);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly cdRef = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly metadataApi = inject(TopicQuizMetadataService);

  // ── remaining variables ─────────────────────────────────────────
  readonly quizData: Quiz[] = getQuizData();
  readonly quizId = signal('');
  readonly indexOfQuizId = signal(0);
  readonly detailedSummaryQuestions = signal<QuizQuestion[]>([]);
  readonly headerLabel = signal('');

  readonly menuOpen = signal(false);
  readonly activeSection = signal<'score' | 'report' | 'summary' | 'highscores' | 'resources'>(
    this.restoreActiveSection()
  );

  readonly finalResult = signal<FinalResult | null>(null);
  readonly scoreAnalysis = computed<ScoreAnalysisItem[]>(() => this.finalResult()?.analysis ?? []);

  // Achievements newly earned by THIS completed quiz (shown once, not after refresh).
  readonly newlyEarnedAchievements = signal<AchievementDefinition[]>([]);
  // Every achievement + earned/locked state, for the expandable catalog section.
  readonly achievementsCatalog = signal<AchievementView[]>([]);
  private achievementsProcessed = false;

  // Facts (0-3) for the completed quiz; QuizFactComponent shows one at random.
  //
  // FROM THE API, NOT THE LOCAL BANK. `facts` reached PostgreSQL but was dropped
  // by `normalizeQuiz` on the way into the private model, so the metadata
  // endpoint could not serve it and this read `assets/data/quiz.json` instead —
  // one of the last runtime dependencies on that asset.
  //
  // The service resolves to nothing on failure rather than falling back, which
  // matches how the panel already behaves for quizzes that have no facts.
  readonly currentQuizFacts = computed<readonly string[]>(() => {
    this.metadataApi.factsByQuiz();   // track the signal so this recomputes on load
    return this.metadataApi.factsFor(this.quizId());
  });


  // Tracks whether ngOnInit already applied a synchronous snapshot, so the
  // finalResult$ effect skips re-applying when the observable later emits.
  private readonly hasSnapshot = signal(false);
  private readonly finalResultStream = toSignal(this.quizService.finalResult$, {
    initialValue: null as FinalResult | null,
  });

  constructor() {
    effect(() => {
      if (this.hasSnapshot()) return;
      const r = this.finalResultStream();
      if (!r) return;
      if (r.quizId) this.quizId.set(r.quizId);
      this.finalResult.set(r);
      this.applyFinalResultSnapshot(r);
      this.updateHeaderLabel(r.total);
      this.persistResultsToSession(r);
      this.finalizeCompletion(r);
    });
  }

  ngOnInit(): void {
    window.scrollTo(0, 0);
    this.quizDataService.loadQuizzes().pipe(take(1)).subscribe();
    // Facts come from the metadata endpoint. Not awaited: the panel renders
    // nothing until they arrive, and never blocks the rest of the page.
    this.metadataApi.load().pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
    this.fetchQuizIdFromParams();
    this.setCompletedQuiz();
    this.findQuizIndex();

    this.detailedSummaryQuestions.set(this.quizService.getQuestionsInDisplayOrder());

    this.updateHeaderLabel(
      this.quizService.totalQuestions() || this.detailedSummaryQuestions().length
    );

    // Try in-memory snapshot first
    let snapshot = this.quizService.getFinalResultSnapshot();

    // If no snapshot exists, build one from current service state. This is the
    // FRESH-completion path: the live selection maps + timer are still valid, so
    // capture the per-question review analysis and the elapsed time NOW — both
    // get wiped when the user leaves Results, and the persisted snapshot is what
    // a revisit reads. (On revisit, getFinalResultSnapshot() returns the saved
    // snapshot and this branch is skipped, preserving the captured data.)
    if (!snapshot && this.quizService.totalQuestions() > 0) {
      const correct = this.quizService.correctAnswersCountSig();
      const total = this.quizService.totalQuestions();

      // Ensure the selection maps are populated (from the durable store) before
      // deriving per-question correctness in the current display order.
      this.selectedOptionService.recoverAnswersForResults();
      const analysis = this.scoreAnalysisService.buildAnalysis(this.detailedSummaryQuestions());
      const completionTime =
        this.timerService.calculateTotalElapsedTime(this.timerService.elapsedTimes) ||
        this.timerService.completionTime ||
        0;

      snapshot = {
        quizId: this.quizId() || this.quizService.quizId,
        correct,
        total,
        percentage: total > 0 ? Math.round((correct / total) * 100) : 0,
        analysis,
        completionTime,
        completedAt: Date.now(),
      };
    }

    if (snapshot) {
      this.hasSnapshot.set(true);
      if (snapshot.quizId) {
        this.quizId.set(snapshot.quizId);
      }
      this.finalResult.set(snapshot);
      this.applyFinalResultSnapshot(snapshot);
      this.updateHeaderLabel(snapshot.total);
      this.persistResultsToSession(snapshot);
      this.finalizeCompletion(snapshot);

      // Record this completed attempt in the High Scores list ONCE, here at the
      // single results-load convergence point (alongside achievements). The
      // write used to live in SummaryReportComponent.initComponent(), which is
      // re-created on every results-section switch, so it appended a duplicate
      // row each time. recordCompletedQuizScore is idempotent, so re-viewing /
      // refreshing the results does not duplicate the row.
      this.quizService.recordCompletedQuizScore(
        snapshot.quizId,
        snapshot.percentage,
        snapshot.total,
        this.quizService.getCurrentAttemptId()
      );
    }
    // No snapshot: the constructor effect picks up finalResult$ emissions.

    // Always show the catalog with the current earned/locked state (even on a
    // refresh, when no new achievement is being announced).
    this.achievementsCatalog.set(this.achievementService.catalog());
  }

  /**
   * Retry for a deferred section whose chunk failed to load. `@defer` has no
   * re-trigger API once it has entered the error state, so a full reload is
   * the honest option — the active section is restored from sessionStorage
   * (`resultsActiveSection`), so the user lands back where they were.
   */
  reloadPage(): void {
    window.location.reload();
  }

  toggleMenu(): void {
    this.menuOpen.update((prev) => !prev);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  /**
   * Dismiss the hamburger menu on a click anywhere outside the hamburger button
   * and its dropdown panel (both live under `.hamburger-menu`). Pure dismissal:
   * it does NOT navigate, scroll, or change the active section — the user stays
   * exactly where they were. The button's own click bubbles here too, but it's
   * inside `.hamburger-menu`, so opening the menu never immediately closes it.
   */
  onDocumentClick(event: MouseEvent): void {
    if (!this.menuOpen()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('.hamburger-menu')) return;
    this.closeMenu();
  }

  /** Escape closes the open menu (keyboard accessibility), nothing more. */
  onEscapeKey(): void {
    if (this.menuOpen()) this.closeMenu();
  }

  setActiveSection(section: 'score' | 'report' | 'summary' | 'highscores' | 'resources'): void {
    this.activeSection.set(section);
    writeSessionString('resultsActiveSection', section);
    this.closeMenu();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.cdRef.markForCheck();
  }

  selectQuiz(): void {
    const quizId = this.quizId() || this.quizService.quizId || '';

    // Mark as completed (checkmark) whenever the quiz was actually finished,
    // regardless of score. A finished quiz has a result snapshot with questions;
    // the 100% distinction is surfaced separately via the Perfect Score
    // achievement, not the tile checkmark.
    const snapshot = this.finalResult();
    const isCompleted = !!snapshot && snapshot.total > 0;
    if (quizId) {
      const key = isCompleted ? SK_COMPLETED_QUIZ_IDS : SK_STARTED_QUIZ_IDS;
      const existing = readSessionJson<string[]>(key, []);
      if (!existing.includes(quizId)) {
        existing.push(quizId);
        writeSessionJson(key, existing);
      }
    }

    if (quizId) {
      this.quizDataService.updateQuizStatus(
        quizId,
        isCompleted ? QuizStatus.COMPLETED : QuizStatus.STARTED
      );
    }
    this.quizService.setCompletedQuizId(isCompleted ? quizId : '');
    this.quizService.quizCompleted = isCompleted;

    this.quizService.resetAll();
    this.quizService.resetQuestions();

    // Clear all in-memory dot/selection state
    this.dotStatusService.clearAllMaps();
    this.selectedOptionService.lastClickedCorrectByQuestion.clear();
    this.selectedOptionService.clearAllSelectionsForQuiz(quizId);
    this.selectedOptionService.clearRefreshBackup();
    this.selectedOptionService.clickConfirmedDotStatus.clear();
    this.quizStateService._answeredQuestionIndices?.clear();
    this.quizStateService._hasUserInteracted?.clear();

    // Signal to quiz component that this is a fresh start from results
    writeSessionString('freshStartFromResults', 'true');

    // Nuclear: wipe ALL quiz-related sessionStorage and localStorage
    try {
      for (let i = 0; i < 100; i++) {
        sessionStorage.removeItem(SK_SEL_Q + i);
        sessionStorage.removeItem(SK_DOT_CONFIRMED + i);
      }
      sessionStorage.removeItem('rawSelectionsMap');
      sessionStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      sessionStorage.removeItem('selectionHistory');
      sessionStorage.removeItem('finalResult');
      sessionStorage.removeItem('resultsActiveSection');

      const lsKeysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('quiz_dot_status_') || key.startsWith('quiz_progress_'))) {
          lsKeysToRemove.push(key);
        }
      }
      for (const key of lsKeysToRemove) {
        localStorage.removeItem(key);
      }
      localStorage.removeItem('questionCorrectness');
      localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      localStorage.removeItem(SK_USER_ANSWERS);
      localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
    } catch (err: unknown) {
      swallow('results.component.ts', err);
    }

    // Reset to light mode when leaving results
    if (this.themeService.isDark()) {
      this.themeService.toggle();
    }

    this.quizId.set('');
    this.indexOfQuizId.set(0);
    this.router.navigate(['/select/']);
  }

  private restoreActiveSection(): 'score' | 'report' | 'summary' | 'highscores' | 'resources' {
    try {
      const stored = sessionStorage.getItem('resultsActiveSection');
      if (
        stored === 'score' ||
        stored === 'report' ||
        stored === 'summary' ||
        stored === 'highscores' ||
        stored === 'resources'
      ) {
        return stored;
      }
    } catch (err: unknown) {
      swallow('results.component.ts', err);
    }
    return 'score';
  }

  private fetchQuizIdFromParams(): void {
    this.activatedRoute.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const routeQuizId = params.get('quizId');
      if (routeQuizId) {
        this.quizId.set(routeQuizId);
        this.setCompletedQuiz();
        this.findQuizIndex();
        this.cdRef.markForCheck();
      }
    });
  }

  private setCompletedQuiz(): void {
    const id = this.quizId();
    if (id) {
      this.quizService.setCompletedQuizId(id);
      this.quizService.setQuizId(id); // ensure service has correct ID for high scores
      this.quizService.setQuizStatus(QuizStatus.COMPLETED);

      // Update the quiz object's status so QuizSelectionComponent can show the icon
      this.quizDataService.updateQuizStatus(id, QuizStatus.COMPLETED);

      // Reaching Results IS the proof that this attempt finished the last
      // question. Recording it here (not only on the way out of the quiz)
      // means browser Back can restore the last question's Show Results
      // button + message no matter which path led here. Attempt-scoped, so
      // Restart / a new attempt invalidates it without an explicit clear.
      try {
        sessionStorage.setItem(
          SK_RESULTS_REACHED_ATTEMPT,
          `${id}|${this.quizService.getCurrentAttemptId()}`
        );
      } catch (err: unknown) {
        swallow('results.component#markResultsReached', err);
      }
    }
  }

  private findQuizIndex(): void {
    const id = this.quizId();
    if (id) {
      this.indexOfQuizId.set(this.quizData.findIndex((elem) => elem.quizId === id));
    }
  }

  private applyFinalResultSnapshot(snapshot: FinalResult): void {
    this.quizService.totalQuestions.set(snapshot.total);
    this.quizService.sendCorrectCountToResults(snapshot.correct);
  }

  private updateHeaderLabel(totalQuestions: number): void {
    const questionCount =
      Number.isFinite(totalQuestions) && totalQuestions > 0
        ? totalQuestions
        : this.detailedSummaryQuestions().length;

    this.headerLabel.set(
      this.quizService.isShuffleEnabled()
        ? `${questionCount} questions, SHUFFLED`
        : `${questionCount} questions`
    );
  }

  /**
   * Records this quiz's best score, then evaluates achievements once. Runs at
   * most once per Results visit (whichever result path fires first), so a later
   * duplicate emission or a refresh can't re-announce. The service itself is
   * idempotent — evaluate() persists + returns only genuinely NEW achievements,
   * so a refresh that re-runs the flow yields [] and shows nothing.
   */
  /**
   * The completion chokepoint. Runs the independent finalization steps for a
   * completed quiz.
   *
   * Topic-performance recording is called HERE rather than from inside
   * processAchievements() so it is not semantically dependent on achievements:
   * an achievement early-return, a disabled achievement system, or a future
   * achievement refactor must never silently stop weak-area data being recorded.
   * Each step carries its own idempotence.
   */
  private finalizeCompletion(result: FinalResult): void {
    this.recordTopicPerformance(result);
    this.processAchievements(result);
  }

  /**
   * Record the RAW correct/total for Weak Areas, exactly once per completion.
   *
   * The attempt id uses `completedAt`, which is stamped ONCE when the result is
   * first built and then persisted in the sessionStorage snapshot — a revisit or
   * refresh reads that snapshot rather than rebuilding, so the id is identical
   * and the store's dedup makes the repeat a no-op. A genuinely new completion
   * of the same quiz gets a new timestamp, so it correctly records a second
   * attempt.
   *
   * Writes only to topicPerformanceHistory:v1 — never High Scores, completion
   * counts, achievements or Interview History.
   */
  private recordTopicPerformance(result: FinalResult): void {
    if (!result?.quizId || !(result.total > 0)) return;
    this.topicPerformanceHistory.record(
      `quiz:${result.quizId}:${result.completedAt}`,
      'topic-quiz',
      [{
        topicId: result.quizId,
        topicName: this.quizData.find((q) => q.quizId === result.quizId)?.milestone ?? result.quizId,
        correct: result.correct,
        total: result.total
      }]
    );
  }

  private processAchievements(result: FinalResult): void {
    if (this.achievementsProcessed) return;
    if (!result?.quizId) return;
    this.achievementsProcessed = true;
    this.achievementService.recordQuizResult(result.quizId, result.percentage);
    this.newlyEarnedAchievements.set(this.achievementService.evaluate(this.quizData));
    // Refresh the catalog so any just-earned achievement flips to "Earned".
    this.achievementsCatalog.set(this.achievementService.catalog());
    this.cdRef.markForCheck();
  }

  private persistResultsToSession(result: FinalResult): void {
    try {
      // Sanitized: the authorized reveal stays in memory for this session and
      // never becomes a durable answer cache. See toDurableFinalResult.
      sessionStorage.setItem('finalResult', JSON.stringify(toDurableFinalResult(result)));
    } catch (err: unknown) {
      swallow('results.component.ts', err);
    }
  }
}
