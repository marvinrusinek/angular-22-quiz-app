import { inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { QuizService } from '../../data/quiz.service';

import { delay } from '../../../utils/delay';

/**
 * Handles question data fetching, validation, and quiz loading for QQC.
 * Extracted from QqcQuestionLoaderService.
 */
@Service()
export class QqcQlFetchService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizService = inject(QuizService);

  // ── remaining variables ─────────────────────────────────────────
  private isLoadingInProgress = false;
  private isQuizLoaded = false;

  /**
   * Loads quiz data (questions) and marks quiz as loaded.
   * Returns the loaded questions array, or null on failure.
   */
  async loadQuizData(quizId: string | null | undefined): Promise<QuizQuestion[] | null> {
    try {
      const quizIdExists = await this.quizService.ensureQuizIdExists();
      if (!quizIdExists) return null;  // quiz ID is missing

      const questions = await this.quizService.fetchQuizQuestions(quizId!);
      if (questions && questions.length > 0) {
        const activeQuiz = this.quizService.getActiveQuiz();
        if (!activeQuiz) return null;  // failed to get the active quiz

        this.isQuizLoaded = true;
        this.quizService.setQuestionsLoaded(true);
        return questions;
      } else {
        // No questions loaded
        return null;
      }
    } catch {
      // Error loading questions
      return null;
    }
  }

  /**
   * Ensures questions are loaded, waiting if a load is already in progress.
   * Returns true if questions are available.
   */
  async ensureQuestionsLoaded(
    questionsArray: QuizQuestion[],
    quizId: string | null | undefined
  ): Promise<{ loaded: boolean; questions: QuizQuestion[] | null }> {
    // When shuffle is active, always prefer shuffledQuestions
    const shuffled = this.quizService.shuffledQuestions;
    if (this.quizService.isShuffleEnabled() && shuffled?.length > 0) {
      return { loaded: true, questions: shuffled };
    }

    if (this.isLoadingInProgress) {
      while (this.isLoadingInProgress) {
        await delay(100);
      }
      return { loaded: this.isQuizLoaded, questions: questionsArray };
    }

    if (this.isQuizLoaded && questionsArray && questionsArray.length > 0) {
      return { loaded: true, questions: questionsArray };
    }

    this.isLoadingInProgress = true;
    const loadedQuestions = await this.loadQuizData(quizId);
    this.isLoadingInProgress = false;

    if (!loadedQuestions) {
      // Failed to load questions
      return { loaded: false, questions: null };
    }

    return { loaded: true, questions: loadedQuestions };
  }

  /**
   * Fetches questions if not already available.
   * Returns the questions array or throws on failure.
   */
  async fetchQuestionsIfNeeded(
    questionsArray: QuizQuestion[] | null
  ): Promise<QuizQuestion[]> {
    // When shuffle is active, always prefer shuffledQuestions as the
    // authoritative source — the passed-in questionsArray may be
    // unshuffled, causing Q&A mismatches for Q2+.
    const shuffled = this.quizService.shuffledQuestions;
    if (this.quizService.isShuffleEnabled() && shuffled?.length > 0) {
      return shuffled;
    }

    if (questionsArray && questionsArray.length > 0) return questionsArray;

    const quizId = this.quizService.getCurrentQuizId();
    if (!quizId) throw new Error('No active quiz ID found.');

    const fetched = await this.quizService.fetchQuizQuestions(quizId);
    if (!fetched?.length) throw new Error('Failed to fetch questions.');

    return fetched;
  }

  /**
   * Validates and computes the authoritative total question count
   * and checks if we should redirect to results.
   */
  checkEndOfQuiz(params: {
    currentQuestionIndex: number;
    questionsArray: QuizQuestion[];
    quizId: string;
  }): { shouldRedirect: boolean; trueTotal: number } {
    // S6p: the client-bank-backed getCachedQuizById(...)?.questions?.length
    // third source was removed. serviceTotal (QuizService.totalQuestions, set
    // by the API-backed applySessionQuestions/setActiveQuiz/setCurrentQuiz)
    // and localTotal (the array actually driving this render) are both
    // already API-sourced and authoritative; the bank read never won the max
    // in practice and would silently degrade to 0 once the bank is removed.
    const serviceTotal = this.quizService.totalQuestions() || 0;
    const localTotal = params.questionsArray.length || 0;
    const trueTotal = Math.max(serviceTotal, localTotal);

    return {
      shouldRedirect: params.currentQuestionIndex >= trueTotal && trueTotal > 0,
      trueTotal
    };
  }

  /**
   * Checks whether a question can be rendered instantly (has text + options).
   */
  canRenderQuestionInstantly(
    questionsArray: QuizQuestion[],
    index: number
  ): boolean {
    if (!Array.isArray(questionsArray) || questionsArray.length === 0) {
      return false;
    }

    if (!Number.isInteger(index) || index < 0 || index >= questionsArray.length) {
      return false;
    }

    const candidate = questionsArray[index];
    if (!candidate) return false;

    const hasQuestionText =
      typeof candidate.questionText === 'string' && candidate.questionText.trim().length > 0;
    const options = Array.isArray(candidate.options) ? candidate.options : [];

    return hasQuestionText && options.length > 0;
  }

  /**
   * Initializes component state: fetches questions, clamps index, sets current question.
   * Returns the initialized state or null on failure.
   */
  async initializeComponentState(params: {
    questionsArray: QuizQuestion[];
    currentQuestionIndex: number;
  }): Promise<{
    questionsArray: QuizQuestion[];
    currentQuestionIndex: number;
    currentQuestion: QuizQuestion;
  } | null> {
    let { questionsArray, currentQuestionIndex } = params;

    try {
      if (!questionsArray || questionsArray.length === 0) {
        const quizId = this.quizService.getCurrentQuizId();
        if (!quizId) {
          return null;  // no active quiz ID found — aborting initialization
        }

        questionsArray = await this.quizService.fetchQuizQuestions(quizId);
        if (!questionsArray || questionsArray.length === 0) {
          return null;  // failed to fetch questions — aborting initialization
        }
      }

      // Clamp currentQuestionIndex to valid range
      if (currentQuestionIndex < 0) currentQuestionIndex = 0;

      const lastIndex = questionsArray.length - 1;
      if (currentQuestionIndex > lastIndex) currentQuestionIndex = lastIndex;

      const currentQuestion = questionsArray[currentQuestionIndex];
      if (!currentQuestion) return null;

      return { questionsArray, currentQuestionIndex, currentQuestion };
    } catch {
      // Error during initialization
      return null;
    }
  }

  /**
   * Fetches and processes quiz questions for a given quiz ID.
   * Runs preparation for each question in parallel.
   * Returns the processed questions array.
   */
  async fetchAndProcessQuizQuestions(params: {
    quizId: string;
    prepareQuestion: (quizId: string, question: QuizQuestion, index: number) => Promise<void>;
  }): Promise<QuizQuestion[]> {
    const { quizId, prepareQuestion } = params;

    if (!quizId) return [];  // quiz ID is not provided or is empty

    try {
      const questions = await this.quizService.fetchQuizQuestions(quizId);

      if (!questions || questions.length === 0) {
        return [];  // no questions were loaded
      }

      // Run all question preparations in parallel
      await Promise.all(
        questions.map((question, index) =>
          prepareQuestion(quizId, question, index)
        )
      );

      return questions;
    } catch {
      // Error loading questions
      return [];
    }
  }

  /**
   * Ensures a question is fully loaded from the quiz service.
   */
  async ensureQuestionIsFullyLoaded(
    index: number,
    questionsArray: QuizQuestion[],
    quizId: string | null | undefined
  ): Promise<void> {
    if (!questionsArray || questionsArray.length === 0) {
      // Questions array is not loaded yet — loading questions
      const loaded = await this.loadQuizData(quizId);

      if (!loaded) {
        // Questions array still not loaded after loading attempt
        throw new Error('Failed to load questions array.');
      }
    }

    if (index < 0 || index >= questionsArray.length) {
      // Invalid index
      throw new Error(`Invalid index ${index}. No such question exists.`);
    }

    return new Promise((resolve, reject) => {
      // Use take(1) instead of a self-referencing `subscription` variable —
      // when getQuestionByIndex emits synchronously (of(...) or seeded
      // BehaviorSubject), the next callback fires DURING .subscribe() before
      // `subscription` is initialized, causing a TDZ ReferenceError.
      this.quizService.getQuestionByIndex(index).pipe(take(1)).subscribe({
        next: (question) => {
          if (question && question.questionText) {
            resolve();
          } else {
            reject(new Error(`No valid question at index ${index}`));
          }
        },
        error: (err: any) => reject(err)
      });
    });
  }

  /**
   * Loads and validates the current question by index.
   * Assigns option IDs and active states.
   */
  async loadCurrentQuestion(params: {
    currentQuestionIndex: number;
    questionsArray: QuizQuestion[];
    quizId: string | null | undefined;
  }): Promise<{
    success: boolean;
    currentQuestion: QuizQuestion | null;
    optionsToDisplay: Option[];
    questions: QuizQuestion[];
  }> {
    const result = await this.ensureQuestionsLoaded(params.questionsArray, params.quizId);
    if (!result.loaded) {
      // No questions available
      return { 
        success: false,
        currentQuestion: null,
        optionsToDisplay: [],
        questions: params.questionsArray
      };
    }

    const questions = result.questions || params.questionsArray;

    if (
      params.currentQuestionIndex < 0 ||
      params.currentQuestionIndex >= questions.length
    ) {
      // Invalid question index
      return { 
        success: false,
        currentQuestion: null,
        optionsToDisplay: [],
        questions
      };
    }

    try {
      const questionData = await firstValueFrom(
        this.quizService.getQuestionByIndex(params.currentQuestionIndex)
      );

      if (questionData) {
        questionData.options = this.quizService.quizOptions.assignOptionIds(
          questionData.options,
          params.currentQuestionIndex
        );

        questionData.options = this.quizService.quizOptions.assignOptionActiveStates(
          questionData.options,
          false
        );

        return {
          success: true,
          currentQuestion: questionData,
          optionsToDisplay: questionData.options ?? [],
          questions
        };
      } else {
        // No data found for question index
        return {
          success: false,
          currentQuestion: null,
          optionsToDisplay: [],
          questions
        };
      }
    } catch {
      // Error fetching question data
      return { success: false, currentQuestion: null, optionsToDisplay: [], questions };
    }
  }

  /**
   * Waits for question data to be available, clamping to last index if needed.
   * Returns the question and its options.
   */
  async waitForQuestionData(params: {
    currentQuestionIndex: number;
    quizId: string;
  }): Promise<{
    currentQuestion: QuizQuestion | null;
    optionsToDisplay: Option[];
    currentQuestionIndex: number;
  }> {
    let idx = params.currentQuestionIndex;

    if (!Number.isInteger(idx) || idx < 0) idx = 0;

    try {
      let question = await firstValueFrom(
        this.quizService.getQuestionByIndex(idx)
      );

      if (!question) {
        const total: number = await firstValueFrom(
          this.quizService.getTotalQuestionsCount(params.quizId)
        );

        const lastIndex = Math.max(0, total - 1);
        idx = lastIndex;

        question = await firstValueFrom(
          this.quizService.getQuestionByIndex(idx)
        );

        if (!question) {
          // Still no question after clamping — aborting
          return {
            currentQuestion: null,
            optionsToDisplay: [],
            currentQuestionIndex: idx
          };
        }
      }

      if (!question.options?.length) {
        // Invalid question data or options missing
        return { 
          currentQuestion: null, 
          optionsToDisplay: [], 
          currentQuestionIndex: idx
        };
      }

      return {
        currentQuestion: question,
        optionsToDisplay: [...question.options],
        currentQuestionIndex: idx
      };
    } catch {
      // Error loading question data
      return { 
        currentQuestion: null, 
        optionsToDisplay: [], 
        currentQuestionIndex: idx
      };
    }
  }

  /**
   * Performs the full quiz data loading and route handler setup.
   */
  async performQuizDataAndRoutingInit(params: {
    quizId: string | null | undefined;
  }): Promise<{
    questions: QuizQuestion[];
    quiz: any;
  } | null> {
    const questions = await this.loadQuizData(params.quizId);
    if (!questions) return null;

    const activeQuiz = this.quizService.getActiveQuiz();
    return {
      questions,
      quiz: activeQuiz || null
    };
  }
}