import { ChangeDetectionStrategy, Component, computed, effect, inject, OnInit,
  signal, ViewEncapsulation } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { NgClass, NgOptimizedImage, NgStyle, TitleCasePipe } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { SK_COMPLETED_QUIZ_IDS, SK_QUIZ_SEARCH_TERM, SK_QUIZ_SORT_ALPHA, SK_QUIZ_SORT_DIFFICULTY, SK_STARTED_QUIZ_IDS } from '../../shared/constants/session-keys';
import { readSessionJson, readSessionString, writeSessionJson, writeSessionString } from '../../shared/utils/session-storage';
import { readLocalString, writeLocalString } from '../../shared/utils/local-storage';

import { QuizRoutes } from '../../shared/models/quiz-routes.enum';
import { QuizStatus } from '../../shared/models/quiz-status.enum';

import { AnimationState } from '../../shared/models/AnimationState.type';
import { Quiz } from '../../shared/models/Quiz.model';
import { AlphaDirection, DifficultyDirection } from '../../shared/models/QuizSort.type';
import { QuizSelectionParams } from '../../shared/models/QuizSelectionParams.model';
import { QuizTileStyles } from '../../shared/models/QuizTileStyles.model';

import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { QuizService } from '../../shared/services/data/quiz.service';
import { AchievementService } from '../../shared/services/achievements/achievement.service';
import { AchievementId } from '../../shared/models/achievement.model';
import { achievementCompletionMessage } from '../../shared/utils/achievement-progress-message';
import { CertificateEarnedBadgeComponent } from '../../components/interview/certificate-earned-badge/certificate-earned-badge.component';
import { ProgressService } from '../../shared/services/progress/progress.service';
import { BestScoreService } from '../../shared/services/progress/best-score.service';
import { LearningPathService } from '../../shared/services/features/learning-path/learning-path.service';
import { DifficultyRecommendationService } from '../../shared/services/features/learning-path/difficulty-recommendation.service';
import { SessionEngagementService } from '../../shared/services/state/session-engagement.service';

import { ProgressSummary, QuizProgress } from '../../shared/models/progress.model';

import { AchievementsSummaryComponent } from '../../components/achievements-summary/achievements-summary.component';
import { ProgressPanelComponent } from '../../components/progress-panel/progress-panel.component';
import { RecommendedNextQuizComponent } from '../../components/recommended-next-quiz/recommended-next-quiz.component';
import { DifficultyRecommendationComponent } from '../../components/difficulty-recommendation/difficulty-recommendation.component';
import {
  QuizCardProgressComponent,
  QuizCardProgressState
} from '../../components/quiz-card-progress/quiz-card-progress.component';
import { QuizSearchComponent } from '../../components/quiz-search/quiz-search.component';
import { QuizSortComponent } from '../../components/quiz-sort/quiz-sort.component';
import { ThemeToggleComponent } from '../../components/theme-toggle/theme-toggle.component';
import { ScrollDownIndicatorComponent } from '../../components/scroll-down-indicator/scroll-down-indicator.component';
import { CountUpDirective } from '../../directives/count-up.directive';

import { TopicQuizMetadataService } from '../../shared/services/api/topic-quiz-metadata.service';

import { getQuizData } from '../../shared/quiz-data-cache';
import { SlideLeftToRightAnimation } from '../../animations/animations';
import { swallow } from '../../shared/utils/error-logging';

@Component({
  selector: 'codelab-quiz-selection',
  standalone: true,
  imports: [
    NgClass,
    NgStyle,
    TitleCasePipe,
    RouterModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    NgOptimizedImage,
    QuizSearchComponent,
    QuizSortComponent,
    ThemeToggleComponent,
    ScrollDownIndicatorComponent,
    RecommendedNextQuizComponent,
    DifficultyRecommendationComponent,
    AchievementsSummaryComponent,
    CertificateEarnedBadgeComponent,
    ProgressPanelComponent,
    QuizCardProgressComponent,
    CountUpDirective
  ],
  templateUrl: './quiz-selection.component.html',
  styleUrls: ['./quiz-selection.component.scss'],
  animations: [SlideLeftToRightAnimation.slideLeftToRight],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QuizSelectionComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly achievementService = inject(AchievementService);
  private readonly progressService = inject(ProgressService);
  private readonly learningPathService = inject(LearningPathService);
  private readonly difficultyService = inject(DifficultyRecommendationService);
  private readonly bestScoreService = inject(BestScoreService);
  private readonly sessionEngagement = inject(SessionEngagementService);
  private readonly metadataApi = inject(TopicQuizMetadataService);
  private readonly router = inject(Router);

  // Gates the progress-driven pieces on THIS screen. Shown whenever the user has
  // ACTUAL progress — engaged this session (tile click), OR has accessed quizzes
  // before, OR has earned any achievement — so a refresh / in-app navigation
  // RETAINS the achievements header + per-tile progress. A truly new user (no
  // progress at all) still starts with a clean, progress-free screen.
  readonly showSelectionProgress = computed(() =>
    this.sessionEngagement.engaged() ||
    this.hasAccessedQuizzes() ||
    this.achievementsEarned() > 0
  );

  // Compact "Achievements X / N" progress for the catalog header. Populated
  // silently on init (evaluating any achievements the user's existing progress
  // already qualifies for — NO "Unlocked" celebration on this screen).
  readonly achievementsEarned = signal(0);
  readonly achievementsTotal = signal(0);
  // Earned achievement ids — drives the completion banner off ACTUAL achievement
  // state (not merely "all quizzes accessed"). Refreshed after each evaluate().
  readonly achievementsEarnedIds = signal<ReadonlySet<AchievementId>>(new Set());

  // ── remaining variables ─────────────────────────────────────────
  readonly quizzes = this.quizDataService.quizzesSig;
  private readonly completedQuizIds = signal<ReadonlySet<string>>(new Set());

  // ── difficulty ranking (used by the 'difficulty' sort) ──────────
  // beginner→intermediate→advanced; missing/unknown difficulties sink last.
  private static readonly DIFFICULTY_RANK: Readonly<Record<string, number>> = {
    beginner: 0,
    intermediate: 1,
    advanced: 2
  };
  private static readonly UNKNOWN_RANK = Number.MAX_SAFE_INTEGER;

  // ── search + sort state (this component owns ALL of it) ─────────
  // The child SearchComponent / SortComponent are presentational only; they
  // emit changes that flow into these signals, and read back the value.
  // Sorting has two independent dimensions: the difficulty direction is the
  // primary grouping, and the alphabetical direction orders quizzes WITHIN
  // each difficulty group.
  readonly searchTerm = signal('');
  readonly sortDifficulty = signal<DifficultyDirection>('asc');
  readonly sortAlpha = signal<AlphaDirection>('az');

  // Persist both sort dimensions so they're remembered on the next visit.
  private readonly persistSortEffect = effect(() => {
    writeLocalString(SK_QUIZ_SORT_DIFFICULTY, this.sortDifficulty());
    writeLocalString(SK_QUIZ_SORT_ALPHA, this.sortAlpha());
  });

  // Persist the search term for THIS session (sessionStorage) so navigating
  // away to a quiz and back restores the filtered list. Clears when the
  // browser/tab closes, so a fresh visit starts with all quizzes.
  private readonly persistSearchEffect = effect(() => {
    writeSessionString(SK_QUIZ_SEARCH_TERM, this.searchTerm());
  });

  // The grid renders this: filter the full list by the search term, then sort
  // the result. Neither step mutates the source array (filter returns a new
  // array; sortQuizzes spreads before sorting).
  readonly displayedQuizzes = computed<Quiz[]>(() => {
    const term = this.searchTerm();
    const difficultyDir = this.sortDifficulty();
    const alphaDir = this.sortAlpha();
    const filtered = (this.quizzes() ?? []).filter(quiz => this.matchesSearch(quiz, term));
    return this.sortQuizzes(filtered, difficultyDir, alphaDir);
  });

  // Summary stats for the catalog row: total quizzes, total questions, and a
  // difficulty breakdown (e.g. "4 Beginner / 5 Intermediate"). Computed from the
  // FULL catalog (not the filtered/searched view).
  readonly quizStats = computed(() => {
    const list = this.quizzes() ?? [];
    const quizCount = list.length;
    const questionCount = list.reduce((sum, quiz) => sum + (quiz.questions?.length ?? 0), 0);

    const counts = new Map<string, number>();
    for (const quiz of list) {
      const difficulty = (quiz.difficulty ?? '').toLowerCase();
      if (difficulty) counts.set(difficulty, (counts.get(difficulty) ?? 0) + 1);
    }
    const levels = ['beginner', 'intermediate', 'advanced']
      .filter(difficulty => counts.has(difficulty))
      .map(difficulty => ({
        key: difficulty,
        label: `${difficulty[0].toUpperCase()}${difficulty.slice(1)}`,
        count: counts.get(difficulty) ?? 0
      }));

    return { quizCount, questionCount, levels };
  });

  // ── progress tracking (derived; reuses the shared best-score store) ─────
  // Recomputes whenever the quiz list changes. Reads completion + best scores
  // from ProgressService (single source), never from localStorage directly here.
  readonly progressSummary = computed<ProgressSummary>(() =>
    this.progressService.getProgressSummary(this.quizzes() ?? [])
  );

  // Per-quiz card state. 'completed' (durable best-score store, or an existing
  // completed status) wins; otherwise an existing STARTED/CONTINUE status →
  // 'in-progress'; otherwise 'not-started'. Best score shows only when recorded.
  readonly quizCardProgress = computed<Map<string, { state: QuizCardProgressState; bestScore: number | null }>>(() => {
    const list = this.quizzes() ?? [];
    const completedIds = this.completedQuizIds();
    const byQuiz = new Map<string, QuizProgress>();
    for (const progress of this.progressService.getQuizProgress(list)) {
      byQuiz.set(progress.quizId, progress);
    }

    const map = new Map<string, { state: QuizCardProgressState; bestScore: number | null }>();
    for (const quiz of list) {
      const progress = byQuiz.get(quiz.quizId);
      let state: QuizCardProgressState;
      if (progress?.completed || quiz.status === QuizStatus.COMPLETED || completedIds.has(quiz.quizId)) {
        state = 'completed';
      } else if (quiz.status === QuizStatus.STARTED || quiz.status === QuizStatus.CONTINUE) {
        state = 'in-progress';
      } else {
        state = 'not-started';
      }
      map.set(quiz.quizId, { state, bestScore: progress?.bestScore ?? null });
    }
    return map;
  });

  // Flat list of card states — drives the progress panel's "has activity" guard.
  readonly cardStateList = computed<QuizCardProgressState[]>(() =>
    Array.from(this.quizCardProgress().values()).map(entry => entry.state)
  );

  // Recommended Next Quiz. Derived from the SAME per-quiz state map the rest of
  // this screen uses (quizCardProgress), so it re-evaluates immediately whenever
  // progress changes (a quiz completed / started / a better score / reset) and
  // never duplicates status logic. Interview Mode uses synthetic ids that never
  // appear in quizCardProgress, so it can't affect the recommendation.
  readonly learningPath = computed(() => {
    const progress = this.quizCardProgress();
    const completed = new Set<string>();
    const inProgress = new Set<string>();
    for (const [quizId, entry] of progress) {
      if (entry.state === 'completed') completed.add(quizId);
      else if (entry.state === 'in-progress') inProgress.add(quizId);
    }
    return this.learningPathService.recommend(this.quizzes(), completed, inProgress);
  });

  // Advisory difficulty-readiness message. Reuses the existing best-score store
  // (same completion definition as Your Progress). Touch quizCardProgress() so it
  // re-evaluates whenever progress changes (a completed quiz / better score),
  // then reads the fresh best scores for the per-difficulty averages.
  readonly difficultyRecommendation = computed(() => {
    this.quizCardProgress();
    return this.difficultyService.recommend(this.quizzes(), this.bestScoreService.getBestScores());
  });

  readonly accessedCount = signal(0);
  readonly totalQuizCountSig = signal(0);
  readonly hasAccessedQuizzes = computed(() => this.accessedCount() > 0);

  readonly allQuizzesAccessed = computed(() =>
    this.totalQuizCountSig() > 0 &&
    this.accessedCount() >= this.totalQuizCountSig()
  );

  readonly accessedQuizLabel = computed(() =>
    this.accessedCount() === 1 ? 'quiz' : 'quizzes'
  );

  // Completion banner — reflects ACTUAL achievement state, never implying "all
  // done" at 4 / 6. Once every topic quiz is accessed it guides the user toward
  // the remaining achievements (Interview Master → Angular Explorer).
  readonly accessedBannerMessage = computed(() => {
    const accessedCount = this.accessedCount();

    if (this.allQuizzesAccessed()) {
      return achievementCompletionMessage(this.achievementsEarnedIds());
    }

    return `You accessed ${accessedCount} ${this.accessedQuizLabel()}. Keep going!`;
  });

  // Split the completion message into a headline (sits inline with the
  // "Achievements X / N" badge) and a subline (its own centered line below).
  // The message uses '\n' as the split point; states without one are headline-only.
  readonly completionParts = computed(() => {
    const msg = achievementCompletionMessage(this.achievementsEarnedIds());
    const nl = msg.indexOf('\n');
    return nl === -1
      ? { headline: msg, subline: '' }
      : { headline: msg.slice(0, nl), subline: msg.slice(nl + 1) };
  });

  private animationStateSignal = signal<AnimationState>('none');
  readonly animationState$ = toObservable(this.animationStateSignal);
  readonly animationStateSig = this.animationStateSignal.asReadonly();
  readonly selectionParams = signal<QuizSelectionParams | null>(null);

  ngOnInit(): void {
    // Tile imagery comes from /quizzes. Fire-and-forget: the bundled value keeps
    // tiles painted until this lands, and the service never throws.
    this.metadataApi.load().subscribe({ error: () => undefined });

    // Open at the TOP of the page — otherwise navigating here (e.g. "Select
    // Quiz" from a scrolled-down Results page) inherits the previous scroll
    // offset and lands partway down the list.
    if (typeof window !== 'undefined') {
      window.scrollTo(0, 0);
    }
    this.initializeQuizSelection();
  }

  async onSelect(quizId: string, _index: number): Promise<void> {
    try {
      if (!quizId) return;

      // The user is now using the quizzes this session → reveal the progress-
      // driven pieces on the Quiz Selection screen from here on (until reload).
      this.sessionEngagement.markEngaged();

      // Track this quiz as accessed AT SELECTION TIME so the
      // "You've accessed N quizzes" / "ALL quizzes accessed" banner
      // counts every quiz the user has clicked into, not just ones
      // that reached the results page.
      this.recordQuizAccess(quizId);

      // this.quizService.quizId = quizId;
      this.quizService.setQuizId(quizId);
      const currentQuiz = this.quizDataService.getCachedQuizById(quizId);
      const isCompleted = currentQuiz?.status === QuizStatus.COMPLETED
        || this.completedQuizIds().has(quizId);
      this.quizService.quizCompleted = isCompleted;

      // If quiz is completed, go to results instead of intro
      if (isCompleted) {
        this.quizService.setQuizStatus(QuizStatus.COMPLETED);
        this.quizService.setCompletedQuizId(quizId);
        await this.router.navigate([QuizRoutes.RESULTS, quizId]);
        return;
      }

      // Set status to STARTED if not already CONTINUE or COMPLETED
      if (!currentQuiz?.status || currentQuiz.status === QuizStatus.STARTED) {
        this.quizDataService.updateQuizStatus(quizId, QuizStatus.STARTED);
        this.quizService.setQuizStatus(QuizStatus.STARTED);
      }

      await this.router.navigate([QuizRoutes.INTRO, quizId]);
    } catch (err) {
      swallow('quiz-selection.component#1', err);
    }
  }

  // Featured Interview Mode card → the Build Your Interview page. Interview Mode
  // is NOT a topic quiz, so it deliberately bypasses onSelect (no access
  // tracking, status, or completion state) and touches none of the catalog
  // counts/progress/achievements.
  startBuildingInterview(): void {
    this.router.navigate(['/interview']);
  }

  // Difficulty-recommendation "Browse …" action. Advisory only — it never
  // filters, locks, or hides quizzes; it just scrolls to the quiz grid so the
  // user can pick from the full list. `_difficulty` is accepted for future use
  // (e.g. highlighting a level) without changing the recommendation contract.
  browseQuizzes(_difficulty: string): void {
    if (typeof document === 'undefined') return;
    document.querySelector('.quiz-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Tile background image. `quiz.image` comes from assets/data/quiz.json, which
  // we treat as UNTRUSTED input. Concatenating a raw value straight into a CSS
  // url() is a CSS-injection sink: a value containing ")" closes the url() early
  // and everything after it is parsed as further CSS declarations. We therefore
  // allow only same-origin relative asset paths or https: URLs, reject any value
  // carrying CSS/quote metacharacters, and emit the result inside double quotes.
  // All 20 images in the shipped dataset satisfy this, so rendering is unchanged;
  // a rejected value degrades to no background rather than injecting CSS.
  private static readonly SAFE_IMAGE_URL =
    /^(?:assets\/[\w\-./]+|https:\/\/[\w\-.]+\/[\w\-./%]*)$/i;

  private safeImageUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    // Characters that could break out of url(...) or inject a new declaration.
    if (!value || /["'()\\;\s]/.test(value)) return null;
    return QuizSelectionComponent.SAFE_IMAGE_URL.test(value) ? value : null;
  }

  getQuizTileStyles(quiz: Quiz): QuizTileStyles {
    // API-FIRST. `/quizzes` is the authority for tile imagery; the bundled value
    // is a transitional fallback that keeps tiles from going blank while a cold
    // backend answers. Both carry identical URLs today, so the swap is invisible.
    // The fallback goes with the asset in S7b-2.
    this.metadataApi.imageByQuiz();   // track the signal so tiles restyle on load
    const image = this.safeImageUrl(
      this.metadataApi.imageFor(quiz?.quizId) || quiz?.image
    );
    return {
      background: image
        ? `url("${image}") no-repeat center 10px`
        : 'none no-repeat center 10px',
      'background-size': '300px 210px'
    };
  }

  getLinkClass(quiz: Quiz): string[] {
    const classes = ['status-link'];
    if (
      quiz.status === QuizStatus.STARTED && (
        !this.selectionParams()?.quizCompleted ||
        quiz.quizId === this.selectionParams()?.startedQuizId ||
        quiz.quizId === this.selectionParams()?.continueQuizId ||
        this.completedQuizIds().has(quiz.quizId)
      )
    ) {
      classes.push('link');
    }
    return classes;
  }

  getTooltip(quiz: Quiz): string {
    if (quiz.status === QuizStatus.COMPLETED || this.completedQuizIds().has(quiz.quizId)) {
      return 'Completed';
    }
    switch (quiz.status) {
      case QuizStatus.STARTED:
        return 'Start';
      case QuizStatus.CONTINUE:
        return 'Continue';
      default:
        return '';
    }
  }

  shouldShowLink(quiz: Quiz): boolean {
    const hasKnownStatus = quiz.status === QuizStatus.STARTED
      || quiz.status === QuizStatus.CONTINUE
      || quiz.status === QuizStatus.COMPLETED;
    const isCompletedQuiz = this.completedQuizIds().has(quiz.quizId);
    return hasKnownStatus || isCompletedQuiz;
  }

  getLinkRouterLink(quiz: Quiz): string[] {
    const quizId = quiz.quizId;
    const isCompleted = quiz.status === QuizStatus.COMPLETED
      || this.completedQuizIds().has(quizId);
    return isCompleted ? ['/results/', quizId] : ['/intro/', quizId];
  }

  getIconClass(quiz: Quiz): string {
    switch (quiz.status) {
      case QuizStatus.STARTED:
        return 'play_arrow';
      case QuizStatus.CONTINUE:
        return 'fast_forward';
      case QuizStatus.COMPLETED:
        return 'done';
      default:
        // Fallback: if this quiz matches the completedQuizId, show checkmark
        if (this.completedQuizIds().has(quiz.quizId)) return 'done';
        return '';
    }
  }

  animationDoneHandler(): void {
    this.animationStateSignal.set('none');
  }

  public isCompleted(quiz: any): boolean {
    return (quiz?.status ?? '').toString().toLowerCase() === 'completed'
      || this.completedQuizIds().has(quiz?.quizId);
  }

  // Case-insensitive match against the quiz's milestone/title ONLY (not the
  // summary or difficulty). An empty term matches everything.
  private matchesSearch(quiz: Quiz, term: string): boolean {
    const needle = term.trim().toLowerCase();
    if (!needle) return true;
    // Match at the START of any word in the title, so "ang" finds "Angular" but
    // NOT "chANGe detection". A plain substring includes() matched mid-word noise.
    const title = (quiz?.milestone ?? '').toString().toLowerCase();
    return title.split(/[^a-z0-9]+/).some(word => word.startsWith(needle));
  }

  // Return a NEW sorted array (never mutates the input). Two-dimensional:
  // primary = difficulty rank (asc/desc), then alphabetical by milestone
  // (az/za) WITHIN each difficulty group.
  private sortQuizzes(quizzes: Quiz[], difficultyDir: DifficultyDirection, alphaDir: AlphaDirection): Quiz[] {
    const difficultyFactor = difficultyDir === 'asc' ? 1 : -1;
    const alphaFactor = alphaDir === 'az' ? 1 : -1;

    return [...quizzes].sort((a, b) => {
      const rankDiff = (this.difficultyRank(a) - this.difficultyRank(b)) * difficultyFactor;
      if (rankDiff !== 0) return rankDiff;
      return this.titleOf(a).localeCompare(this.titleOf(b)) * alphaFactor;  // within group
    });
  }

  private titleOf(quiz: Quiz): string {
    return (quiz?.milestone ?? '').toString().toLowerCase();
  }

  private difficultyRank(quiz: Quiz): number {
    const key = (quiz?.difficulty ?? '').toString().toLowerCase();
    const rank = QuizSelectionComponent.DIFFICULTY_RANK[key];
    return rank ?? QuizSelectionComponent.UNKNOWN_RANK;
  }

  private initializeQuizSelection(): void {
    this.restoreSortPreference();
    this.restoreSessionAccessState();
    this.selectionParams.set(this.quizService.returnQuizSelectionParams());
    this.loadQuizCatalog();
    this.refreshAchievementsSummary();
  }

  // Silently evaluate achievements from existing progress (persists any newly
  // qualified, but shows no celebration here) and publish the X / N summary.
  private refreshAchievementsSummary(): void {
    try {
      this.achievementService.evaluate(getQuizData());  // silent: return value ignored
      const { earned, total } = this.achievementService.summary();
      this.achievementsEarned.set(earned);
      this.achievementsTotal.set(total);
      this.achievementsEarnedIds.set(this.achievementService.earnedIds());
    } catch (err: unknown) { swallow('quiz-selection.component.ts', err); }
  }

  // Restore the sort dimensions (localStorage, cross-visit) and the search
  // term (sessionStorage, this session only) from a previous visit.
  private restoreSortPreference(): void {
    const savedDifficulty = readLocalString(SK_QUIZ_SORT_DIFFICULTY);
    if (savedDifficulty === 'asc' || savedDifficulty === 'desc') {
      this.sortDifficulty.set(savedDifficulty);
    }

    const savedAlpha = readLocalString(SK_QUIZ_SORT_ALPHA);
    if (savedAlpha === 'az' || savedAlpha === 'za') {
      this.sortAlpha.set(savedAlpha);
    }

    const savedSearch = readSessionString(SK_QUIZ_SEARCH_TERM);
    if (savedSearch) this.searchTerm.set(savedSearch);
  }

  // Restore quiz statuses from sessionStorage (one-time consumption)
  private restoreSessionAccessState(): void {
    try {
      const completedIds = this.consumeCompletedQuizIds();
      const startedIds = this.consumeStartedQuizIds();

      const allAccessed = new Set([...completedIds, ...startedIds]);
      this.accessedCount.set(allAccessed.size);
    } catch (err: unknown) {
      console.warn('[QuizSelection] Failed to restore quiz access state.', err);
      this.accessedCount.set(0);
    }
  }

  private consumeCompletedQuizIds(): string[] {
    // Read but DON'T remove — the user's accessed-quiz history needs to
    // persist across visits to the selection page, otherwise the
    // "You've accessed N quizzes" banner resets to whatever the latest
    // results page wrote (typically 1).
    const completedIds = readSessionJson<string[]>(SK_COMPLETED_QUIZ_IDS, []);

    for (const id of completedIds) {
      this.completedQuizIds.update(s => new Set(s).add(id));
      this.quizDataService.updateQuizStatus(id, QuizStatus.COMPLETED);
    }

    if (completedIds.length > 0) {
      this.quizService.setCompletedQuizId(completedIds[completedIds.length - 1]);
      this.quizService.quizCompleted = true;
    }

    return completedIds;
  }

  private consumeStartedQuizIds(): string[] {
    // Read but DON'T remove — see consumeCompletedQuizIds.
    const startedIds = readSessionJson<string[]>(SK_STARTED_QUIZ_IDS, []);

    for (const id of startedIds) {
      this.quizDataService.updateQuizStatus(id, QuizStatus.STARTED);
    }

    return startedIds;
  }

  // Persist a quiz access at selection time so the accessed-quizzes count
  // reflects every quiz the user has clicked into, regardless of whether
  // they completed it. The previous tracking in results.component.ts only
  // fires when the user reaches the results page, so quizzes the user
  // bailed on were uncounted.
  private recordQuizAccess(quizId: string): void {
    if (!quizId) return;
    try {
      const completed = readSessionJson<string[]>(SK_COMPLETED_QUIZ_IDS, []);
      if (completed.includes(quizId)) return;  // already counted

      const started = readSessionJson<string[]>(SK_STARTED_QUIZ_IDS, []);
      if (!started.includes(quizId)) {
        started.push(quizId);
        writeSessionJson(SK_STARTED_QUIZ_IDS, started);
      }

      // Update the live count immediately so the banner refreshes without
      // needing a route round-trip back to the selection page.
      const accessedSet = new Set([...completed, ...started]);
      this.accessedCount.set(accessedSet.size);
    } catch (err: unknown) { swallow('quiz-selection.component.ts', err); /* ignore storage failures */ }
  }

  // Load quizzes once – replaces constructor side-effect
  private loadQuizCatalog(): void {
    this.quizDataService.loadQuizzes().subscribe((quizzes) => {
      this.totalQuizCountSig.set(quizzes?.length ?? 0);
    });

  }
}
