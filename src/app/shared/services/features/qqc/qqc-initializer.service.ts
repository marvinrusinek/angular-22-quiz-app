import { DestroyRef, inject, Service } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormControl, FormGroup } from '@angular/forms';
import { Subscription } from 'rxjs';
import { map } from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { Quiz } from '../../../models/Quiz.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QqcQuestionLoaderService } from './qqc-question-loader.service';
import { QuizDataService } from '../../data/quizdata.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

/**
 * Manages initialization logic for QuizQuestionComponent:
 * - Quiz data loading and question array population
 * - Quiz question initialization and option ID assignment
 * - First question setup from route parameters
 * - Display mode subscription initialization
 *
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Service()
export class QqcInitializerService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly questionLoader = inject(QqcQuestionLoaderService);
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // QUIZ DATA LOADING
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Loads quiz data (questions) via the question loader.
   * Returns the loaded questions array or null on failure.
   */
  async loadQuizData(quizId: string | null): Promise<{
    questions: QuizQuestion[] | null;
    quiz: Quiz | null;
    isQuizLoaded: boolean;
  }> {
    const questions = await this.questionLoader.loadQuizData(quizId);
    if (!questions) return { questions: null, quiz: null, isQuizLoaded: false };

    const activeQuiz = this.quizService.getActiveQuiz();
    if (!activeQuiz) {
      // Failed to get the active quiz
      return { questions, quiz: null, isQuizLoaded: false };
    }

    return { questions, quiz: activeQuiz, isQuizLoaded: true };
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // QUESTION INITIALIZATION
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Sets up the first question based on a route index.
   * Returns the prepared question and options.
   */
  setQuestionFirst(params: {
    index: number;
    questionsArray: QuizQuestion[];
  }): {
    currentQuestion: QuizQuestion | null;
    optionsToDisplay: Option[];
    questionIndex: number;
  } | null {
    const { index, questionsArray } = params;

    if (!questionsArray || questionsArray.length === 0) {
      return null;  // questionsArray is empty or undefined
    }

    // Clamp index to valid range
    const questionIndex = Math.max(
      0,
      Math.min(index, questionsArray.length - 1)
    );

    if (questionIndex >= questionsArray.length) {
      return null;  // invalid question index
    }

    const question = questionsArray[questionIndex];
    if (!question) {
      return null;  // no question data available at this index
    }

    // Update quiz service
    this.quizService.setCurrentQuestion(question);

    return {
      currentQuestion: question,
      optionsToDisplay: [...(question.options ?? [])],
      questionIndex
    };
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // QUIZ QUESTIONS AND ANSWERS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Initializes quiz questions and answers from the route quizId.
   * Fetches questions if not already loaded.
   */
  async initializeQuizQuestionsAndAnswers(params: {
    quizId: string | null;
    currentQuestionIndex: number;
    questionsArray: QuizQuestion[];
    fetchAndProcessQuizQuestions: (quizId: string) => Promise<QuizQuestion[]>;
  }): Promise<{
    questionsArray: QuizQuestion[];
    questions: QuizQuestion[];
  } | null> {
    const { quizId, currentQuestionIndex, questionsArray, fetchAndProcessQuizQuestions } = params;

    try {
      if (!quizId) return null;  // quiz ID is empty after initialization

      // Fetch and store only if not already fetched
      let result = questionsArray;
      if (!result || result.length === 0) {
        const fetched = await fetchAndProcessQuizQuestions(quizId);
        if (!fetched || fetched.length === 0) {
          // No questions returned
          return null;
        }
        result = fetched;
      }

      // Now safe to run post-fetch logic
      await this.quizDataService.asyncOperationToSetQuestion(
        quizId,
        currentQuestionIndex
      );

      return {
        questionsArray: result,
        questions: result
      };
    } catch {
      // Error initializing quiz questions and answers
      return null;
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // EXPLANATION PREPARATION
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Prepares explanation text for a question during initialization.
   * Only processes if the question is already answered.
   */
  async prepareExplanationForQuestion(params: {
    quizId: string;
    questionIndex: number;
    question: QuizQuestion;
    getExplanationText: (index: number) => Promise<string>;
  }): Promise<void> {
    const { quizId, questionIndex, getExplanationText } = params;

    try {
      const state = this.quizStateService.getQuestionState(quizId, questionIndex);

      if (state?.isAnswered) {
        try {
          const explanationText = await getExplanationText(questionIndex);

          this.explanationTextService.formattedExplanations[questionIndex] = {
            questionIndex,
            explanation: explanationText || 'No explanation provided.'
          };
        } catch {
          // Failed to fetch explanation for this question

          this.explanationTextService.formattedExplanations[questionIndex] = {
            questionIndex,
            explanation: 'Unable to load explanation.'
          };
        }
      }
    } catch {
      // Unexpected error during prepareQuestion
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ROUTE INDEX PARSING
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Extracts and normalizes a question index from route snapshot.
   * Returns the 0-based index.
   */
  parseQuestionIndexFromRoute(questionIndexParam: string | null): number {
    const routeIndex = questionIndexParam !== null ? +questionIndexParam : 1;
    return Math.max(0, routeIndex - 1);  // normalize to 0-based
  }

  /**
   * Parses and validates a route parameter for question index,
   * clamping to valid bounds.
   * Returns the 0-based index.
   */
  handleRouteChangeParsing(params: {
    rawParam: string | null;
    totalQuestions: number;
  }): number {
    const { rawParam, totalQuestions } = params;
    const parsedParam = Number(rawParam);
    let questionIndex = isNaN(parsedParam) ? 1 : parsedParam;

    // The upper bound only means something once the count is known.
    //
    // On a cold load straight to a deep link — /quiz/question/forms/6 — this
    // runs before the questions have arrived, so totalQuestions is still 0.
    // Bounding against 0 rejected every question but the first and silently
    // rewrote the index to 1, which then became the app's currentQuestionIndex.
    // The route said question 6, the heading rendered question 1, and the
    // mismatch only surfaced on the first click, when the heading recomputed
    // and read the overwritten index. Deep links to question 1 were unaffected,
    // which is why this hid for so long.
    //
    // The URL is the authority for which question is showing; when the count is
    // unknown there is nothing to validate against, so the param stands.
    const hasTotal = Number.isFinite(totalQuestions) && totalQuestions > 0;
    if (questionIndex < 1 || (hasTotal && questionIndex > totalQuestions)) {
      questionIndex = 1;
    }

    return questionIndex - 1;  // convert to 0-based
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // DISPLAY MODE INITIALIZATION
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Sets up the initial display mode subscription.
   * Returns the mode string for the component to react to.
   */
  computeInitialDisplayMode(isAnswered: boolean): 'question' | 'explanation' {
    return isAnswered ? 'explanation' : 'question';
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // FORM INITIALIZATION & VALIDATION
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Builds a FormGroup from question options, each keyed by optionId.
   * Returns null if the question or options are not ready.
   */
  buildFormFromOptions(
    currentQuestion: QuizQuestion | null,
    fb: FormBuilder
  ): FormGroup | null {
    if (!currentQuestion?.options?.length) return null;

    const controls = currentQuestion.options.reduce(
      (acc: { [key: string]: any }, option: Option) => {
        acc[option.optionId!] = new FormControl(false);
        return acc;
      },
      {}
    );

    const form = fb.group(controls);
    form.updateValueAndValidity();
    return form;
  }

  /**
   * Checks if both the form is valid and question data is available.
   * Returns true if the component should render.
   */
  checkRenderReady(questionForm: FormGroup | null): boolean {
    return questionForm?.valid ?? false;
  }

  /**
   * Validates a form for submission: checks form validity and option selection.
   */
  validateFormForSubmission(questionForm: FormGroup): boolean {
    if (questionForm.invalid) return false;

    const selectedOption = questionForm.get('selectedOption')?.value;
    return selectedOption != null;  // form is valid and option is selected
  }

  /**
   * Processes an answer submission: validates, records, checks correctness,
   * and updates quiz state. Returns whether the answer was correct.
   */
  async processAnswer(params: {
    selectedOption: any;
    currentQuestion: QuizQuestion;
    currentQuestionIndex: number;
    answers: any[];
  }): Promise<boolean> {
    const { selectedOption, currentQuestion, currentQuestionIndex, answers } = params;

    if (
      !selectedOption ||
      !currentQuestion?.options?.find(
        (opt) => opt.optionId === selectedOption.optionId
      )
    ) return false;   // invalid or unselected option

    answers.push({
      question: currentQuestion,
      questionIndex: currentQuestionIndex,
      selectedOption: selectedOption
    });

    let isCorrect = false;
    try {
      isCorrect = await this.quizService.checkIfAnsweredCorrectly();
    } catch {
      // Error checking answer correctness
    }

    const explanationText = currentQuestion?.explanation;
    const quizId = this.quizService.getCurrentQuizId();

    // Update the state to include the selected option and adjust the number of correct answers
    const selectedOptions = currentQuestion?.selectedOptions || [];
    selectedOptions.push(selectedOption); // add the newly selected option
    const numberOfCorrectAnswers = selectedOptions.filter(
      (opt) => opt.correct
    ).length;

    this.quizStateService.setQuestionState(quizId, currentQuestionIndex, {
      isAnswered: true,
      isCorrect: isCorrect,
      explanationText: explanationText,
      selectedOptions: selectedOptions,
      numberOfCorrectAnswers: numberOfCorrectAnswers
    });

    return isCorrect;
  }

  /**
   * Initializes the quiz question subscription: fetches all questions,
   * assigns option IDs, and updates answered state.
   * Returns the subscription for cleanup.
   * Extracted from initializeQuizQuestion().
   */
  initializeQuizQuestion(params: {
    destroyRef: DestroyRef;
    onQuestionsLoaded: (questions: QuizQuestion[]) => void;
  }): void {
    if (!this.quizStateService || !this.quizService) return;
    if (this.quizStateService.getQuizQuestionCreated()) return;

    this.quizStateService.setQuizQuestionCreated();

    this.quizService
      .getAllQuestions()
      .pipe(
        map((questions: QuizQuestion[]) => {
          for (const quizQuestion of questions) {
            quizQuestion.selectedOptions = [];

            if (Array.isArray(quizQuestion.options)) {
              quizQuestion.options = quizQuestion.options.map(
                (option, index) => ({
                  ...option,
                  optionId: index
                })
              );
            } else {
              // Options are not properly defined for this question
              quizQuestion.options = [];
            }
          }
          return questions;
        }),
        takeUntilDestroyed(params.destroyRef)
      )
      .subscribe({
        next: (questions: QuizQuestion[]) => {
          if (questions && questions.length > 0) {
            const selectedOptions =
              this.selectedOptionService.getSelectedOptions();
            const hasAnswered =
              Array.isArray(selectedOptions) && selectedOptions.length > 0;
            if (hasAnswered) this.selectedOptionService.setAnsweredState(true);

            params.onQuestionsLoaded(questions);
          }
        },
        error: () => { }
      });
  }

  /**
   * Initializes the selected quiz subscription.
   * Returns the subscription for cleanup.
   * Extracted from initializeSelectedQuiz().
   */
  initializeSelectedQuiz(params: {
    onQuizSelected: (quiz: Quiz) => void;
  }): Subscription | null {
    if (!this.quizDataService.selectedQuiz$) return null;

    return this.quizDataService.selectedQuiz$.subscribe((quiz: Quiz | null) => {
      if (quiz) params.onQuizSelected(quiz);
    });
  }

  /**
   * Performs the full quiz initialization flow: initializes the selected quiz,
   * resolves the quiz ID from the route, and loads quiz questions/answers.
   * Combines initializeQuiz() and fetchAndProcessQuizQuestions().
   * Extracted from QuizQuestionComponent.
   */
  async performFullQuizInit(params: {
    currentQuestionIndex: number;
    questionsArray: QuizQuestion[];
    routeQuizId: string | null;
    setQuestionOptions: () => void;
    questionLoader: {
      fetchAndProcessQuizQuestions: (p: {
        quizId: string;
        prepareQuestion: (id: string, question: QuizQuestion, index: number) => Promise<void>;
      }) => Promise<QuizQuestion[]>;
    };
    prepareExplanationForQuestion: (p: {
      quizId: string;
      questionIndex: number;
      question: QuizQuestion;
      getExplanationText: (idx: number) => any;
    }) => Promise<void> | void;
    getExplanationText: (idx: number) => any;
  }): Promise<{
    questionsArray: QuizQuestion[];
    questions: QuizQuestion[];
    quizId: string | null;
  } | null> {
    // Initialize selected quiz subscription
    this.initializeSelectedQuiz({
      onQuizSelected: (_quiz: Quiz) => params.setQuestionOptions()
    });

    const quizId = params.routeQuizId;

    // Initialize quiz questions and answers
    const result = await this.initializeQuizQuestionsAndAnswers({
      quizId,
      currentQuestionIndex: params.currentQuestionIndex,
      questionsArray: params.questionsArray,
      fetchAndProcessQuizQuestions: async (id: string) => {
        const questions = await params.questionLoader.fetchAndProcessQuizQuestions({
          quizId: id,
          prepareQuestion: async (qId, question, index) =>
            params.prepareExplanationForQuestion({
              quizId: qId,
              questionIndex: index,
              question,
              getExplanationText: params.getExplanationText
            })
        });
        return questions;
      }
    });

    if (result) {
      return {
        questionsArray: result.questionsArray,
        questions: result.questions,
        quizId
      };
    }

    return null;
  }
}