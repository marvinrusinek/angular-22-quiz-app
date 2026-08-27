import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';

import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';

import {
  SK_COMPLETED_QUIZ_IDS,
  SK_CORRECT_ANSWERS_COUNT,
  SK_DISPLAY_MODE,
  SK_DOT_CONFIRMED,
  SK_IS_ANSWERED,
  SK_SEL_Q,
  SK_SELECTED_OPTIONS_MAP,
  SK_STARTED_QUIZ_IDS,
} from '../../../shared/constants/session-keys';
import {
  readSessionJson,
  removeSessionKey,
  writeSessionJson,
} from '../../../shared/utils/session-storage';

import { ExplanationTextService } from '../../../shared/services/features/explanation/explanation-text.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { QuizDotStatusService } from '../../../shared/services/flow/quiz-dot-status.service';
import { QuizPersistenceService } from '../../../shared/services/state/quiz-persistence.service';
import { QuestionTimingService } from '../../../shared/services/features/timer/question-timing.service';
import { QuestionVerdictService } from '../../../shared/services/features/verdict/question-verdict.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';
import { ThemeService } from '../../../shared/services/ui/theme.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';
import { swallow } from '../../../shared/utils/error-logging';

@Component({
  selector: 'codelab-results-return',
  standalone: true,
  imports: [MatCardModule, MatListModule],
  templateUrl: './return.component.html',
  styleUrls: ['./return.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReturnComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly dotStatusService = inject(QuizDotStatusService);
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizPersistence = inject(QuizPersistenceService);
  private readonly questionTimingService = inject(QuestionTimingService);
  private readonly questionVerdictService = inject(QuestionVerdictService);
  private readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly themeService = inject(ThemeService);
  private readonly timerService = inject(TimerService);
  private readonly router = inject(Router);

  // ── remaining variables ─────────────────────────────────────────
  readonly quizId = signal<string>('');
  readonly codelabUrl = 'https://www.codelab.fun';

  ngOnInit(): void {
    this.quizId.set(this.quizService.quizId);
  }

  restartQuiz(): void {
    this.ensureQuizId();

    const id = this.quizId();

    this.resetScoreAndResults();
    this.resetQuizSession(id);
    this.resetQuizRuntimeState();
    this.resetDotStatus(id);
    this.clearRestartStorageState();
    this.resetThemeToLight();
    this.clearResultsUiState();

    if (id) void this.router.navigate(['/quiz/question', id, 1]);
  }

  selectQuiz(): void {
    this.selectedOptionService.clearState();

    const id = this.quizId() || this.quizService.quizId;

    // Mark as completed (checkmark) whenever the quiz was actually finished,
    // regardless of score. The 100% distinction is surfaced separately via the
    // Perfect Score achievement, not the tile checkmark.
    const snapshot = readSessionJson<{ total?: number; correct?: number }>('finalResult', {});
    const isCompleted = (snapshot.total ?? 0) > 0;
    if (id) {
      const key = isCompleted ? SK_COMPLETED_QUIZ_IDS : SK_STARTED_QUIZ_IDS;
      const existing = readSessionJson<string[]>(key, []);
      if (!existing.includes(id)) {
        existing.push(id);
        writeSessionJson(key, existing);
      }
    }

    if (id) {
      this.quizDataService.updateQuizStatus(id, isCompleted ? 'completed' : 'started');
    }

    this.quizService.resetAll();
    this.quizService.resetQuestions();
    this.explanationTextService.resetExplanationState();
    this.timerService.clearTimerState();

    // Reset to light mode when leaving results
    if (this.themeService.isDark()) {
      this.themeService.toggle();
    }

    removeSessionKey('resultsActiveSection');

    this.quizId.set('');
    this.router.navigate(['/select/']);
  }

  private ensureQuizId(): void {
    if (!this.quizId()) this.quizId.set(this.quizService.quizId);
  }

  private resetScoreAndResults(): void {
    // Reset score FIRST before anything else
    this.quizService.resetScore();
    localStorage.removeItem(SK_CORRECT_ANSWERS_COUNT);
    localStorage.removeItem('questionCorrectness');

    // Clear “results snapshot”
    this.quizService.clearFinalResult();
  }

  private resetQuizSession(id: string): void {
    // Clear session state: answered, selections, resume index, completion flags
    if (id) {
      this.quizService.resetQuizSessionForNewRun(id);
      this.selectedOptionService.clearState();
    }
  }

  private resetQuizRuntimeState(): void {
    this.quizService.resetAll();
    this.quizService.resetQuestions();
    this.explanationTextService.resetExplanationState();
    this.timerService.clearTimerState();
    this.timerService.clearDurableCompletionTime(this.quizId());

    // A restart keeps the same quizId, so the timer cannot notice the new run
    // by identity — it has to be told. Without this the completed run's expiry
    // flags survive, and every guard that reads them refuses to start
    // question 1 again.
    this.timerService.beginNewRun();

    // A RESTART IS A NEW ATTEMPT, SO THE OLD ATTEMPT STOPS COUNTING.
    //
    // `clearTimerState` only drops elapsed-time bookkeeping. The SIGNED
    // DEADLINES live in QuestionTimingService, and question 1 of the completed
    // run still had one — long past by the time anyone restarts. The restarted
    // question then resumed against it: `startTimerUntil` computed
    // `remainingSeconds = 0`, called `expireImmediately()`, and the timer
    // rendered 0:00 without ever running.
    //
    // The in-quiz restart already does this via
    // `QuizResetService.performRestartServiceResets`; this button hand-rolls
    // its own sequence and had simply never been given the same call.
    this.questionTimingService.clearTiming();

    // THE COMPLETED RUN'S VERDICTS ARE NOT THIS RUN'S VERDICTS.
    //
    // Completion is derived from the verdict — `isQuestionCompleted` reads
    // `phase === `resolved` && isResolvedCorrect`, then memoizes it. Restart
    // cleared that memo through `selectionMessage.resetAll()`, but not the
    // source it is memoizing, so the very next query rebuilt it from the old
    // run and question 1 announced "Answered" before it had been answered.
    //
    // Verdicts key on quizId + question TEXT, which a restart reuses verbatim,
    // so nothing here expires on its own. Both the in-memory store and its
    // sessionStorage mirror are dropped — leaving the mirror would restore the
    // same state on the next reload.
    this.questionVerdictService.clearAll();
    const restartingQuizId = this.quizId();
    if (restartingQuizId) {
      this.questionVerdictService.clearEarnedVerdicts(restartingQuizId);
    }
  }

  private resetDotStatus(id: string): void {
    // Clear ALL dot status sources so dots reset to gray
    this.dotStatusService.clearAllMaps();
    this.selectedOptionService.clickConfirmedDotStatus.clear();
    this.selectedOptionService.lastClickedCorrectByQuestion.clear();
    this.selectedOptionService.clearRefreshBackup();
    this.quizService.questionCorrectness.clear();

    if (id) {
      this.selectedOptionService.clearAllSelectionsForQuiz(id);
      this.quizPersistence.clearAllPersistedDotStatus(id);
      this.quizPersistence.clearClickConfirmedDotStatus(20);
    }
  }

  private clearRestartStorageState(): void {
    try {
      this.clearQuestionSessionStorage();
      this.clearGlobalSessionStorage();
      this.clearQuizProgressLocalStorage();

      sessionStorage.setItem('freshStartFromResults', 'true');
    } catch (err: unknown) {
      swallow('return.component.ts', err);
    }
  }

  private clearQuestionSessionStorage(): void {
    for (let i = 0; i < 100; i++) {
      sessionStorage.removeItem(SK_DOT_CONFIRMED + i);
      sessionStorage.removeItem(SK_SEL_Q + i);
      sessionStorage.removeItem('quiz_selection_' + i);
      sessionStorage.removeItem(SK_DISPLAY_MODE + i);
      sessionStorage.removeItem('feedbackText_' + i);
    }
  }

  private clearGlobalSessionStorage(): void {
    sessionStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
    sessionStorage.removeItem('rawSelectionsMap');
    sessionStorage.removeItem('selectionHistory');
    sessionStorage.removeItem(SK_IS_ANSWERED);
    sessionStorage.removeItem('answeredQuestionIndices');
  }

  private clearQuizProgressLocalStorage(): void {
    const lsKeysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);

      if (key && (key.startsWith('quiz_dot_status_') || key.startsWith('quiz_progress_')))
        lsKeysToRemove.push(key);
    }

    for (const key of lsKeysToRemove) {
      localStorage.removeItem(key);
    }
  }

  private resetThemeToLight(): void {
    // Reset to light mode when restarting
    if (this.themeService.isDark()) {
      this.themeService.toggle();
    }
  }

  private clearResultsUiState(): void {
    try {
      sessionStorage.removeItem('resultsActiveSection');
    } catch (err: unknown) {
      swallow('return.component.ts', err);
    }
  }
}
