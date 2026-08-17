import { inject, Service } from '@angular/core';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { QuizDataLoaderService } from './quiz-data-loader.service';
import { QuizOptionsService } from './quiz-options.service';
import { QuizQuestionResolverService } from './quiz-question-resolver.service';
import { QuizShuffleService } from '../flow/quiz-shuffle.service';

import { isOptionCorrect } from '../../utils/is-option-correct';

/**
 * Responsible for preparing and emitting question + options data to
 * QuizService's reactive subjects. Extracted from QuizService to reduce
 * its size.
 */
@Service()
export class QuizQuestionEmitterService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly dataLoader = inject(QuizDataLoaderService);
  private readonly optionsService = inject(QuizOptionsService);
  private readonly questionResolver = inject(QuizQuestionResolverService);
  private readonly quizShuffleService = inject(QuizShuffleService);

  /**
   * Convert a value to a numeric ID, falling back to the given default.
   */
  toNumericId(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /**
   * Resolve the canonical question for a given index, using the quiz's
   * canonical caches, shuffle state, and the question resolver.
   */
  resolveCanonicalQuestion(
    index: number,
    currentQuestion: QuizQuestion | null,
    quizId: string | null,
    activeQuizId: string | null,
    selectedQuizId: string | null,
    isShuffleEnabled: () => boolean,
    shouldShuffle: () => boolean,
    shuffledQuestions: QuizQuestion[],
    canonicalQuestionsByQuiz: Map<string, QuizQuestion[]>,
    canonicalQuestionIndexByText: Map<string, Map<string, number>>,
    questions: QuizQuestion[]
  ): QuizQuestion | null {
    const resolvedQuizId = quizId || activeQuizId || selectedQuizId || null;
    return this.questionResolver.resolveCanonicalQuestion(
      index,
      currentQuestion,
      resolvedQuizId,
      isShuffleEnabled,
      shouldShuffle,
      shuffledQuestions,
      canonicalQuestionsByQuiz,
      canonicalQuestionIndexByText,
      questions,
      (q, idx) => this.questionResolver.cloneQuestionForSession(q, idx),
      (text) => this.dataLoader.normalizeQuestionText(text),
      this.quizShuffleService
    );
  }

  /**
   * Prepare and normalize a question + options for emission.
   * Returns the normalized question, options, and payload — or null if
   * the input is invalid.
   */
  prepareQuestionAndOptions(
    currentQuestion: QuizQuestion,
    options: Option[],
    _currentQuestionIndex: number,
    _indexOverride: number | undefined,
    isShuffleEnabled: boolean,
    canonical: QuizQuestion | null
  ): {
    questionToEmit: QuizQuestion;
    optionsToUse: Option[];
  } | null {
    if (!currentQuestion) return null;

    const rawOptions = Array.isArray(options) ? options : [];

    let questionToEmit = currentQuestion;
    let optionsToUse = rawOptions;

    // If shuffle is enabled, trust the questions/options passed in.
    if (isShuffleEnabled) {
      optionsToUse = this.optionsService.normalizeOptionDisplayOrder(rawOptions ?? []).map(
        (option, index) => ({
          ...option,
          optionId: this.toNumericId(option.optionId, index + 1),
          displayOrder: index,
          correct: (option.correct as any) === true || (option.correct as any) === 'true',
          selected: option.selected === true,
          highlight: option.highlight ?? false,
          showIcon: option.showIcon ?? false
        })
      );
    } else {
      if (canonical) {
        const sameQuestion =
          this.dataLoader.normalizeQuestionText(canonical?.questionText) ===
          this.dataLoader.normalizeQuestionText(currentQuestion?.questionText);

        if (!sameQuestion) {
          questionToEmit = {
            ...canonical,
            explanation:
              canonical.explanation ?? currentQuestion.explanation ?? ''
          };
          optionsToUse = Array.isArray(canonical.options)
            ? canonical.options.map((option) => ({ ...option })) : [];
        } else {
          questionToEmit = {
            ...currentQuestion,
            explanation:
              canonical.explanation ?? currentQuestion.explanation ?? '',
            options: Array.isArray(canonical.options)
              ? canonical.options.map((option) => ({ ...option })) : []
          };
        }

        optionsToUse = this.optionsService.mergeOptionsWithCanonical(
          questionToEmit,
          optionsToUse
        );
      } else {
        optionsToUse = this.optionsService.normalizeOptionDisplayOrder(optionsToUse ?? []).map(
          (option, index) => ({
            ...option,
            optionId: this.toNumericId(option.optionId, index + 1),
            displayOrder: index,
            // PRESERVE ABSENCE. `isOptionCorrect` answers false for an option
            // that carries no `correct` at all, so restating it here turned
            // "nobody has said" into "this option is wrong" — and this result is
            // assigned back onto the displayed question below, so the claim
            // reached the rendered options.
            ...(option.correct === undefined ? {} : { correct: isOptionCorrect(option) }),
            selected: option.selected === true,
            highlight: option.highlight ?? false,
            showIcon: option.showIcon ?? false
          })
        );
      }
    }

    if (!optionsToUse.length) return null;

    const normalizedOptions = optionsToUse.map((option) => ({ ...option }));
    const normalizedQuestion = {
      ...questionToEmit,
      options: normalizedOptions
    };

    // Safeguard: Only mutate currentQuestion if we are NOT in shuffle mode,
    // or if we are sure we aren't creating a mixed source.
    // In shuffle mode, currentQuestion SHOULD be the shuffled instance.
    // Assigning normalizedQuestion (which uses currentQuestion properties) is redundant but safe,
    // UNLESS optionsToUse came from a different source.
    if (!isShuffleEnabled) {
      Object.assign(currentQuestion, normalizedQuestion);
    } else {
      // In Shuffle mode, we just update the internal state of the question (e.g. options ref)
      // but we do NOT merge properties blindly from potential canonical fallbacks.
      currentQuestion.options = normalizedOptions;
    }

    return {
      questionToEmit: normalizedQuestion,
      optionsToUse: normalizedOptions
    };
  }
}
