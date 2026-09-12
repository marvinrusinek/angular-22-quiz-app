import {
  ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, OnInit, signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgClass, NgOptimizedImage, TitleCasePipe } from '@angular/common';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleChange, MatSlideToggleModule }
  from '@angular/material/slide-toggle';
import { EMPTY, firstValueFrom, TimeoutError } from 'rxjs';
import { catchError, map, switchMap, tap, timeout } from 'rxjs/operators';

import { Quiz, QuizDifficulty } from '../../shared/models/Quiz.model';
import { QuizQuestion } from '../../shared/models/QuizQuestion.model';

import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { TopicQuizMetadataService } from '../../shared/services/api/topic-quiz-metadata.service';
import { QuizDotStatusService } from '../../shared/services/flow/quiz-dot-status.service';
import { QuizNavigationService } from '../../shared/services/flow/quiz-navigation.service';
import { QuizPersistenceService } from '../../shared/services/state/quiz-persistence.service';
import { QuizService } from '../../shared/services/data/quiz.service';
import { QuizShuffleService } from '../../shared/services/flow/quiz-shuffle.service';
import { SelectedOptionService } from '../../shared/services/state/selectedoption.service';
import { TimerService } from '../../shared/services/features/timer/timer.service';
import { QuizStartSpinnerHandle, QuizStartSpinnerService } from '../../shared/services/ui/quiz-start-spinner.service';
import { swallow } from '../../shared/utils/error-logging';

/** The Introduction page's quiz preferences, as a typed Signal Forms model. */
export interface QuizPreferencesModel {
  shouldShuffleOptions: boolean;
}

@Component({
  selector: 'codelab-quiz-intro',
  standalone: true,
  imports: [
    NgClass,
    TitleCasePipe,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatSlideToggleModule,
    NgOptimizedImage
  ],
  templateUrl: './introduction.component.html',
  styleUrls: ['./introduction.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class IntroductionComponent implements OnInit {
  /**
   * Bounded timeout for the Start-Quiz question-loading operation ONLY —
   * chosen from MEASURED Spring/Neon cold-start behavior, not a guess:
   *
   *   - A fully cold Render container took 55.7s, and on a separate
   *     occasion 124.7s, to answer even a bare health check (direct curl
   *     timing).
   *   - Neon's own compute wake alone (container already warm) measured
   *     10.2s-13.1s across several real cold-question-fetch runs.
   *   - render.yaml's own, pre-existing comment already estimates "roughly
   *     30-60 seconds" for this app's cold start.
   *
   * 45s sits inside that documented 30-60s range: generous enough that a
   * typical cold start still succeeds without ever showing the timeout
   * state, but bounded enough that a genuinely stuck request surfaces a
   * concrete "still waking up" + Retry affordance well before the
   * multi-minute worst case observed directly, rather than leaving the
   * user staring at a spinner indefinitely. Warm requests (any environment,
   * any backend) are unaffected — this is far beyond any normal response.
   */
  private static readonly QUESTION_LOAD_TIMEOUT_MS = 45_000;

  // ── injects ─────────────────────────────────────────────────────
  private readonly dotStatusService = inject(QuizDotStatusService);
  private readonly metadataApi = inject(TopicQuizMetadataService);
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizNavigationService = inject(QuizNavigationService);
  private readonly quizPersistence = inject(QuizPersistenceService);
  private readonly quizService = inject(QuizService);
  private readonly quizShuffleService = inject(QuizShuffleService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly timerService = inject(TimerService);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly startSpinner = inject(QuizStartSpinnerService);

  // ── remaining variables ─────────────────────────────────────────
  quizId: string | undefined;
  readonly selectedQuiz = signal<Quiz | null>(null);
  // ── Signal Forms: quiz preferences ──────────────────────────────
  // A typed model replaces the FormBuilder group. The former group also carried
  // an `isImmediateFeedback` control that nothing ever read — dropped rather
  // than carried across.
  //
  // NOTE: with a single always-valid boolean there is no schema to attach; the
  // value of `form()` here is the typed model and losing the reactive-forms
  // machinery, not validation.
  private readonly preferences = signal<QuizPreferencesModel>({
    shouldShuffleOptions: false
  });

  readonly preferencesForm = form(this.preferences);

  /** The toggle's state, read straight off the field. */
  readonly isChecked = computed(() => this.preferencesForm.shouldShuffleOptions().value());
  readonly isStartingQuiz = signal(false);
  /**
   * True after a Start attempt genuinely failed to load real question
   * content (the backend never returned a usable question set) — renders a
   * Retry affordance instead of silently navigating into a broken, empty
   * quiz. Cleared at the start of every new attempt (including a retry).
   */
  private readonly _startFailed = signal(false);
  readonly startFailed = this._startFailed.asReadonly();
  /**
   * True specifically when the question-loading operation hit its own
   * bounded timeout (below) rather than a definite error — renders the
   * "server is still waking up" message instead of the generic
   * unreachable-service one. Cleared alongside `_startFailed`.
   */
  private readonly _startTimedOut = signal(false);
  readonly startTimedOut = this._startTimedOut.asReadonly();
  readonly questionCountSig = signal(0);
  readonly questionLabelSig = computed(() =>
    this.questionCountSig() === 1 ? 'question' : 'questions'
  );

  // Rough completion-time estimate: question count × per-question seconds
  // (TimerService.timePerQuestion, default 30s), rounded up to whole minutes.
  readonly estimatedMinutesSig = computed(() => {
    const count = this.questionCountSig();
    if (count <= 0) return 0;
    const seconds = count * this.timerService.timePerQuestion;
    return Math.max(1, Math.ceil(seconds / 60));
  });
  readonly introImgSig = signal('');

  // The in-flight start attempt's OWN handle, retained immediately after
  // showForStart() and cleared once that attempt completes normally. The
  // destroy hook below cancels THIS handle specifically — never the shared
  // service globally — so destroying this component can never affect some
  // OTHER component's newer, still-active attempt on the same overlay.
  private currentSpinnerAttempt: QuizStartSpinnerHandle | null = null;

  constructor() {

    // Mirror the toggle into QuizService whenever it changes. The write path is
    // now onSlideToggleChange() alone; this effect only propagates.
    effect(() => this.quizService.setCheckedShuffle(this.isChecked()));

    // Defensive safety net: if this component is destroyed while a start
    // attempt is still in flight (e.g. the user navigated away some other
    // way during a slow cold-backend fetch), the overlay must not be left
    // stuck. forceCancel() (not hide()) bypasses the minimum-duration floor
    // — a destroyed component has no polished transition left to protect —
    // and is scoped to THIS attempt's handle: a no-op if it has already
    // completed (currentSpinnerAttempt is null) or been superseded by a
    // newer attempt (forceCancel() checks generation ownership itself).
    this.destroyRef.onDestroy(() => this.currentSpinnerAttempt?.forceCancel());
  }

  ngOnInit(): void {
    // Intro imagery comes from /quizzes; the bundled value covers the gap.
    this.metadataApi.load().subscribe({ error: () => undefined });
    this.quizService.clearStoredCorrectAnswersText();
    this.subscribeToRouteParameters();
  }

  // The SINGLE write path for the toggle. Previously the template used BOTH
  // formControlName and this handler, so every flip was applied twice — once
  // through the control's valueChanges effect and once here.
  onSlideToggleChange(event: MatSlideToggleChange): void {
    this.preferencesForm.shouldShuffleOptions().value.set(event.checked);
  }

  async onStartQuiz(quizId?: string): Promise<void> {
    // Guards against duplicate Start requests: a second click while one is
    // already in flight is a no-op rather than a second fetch/navigation.
    if (this.isStartingQuiz()) return;

    this.isStartingQuiz.set(true);
    // Clear any previous failure/timeout state — this is a fresh attempt (or a retry).
    this._startFailed.set(false);
    this._startTimedOut.set(false);

    // Play the "starting the quiz" spinner over the INTRO. The returned
    // handle is scoped to THIS attempt: minimumElapsed resolves after the
    // minimum rotation (1600ms) but does NOT hide the overlay by itself —
    // spinner.hide() below does that, once the real work AND that minimum
    // have both completed. On a cold backend this keeps the overlay up for
    // the genuine wait instead of it vanishing early while the fetch is
    // still silently in flight. Because the handle is generation-stamped, a
    // late finally-block hide() from an attempt superseded by a NEWER one
    // (e.g. this component was destroyed and a different start flow began)
    // can never prematurely hide that newer attempt's overlay. Retained
    // immediately so the destroy hook can cancel exactly THIS attempt.
    const spinner = this.startSpinner.showForStart();
    this.currentSpinnerAttempt = spinner;

    try {
      const targetQuizId = this.resolveTargetQuizId(quizId);
      if (!targetQuizId) return;

      this.clearCachesAndResetSession(targetQuizId);

      const activeQuiz = await this.resolveActiveQuiz(targetQuizId);
      if (!activeQuiz) return;

      const shouldShuffleOptions = this.isChecked();
      this.applySelectedQuizState(activeQuiz, targetQuizId, shouldShuffleOptions);

      this.resetQuizForFreshStart(targetQuizId);

      const outcome = await this.prepareAndSetCurrentQuiz(activeQuiz, targetQuizId);
      if (outcome !== 'success') {
        // Genuine backend failure, an empty result (which for a real quiz
        // means the same thing), or the bounded timeout firing: do NOT
        // blindly proceed to navigateToFirstQuestion. That path's own
        // ensureSessionQuestions (and, again, resetUIAndNavigate's internal
        // call to it) would silently re-issue the SAME real HTTP request a
        // second and third time — exactly the duplicate-request pattern
        // that, against a struggling backend, turned one slow attempt into
        // a multi-minute apparent hang with no way for the user to know or
        // act, and no way for a genuinely hung request to ever surface a
        // failure at all. One click means ONE logical load attempt, bounded
        // in time; a real failure or a timeout surfaces here, immediately,
        // as a Retry action instead.
        this._startFailed.set(true);
        this._startTimedOut.set(outcome === 'timeout');
        return;
      }

      // Wait out the spinner's minimum rotation over the intro (already
      // elapsed if the fetch above took longer than that), THEN navigate so
      // the Q1 timer only starts once the overlay is ready to fade away.
      await spinner.minimumElapsed;

      await this.navigateToFirstQuestion(targetQuizId);
    } finally {
      // Runs on every exit — success, an early return (unresolved quiz id or
      // quiz), or navigation failure — so the overlay and the in-flight flag
      // never outlive the attempt they belong to. hide() is idempotent, and
      // scoped to THIS attempt's generation.
      spinner.hide();
      // Clear the retained handle now that this attempt has completed
      // normally — the destroy hook has nothing left to cancel for it.
      this.currentSpinnerAttempt = null;
      this.isStartingQuiz.set(false);
    }
  }

  private subscribeToRouteParameters(): void {
    this.activatedRoute.params
      .pipe(
        tap((params) => this.handleRouteParams(params)),
        tap((params) => this.paintFromSeededMetadata(params['quizId'])),
        switchMap((params) => this.fetchQuiz(params)),
        tap((quiz) => this.logQuizLoaded(quiz)),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: (quiz: Quiz | null) => this.handleLoadedQuiz(quiz),
        error: (error) => this.handleError(error)
      });
  }

  private handleRouteParams(params: Params): void {
    this.quizId = params['quizId'];
  }

  /**
   * First paint, synchronously. `TopicQuizMetadataService` seeds its public
   * metadata signals from the bundled `QUIZ_CATALOG_METADATA` at construction
   * — the same mechanism QuizSelection's tiles already read to paint instantly
   * — so a known quiz id resolves here before `metadataApi.load()`'s HTTP round
   * trip ever settles. Without this, Introduction sat on "Loading…" for
   * however long a cold `GET /api/quizzes` took (visible on a cold Render
   * backend); `fetchQuiz` below still runs afterwards and refreshes
   * `selectedQuiz` once the authoritative response lands.
   */
  private paintFromSeededMetadata(quizId: string | undefined): void {
    if (!quizId) return;
    const seeded = this.buildQuizFromMetadata(quizId);
    if (seeded) this.handleLoadedQuiz(seeded);
  }

  private fetchQuiz(params: Params) {
    const quizId = params['quizId'];
    if (!quizId) {
      return EMPTY;  // return EMPTY if no quizId is available
    }

    // Hard refresh on /quiz/intro/:quizId skips QuizSelection, so the
    // metadata list may not have been fetched yet. load() triggers the HTTP
    // fetch on first run (shared/cached), then buildQuizFromMetadata resolves
    // again against the authoritative response — refreshing (or, for a quiz id
    // absent from the bundled seed, first supplying) selectedQuiz.
    return this.metadataApi.load().pipe(
      map(() => this.buildQuizFromMetadata(quizId)),
      catchError(() => EMPTY)
    );
  }

  // Build a synthetic Quiz from API metadata alone — no client bank read.
  // summary is intentionally blank; Introduction never displayed it.
  private buildQuizFromMetadata(quizId: string): Quiz | null {
    if (!this.metadataApi.questionCountByQuiz().has(quizId)) return null;
    return {
      quizId,
      milestone: this.metadataApi.milestoneFor(quizId) ?? '',
      summary: '',
      image: this.metadataApi.imageFor(quizId) ?? '',
      difficulty: this.metadataApi.difficultyByQuiz().get(quizId) as QuizDifficulty | undefined,
      facts: [...this.metadataApi.factsFor(quizId)]
    };
  }

  private logQuizLoaded(quiz: Quiz | null): void {
    if (!quiz) {
      console.warn('[QuizSelection] Quiz was not found or failed to load.');
      return;
    }
  }

  private handleLoadedQuiz(quiz: Quiz | null): void {
    if (quiz) {
      const questionCount = this.metadataApi.questionCountByQuiz().get(quiz.quizId) ?? 0;

      this.selectedQuiz.set(quiz);
      // API-FIRST: /quizzes is the authority for imagery; the bundled value is
      // a transitional fallback for a cold backend. Removed with the asset in S7b-2.
      this.introImgSig.set(this.metadataApi.imageFor(quiz.quizId) || quiz.image);
      this.questionCountSig.set(questionCount);
    } else {
      console.warn('[QuizSelection] Quiz was not found or failed to load.');

      this.selectedQuiz.set(null);
      this.introImgSig.set('');
      this.questionCountSig.set(0);
    }
  }

  private handleError(error: unknown): void {
    console.error('[QuizSelection] Failed to load quiz:', error);

    this.selectedQuiz.set(null);
    this.introImgSig.set('');
    this.questionCountSig.set(0);
  }

  // Resolve which quiz id the user is starting: explicit override → field
  // → localStorage fallback. Returns null when nothing resolves.
  private resolveTargetQuizId(override?: string): string | null {
    return override ?? this.quizId ?? this.getStoredQuizId();
  }

  // Drop cached questions + shuffle state for this quiz so the run that
  // follows gets a fresh shuffle, then reset the in-memory session.
  private clearCachesAndResetSession(targetQuizId: string): void {
    this.quizDataService.clearQuizQuestionCache(targetQuizId);
    this.quizShuffleService.clear(targetQuizId);
    this.quizService.resetQuizSessionState();
  }

  // Apply the user's selected quiz across services, persist the id, and
  // commit the shuffle preference. Index resets to Q1 (0).
  private applySelectedQuizState(
    activeQuiz: Quiz,
    targetQuizId: string,
    shouldShuffleOptions: boolean
  ): void {
    this.quizDataService.setSelectedQuiz(activeQuiz);
    this.quizService.setSelectedQuiz(activeQuiz);
    this.quizService.setActiveQuiz(activeQuiz);
    this.persistQuizId(targetQuizId);
    this.quizService.setCheckedShuffle(shouldShuffleOptions);
    this.quizService.setQuizId(targetQuizId);
    this.quizService.setCurrentQuestionIndex(0);
  }

  // Hard fresh-start reset for same-tab runs before entering Q1.
  // Prevents stale state (e.g. 1/6 score) leaking from a prior attempt.
  // Storage cleanup is delegated to QuizPersistenceService.
  private resetQuizForFreshStart(targetQuizId: string): void {
    // A fresh start is a NEW attempt → mint a new attempt id so its completion
    // records a distinct High Scores row (even if it scores the same as before).
    this.quizService.startNewAttempt();
    this.quizService.resetScore();
    this.quizService.questionCorrectness.clear();
    this.quizService.selectedOptionsMap.clear();
    this.quizService.userAnswers = [];
    this.quizService.answers = [];
    this.selectedOptionService.clearAllSelectionsForQuiz(targetQuizId);
    this.selectedOptionService.clearRefreshBackup();
    this.selectedOptionService.clickConfirmedDotStatus.clear();
    this.selectedOptionService.lastClickedCorrectByQuestion.clear();
    this.dotStatusService.clearAllMaps();
    this.quizPersistence.clearClickConfirmedDotStatus(20);
    this.quizPersistence.clearAllPersistedDotStatus(targetQuizId);
    this.quizPersistence.clearAllForFreshStart(targetQuizId);
  }

  // Prepare the quiz session (which produces shuffled questions) and commit
  // the resulting quiz to the data service. Returns which of three outcomes
  // actually occurred, so the caller can distinguish a bounded timeout (show
  // "still waking up") from any other failure (show the generic message).
  //
  // QuizDataService.prepareQuizSession's own API-fetch branch resolves to an
  // EMPTY array on failure rather than throwing (its trailing catchError
  // recovers with `of([])` — see its own doc comment: "the next attempt
  // re-requests"), so the `catch` block below is a defensive fallback for a
  // genuinely thrown error; an empty array is the MORE LIKELY failure
  // signal in practice and is checked explicitly. A real quiz's metadata
  // (questionCountSig, already shown on this very page) is never zero, so
  // an empty result here always means the fetch didn't actually succeed —
  // never a legitimate "this quiz has no questions" state.
  //
  // The `timeout()` operator bounds ONLY this operation — see
  // QUESTION_LOAD_TIMEOUT_MS's own doc comment for the measured reasoning
  // behind 45s. It unsubscribes from `prepareQuizSession`'s Observable when
  // it fires, but the UNDERLYING real HTTP call is not necessarily
  // cancelled: TopicQuizQuestionsService's cache multicasts via
  // `shareReplay({ refCount: false })`, so the real request — and any OTHER
  // consumer sharing it — keeps running regardless of how many downstream
  // subscribers stop listening. That is intentional and harmless: once this
  // method's own `firstValueFrom` has rejected with a TimeoutError, that
  // Promise is permanently settled, so a value arriving on the shared
  // source afterward can never retroactively change this outcome — a late
  // response after a timeout is inherently ignored, not specially handled.
  private async prepareAndSetCurrentQuiz(
    activeQuiz: Quiz,
    targetQuizId: string
  ): Promise<'success' | 'timeout' | 'error'> {
    try {
      const preparedQuestions = (await firstValueFrom(
        this.quizDataService.prepareQuizSession(targetQuizId).pipe(
          timeout(IntroductionComponent.QUESTION_LOAD_TIMEOUT_MS)
        ),
      )) as QuizQuestion[];

      if (!Array.isArray(preparedQuestions) || preparedQuestions.length === 0) {
        return 'error';
      }

      this.quizDataService.setCurrentQuiz({ ...activeQuiz, questions: preparedQuestions });
      return 'success';
    } catch (err: unknown) {
      this.quizDataService.setCurrentQuiz(activeQuiz);
      return err instanceof TimeoutError ? 'timeout' : 'error';
    }
  }

  private async navigateToFirstQuestion(targetQuizId: string): Promise<boolean> {
    // Resolve the effective quiz id (override → service → component → localStorage)
    const quizId = this.quizNavigationService.resolveEffectiveQuizId(targetQuizId);
    if (!quizId) return false;

    // Ensure the session is ready and can resolve Q0 (best-effort; don’t block nav)
    await this.quizNavigationService.ensureSessionQuestions(quizId);

    const firstQuestion = await this.quizNavigationService.tryResolveQuestion(0);
    if (!firstQuestion) {
      console.warn('[QuizSelection] Could not resolve first question before navigation.');
    }

    try {
      // Preferred path: let the service reset UI and navigate to Q1 (index 0)
      const viaService = await this.quizNavigationService.resetUIAndNavigate(
        0,
        quizId
      );
      if (viaService) return true;  // if the service explicitly succeeded, we’re done

      // Service returned false/undefined/non-boolean – fall back to direct navigation
    } catch (err) {
      swallow('introduction.component#1', err);
    }

    // Fallback to direct router navigation
    try {
      // Router expects 1-based question in URL; index 0 ⇒ "/.../1"
      const fallbackSucceeded = await this.router.navigate([
        '/quiz/question',
        quizId,
        1,
      ]);

      if (!fallbackSucceeded) {
        console.warn(
          '[QuizSelection] Fallback navigation returned false.',
          { quizId }
        );
      }

      return fallbackSucceeded;
    } catch (err: unknown) {
      console.error(
        '[QuizSelection] Fallback navigation failed.',
        { quizId, error: err }
      );

      return false;
    }
  }

  private async resolveActiveQuiz(targetQuizId: string): Promise<Quiz | null> {
    const quizFromState = this.selectedQuiz();

    if (quizFromState?.quizId === targetQuizId) return quizFromState;

    try {
      await firstValueFrom(this.metadataApi.load());
      const loadedQuiz = this.buildQuizFromMetadata(targetQuizId);
      if (loadedQuiz) {
        this.selectedQuiz.set(loadedQuiz);
      }
      return loadedQuiz;
    } catch {
      // error handled silently
      return null;
    }
  }

  private getStoredQuizId(): string | null {
    try {
      if (typeof localStorage === 'undefined') {
        return null;
      }
      return localStorage.getItem('quizId');
    } catch {
      return null;
    }
  }

  private persistQuizId(quizId: string): void {
    try {
      localStorage.setItem('quizId', quizId);
    } catch (err: unknown) {
      console.error('Failed to persist quizId to localStorage:', err);
    }
  }
}
