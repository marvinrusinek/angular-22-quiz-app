import { Service } from '@angular/core';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { ShuffleState } from '../../models/ShuffleState.model';

import { isOptionCorrect } from '../../utils/is-option-correct';
import { norm } from '../../utils/text-norm';
import { ArrayUtils } from '../../utils/array-utils';
import { swallow } from '../../utils/error-logging';

export interface PrepareShuffleOpts {
  shuffleQuestions?: boolean,
  shuffleOptions?: boolean
}

@Service()
export class QuizShuffleService {
  // ── properties ──────────────────────────────────────────────────
  private shuffleByQuizId = new Map<string, ShuffleState>();

  // ── public methods ──────────────────────────────────────────────

  // Call once starting a quiz session (after fetching questions)
  public prepareShuffle(
    quizId: string,
    questions: QuizQuestion[],
    // Questions AND options are both shuffled. Option shuffling is safe because
    // each option's identity travels with its STABLE optionId (assigned by
    // ORIGINAL position in cloneAndNormalizeOptions before reorderOptions runs),
    // not its display position. Scoring, feedback, FET and results resolve answers
    // by optionId/text, never by array index, so the visual order can change
    // freely.
    opts: PrepareShuffleOpts = { shuffleQuestions: true, shuffleOptions: true }
  ): void {
    // Shuffle EXACTLY ONCE per quiz session. If an order already exists for this
    // quiz, keep it untouched so navigation never reshuffles the questions OR
    // the options (no re-normalization to identity).
    if (this.shuffleByQuizId.has(quizId)) {
      return;
    }

    // Restore a persisted order if one exists — keep its option order as saved.
    if (this.loadState(quizId)) {
      const state = this.shuffleByQuizId.get(quizId);
      if (state && state.questionOrder.length === questions.length) {
        return;
      }
      // Persisted shuffle length mismatch — regenerating
      this.shuffleByQuizId.delete(quizId);
      localStorage.removeItem(`shuffleState:${quizId}`);
    }

    const { shuffleQuestions = true, shuffleOptions = true } = opts;

    const qIdx = questions.map((_, i) => i);
    const questionOrder = shuffleQuestions ? ArrayUtils.shuffleArray(qIdx) : qIdx;

    const optionOrder = new Map<number, number[]>();
    for (const origIdx of questionOrder) {
      const len = questions[origIdx]?.options?.length ?? 0;
      const base = Array.from({ length: len }, (_, i) => i);
      optionOrder.set(
        origIdx,
        shuffleOptions ? ArrayUtils.shuffleArray(base) : base
      );
    }

    this.shuffleByQuizId.set(quizId, { questionOrder, optionOrder });
    this.saveState(quizId);
  }

  public hasShuffleState(quizId: string): boolean {
    return this.shuffleByQuizId.has(quizId) ||
      !!localStorage.getItem(`shuffleState:${quizId}`);
  }

  public getShuffleState(quizId: string): ShuffleState | undefined {
    if (!this.shuffleByQuizId.has(quizId)) this.loadState(quizId);
    return this.shuffleByQuizId.get(quizId);
  }

  public alignAnswersWithOptions(
    rawAnswers: Option[] | undefined,
    options: Option[] = []
  ): Option[] {
    const normalizedOptions = Array.isArray(options) ? options : [];
    if (normalizedOptions.length === 0) return [];

    const answers = Array.isArray(rawAnswers) ? rawAnswers : [];
    const aligned = answers
      .map((answer) => this.normalizeAnswerReference(answer, normalizedOptions))
      .filter((option): option is Option => option != null);

    if (aligned.length > 0) {
      const seen = new Set<number>();
      return aligned
        .filter((option) => {
          const id = this.toNum(option.optionId);
          if (id == null) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .map((option) => ({ ...option }));
    }

    const fallback = normalizedOptions.filter((option) => option.correct);
    if (fallback.length > 0) return fallback.map((option) => ({ ...option }));

    return [];
  }

  // Map display index -> original index (for scoring, persistence, timers)
  public toOriginalIndex(quizId: string, displayIdx: number): number | null {
    if (!this.shuffleByQuizId.has(quizId)) this.loadState(quizId);

    const state = this.shuffleByQuizId.get(quizId);
    if (!state) return null;

    const result = state.questionOrder[displayIdx] ?? null;
    return result;
  }

  // Get a question re-ordered by the saved permutation (options included).
  public getQuestionAtDisplayIndex(
    quizId: string,
    displayIdx: number,
    allQuestions: QuizQuestion[]
  ): QuizQuestion | null {
    const state = this.shuffleByQuizId.get(quizId);
    if (!state) return null;

    const origIdx = state.questionOrder[displayIdx];
    const src = allQuestions[origIdx];
    if (!src) return null;

    // Ensure numeric, stable optionId before reordering
    const normalizedOpts = this.cloneAndNormalizeOptions(
      src.options ?? [],
      origIdx
    );
    const order = state.optionOrder.get(origIdx);
    const safeOptions = this.reorderOptions(normalizedOpts, order);

    const alignedAnswers = this.alignAnswersWithOptions(src.answer, safeOptions);

    return {
      ...src,
      options: safeOptions.map((option) => ({ ...option })),
      answer: alignedAnswers
    };
  }

  public buildShuffledQuestions(
    quizId: string,
    questions: QuizQuestion[]
  ): QuizQuestion[] {
    if (!Array.isArray(questions) || questions.length === 0) return [];

    const state = this.shuffleByQuizId.get(quizId);
    if (!state) {
      return questions.map((question, index) => {
        const normalizedOptions = this.cloneAndNormalizeOptions(
          question.options ?? [],
          index  // use loop index as question index
        );
        const hasAnswerKey = Array.isArray(question.answer) && question.answer.length > 0;
        return {
          ...question,
          options: normalizedOptions.map((option) => ({ ...option })),
          // An empty `answer` array reads as "this question has no correct
          // options". Undefined says nobody has told us. See the note below.
          answer: hasAnswerKey
            ? this.alignAnswersWithOptions(question.answer, normalizedOptions)
            : undefined
        };
      });
    }

    const displaySet = state.questionOrder
      .map((originalIndex) => {
        const source = questions[originalIndex];
        if (!source) return null;

        const normalizedOptions = this.cloneAndNormalizeOptions(
          source.options ?? [],
          originalIndex
        );
        const orderedOptions = this.reorderOptions(
          normalizedOptions,
          state.optionOrder.get(originalIndex)
        );

        const alignedAnswers = this.alignAnswersWithOptions(source.answer, orderedOptions);
        const correctIds = new Set(alignedAnswers.map(a => Number(a.optionId)));
        const correctTexts = new Set(alignedAnswers.map(a => norm(a.text)));

        // NO ANSWER KEY, NO CLAIM — the same rule `normalizeQuestion` applies.
        // Aligning against an answer key is right when there IS one; with API
        // questions there is none, so every option would be stamped
        // `correct: false` and `answer` would become `[]` — asserting that no
        // option is correct rather than that nobody has said.
        const hasAnswerKey = Array.isArray(source.answer) && source.answer.length > 0;

        return {
          ...source,
          options: orderedOptions.map((option) => {
            if (!hasAnswerKey && option.correct === undefined) return { ...option };
            return {
              ...option,
              correct: isOptionCorrect(option) ||
                (option.optionId !== undefined && correctIds.has(Number(option.optionId))) ||
                (option.text !== undefined && correctTexts.has(norm(option.text)))
            };
          }),
          answer: hasAnswerKey ? alignedAnswers : undefined
        } as QuizQuestion;
      })
      .filter((question): question is QuizQuestion => question !== null);

    if (displaySet.length === 0) {
      return questions.map((question, index) => {
        const normalizedOptions = this.cloneAndNormalizeOptions(
          question.options ?? [],
          index
        );
        const alignedAnswers = this.alignAnswersWithOptions(
          question.answer,
          normalizedOptions
        );
        const correctIds = new Set(alignedAnswers.map(a => Number(a.optionId)));
        const correctTexts = new Set(alignedAnswers.map(a => norm(a.text)));
        const hasAnswerKey = Array.isArray(question.answer) && question.answer.length > 0;

        return {
          ...question,
          options: normalizedOptions.map((option) => {
            if (!hasAnswerKey && option.correct === undefined) return { ...option };
            return {
              ...option,
              correct: isOptionCorrect(option) ||
                (option.optionId !== undefined && correctIds.has(Number(option.optionId))) ||
                (option.text !== undefined && correctTexts.has(norm(option.text)))
            };
          }),
          answer: hasAnswerKey ? alignedAnswers : undefined
        };
      });
    }

    return displaySet;
  }

  // Clear when the session ends
  public clear(quizId: string): void {
    this.shuffleByQuizId.delete(quizId);
    localStorage.removeItem(`shuffleState:${quizId}`);
  }

  public clearAll(): void {
    this.shuffleByQuizId.clear();
    try {
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        if (key.startsWith('shuffleState:')) {
          localStorage.removeItem(key);
        }
      }
    } catch (err) {
      swallow('quiz-shuffle.service#1', err);
    }
  }

  // Make optionId numeric & stable; idempotent. Prefer 1-based ids for compatibility
  // with existing quiz logic while always normalising the display order.
  // Make optionId numeric & stable; idempotent. Uses questionIndex to ensure global uniqueness.
  public assignOptionIds(options: Option[], questionIndex: number): Option[] {
    return (options ?? []).map((o, i) => {
      // IDEMPOTENT: an option that already carries a valid numeric optionId keeps
      // it, so re-stamping an already-SHUFFLED array (this method is called at
      // several pipeline stages) never renumbers an option by its new display
      // position. Without this, an option's id would change when it moves, and
      // scoring/feedback/FET — which resolve by optionId — would break. Only
      // assign a fresh id (by original position) when one is missing.
      const existing = this.toNum((o as any).optionId);
      const uniqueId = existing != null && existing > 0
        ? existing
        : (questionIndex + 1) * 100 + (i + 1);

      return {
        ...o,
        optionId: uniqueId,
        // Fallback so selectedOptions.includes(option.value) remains viable
        value: (o as any).value ?? (o as any).text ?? uniqueId
      } as Option;
    });
  }

  // ── private methods ─────────────────────────────────────────────

  // Persistence Utilities
  private saveState(quizId: string): void {
    const state = this.shuffleByQuizId.get(quizId);
    if (!state) return;

    try {
      // Convert Map to Array for JSON serialization
      const serializedState = {
        questionOrder: state.questionOrder,
        optionOrder: Array.from(state.optionOrder.entries())
      };
      localStorage.setItem(`shuffleState:${quizId}`, JSON.stringify(serializedState));
    } catch (err) {
      swallow('quiz-shuffle.service#2', err);
    }
  }

  private loadState(quizId: string): boolean {
    try {
      const raw = localStorage.getItem(`shuffleState:${quizId}`);
      if (!raw) return false;

      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.questionOrder || !Array.isArray(parsed.optionOrder)) return false;

      const state: ShuffleState = {
        questionOrder: parsed.questionOrder,
        optionOrder: new Map(parsed.optionOrder)
      };

      this.shuffleByQuizId.set(quizId, state);
      return true;
    } catch {
      // load failed — non-critical
      return false;
    }
  }

  private reorderOptions(options: Option[], order?: number[]): Option[] {
    if (!Array.isArray(options) || options.length === 0) return [];

    const normalizeForDisplay = (opts: Option[]): Option[] =>
      opts.map((option, index) => {
        const id = this.toNum(option.optionId) ?? index + 1;

        // value must remain a number per your model
        const numericValue =
          typeof option.value === 'number'
            ? option.value : (this.toNum(option.value) ?? id);

        return {
          ...option,
          optionId: id,
          displayOrder: index,  // if this isn't in Option, you can keep it as an extension or drop it
          value: numericValue   // always number
        } as Option;  // if displayOrder isn't in Option, use a local type if you need it
      });

    if (!Array.isArray(order) || order.length !== options.length) {
      return normalizeForDisplay(options.map((option) => ({ ...option })));
    }

    const reordered = order
      .map((sourceIndex) => {
        const option = options[sourceIndex];
        if (!option) return null;
        return { ...option } as Option;
      })
      .filter((option): option is Option => option !== null);

    if (reordered.length !== options.length) {
      return normalizeForDisplay(options.map((option) => ({ ...option })));
    }

    return normalizeForDisplay(reordered);
  }

  private normalize(val: unknown): string {
    return String(val ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/ /g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  private normalizeAnswerReference(
    answer: Option | null | undefined,
    options: Option[]
  ): Option | null {
    if (!answer) return null;

    const byId = this.toNum(answer.optionId);
    if (byId != null) {
      const matchById = options.find(
        (option) => this.toNum(option.optionId) === byId
      );
      if (matchById) return matchById;
    }

    const byValue = this.toNum(answer.value);
    if (byValue != null) {
      const matchByValue = options.find(
        (option) => this.toNum(option.value) === byValue
      );
      if (matchByValue) return matchByValue;
    }

    const normAnsText = this.normalize(answer.text);
    if (normAnsText) {
      const matchByText = options.find(
        (option) => this.normalize(option.text) === normAnsText
      );
      if (matchByText) return matchByText;
    }

    return null;
  }

  private toNum(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = Number(String(v));
    return Number.isFinite(n) ? n : null;
  }

  private cloneAndNormalizeOptions(
    options: Option[] = [],
    questionIndex: number
  ): Option[] {
    const withIds = this.assignOptionIds(options, questionIndex);
    return withIds.map((option, index) => ({
      ...option,
      displayOrder: index,
      // ABSENCE IS PRESERVED. Writing `correct: false` for an option that
      // carries no correctness at all asserts the option is WRONG, which is a
      // claim nobody has made — API options carry no `correct` by design, and
      // the verdict is the only thing entitled to answer it. Normalizing a
      // present flag is still fine; manufacturing an absent one is not.
      ...(option.correct === undefined ? {} : { correct: isOptionCorrect(option) }),
      selected: option.selected === true,
      highlight: option.highlight ?? false,
      showIcon: option.showIcon ?? false
    }));
  }
}
