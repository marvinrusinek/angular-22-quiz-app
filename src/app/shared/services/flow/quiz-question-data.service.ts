import { Service, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { QuizDataService } from '../data/quizdata.service';
import { TopicQuizTypeRegistry } from '../api/topic-quiz-type-registry.service';
import { QuizService } from '../data/quiz.service';

/**
 * Handles question data fetching, normalization, and preparation.
 * Extracted from QuizComponent to reduce its size.
 */
@Service()
export class QuizQuestionDataService {
  // ── injects ─────────────────────────────────────────────────────
  private explanationTextService = inject(ExplanationTextService);
  private quizDataService = inject(QuizDataService);
  private topicQuizTypeRegistry = inject(TopicQuizTypeRegistry);
  private quizService = inject(QuizService);

  // ── public methods ──────────────────────────────────────────────

  // ═══════════════════════════════════════════════════════════════
  // FETCH QUESTION DETAILS
  // ═══════════════════════════════════════════════════════════════

  async fetchQuestionDetails(questionIndex: number): Promise<QuizQuestion | null> {
    try {
      const resolvedQuestion: QuizQuestion | null = await firstValueFrom(
        this.quizService.getQuestionByIndex(questionIndex)
      );

      if (!resolvedQuestion || !resolvedQuestion.questionText?.trim()) {
        return null;
      }

      const trimmedText = resolvedQuestion.questionText.trim();

      const options =
        Array.isArray(resolvedQuestion.options)
          ? resolvedQuestion.options.map((option, idx) => ({
            ...option,
            optionId: option.optionId ?? idx
          })) : [];

      if (!options.length) return null;

      let explanation = 'No explanation available';
      if (this.explanationTextService.explanationsInitialized) {
        const fetchedExplanation = await firstValueFrom(
          this.explanationTextService.getFormattedExplanationTextForQuestion(
            questionIndex
          )
        );
        explanation = fetchedExplanation?.trim() || 'No explanation available';
      }

      if (
        (!explanation || explanation === 'No explanation available') &&
        resolvedQuestion.explanation?.trim()
      ) explanation = resolvedQuestion.explanation.trim();

      // This builds a FRESH question object, so there is no stamped type to
      // read — ask the registry by text instead. Without this the manufactured
      // type would overwrite the declared one for every question built here.
      // REMOVE THE COUNT IN /questions CONTENT CUTOVER.
      const correctCount = options.filter((opt: Option) => opt.correct).length;
      const type =
        this.topicQuizTypeRegistry.questionTypeOf(trimmedText) ??
        (correctCount > 1
          ? QuestionType.MultipleAnswer : QuestionType.SingleAnswer);

      const question: QuizQuestion = {
        questionText: trimmedText,
        options,
        explanation,
        type
      };

      this.quizDataService.setQuestionType(question);
      return question;
    } catch (err: unknown) {
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FETCH QUESTION DATA (legacy path)
  // ═══════════════════════════════════════════════════════════════

  async fetchQuestionData(
    quizId: string,
    questionIndex: number
  ): Promise<QuizQuestion | undefined> {
    try {
      const rawData = this.quizService.getQuestionData(quizId, questionIndex);
      if (!rawData) return undefined;

      const explanationObservable = this.explanationTextService.explanationsInitialized
        ? this.explanationTextService.getFormattedExplanationTextForQuestion(questionIndex)
        : undefined;

      let explanation = '';
      if (explanationObservable) {
        explanation = (await firstValueFrom(explanationObservable)) ?? '';
      }

      return {
        questionText: (rawData as any).questionText ?? '',
        options: (rawData as any).currentOptions ?? [],
        explanation: explanation ?? '',
        type: this.quizDataService.questionType as QuestionType
      } as QuizQuestion;
    } catch (err: unknown) {
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FORMAT EXPLANATIONS FOR QUESTION SET
  // ═══════════════════════════════════════════════════════════════

  formatExplanationsForQuestions(
    hydratedQuestions: QuizQuestion[]
  ): Array<{ questionIndex: number; explanation: string }> {
    return hydratedQuestions.map((question, index) => {
      const rawExplanation = (question.explanation ?? '').trim();

      const correctIndices = this.explanationTextService.getCorrectOptionIndices(
        question,
        question.options,
        index
      );

      const formattedText = this.explanationTextService.formatExplanation(
        question,
        correctIndices,
        rawExplanation
      );

      return { questionIndex: index, explanation: formattedText };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // FORCE REGENERATE EXPLANATION
  // ═══════════════════════════════════════════════════════════════

  forceRegenerateExplanation(question: QuizQuestion, index: number): void {
    if (question && question.options) {

      const correctIndices = this.explanationTextService.getCorrectOptionIndices(
        question,
        question.options,
        index
      );

      // `?? ''` matches formatExplanationsForQuestions above. Questions from
      // `/questions` carry no explanation at all — the FET body is authorized
      // by the verdict — so this formats an empty body rather than reaching
      // for a bank value that no longer exists.
      const formattedExplanation = this.explanationTextService.formatExplanation(
        question,
        correctIndices,
        question.explanation ?? ''
      );

      this.explanationTextService.storeFormattedExplanation(
        index,
        formattedExplanation,
        question,
        question.options,
        true
      );
    }
  }
}