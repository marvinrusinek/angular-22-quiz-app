import { inject, Service } from '@angular/core';
import { ParamMap } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { debounceTime, tap } from 'rxjs/operators';

import { QUESTION_ROUTE_REGEX } from '@shared/constants/route-patterns';
import { SK_SEL_Q } from '@shared/constants/session-keys';

import { Option } from '@shared/models/Option.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

import { CqcFetGuardService } from './cqc-fet-guard.service';

import type { CodelabQuizContentComponent } from '../../../../containers/quiz/quiz-content/codelab-quiz-content.component';

type Host = CodelabQuizContentComponent;

/**
 * Manages question navigation and loading for CodelabQuizContentComponent.
 * Extracted from CqcOrchestratorService.
 *
 * Responsible for:
 * - cleanupStaleStateForIndex: post-refresh stale state cleanup
 * - runQuestionIndexSet: question index change handling
 * - runLoadQuizDataFromRoute: route-based quiz data loading
 * - runLoadQuestion: question loading with FET recovery
 */
@Service()
export class CqcQuestionNavService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly fetGuard = inject(CqcFetGuardService);


  /**
   * If the current browser nav is a page refresh AND the target idx
   * differs from the index we refreshed on, wipe all stale restored
   * state for the target idx so downstream pipelines treat it as fresh.
   * Idempotent — safe to call from multiple entry points.
   */
  cleanupStaleStateForIndex(host: Host, idx: number): void {
    try {
      let isPageRefresh = false;
      try {
        const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
        isPageRefresh = navEntries.length > 0 && navEntries[0].type === 'reload';
      } catch { /* ignore */ }

      if (!isPageRefresh) return;

      if (host._refreshInitialIdx == null) {
        let urlIdx: number | null = null;
        try {
          const match = (window?.location?.pathname ?? '').match(QUESTION_ROUTE_REGEX);
          if (match && match[1]) {
            const oneBased = parseInt(match[1], 10);
            if (Number.isFinite(oneBased) && oneBased >= 1) urlIdx = oneBased - 1;
          }
        } catch { /* ignore */ }
        host._refreshInitialIdx = urlIdx ?? idx;
        if (host._refreshInitialIdx === idx) return;
      }

      if (host._refreshInitialIdx === idx) return;

      if (!host._postRefreshCleanedIndices) {
        host._postRefreshCleanedIndices = new Set<number>();
      }
      if (host._postRefreshCleanedIndices.has(idx)) return;
      host._postRefreshCleanedIndices.add(idx);

      try {
        host.quizStateService._hasUserInteracted?.delete(idx);
        host.quizStateService._answeredQuestionIndices?.delete(idx);
        host.quizStateService.persistInteractionState?.();
      } catch { /* ignore */ }
      try {
        host.selectedOptionService.selectedOptionsMap?.delete(idx);
        host.selectedOptionService._refreshBackup?.delete(idx);
      } catch { /* ignore */ }
      try {
        host.quizService.selectedOptionsMap?.delete(idx);
      } catch { /* ignore */ }
      try {
        sessionStorage.removeItem(SK_SEL_Q + idx);
      } catch { /* ignore */ }
      try {
        host.explanationTextService.fetByIndex?.delete(idx);
        delete (host.explanationTextService.formattedExplanations as any)[idx];
      } catch { /* ignore */ }
      try {
        host.quizStateService.setDisplayState({ mode: 'question', answered: false }, { force: true });
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }

  runQuestionIndexSet(host: Host, idx: number): void {
    host.currentIndex = idx;
    host._fetLocked = false;
    host._lockedForIndex = -1;
    host.timedOutIdxSig.set(-1);
    host.timedOutIdxSubject.next(-1);
    (window as any).__quizTimerExpired = false;

    if (!this.fetGuard.hasInteractionEvidence(host, idx)) {
      host._lastDisplayedText = '';
    }

    this.cleanupStaleStateForIndex(host, idx);

    // Heading is rendered by the single-source headingHtml computed; the
    // stamp-question-text-into-<h3> retry cascade is no longer needed.

    host.questionIndexSig.set(idx);
    host.questionIndexSubject.next(idx);

    const ets = host.explanationTextService;
    ets._activeIndex = idx;

    const isShuffled = host.quizService.isShuffleEnabled() && Array.isArray(host.quizService.shuffledQuestions) && host.quizService.shuffledQuestions.length > 0;
    const currentQuestion = isShuffled
      ? host.quizService.shuffledQuestions[idx]
      : host.quizService.questions[idx];

    const hasSelectedOption = currentQuestion?.options?.some((o: Option) => o.selected) ?? false;
    const quizServiceHasSelections = host.quizService.selectedOptionsMap?.has(idx) ?? false;
    const selectedOptionServiceHasSelections = (host.selectedOptionService.selectedOptionsMap?.get(idx)?.length ?? 0) > 0;
    const hasTrackedInteraction = host.quizStateService.hasUserInteracted(idx);
    const hasAnswerEvidence =
      hasSelectedOption || quizServiceHasSelections || selectedOptionServiceHasSelections || hasTrackedInteraction;

    // All navigation to an existing question — forward, backward, Next/Prev,
    // dot, or arrow key — shows the QUESTION TEXT, never the FET. The FET
    // belongs to the live answer view only. Previously this re-entered
    // explanation mode for a "resolved" question UNLESS isNavigatingToPrevious
    // was set, which is exactly why ArrowLeft/Prev (backward, flag set) showed
    // the question text while a dot/Next (flag unset) showed the FET. Answer
    // state (selections/scoring) is preserved — the cleanup below still runs
    // only when there is no answer evidence at all.
    host.quizStateService.setDisplayState({ mode: 'question', answered: false });

    if (!hasAnswerEvidence) {
      ets.resetForIndex(idx);
      ets.latestExplanation = '';
      ets.latestExplanationIndex = -1;
      ets.formattedExplanationSig.set('');

      try { (ets as any)._fetSubject?.next({ idx: -1, text: '', token: 0 }); } catch { }
      try { ets.fetByIndex?.delete(idx); } catch { }
      try { delete (ets.formattedExplanations as any)[idx]; } catch { }

      host._lastQuestionTextByIndex?.delete(idx);
      host.quizService.selectedOptionsMap?.delete(idx);
      host.selectedOptionService.selectedOptionsMap?.delete(idx);
      host._fetDisplayedThisSession?.delete(idx);
      ets.setShouldDisplayExplanation(false, { force: true });
      ets.setIsExplanationTextDisplayed(false, { force: true });
    }

    host.resetExplanationView();

    host.cdRef.markForCheck();
  }

  runLoadQuizDataFromRoute(host: Host): void {
    host.activatedRoute.paramMap.subscribe(async (params: ParamMap) => {
      const quizId = params.get('quizId');
      const questionIndex = Number(params?.get('questionIndex') ?? 1);
      const zeroBasedIndex = questionIndex - 1;

      if (quizId) {
        host.setQuizId(quizId);
        host.quizService.quizId = quizId;
        host.quizService.setQuizId(quizId);
        localStorage.setItem('quizId', quizId);
        host.currentQuestionIndexValue = zeroBasedIndex;

        try {
          host.quizService.scoringService?.restoreScoreFromPersistence?.(quizId);
        } catch { /* ignore */ }

        host.currentIndex = zeroBasedIndex;

        this.cleanupStaleStateForIndex(host, zeroBasedIndex);

        // Heading is rendered by the single-source headingHtml computed; the
        // stamp-question-text-into-<h3> retry cascade is no longer needed.

        host.questionIndexSig.set(zeroBasedIndex);
        host.questionIndexSubject.next(zeroBasedIndex);

        await host.loadQuestion(quizId, zeroBasedIndex);
      }
    });

    host.currentQuestion$
      .pipe(
        debounceTime(200),
        tap((question: QuizQuestion | null) => {
          if (question) host.updateCorrectAnswersDisplay(question).subscribe();
        })
      )
      .subscribe();
  }

  async runLoadQuestion(host: Host, quizId: string, zeroBasedIndex: number): Promise<void> {
    if (zeroBasedIndex == null || isNaN(zeroBasedIndex)) return;

    try {
      const questions = (await firstValueFrom(
        host.quizDataService.getQuestionsForQuiz(quizId)
      )) as QuizQuestion[];
      if (
        questions &&
        questions.length > 0 &&
        zeroBasedIndex >= 0 &&
        zeroBasedIndex < questions.length
      ) {
        const question = this.resolveQuestionForIndex(host, questions, zeroBasedIndex);
        this.applyQuestionLoad(host, question);
        this.runEagerFetRegeneration(host, question, zeroBasedIndex);
      }
    } catch {
    }
  }

  // Pick the question for this index, preferring the shuffled array when active.
  private resolveQuestionForIndex(host: Host, questions: QuizQuestion[], zeroBasedIndex: number): QuizQuestion {
    let question = questions[zeroBasedIndex];
    if (host.quizService.isShuffleEnabled() &&
      host.quizService.shuffledQuestions?.length > zeroBasedIndex) {
      question = host.quizService.shuffledQuestions[zeroBasedIndex];
    }
    return question;
  }

  // Commit the question to state, reset explanation, and clear eager-FET timers/locks.
  private applyQuestionLoad(host: Host, question: QuizQuestion): void {
    host.currentQuestionSig.set(question);

    host.explanationTextService.resetExplanationState();
    host.explanationTextService.resetExplanationText();

    host.quizService.setCurrentQuestion(question);

    if (Array.isArray(host._eagerFetRetryTimers)) {
      for (const t of host._eagerFetRetryTimers) clearTimeout(t);
    }
    host._eagerFetRetryTimers = [];
    host._fetLockedForIndex = -1;
  }

  private runEagerFetRegeneration(host: Host, question: QuizQuestion, zeroBasedIndex: number): void {
    try {
      this.applyPostRefreshCleanup(host, zeroBasedIndex);
    } catch {
      // post-refresh cleanup failed
    }
  }

  // After a page refresh, when navigating to a different index than the initial
  // load, wipe stale interaction/selection/explanation state for that index.
  private applyPostRefreshCleanup(host: Host, zeroBasedIndex: number): void {
    let isPageRefresh = false;
    try {
      const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      isPageRefresh = navEntries.length > 0 && navEntries[0].type === 'reload';
    } catch { /* ignore */ }
    if (host._refreshInitialLoadConsumed == null) {
      host._refreshInitialLoadConsumed = false;
    }
    const isInitialLoadAfterRefresh = isPageRefresh && !host._refreshInitialLoadConsumed;
    if (isInitialLoadAfterRefresh) {
      host._refreshInitialIdx = zeroBasedIndex;
    }
    host._refreshInitialLoadConsumed = true;

    const isPostRefreshNavToDifferentIdx =
      isPageRefresh
      && typeof host._refreshInitialIdx === 'number'
      && host._refreshInitialIdx !== zeroBasedIndex;
    if (isPostRefreshNavToDifferentIdx) {
      this.wipeStaleIndexState(host, zeroBasedIndex);
    }
  }

  // Wipe interaction, selection, and explanation state for a single index.
  private wipeStaleIndexState(host: Host, zeroBasedIndex: number): void {
    try {
      host.quizStateService._hasUserInteracted?.delete(zeroBasedIndex);
      host.quizStateService._answeredQuestionIndices?.delete(zeroBasedIndex);
      host.quizStateService.persistInteractionState?.();
    } catch { /* ignore */ }
    try {
      host.selectedOptionService.selectedOptionsMap?.delete(zeroBasedIndex);
    } catch { /* ignore */ }
    try {
      sessionStorage.removeItem(SK_SEL_Q + zeroBasedIndex);
    } catch { /* ignore */ }
    try {
      host.explanationTextService.fetByIndex?.delete(zeroBasedIndex);
      delete (host.explanationTextService.formattedExplanations as any)[zeroBasedIndex];
    } catch { /* ignore */ }
  }


}
