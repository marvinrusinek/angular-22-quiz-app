import { Service, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, ParamMap, Params, Router } from '@angular/router';
import { distinctUntilChanged, filter, map, tap } from 'rxjs/operators';

import { SK_SAVED_QUESTION_INDEX } from '../../constants/session-keys';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { NextButtonStateService } from '../state/next-button-state.service';
import { QuizContentLoaderService } from './quiz-content-loader.service';
import { QuizDotStatusService } from './quiz-dot-status.service';
import { QuizNavigationService } from './quiz-navigation.service';
import { QuizPersistenceService } from '../state/quiz-persistence.service';
import { QuizResetService } from './quiz-reset.service';
import { QuizRouteService } from './quiz-route.service';
import { QuizService } from '../data/quiz.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { SelectionMessageService } from '../features/selection-message/selection-message.service';
import { QuestionTimingService } from '../features/timer/question-timing.service';
import { TimerService } from '../features/timer/timer.service';

import type { QuizComponent } from '../../../containers/quiz/quiz.component';
import { withCorrectCountBanner } from '../../utils/correct-count-banner';
import { isOptionCorrect } from '../../utils/is-option-correct';
import { swallow } from '../../utils/error-logging';

type Host = QuizComponent;

/**
 * Handles route subscriptions, URL-driven navigation, and question-index tracking for QuizComponent.
 * Extracted from QuizSetupService.
 */
@Service()
export class QuizSetupRouteService {
  // ── injects ─────────────────────────────────────────────────────
  private dotStatusService = inject(QuizDotStatusService);
  private nextButtonStateService = inject(NextButtonStateService);
  private questionTimingService = inject(QuestionTimingService);
  private quizContentLoaderService = inject(QuizContentLoaderService);
  private quizNavigationService = inject(QuizNavigationService);
  private quizPersistence = inject(QuizPersistenceService);
  private quizResetService = inject(QuizResetService);
  private quizRouteService = inject(QuizRouteService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private router = inject(Router);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);
  private timerService = inject(TimerService);

  // ── public methods ──────────────────────────────────────────────

  // â”€â”€ Route events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  subscribeToRouteEvents(
    host: Host,
    loadQuestions: (host: Host) => Promise<void>
  ): void {
    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(async () => {
        const { routeQuizId, index: idx, isQuizSwitch } =
          this.quizRouteService.parseNavigationEndParams(host.activatedRoute, host.quizId());

        if (isQuizSwitch && routeQuizId) {
          this.quizNavigationService.resetForNewQuiz();
          this.quizResetService.performQuizSwitchResets(routeQuizId);
          this.resetComponentStateForQuizSwitch(host, routeQuizId);
          await loadQuestions(host);
          host.isQuizLoaded.set(true);
        }

        host.currentQuestionIndex.set(idx);
        this.quizService.setCurrentQuestionIndex(idx);
        host.updateDotStatus(idx);

        // Force-update combinedQuestionData so the template always
        // has question data after URL navigation. Prefer quizService.questions
        // getter which returns shuffled data when shuffle is active.
        const question = this.quizService.questions?.[idx]
          ?? host.questionsArray()?.[idx] ?? null;
        if (question && question.options?.length > 0) {
          const payload = {
            question,
            options: question.options,
            explanation: question.explanation
          };
          host.combinedQuestionData.set(payload);
          host.questionToDisplaySig.set(question.questionText?.trim() ?? '');
          host.cdRef.markForCheck();

          // Heading is rendered by the single-source headingHtml computed; the
          // setTimeout cascade that stamped question text into <h3> is no longer
          // needed (the computed renders the question from state).

          // Retry after microtask to ensure child components have rendered
          Promise.resolve().then(() => {
            host.combinedQuestionData.set(payload);
            host.cdRef.markForCheck();
          });
        }
      });
  }

  private resetComponentStateForQuizSwitch(host: Host, routeQuizId: string): void {
    host.questionsArray.set([]);
    host.currentQuestion.set(null);
    host.optionsToDisplaySig.set([]);
    host.combinedQuestionData.set(null);
    host.questionToDisplaySig.set('');
    host.explanationToDisplay.set('');
    host.currentQuestionIndex.set(0);
    host.lastLoggedIndex = -1;
    host.navigatingToResults.set(false);
    host.isQuizLoaded.set(false);
    host.isQuizDataLoaded.set(false);
    host.totalQuestions.set(0);
    host.progressSig.set(0);
    host.quizId.set(routeQuizId);
    this.quizService.setQuizId(routeQuizId);
  }

  fetchTotalQuestions(host: Host): void {
    this.quizService.getTotalQuestionsCount(host.quizId())
      .pipe()
      .subscribe((total: number) => {
        host.totalQuestions.set(total);
        host.cdRef.markForCheck();
      });
  }

  subscribeToQuestionIndex(host: Host): void {
    this.quizService.currentQuestionIndex$
      .pipe(distinctUntilChanged(), takeUntilDestroyed(host.destroyRef))
      .subscribe((idx: number) => {
        const prevIdx = host.lastLoggedIndex;
        host.lastLoggedIndex = idx;
        host.currentQuestionIndex.set(idx);
        const { question, isNavigation } = this.quizContentLoaderService.handleQuestionIndexTransition({
          idx, prevIdx, quizId: host.quizId(), questionsArray: host.questionsArray()
        });

        if (question) {
          host.currentQuestion.set(question);
          host.questionToDisplaySig.set(question.questionText?.trim() ?? '');
          host.combinedQuestionData.set({
            question, options: question.options, explanation: question.explanation
          });
        }
        host.cdRef.markForCheck();

        if (isNavigation) {
          host.explanationToDisplay.set('');
          host.optionsToDisplaySig.set([]);
          host.updateDotStatus(idx);
        }
        // Nuclear clear: wipe ALL locks on navigation so disable state
        // from any prior question can't leak into the new one.
        try {
          const sos: any = this.selectedOptionService;
          sos._lockedByQuestion?.clear?.();
          sos._questionLocks?.clear?.();
          const sms: any = this.selectionMessageService;
          sms._singleAnswerCorrectLock?.clear?.();
          sms._singleAnswerIncorrectLock?.clear?.();
          sms._multiAnswerInProgressLock?.clear?.();
          sms._multiAnswerCompletionLock?.clear?.();
          sms._multiAnswerPreLock?.clear?.();
        } catch (err: unknown) {
          console.error('QuizSetupRouteService.subscribeToQuestionIndex lock clear failed:', err);
        }

        // Start the timer on both initial load and navigation (unless answered)
        if (!this.selectedOptionService.isQuestionAnswered(idx)) {
          this.timerService.restartForQuestion(idx);
        }
      });
  }

  subscribeToRouteParams(host: Host): void {
    host.activatedRoute.paramMap
      .pipe(
        distinctUntilChanged(
          (prev: ParamMap, curr: ParamMap) =>
            prev.get('questionIndex') === curr.get('questionIndex') &&
            prev.get('quizId') === curr.get('quizId')
        )
      )
      .subscribe((params: ParamMap) => void this.handleParamMapChange(host, params));
  }

  private async handleParamMapChange(host: Host, params: ParamMap): Promise<void> {
    const quizId = params.get('quizId') ?? '';
    const indexParam = params.get('questionIndex');
    const index = Number(indexParam) - 1;
    if (!quizId || isNaN(index) || index < 0) return;

    if (host.quizId() && host.quizId() !== quizId) {
      this.dotStatusService.clearAllMaps();
      this.quizPersistence.clearClickConfirmedDotStatus(host.totalQuestions() || 20);
      host.progressSig.set(0);
      this.quizStateService.reset();
    }

    host.quizId.set(quizId);
    host.currentQuestionIndex.set(index);
    this.quizService.setQuizId(quizId);
    this.quizService.setCurrentQuestionIndex(index);
    this.timerService.stopTimer?.(undefined, { force: true });
    this.timerService.resetTimer();
    this.timerService.resetTimerFlagsFor(index);

    try {
      const result = await this.quizContentLoaderService.loadQuestionFromRouteChange({ quizId, index });
      if (!result.success || !result.question) return;

      host.totalQuestions.set(result.totalQuestions);
      host.currentQuestion.set(result.question);
      host.question.set(result.question);
      const payload = {
        question: result.question, options: result.options, explanation: result.explanation
      };
      host.combinedQuestionData.set(payload);
      host.questionToDisplaySig.set(result.question.questionText?.trim() ?? '');
      host.optionsToDisplaySig.set([...result.options]);
      host.explanationToDisplay.set(result.explanation);
      host.shouldRenderOptions.set(true);
      host.cdRef.markForCheck();

      // Heading is rendered by the single-source headingHtml computed; the
      // setTimeout cascade that stamped question text into <h3> is no longer
      // needed (the computed renders the question from state).

      if (!result.hasValidSelections) {
        this.timerService.restartForQuestion(index);
      } else {
        // Answered question on revisit: freeze at the recorded time taken.
        this.timerService.freezeAtRecordedTime(index);
      }
      localStorage.setItem(SK_SAVED_QUESTION_INDEX, index.toString());
    } catch (err: unknown) {
      console.error('QuizSetupRouteService.subscribeToRouteParams param map change handling failed:', err);
    }
  }

  fetchRouteParams(host: Host): void {
    host.activatedRoute.params
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe((params: Params) => {
        host.quizId.set(params['quizId'] ?? '');
        host.questionIndex.set(+params['questionIndex']);
        host.currentQuestionIndex.set(host.questionIndex() - 1);
      });
  }

  subscribeRouterAndInit(host: Host): void {
    host.activatedRoute.data
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe((data: any) => {
        const quizData = data['quizData'];
        if (!quizData?.questions?.length) {
          void this.router.navigate(['/select']);
          return;
        }
        host.quizId.set(quizData.quizId);
        host.questionIndex.set(+host.activatedRoute.snapshot.params['questionIndex']);
      });
  }

  setupNavigation(host: Host): void {
    host.activatedRoute.params
      .pipe(
        takeUntilDestroyed(host.destroyRef),
        map((params: Params) => +params['questionIndex']),
        distinctUntilChanged(),
        tap((currentIndex: number) => {
          host.isNavigatedByUrl.set(true);
          void this.updateContentBasedOnIndex(host, currentIndex);
        })
      )
      .subscribe();
  }

  async updateContentBasedOnIndex(host: Host, index: number): Promise<void> {
    const adjustedIndex = index - 1;
    const total = host.quiz()?.questions?.length ?? 0;
    if (adjustedIndex < 0 || adjustedIndex >= total) return;

    this.quizContentLoaderService.lockAndPurgeFet(adjustedIndex);

    if (host.previousIndex() === adjustedIndex && !host.isNavigatedByUrl()) return;

    host.currentQuestionIndex.set(adjustedIndex);
    host.previousIndex.set(adjustedIndex);
    this.quizService.currentQuestionIndexSig.set(adjustedIndex);
    this.quizService.currentQuestionIndexSubject.next(adjustedIndex);

    host.explanationToDisplay.set('');
    this.quizContentLoaderService.resetDisplayExplanationText(host.currentQuestionIndex());
    this.quizContentLoaderService.clearAllOptionStates();
    this.nextButtonStateService.setNextButtonState(false);

    await new Promise<void>((res) => requestAnimationFrame(() => res()));

    try {
      await this.loadQuestionByRouteIndex(host, index);
      this.quizContentLoaderService.unlockFetGateAfterRender(
        adjustedIndex,
        () => host.currentQuestionIndex(),
        () => host.cdRef.markForCheck()
      );
      setTimeout(() => this.quizContentLoaderService.enableAllOptionPointerEvents(), 200);
    } catch (err: unknown) {
      console.error('QuizSetupRouteService.handleRouteIndexChange content update failed:', err);
    } finally {
      host.isNavigatedByUrl.set(false);
    }
  }

  async loadQuestionByRouteIndex(host: Host, routeIndex: number): Promise<void> {
    try {
      const result = await this.quizContentLoaderService.loadQuestionByRoute({
        routeIndex, quiz: host.quiz(), quizId: host.quizId(), totalQuestions: host.totalQuestions(),
      });
      if (result.questionIndex === -1) {
        void this.router.navigate(['/question/', host.quizId(), 1]);
        return;
      }
      if (!result.success || !result.question) return;
      host.currentQuestionIndex.set(result.questionIndex);
      this.timerService.resetTimer();
      this.resetFeedbackState(host);
      host.currentQuestion.set(result.question);

      // Timing is requested only once the question is installed, because the
      // freeze/start decision reads the active question's answered state. The
      // countdown itself begins when the signed deadline arrives — never from
      // a local 30s guess started here.
      this.questionTimingService.activateQuestionTiming(
        host.quizId(), result.question.questionText, result.questionIndex
      );

      host.combinedQuestionData.set({
        question: result.question, options: result.question.options ?? [], explanation: result.question.explanation ?? ''
      });
      host.questionToDisplaySig.set(result.questionText);
      host.optionsToDisplaySig.set(result.optionsWithIds);
      setTimeout(() => {
        this.quizContentLoaderService.restoreSelectedOptionsFromSession(host.optionsToDisplaySig());
        setTimeout(() => {
          const prev = host.optionsToDisplaySig().find((opt: Option) => opt.selected);
          if (prev) this.selectedOptionService.reapplySelectionForQuestion(prev, host.currentQuestionIndex());
        }, 50);
      }, 50);
    } catch (err: unknown) {
      console.error('QuizSetupRouteService.loadQuestionByRouteIndex question load failed:', err);
      host.cdRef.markForCheck();
    }
  }

  private resetFeedbackState(host: Host): void {
    for (const option of host.optionsToDisplaySig()) {
      option.feedback = '';
      option.showIcon = false;
      option.selected = false;
    }
    host.cdRef.markForCheck();
  }

  /**
   * Build question display HTML including the multi-answer banner.
   * Uses pristine quizInitialState for accurate correct-answer count.
   */
  buildQuestionDisplayHTML(question: QuizQuestion): string {
    const rawQ = (question.questionText ?? '').trim();
    if (!rawQ) return '';

    const opts = question.options ?? [];
    let numCorrect = opts.filter((o: Option) => isOptionCorrect(o)).length;

    // Cross-check against pristine data for accurate count
    try {
      const pq = this.quizService?.getPristineQuestionByText(rawQ);
      if (pq) {
        const pc = (pq.options ?? []).filter(
          (o: any) => isOptionCorrect(o)
        ).length;
        if (pc > numCorrect) numCorrect = pc;
      }
    } catch (err: unknown) { swallow('quiz-setup-route.service.ts', err); }

    if (numCorrect > 1 && opts.length > 0) {
      const pluralSuffix = numCorrect === 1 ? 'answer is' : 'answers are';
      const banner = `(${numCorrect} ${pluralSuffix} correct)`;
      return withCorrectCountBanner(rawQ, banner);
    }
    return rawQ;
  }
}