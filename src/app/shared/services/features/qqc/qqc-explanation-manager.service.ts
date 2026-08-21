import { inject, Service } from '@angular/core';
import { firstValueFrom, Subscription } from 'rxjs';

import { FormattedExplanation } from '../../../models/FormattedExplanation.model';
import { QuestionState } from '../../../models/QuestionState.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { QuestionVerdictService } from '../verdict/question-verdict.service';

/**
 * Manages explanation text resolution, formatting, and caching for QQC.
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Service()
export class QqcExplanationManagerService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly verdicts = inject(QuestionVerdictService);

  /**
   * Fetches explanation text for a question index.
   * Returns fallback strings on error or missing data.
   */
  async getExplanationText(questionIndex: number): Promise<string> {
    try {
      if (!this.explanationTextService.explanationsInitialized) {
        return 'No explanation available for this question.';
      }

      const explanation$ =
        this.explanationTextService.getFormattedExplanationTextForQuestion(
          questionIndex
        );
      const explanationText = await firstValueFrom(explanation$);

      const trimmed = explanationText?.trim();
      if (!trimmed) return 'No explanation available for this question.';

      return trimmed;
    } catch {
      return 'Error loading explanation.';
    }
  }

  /**
   * Processes explanation text for a question: formats and returns a FormattedExplanation.
   */
  async processExplanationText(
    questionData: QuizQuestion,
    questionIndex: number
  ): Promise<FormattedExplanation | null> {
    if (!questionData) {
      return {
        questionIndex,
        explanation: 'No question data available'
      };
    }

    const explanation = questionData.explanation || 'No explanation available';

    try {
      const formattedExplanation = await this.getFormattedExplanation(
        questionData,
        questionIndex
      );

      if (formattedExplanation) {
        const explanationText =
          typeof formattedExplanation === 'string'
            ? formattedExplanation
            : formattedExplanation.explanation || '';

        return {
          questionIndex,
          explanation: explanationText
        };
      } else {
        return {
          questionIndex,
          explanation: questionData.explanation || 'No explanation available'
        };
      }
    } catch {
      return {
        questionIndex,
        explanation: questionData.explanation || 'Error processing explanation'
      };
    }
  }

  /**
   * Gets a formatted explanation from the explanation text service.
   */
  async getFormattedExplanation(
    questionData: QuizQuestion,
    questionIndex: number
  ): Promise<{ questionIndex: number; explanation: string }> {
    const formattedExplanationObservable =
      this.explanationTextService.formatExplanationText(
        questionData,
        questionIndex
      );
    const result = await firstValueFrom(formattedExplanationObservable);

    // COMPOSE AGAIN WHEN THE VERDICT ARRIVES.
    //
    // Tracing the live path showed this service composes a question's FET
    // EXACTLY ONCE, at `phase=idle`, and nothing re-runs it after `checking` or
    // `resolved`. That is fine while the answer key is in the bundle, because
    // the correct-option identity is available at idle. It is not fine once
    // identity comes from the verdict: the one composition that happens has no
    // authorized identity, so the "Option N is correct because" prefix cannot
    // be built, and nothing ever revisits it.
    //
    // The trigger belongs HERE rather than in the formatter. This service owns
    // WHEN a FET is composed; the formatter only composes what it is given.
    // Putting the subscription in the formatter proved unreachable, precisely
    // because the formatter is never re-entered.
    this.listenForTerminalVerdicts();

    return result;
  }

  /** One long-lived listener for the whole service. */
  private terminalSub: Subscription | null = null;

  /** Matches the canonicalization used for verdict identity elsewhere. */
  private canonical(text: string | null | undefined): string {
    return (text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /**
   * Recompose a question whenever ITS verdict becomes terminal.
   *
   * ── Why this listens broadly rather than per question ─────────────
   *
   * The first attempt registered a one-shot subscription for the question
   * being composed. Tracing `shuffle:40` showed why that cannot work:
   *
   *     REGISTER q="Which of the following does TypeSc..."   <- composed at load
   *     EMIT     q="Which is an array method to genera..."   <- what was answered
   *
   * Composition happens ONCE per question load, so the only registration made
   * was for the question showing at load. The user then navigated and answered
   * a different one, whose verdict emitted against an identity nobody was
   * waiting on — so the filter never matched and the prefix never composed.
   *
   * The verdict already names the question it belongs to. So rather than
   * guessing in advance which question will be answered, this listens once and
   * recomposes whatever the arrival names, resolved to its CURRENT display
   * index. Identity comes from the event; the index comes from what is on
   * screen now. Neither is inferred.
   */
  private listenForTerminalVerdicts(): void {
    if (this.terminalSub) return;

    const arrivals = this.verdicts?.terminalVerdicts$;
    if (!arrivals || typeof arrivals.subscribe !== 'function') return;

    this.terminalSub = arrivals.subscribe((arrival) => {
      const quizId = (this.quizService as unknown as { quizId?: string })?.quizId;
      if (!quizId || arrival.quizId !== quizId) return;

      const wanted = this.canonical(arrival.questionText);
      if (!wanted) return;

      // Resolve the arrival to the question AS DISPLAYED. Matching by text
      // rather than by a remembered index is what keeps this correct under
      // shuffle, where the same index shows different questions over time.
      const displayed = this.quizService.getQuestionsInDisplayOrder?.() ?? [];
      const index = displayed.findIndex(
        (q) => this.canonical(q?.questionText) === wanted
      );
      if (index < 0) return;

      const question = displayed[index];
      if (!question) return;

      // The formatter refuses a question it has already processed
      // (`isQuestionValid` consults `processedQuestions`). That guard stops
      // redundant re-processing during ordinary rendering and predates
      // verdicts — it would reject THIS pass, the only one that can compose
      // the authorized prefix. Re-open the question for exactly this
      // recomposition; the composition itself marks it processed again.
      const key = question.questionText;
      if (key) this.explanationTextService.processedQuestions.delete(key);

      // Bounded: identity is authorized now, so the recomposition produces the
      // prefixed text and no further arrival is expected for this question.
      void this.getFormattedExplanation(question, index);
    });
  }
  /**
   * Normalizes a question index to a valid 0-based index within the questions array.
   * Handles NaN, negative, 1-based overflow, and out-of-range values.
   *
   * Extracted from QuizQuestionComponent.normalizeIndex().
   */
  normalizeIndex(idx: number, questions: QuizQuestion[]): number {
    if (!Number.isFinite(idx)) return 0;

    const normalized = Math.trunc(idx);

    if (!questions || questions.length === 0) return normalized >= 0 ? normalized : 0;
    if (questions[normalized] != null) return normalized;

    const potentialOneBased = normalized - 1;
    const looksOneBased =
      normalized === potentialOneBased + 1 &&
      potentialOneBased >= 0 &&
      potentialOneBased < questions.length &&
      questions[potentialOneBased] != null;

    if (looksOneBased) return potentialOneBased;

    return Math.min(Math.max(normalized, 0), questions.length - 1);
  }

  /**
   * Captures the current explanation display state for a question.
   * Returns a snapshot that can be used to restore state after a reset.
   */
  captureExplanationSnapshot(params: {
    preserveVisualState: boolean;
    index: number;
    explanationToDisplay: string;
    quizId: string | null | undefined;
    isAnswered: boolean;
    displayMode: string;
    shouldDisplayExplanation: boolean;
    explanationVisible: boolean;
    displayExplanation: boolean;
    displayStateAnswered: boolean;
  }): {
    shouldRestore: boolean;
    explanationText: string;
    questionState?: QuestionState;
  } {
    if (!params.preserveVisualState) {
      return { shouldRestore: false, explanationText: '' };
    }

    const rawExplanation = (params.explanationToDisplay ?? '').trim();
    const latestExplanation = (this.explanationTextService.getLatestExplanation() ?? '')
      .toString()
      .trim();
    const explanationText = rawExplanation || latestExplanation;

    if (!explanationText) {
      return { shouldRestore: false, explanationText: '' };
    }

    const activeQuizId =
      [params.quizId, this.quizService.getCurrentQuizId(), this.quizService.quizId]
        .find((id) => typeof id === 'string' && id.trim().length > 0) ?? null;

    const questionState = activeQuizId
      ? this.quizStateService.getQuestionState(activeQuizId, params.index)
      : undefined;

    const answered = Boolean(
      questionState?.isAnswered ||
      this.selectedOptionService.isAnsweredSig() ||
      params.isAnswered ||
      params.displayStateAnswered
    );

    const explanationVisibleCheck = Boolean(
      params.displayMode === 'explanation' ||
      params.shouldDisplayExplanation ||
      params.explanationVisible ||
      params.displayExplanation ||
      this.explanationTextService.shouldDisplayExplanationSig() ||
      questionState?.explanationDisplayed
    );

    return {
      shouldRestore:
        params.preserveVisualState &&
        answered &&
        explanationVisibleCheck &&
        explanationText.length > 0,
      explanationText,
      questionState
    };
  }
}