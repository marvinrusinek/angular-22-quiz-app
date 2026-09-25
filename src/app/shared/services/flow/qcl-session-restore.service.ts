import { Service, inject } from '@angular/core';

import { Option } from '@shared/models/Option.model';
import { Quiz } from '@shared/models/Quiz.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

import { ExplanationTextService } from '@shared/services/features/explanation/explanation-text.service';
import { QuizQuestionDataService } from './quiz-question-data.service';
import { QuizScoringService } from './quiz-scoring.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { QuizStateService } from '@shared/services/state/quizstate.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { SessionSnapshotResult } from './quiz-content-loader.service';
import { swallow } from '@shared/utils/error-logging';

/**
 * Handles session restore, hydration, and selection persistence.
 * Extracted from QuizContentLoaderService.
 */
@Service()
export class QclSessionRestoreService {

  // ── injects ─────────────────────────────────────────────────────
  private explanationTextService = inject(ExplanationTextService);
  private quizQuestionDataService = inject(QuizQuestionDataService);
  private quizScoringService = inject(QuizScoringService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);

  // ── public methods ──────────────────────────────────────────────
  syncQuestionSnapshot(params: {
    hydratedQuestions: QuizQuestion[];
    currentQuestionIndex: number;
    previousIndex: number | null;
    serviceCurrentIndex: number | undefined;
  }): SessionSnapshotResult {
    const { hydratedQuestions } = params;
    const empty: SessionSnapshotResult = {
      isEmpty: true,
      normalizedIndex: 0,
      question: null,
      trimmedQuestionText: '',
      normalizedOptions: [],
      trimmedExplanation: ''
    };

    if (!Array.isArray(hydratedQuestions) || hydratedQuestions.length === 0) {
      return empty;
    }

    const candidateIndices: Array<number | null> = [
      Number.isInteger(params.serviceCurrentIndex) ? params.serviceCurrentIndex! : null,
      Number.isInteger(params.currentQuestionIndex) ? params.currentQuestionIndex : null,
      Number.isInteger(params.previousIndex) ? params.previousIndex : null,
    ];

    const resolvedIndex = candidateIndices.find(
      (value): value is number => typeof value === 'number'
    );

    const normalizedIndex = Math.min(
      Math.max(resolvedIndex ?? 0, 0),
      hydratedQuestions.length - 1
    );

    this.quizService.setCurrentQuestionIndex(normalizedIndex);

    const selectedQuestion = hydratedQuestions[normalizedIndex];
    if (!selectedQuestion) return empty;

    const normalizedOptions = this.quizService.quizOptions
      .assignOptionIds(selectedQuestion.options ?? [], normalizedIndex)
      .map((option) => ({
        ...option,
        correct: (option.correct as any) === true || (option.correct as any) === 'true',
        selected: option.selected ?? false,
        active: option.active ?? true,
        showIcon: option.showIcon ?? false
      }));

    const trimmedQuestionText = selectedQuestion.questionText?.trim() ?? 'No question available';
    const trimmedExplanation = (selectedQuestion.explanation ?? '').trim();

    const formattedFet = this.explanationTextService.getFormattedSync(normalizedIndex);
    this.explanationTextService.setExplanationTextForQuestionIndex(
      normalizedIndex,
      formattedFet || trimmedExplanation
    );

    if (normalizedOptions.length > 0) {
      const clonedOptions = normalizedOptions.map((option) => ({ ...option }));
      this.quizService.emitQuestionAndOptions(selectedQuestion, clonedOptions, normalizedIndex);
    }

    return {
      isEmpty: false,
      normalizedIndex,
      question: selectedQuestion,
      trimmedQuestionText,
      normalizedOptions,
      trimmedExplanation
    };
  }

  restoreSessionSelections(questionIndex: number): void {
    if (!this.selectedOptionService.isQuestionAnswered(questionIndex)) {
      const storedSel = sessionStorage.getItem(`quiz_selection_${questionIndex}`);
      if (storedSel) {
        try {
          const ids = JSON.parse(storedSel);
          if (Array.isArray(ids) && ids.length > 0) {
            for (const id of ids) {
              this.selectedOptionService.addSelectedOptionIndex(questionIndex, id);
            }
            this.selectedOptionService.updateAnsweredState(
              this.selectedOptionService.getSelectedOptionsForQuestion(questionIndex),
              questionIndex
            );
          }
        } catch (err) {
          swallow('qcl-session-restore.service#1', err);
        }
      }
    }
  }

  restoreSelectionState(currentQuestionIndex: number): void {
    try {
      let selectedOptions = this.selectedOptionService.getSelectedOptionIndices(currentQuestionIndex);

      if (!selectedOptions || selectedOptions.length === 0) {
        const stored = sessionStorage.getItem(`quiz_selection_${currentQuestionIndex}`);
        if (stored) {
          try {
            const ids = JSON.parse(stored);
            if (Array.isArray(ids)) {
              selectedOptions = ids;
            }
          } catch (err) {
            swallow('qcl-session-restore.service#2', err);
          }
        }
      }

      for (const optionId of selectedOptions) {
        this.selectedOptionService.addSelectedOptionIndex(currentQuestionIndex, optionId);
      }

      const questionOptions =
        this.selectedOptionService.selectedOptionsMap.get(currentQuestionIndex) || [];
      this.selectedOptionService.updateAnsweredState(questionOptions, currentQuestionIndex);
    } catch (err) {
      swallow('qcl-session-restore.service#3', err);
    }
  }

  restoreSelectedOptionsFromSession(optionsToDisplay: Option[]): void {
    const selectedOptionsData = sessionStorage.getItem('selectedOptions');
    if (!selectedOptionsData) return;

    try {
      const selectedOptions = JSON.parse(selectedOptionsData);
      if (!Array.isArray(selectedOptions) || selectedOptions.length === 0) {
        return;
      }

      for (const option of selectedOptions) {
        const restoredOption = optionsToDisplay.find(
          opt => opt.optionId === option.optionId
        );

        if (restoredOption) restoredOption.selected = true;
      }
    } catch (err) {
      swallow('qcl-session-restore.service#4', err);
    }
  }

  hydrateQuestionsFromSession(params: {
    questions: QuizQuestion[];
    quiz: Quiz | null;
    selectedQuiz: Quiz | null;
  }): {
    hydratedQuestions: QuizQuestion[];
    quizQuestions: QuizQuestion[] | null;
    selectedQuizQuestions: QuizQuestion[] | null;
  } {
    const hydratedQuestions = this.quizScoringService.hydrateQuestionSet(params.questions);

    if (hydratedQuestions.length === 0) {
      this.explanationTextService.initializeExplanationTexts([]);
      this.explanationTextService.initializeFormattedExplanations([]);
      return { hydratedQuestions, quizQuestions: null, selectedQuizQuestions: null };
    }

    const explanations = hydratedQuestions.map((question) =>
      (question.explanation ?? '').trim()
    );
    this.explanationTextService.initializeExplanationTexts(explanations);

    this.explanationTextService.fetByIndex.clear();

    const formattedExplanations =
      this.quizQuestionDataService.formatExplanationsForQuestions(hydratedQuestions);
    this.explanationTextService.initializeFormattedExplanations(formattedExplanations);

    const deepCloneQuestions = (qs: QuizQuestion[]) =>
      qs.map((question) => ({
        ...question,
        options: question.options.map((option) => ({ ...option }))
      }));

    const quizQuestions = params.quiz ? deepCloneQuestions(hydratedQuestions) : null;
    const selectedQuizQuestions = params.selectedQuiz ? deepCloneQuestions(hydratedQuestions) : null;

    return { hydratedQuestions, quizQuestions, selectedQuizQuestions };
  }

  async prepareQuizSession(params: {
    quizId: string;
    applyQuestionsFromSession: (questions: QuizQuestion[]) => void;
  }): Promise<void> {
    try {
      const questions: QuizQuestion[] = await this.quizService.fetchQuizQuestions(params.quizId);
      params.applyQuestionsFromSession(questions);

      const storedStates = this.quizStateService.getStoredState(params.quizId);

      if (storedStates) {
        for (const [questionId, state] of storedStates.entries()) {
          this.quizStateService.setQuestionState(params.quizId, questionId, state);

          if (state.isAnswered && state.explanationDisplayed) {
            const restoredIndex = Number(questionId);
            const restoredQuestion = this.quizService.questions?.[restoredIndex];

            if (!restoredQuestion) continue;

            const rawExplanation = (restoredQuestion.explanation ?? '').trim();
            this.explanationTextService.storeFormattedExplanation(
              restoredIndex,
              rawExplanation,
              restoredQuestion,
              restoredQuestion.options,
              true
            );
          }
        }

        const firstQuestionState = storedStates.get(0);
        if (firstQuestionState && firstQuestionState.isAnswered) {
          this.explanationTextService.setResetComplete(true);
          this.explanationTextService.setShouldDisplayExplanation(true);
        }
      } else {
        this.quizStateService.applyDefaultStates(params.quizId, questions);
      }
    } catch (err) {
      swallow('qcl-session-restore.service#5', err);
    }
  }
}