import { inject, Service, Injector, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { Observable, of } from 'rxjs';

import { QuestionType } from '../../../models/question-type.enum';

import { FormattedExplanation } from '../../../models/FormattedExplanation.model';
import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { QuestionVerdictService } from '../verdict/question-verdict.service';
import { authorizedCorrectTexts, authorizedExplanation } from '../verdict/authorized-correctness';
import { QuizService } from '../../data/quiz.service';
import { QuizShuffleService } from '../../flow/quiz-shuffle.service';
import { pinAllOfTheAboveLast, pinnedIndex1Based } from '../../../utils/all-of-the-above';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';
import { withTerminalPeriod } from '../../../utils/terminal-period';
import { swallow } from '../../../utils/error-logging';

@Service()
export class ExplanationFormatterService {
  // -- injects -----------------------------------------------------
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly injector = inject(Injector);

  formattedExplanations: Record<number, FormattedExplanation> = {};
  readonly formattedExplanationSig = signal<string>('');
  formattedExplanation$ = toObservable(this.formattedExplanationSig);
  private formattedExplanationByQuestionText = new Map<string, string>();

  public readonly explanationsUpdatedSig = 
    signal<Record<number, FormattedExplanation>>(this.formattedExplanations);
  public readonly explanationsUpdated$ = toObservable(this.explanationsUpdatedSig);

  processedQuestions: Set<string> = new Set<string>();
  readonly explanationsInitializedSig = signal<boolean>(false);

  // FET cache by index - reliable storage that won't be cleared by stream timing issues
  public fetByIndex = new Map<number, string>();
  // Track which FET indices have been locked to prevent regeneration with wrong options
  public lockedFetIndices = new Set<number>();

  // Synchronous lookup by question index
  public getFormattedSync(qIdx: number): string | undefined {
    return this.formattedExplanations[qIdx]?.explanation;
  }

  initializeExplanationTexts(explanationTexts: Record<number, string>, explanations: string[]): void {
    for (const k of Object.keys(explanationTexts)) {
      delete explanationTexts[Number(k)];
    }
    this.formattedExplanationByQuestionText.clear();

    for (const [index, explanation] of explanations.entries()) {
      explanationTexts[index] = explanation;
    }
  }

  initializeFormattedExplanations(
    explanations: { questionIndex: number; explanation: string }[]
  ): void {
    this.formattedExplanations = {};  // clear existing data
    this.formattedExplanationByQuestionText.clear();

    if (!Array.isArray(explanations) || explanations.length === 0) return;

    for (const entry of explanations) {
      const idx = Number(entry.questionIndex);
      const text = entry.explanation ?? '';

      if (!Number.isFinite(idx) || idx < 0) continue;

      const trimmed = String(text).trim();

      this.formattedExplanations[idx] = {
        questionIndex: idx,
        explanation: trimmed || 'No explanation available'
      };
    }

    // Notify subscribers about the updated explanations
    this.explanationsUpdatedSig.set({ ...this.formattedExplanations });
  }

  formatExplanationText(
    question: QuizQuestion,
    questionIndex: number
  ): Observable<{ questionIndex: number; explanation: string }> {
    // Early exit for invalid or stale questions
    if (!this.isQuestionValid(question)) {
      return of({ questionIndex, explanation: '' });
    }

    // NOTHING IS SAID UNTIL THERE IS SOMETHING TO SAY.
    //
    // This fabricated `'Explanation not provided'` whenever the question
    // carried no explanation of its own — and then STORED it, into both
    // `formattedExplanations[idx]` and `fetByIndex`. Since S4 an API-sourced
    // question never carries one (the explanation names the correct options, so
    // only `/check` may release it), which means the placeholder was written on
    // every question while the verdict was still `idle`, before anything had
    // been asked. `heading-inputs` prefers those stored values over the
    // authorized explanation, so the fabrication won until something overwrote
    // it — and stayed on screen whenever nothing did.
    //
    // An empty raw explanation now falls to the AUTHORIZED one, and if that has
    // not arrived either, this returns without storing anything at all. The
    // heading renders nothing, which is the honest state for "not yet checked".
    const rawExplanation =
      question?.explanation?.trim() || this.authorizedExplanationFor(questionIndex);

    if (!rawExplanation) {
      return of({ questionIndex, explanation: '' });
    }

    // Idempotency detector (same as in formatExplanation)
    const alreadyFormattedRe =
      /^(?:option|options)\s+#?\d+(?:\s*,\s*#?\d+)*(?:\s+and\s+#?\d+)?\s+(?:is|are)\s+correct\s+because\s+/i;

    // Format explanation (only if not already formatted)
    const correctOptionIndices = this.getCorrectOptionIndices(question, question.options, questionIndex);
    let formattedExplanation = alreadyFormattedRe.test(rawExplanation)
      ? rawExplanation
      : this.formatExplanation(question, correctOptionIndices, rawExplanation, questionIndex);

    // Normalize the terminal period ONCE, up front, so the stored value, the
    // signal, the coalescing comparison below, and the returned value all agree
    // (otherwise stored-with-period vs local-without would never coalesce).
    formattedExplanation = this.ensureTerminalPeriod(formattedExplanation);

    // Store and sync (but coalesce to avoid redundant emits)
    const prev =
      this.formattedExplanations[questionIndex]?.explanation?.trim() || '';
    if (prev !== formattedExplanation) {
      this.storeFormattedExplanation(
        questionIndex,
        formattedExplanation,
        question
      );
      this.syncFormattedExplanationState(questionIndex, formattedExplanation);
      this.updateFormattedExplanation(formattedExplanation);
    }

    // Prevent duplicate processing
    const questionKey =
      question?.questionText ?? JSON.stringify({ i: questionIndex });
    this.processedQuestions.add(questionKey);

    return of({
      questionIndex,
      explanation: formattedExplanation
    });
  }

  updateFormattedExplanation(explanation: string): void {
    const trimmed = explanation?.trim();
    if (!trimmed) return;

    this.formattedExplanationSig.set(trimmed);
  }

  // Leading "Option(s) X is/are correct because" prefix.
  private readonly fetAlreadyFormattedRe =
    /^(?:option|options)\s+#?\d+(?:\s*,\s*#?\d+)*(?:\s+and\s+#?\d+)?\s+(?:is|are)\s+correct\s+because\s+/i;

  storeFormattedExplanation(
    index: number,
    explanation: string,
    question: QuizQuestion,
    options?: Option[],
    force = false
  ): void {
    if (index < 0) return;
    if (!explanation || explanation.trim() === '') return;

    const trimmedExplanation = explanation.trim();
    const incomingAlreadyFormatted = this.fetAlreadyFormattedRe.test(trimmedExplanation);

    let formattedExplanation = (force && incomingAlreadyFormatted)
      ? this.resolveForcedFormatted(index, question, options, trimmedExplanation)
      : this.resolveDefaultFormatted(index, question, options, trimmedExplanation, incomingAlreadyFormatted);

    formattedExplanation = this.revalidateFormattedAgainstVisual(formattedExplanation, index, question, options, trimmedExplanation);

    // End the FET with a period when the sentence doesn't already end in
    // sentence-ending punctuation (leave it untouched if it does).
    formattedExplanation = this.ensureTerminalPeriod(formattedExplanation);

    this.commitFormattedExplanation(index, question, formattedExplanation, force);
  }

  /**
   * Ensure a FET ends with sentence-ending punctuation: append a period when the
   * (trailing-whitespace-trimmed) text doesn't already end with `.`, `!`, `?` or
   * `…`. A single trailing closer (`)`, `]`, `}`, quote) is ignored for the
   * check, so a quoted/parenthesised ending that already has a period isn't
   * double-punctuated. Idempotent — a no-op when a terminator is already present.
   */
  private ensureTerminalPeriod(text: string): string {
    return withTerminalPeriod(text);
  }

  /** 1-based option indices parsed from a formatted FET prefix. */
  private parseLeadingOptionIndices(text: string): number[] {
    const prefixMatch = text.match(/^(?:option|options)\s+([^]*?)\s+(?:is|are)\s+correct\s+because\s+/i);
    if (!prefixMatch || !prefixMatch[1]) return [];
    const rawNumbers = prefixMatch[1].match(/\d+/g) || [];
    return Array.from(new Set(
      rawNumbers.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    )).sort((a, b) => a - b);
  }

  /**
   * The AUTHORIZED explanation for a display index, or '' when none exists yet.
   *
   * Same lazy-injector approach as the authorized-indices helper below, and the
   * same authority: `authorizedExplanation` answers only on a TERMINAL verdict
   * (resolved or expired), so this is empty while idle or checking — which is
   * exactly when nothing should be rendered.
   */
  private authorizedExplanationFor(displayIndex: number): string {
    if (typeof displayIndex !== 'number' || displayIndex < 0) return '';
    const quizSvc = this.injector.get(QuizService, null);
    const verdicts = this.injector.get(QuestionVerdictService, null);
    if (!quizSvc || !verdicts) return '';
    return (authorizedExplanation(quizSvc, displayIndex, verdicts) ?? '').trim();
  }

  /** Visual correct-option indices from the snapshot: by answer-text first, then by correct flags. */
  private getVisualIndicesFromSnapshot(index: number, question: QuizQuestion, options?: Option[]): number[] {
    let opts = Array.isArray(options) ? options : [];
    if (opts.length === 0) {
      try {
        const quizSvc = this.injector.get(QuizService, null);
        if (quizSvc) {
          const shuffledQs = quizSvc.shuffledQuestions;
          const isShuffled = quizSvc.isShuffleEnabled?.() ?? false;
          const questions = isShuffled && shuffledQs?.length > 0 ? shuffledQs : quizSvc.questions;
          if (Array.isArray(questions) && questions[index]) {
            opts = questions[index].options ?? [];
          }
        }
      } catch (err: unknown) { swallow('explanation-formatter.service.ts display-opts resolve', err); }
    }
    if (opts.length === 0) return [];

    const answerTexts = new Set<string>();
    for (const answer of (question?.answer ?? [])) {
      const normalized = this.normalizeLocalText((answer as any)?.text);
      if (normalized) answerTexts.add(normalized);
    }
    const byAnswerText = opts
      .map((option, idx) => answerTexts.has(this.normalizeLocalText(option?.text)) ? idx + 1 : null)
      .filter((n): n is number => n !== null);
    if (byAnswerText.length > 0) {
      return Array.from(new Set(byAnswerText)).sort((a, b) => a - b);
    }
    const byFlags = opts
      .map((option, idx) => isOptionCorrect(option) ? idx + 1 : null)
      .filter((n): n is number => n !== null);
    return Array.from(new Set(byFlags)).sort((a, b) => a - b);
  }

  /** The question with the passed options spliced in (when non-empty). */
  private questionWithOptions(question: QuizQuestion, options?: Option[]): QuizQuestion {
    return Array.isArray(options) && options.length > 0 ? { ...question, options } : question;
  }

  /** Two index arrays are identical (same length, same order). */
  private sameIndices(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((n, i) => n === b[i]);
  }

  /** Strip the FET prefix down to the raw explanation (falling back to the original). */
  private stripFetPrefix(text: string, fallback: string): string {
    const raw = text.replace(this.fetAlreadyFormattedRe, '').trim();
    return raw || fallback;
  }

  /** Forced + pre-formatted: trust the text when its prefix matches the visual snapshot, else re-format. */
  private resolveForcedFormatted(index: number, question: QuizQuestion, options: Option[] | undefined, trimmedExplanation: string): string {
    const prefixIndices = this.parseLeadingOptionIndices(trimmedExplanation);
    const visualSnapshotIndices = this.getVisualIndicesFromSnapshot(index, question, options);
    const hasComparableData = prefixIndices.length > 0 && visualSnapshotIndices.length > 0;
    if (!hasComparableData || this.sameIndices(prefixIndices, visualSnapshotIndices)) {
      return trimmedExplanation;
    }
    const rawExplanation = this.stripFetPrefix(trimmedExplanation, trimmedExplanation);
    return this.formatExplanation(this.questionWithOptions(question, options), visualSnapshotIndices, rawExplanation, index);
  }

  /** Default path: strip any prefix and regenerate with the current correct indices. */
  private resolveDefaultFormatted(index: number, question: QuizQuestion, options: Option[] | undefined, trimmedExplanation: string, incomingAlreadyFormatted: boolean): string {
    const rawExplanation = incomingAlreadyFormatted ? this.stripFetPrefix(trimmedExplanation, trimmedExplanation) : trimmedExplanation;
    const correctOptionIndices = this.getCorrectOptionIndices(question, options, index);
    return this.formatExplanation(this.questionWithOptions(question, options), correctOptionIndices, rawExplanation, index);
  }

  /** Final guardrail: re-format if the prefix indices don't match the visual snapshot. */
  private revalidateFormattedAgainstVisual(formattedExplanation: string, index: number, question: QuizQuestion, options: Option[] | undefined, trimmedExplanation: string): string {
    const finalPrefixIndices = this.parseLeadingOptionIndices(formattedExplanation);
    const finalVisualIndices = this.getVisualIndicesFromSnapshot(index, question, options);
    const mismatch = finalPrefixIndices.length > 0 && finalVisualIndices.length > 0
      && !this.sameIndices(finalPrefixIndices, finalVisualIndices);
    if (!mismatch) return formattedExplanation;
    const rawExplanation = this.stripFetPrefix(formattedExplanation, trimmedExplanation);
    return this.formatExplanation(this.questionWithOptions(question, options), finalVisualIndices, rawExplanation, index);
  }

  /** Lock-protect then store the formatted FET (caches, lock, per-question map, signal). */
  private commitFormattedExplanation(index: number, question: QuizQuestion, formattedExplanation: string, force: boolean): void {
    if (!force && this.lockedFetIndices.has(index)) {
      const existing = this.fetByIndex.get(index) ?? this.formattedExplanations[index]?.explanation ?? '';
      if (existing.trim() === formattedExplanation.trim()) return;
    }
    this.formattedExplanations[index] = { questionIndex: index, explanation: formattedExplanation };
    this.fetByIndex.set(index, formattedExplanation);
    this.lockedFetIndices.add(index);
    this.storeFormattedExplanationForQuestion(question, index, formattedExplanation);
    this.explanationsUpdatedSig.set({ ...this.formattedExplanations });
  }

  private storeFormattedExplanationForQuestion(
    question: QuizQuestion,
    index: number,
    explanation: string
  ): void {
    if (!question) return;

    const keyWithoutIndex = this.buildQuestionKey(question?.questionText);
    const keyWithIndex = this.buildQuestionKey(question?.questionText, index);

    if (keyWithoutIndex) {
      this.formattedExplanationByQuestionText.set(keyWithoutIndex, explanation);
    }

    if (keyWithIndex) {
      this.formattedExplanationByQuestionText.set(keyWithIndex, explanation);
    }
  }

  /**
   * Identifies 1-based indices of correct options within the provided `options` array.
   * Priority:
   * 1. Pristine question lookup from QuizService (best)
   * 2. provided question.answer texts (very good)
   * 3. provided options[].correct flags (fallback)
   */
  getCorrectOptionIndices(
    question: QuizQuestion,
    options?: Option[],
    displayIndex?: number
  ): number[] {
    const opts = this.resolveOptionsForCorrectness(question, options, displayIndex);
    const targetQuestionText = question?.questionText || '';
    const qIdx = this.resolveCorrectIndicesQIdx(displayIndex);
    const qTextNormFull = (question?.questionText || targetQuestionText || '').toLowerCase();
    const isSingleChoice = this.computeIsSingleChoice(question, opts, qTextNormFull);
    const lowerExpContent = (question?.explanation || '').toLowerCase();

    // ── AUTHORIZED IDENTITY FIRST, AND ALONE ─────────────────────────
    //
    // Every strategy below reconstructs WHICH options are correct from the
    // local answer key — `option.correct`, keyword scans over the explanation,
    // the pristine sets. None of them can answer once questions arrive from
    // `/questions` carrying no correctness, which left the composed FET
    // ("Option 2 is correct because …") with no indices and therefore no
    // prefix.
    //
    // The verdict discloses `correctOptionTexts` on a terminal phase, so once
    // it has, that IS the identity — and the local chain must not run at all.
    // Falling through to it would let a stale flag contradict an authorized
    // reveal, which is the precise inversion this migration removes.
    //
    // PRESENTATION ONLY. This changes where the numbers come from, never when
    // a FET may show, nor scoring, completion or the verdict itself.
    const authorized = this.authorizedCorrectIndices(opts, displayIndex);
    if (authorized) return authorized;

    return this.tryInternalCorrectFlags(opts, isSingleChoice, lowerExpContent)
      ?? this.tryExplanationKeywordScan(opts, lowerExpContent)
      ?? this.tryVisualCorrectFlags(opts)
      ?? this.resolveByCorrectSets(question, opts, qIdx, targetQuestionText, isSingleChoice, lowerExpContent, qTextNormFull)
      ?? this.tryQuickVisualScan(opts);
  }

  /**
   * 1-based indices of the correct options, from the AUTHORIZED reveal.
   *
   * Null when nothing is authorized — never an empty array, which downstream
   * would read as "no option is correct" and compose a prefix claiming so.
   *
   * Matched by TEXT against the options as DISPLAYED, so a shuffled quiz
   * numbers them by what the user is looking at rather than by any canonical
   * position. `authorizedCorrectTexts` normalizes with the shared `norm`, and
   * this side uses the same helper, so the two agree by construction.
   */
  private authorizedCorrectIndices(
    opts: Option[],
    displayIndex?: number
  ): number[] | null {
    if (!Array.isArray(opts) || opts.length === 0) return null;
    if (typeof displayIndex !== 'number' || displayIndex < 0) return null;

    // Resolved lazily through the injector, like every other service reference
    // in this file — a constructor-injected QuizService would drag its graph
    // into the formatter's own construction.
    const quizSvc = this.injector.get(QuizService, null);
    const verdicts = this.injector.get(QuestionVerdictService, null);
    if (!quizSvc || !verdicts) return null;

    const correctTexts = authorizedCorrectTexts(quizSvc, displayIndex, verdicts);
    if (!correctTexts || correctTexts.size === 0) return null;

    const indices = opts
      .map((opt, i) => (correctTexts.has(norm(opt?.text)) ? i + 1 : null))
      .filter((n): n is number => n !== null);

    // An authorized set that matches NOTHING on screen means the options and
    // the verdict describe different questions. Answering null sends the
    // caller down the legacy chain rather than composing a prefix from an
    // empty match, which would be worse than not composing one.
    return indices.length > 0 ? indices : null;
  }

  /** HTML/entity-stripping normalizer used by the correct-index matchers. Extracted verbatim. */
  private normalizeLocalText(s: any): string {
    if (typeof s !== 'string') return '';
    return s
      .replace(/&nbsp;/gi, ' ')
      .replace(/\u00A0/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  /**
   * Resolve the options to evaluate: prefer the raw, untouched quizService
   * questions array (in-memory questions may carry OR-merged stale correct
   * flags). Extracted verbatim.
   */
  private resolveOptionsForCorrectness(question: QuizQuestion, options?: Option[], displayIndex?: number): Option[] {
    let opts = options || question?.options || [];
    try {
      const quizSvc = this.injector.get(QuizService, null);
      const idx = Number.isFinite(displayIndex)
        ? (displayIndex as number)
        : (typeof quizSvc?.getCurrentQuestionIndex === 'function'
          ? quizSvc.getCurrentQuestionIndex()
          : -1);
      // SHUFFLE-AWARE: resolve through the DISPLAYED question so the returned
      // correct indices are DISPLAY positions — the "Option N" label in the FET
      // and feedback must match the order the user actually sees. With option
      // shuffling on, indexing the raw `questions` array (original option order)
      // would label the correct option by its original position. getDisplayed-
      // Question returns shuffledQuestions[idx] (option-shuffled, display order)
      // when shuffling is on, and the original question otherwise.
      const displayedOpts = quizSvc?.getDisplayedQuestion?.(idx)?.options;
      const rawOpts = (Array.isArray(displayedOpts) && displayedOpts.length)
        ? displayedOpts
        : quizSvc?.questions?.[idx]?.options;
      if (Array.isArray(rawOpts) && rawOpts.length) opts = rawOpts;
    } catch (err: unknown) {
      console.error('ExplanationFormatterService.formatExplanation options fallback lookup failed:', err);
    }
    return opts;
  }

  /** Resolve the question index (displayIndex, then latestExplanationIndex, then QuizService). Extracted verbatim. */
  private resolveCorrectIndicesQIdx(displayIndex?: number): number {
    let qIdx = Number.isFinite(displayIndex) ? (displayIndex as number) : this.latestExplanationIndex;
    if (!Number.isFinite(qIdx) || qIdx === -1) {
      try {
        const quizSvc = this.injector.get(QuizService, null);
        if (quizSvc) {
          const svcIdx = quizSvc.getCurrentQuestionIndex();
          if (typeof svcIdx === 'number' && svcIdx >= 0) qIdx = svcIdx;
        }
      } catch (err: unknown) {
        console.error('ExplanationFormatterService.formatExplanation QuizService index fallback failed:', err);
      }
    }
    return qIdx ?? 0;
  }

  /** Single-choice detection: <=1 correct flag and a single/true-false (non-explicit-multi) type. Extracted verbatim. */
  private computeIsSingleChoice(question: QuizQuestion, opts: Option[], qTextNormFull: string): boolean {
    const isExplicitMulti = qTextNormFull.includes('apply') || qTextNormFull.includes('multiple');
    const qTypeRaw = String(question?.type || '').toLowerCase();
    const correctFlagCount = opts.filter(o => isOptionCorrect(o)).length;
    return correctFlagCount <= 1 &&
      (qTypeRaw === 'single_answer' || qTypeRaw === 'true_false' ||
      (!isExplicitMulti && qTypeRaw !== 'multiple_answer'));
  }

  /**
   * Attempt 0: trust the internal correct flags first (most reliable signal);
   * for single-choice with multiple flags, refine by explanation keyword.
   * Returns null to fall through. Extracted verbatim.
   */
  private tryInternalCorrectFlags(opts: Option[], isSingleChoice: boolean, lowerExpContent: string): number[] | null {
    const internalCorrectIndices = opts
      .map((opt, i) => (isOptionCorrect(opt) ? i + 1 : null))
      .filter((n): n is number => n !== null);
    if (internalCorrectIndices.length === 0) return null;

    let result = Array.from(new Set(internalCorrectIndices)).sort((a, b) => a - b);
    // Safeguard: multiple flags for single-choice -> refine by explanation keyword.
    if (result.length > 1 && isSingleChoice && lowerExpContent.length > 5) {
      const matchingExp = result.filter(idx => {
        const t = (opts[idx - 1]?.text || '').toLowerCase();
        return t.length > 2 && lowerExpContent.includes(t);
      });
      if (matchingExp.length === 1) result = matchingExp;
    }
    return result;
  }

  /**
   * Truth layer 0: explanation keyword scan (only when correct flags are absent).
   * Constructor hard-lock for Q5, else a single unique option mention. Returns
   * null to fall through. Extracted verbatim.
   */
  private tryExplanationKeywordScan(opts: Option[], lowerExpContent: string): number[] | null {
    if (lowerExpContent.length <= 5) return null;
    // HARD-LOCK for Constructor Question (Q5).
    if (lowerExpContent.includes('constructor') && lowerExpContent.includes('instantiation')) {
      const found = opts.findIndex(o => (o.text || '').toLowerCase().includes('constructor'));
      if (found !== -1) return [found + 1];
    }
    const uniqueMention = opts
      .map((o, i) => {
        const t = norm(o.text);
        if (t.length < 3) return null;
        return lowerExpContent.includes(t) ? i + 1 : null;
      })
      .filter((n): n is number => n !== null);
    if (uniqueMention.length === 1) return uniqueMention;
    return null;
  }

  /** Attempt 1: trust the visual options' correct flags. Returns null to fall through. Extracted verbatim. */
  private tryVisualCorrectFlags(opts: Option[]): number[] | null {
    const visualCorrectIndices = opts
      .map((opt, i) => (isOptionCorrect(opt) ? i + 1 : null))
      .filter((n): n is number => n !== null);
    if (visualCorrectIndices.length === 0) return null;
    return Array.from(new Set(visualCorrectIndices)).sort((a, b) => a - b);
  }

  /**
   * Pristine/answer correct-set resolution: gather correct texts/IDs from the
   * pristine question (then the provided question.answer), and match the live
   * options against them. Returns null to fall through. Extracted verbatim.
   */
  private resolveByCorrectSets(
    question: QuizQuestion, opts: Option[], qIdx: number, targetQuestionText: string,
    isSingleChoice: boolean, lowerExpContent: string, qTextNormFull: string
  ): number[] | null {
    let { correctTexts, correctIds } = this.resolvePristineCorrectSets(question, qIdx, targetQuestionText);
    if (correctTexts.size === 0 && correctIds.size === 0) {
      ({ correctTexts, correctIds } = this.collectAnswerCorrectSets(question));
    }
    return this.matchOptionsToCorrectSets(opts, correctTexts, correctIds, isSingleChoice, lowerExpContent, qTextNormFull);
  }

  /**
   * Attempt 1: pristine correct texts/IDs from QuizService (shuffle-mapped, with
   * a question-text fallback and a strict text-match verification to avoid
   * cross-question mixups). Extracted verbatim.
   */
  private resolvePristineCorrectSets(question: QuizQuestion, qIdx: number, targetQuestionText: string): {
    correctTexts: Set<string>; correctIds: Set<string | number>;
  } {
    try {
      const quizSvc = this.injector.get(QuizService, null);
      const shuffleSvc = this.injector.get(QuizShuffleService, null);
      const resolvedQuizId = quizSvc?.quizId || this.activatedRoute.snapshot.paramMap.get('quizId') || 'dependency-injection';
      if (quizSvc && shuffleSvc && typeof qIdx === 'number' && resolvedQuizId) {
        const pristine = this.findPristineQuestion(quizSvc, shuffleSvc, resolvedQuizId, qIdx, targetQuestionText);
        if (pristine) {
          return this.extractPristineCorrectSets(pristine, question, targetQuestionText);
        }
      }
    } catch (err: unknown) {
      console.error('ExplanationFormatterService.formatExplanation pristine correct-answer lookup failed:', err);
    }
    return { correctTexts: new Set<string>(), correctIds: new Set<string | number>() };
  }

  /** Resolve the pristine question via the shuffle map, then a question-text fallback. Extracted verbatim. */
  private findPristineQuestion(
    quizSvc: any, shuffleSvc: any, resolvedQuizId: string, qIdx: number, targetQuestionText: string
  ): QuizQuestion | null {
    const origIdx = shuffleSvc.toOriginalIndex(resolvedQuizId, qIdx);
    let pristine: QuizQuestion | null = (origIdx !== null) ? quizSvc.getPristineQuestion(origIdx) : null;
    // ROBUSTNESS FIX: find origIdx by question text if mapping fails.
    if (!pristine && targetQuestionText) {
      const canonical = quizSvc.quizDataLoader.getCanonicalQuestions(resolvedQuizId);
      const foundIdx = canonical.findIndex((q: QuizQuestion) => this.normalizeLocalText(q.questionText) === this.normalizeLocalText(targetQuestionText));
      if (foundIdx !== -1) pristine = canonical[foundIdx];
    }
    return pristine;
  }

  /**
   * Extract correct texts/IDs from a pristine question, but only after a strict
   * question-text match (loose .includes() mixed Q5/Q6). Extracted verbatim.
   */
  private extractPristineCorrectSets(pristine: QuizQuestion, question: QuizQuestion, targetQuestionText: string): {
    correctTexts: Set<string>; correctIds: Set<string | number>;
  } {
    const correctTexts = new Set<string>();
    const correctIds = new Set<string | number>();
    const pristineText = this.normalizeLocalText(pristine.questionText);
    const currentText = this.normalizeLocalText(question?.questionText || targetQuestionText);
    if (pristineText !== currentText) return { correctTexts, correctIds };

    // Check both answer (if populated) and options (standard raw data).
    const correctPristine = [
      ...(Array.isArray(pristine.answer) ? (pristine.answer as any[]) : []),
      ...(Array.isArray(pristine.options) ? (pristine.options as any[]).filter((o: any) => o.correct) : [])
    ];
    for (const a of correctPristine) {
      if (a) this.addCorrectEntry(a, correctTexts, correctIds);
    }
    return { correctTexts, correctIds };
  }

  /** Attempt 2: correct texts/IDs from the provided question.answer. Extracted verbatim. */
  private collectAnswerCorrectSets(question: QuizQuestion): { correctTexts: Set<string>; correctIds: Set<string | number> } {
    const correctTexts = new Set<string>();
    const correctIds = new Set<string | number>();
    const answers = question?.answer || [];
    if (Array.isArray(answers) && answers.length > 0) {
      for (const a of answers) {
        if (a) this.addCorrectEntry(a, correctTexts, correctIds);
      }
    }
    return { correctTexts, correctIds };
  }

  /** Add one correct entry's normalized text and optionId(s) into the sets. Extracted verbatim. */
  private addCorrectEntry(a: any, correctTexts: Set<string>, correctIds: Set<string | number>): void {
    const normd = this.normalizeLocalText(a.text);
    if (normd) correctTexts.add(normd);
    if (a.optionId !== undefined) {
      correctIds.add(a.optionId);
      correctIds.add(Number(a.optionId));
    }
  }

  /**
   * Match the live options against the correct texts/IDs (text first, then ID),
   * then for single-choice with multiple matches narrow by explanation keyword,
   * visual flag, or the first index. Returns null to fall through. Extracted verbatim.
   */
  private matchOptionsToCorrectSets(
    opts: Option[], correctTexts: Set<string>, correctIds: Set<string | number>,
    isSingleChoice: boolean, lowerExpContent: string, qTextNormFull: string
  ): number[] | null {
    if (correctTexts.size === 0 && correctIds.size === 0) return null;
    const indices = this.mapOptionsToCorrectIndices(opts, correctTexts, correctIds);
    if (indices.length === 0) return null;

    let result = Array.from(new Set(indices)).sort((a, b) => a - b);
    if (isSingleChoice && result.length > 1) {
      result = this.narrowSingleChoiceResult(result, opts, lowerExpContent, qTextNormFull);
    }
    return result;
  }

  /** Map options to 1-based indices by correct text (priority 1), then correct ID (priority 2). Extracted verbatim. */
  private mapOptionsToCorrectIndices(opts: Option[], correctTexts: Set<string>, correctIds: Set<string | number>): number[] {
    return opts
      .map((option, idx) => {
        if (!option) return null;
        const normalizedInput = this.normalizeLocalText(option.text);
        // PRIORITY 1: Match by TEXT (stable across ID reassignments).
        if (correctTexts.size > 0 && normalizedInput && correctTexts.has(normalizedInput)) {
          return idx + 1;
        }
        // PRIORITY 2: Match by ID (only if text matching didn't find anything).
        if (correctTexts.size === 0) {
          const oid = option.optionId !== undefined ? Number(option.optionId) : null;
          if (oid !== null && correctIds.has(oid)) return idx + 1;
        }
        return null;
      })
      .filter((n): n is number => n !== null);
  }

  /**
   * Narrow a multi-index single-choice result to one: explanation-keyword match,
   * then visual correct flag, then the first index (with the parked Q5 hotfix).
   * Extracted verbatim.
   */
  private narrowSingleChoiceResult(result: number[], opts: Option[], lowerExpContent: string, qTextNormFull: string): number[] {
    // Priority 1: pick the one that appears in the explanation.
    const matchingExplanation = result.filter(idx => {
      const text = (opts[idx - 1]?.text ?? '').toLowerCase();
      return text.length > 2 && lowerExpContent.includes(text);
    });
    if (matchingExplanation.length === 1) {
      return matchingExplanation;
    }
    // Priority 2: filter by visual 'correct' flags.
    const verified = result.filter(idx => isOptionCorrect(opts[idx - 1]));
    if (verified.length === 1) {
      return verified;
    }
    if (result.includes(2) && qTextNormFull.includes('injection occur')) {
      // Specific Q5 Hotfix: Option 2 (constructor) is the truth   result = [2];
      return result;
    }
    return [result[0]];
  }

  /** Attempt 4: simple visual scan of the provided options. Always returns (possibly empty). Extracted verbatim. */
  private tryQuickVisualScan(opts: Option[]): number[] {
    const quickVisual = opts
      .map((o, idx) => (isOptionCorrect(o) ? idx + 1 : null))
      .filter((n): n is number => n !== null);
    if (quickVisual.length > 0) {
      return Array.from(new Set(quickVisual)).sort((a, b) => a - b);
    }
    return [];
  }

  // Lowercases only the first letter of the leading word, leaving acronyms and
  // camelCase/PascalCase identifiers (OnPush, RxJS, TypeScript, HTTP) untouched so
  // the FET reads naturally after "… correct because" without corrupting a name.
  private lowercaseLead(text: string): string {
    const m = (text ?? '').match(/^(\s*)(\S+)([\s\S]*)$/);
    if (!m) return text;
    const [, ws, word, tail] = m;
    const first = word.charAt(0);
    if (first < 'A' || first > 'Z') return text;   // first char isn't an uppercase letter
    if (/[A-Z]/.test(word.slice(1))) return text;  // internal caps -> identifier/acronym
    return ws + first.toLowerCase() + word.slice(1) + tail;
  }

  formatExplanation(
    question: QuizQuestion,
    correctOptionIndices: number[] | null | undefined,
    explanation: string,
    _displayIndex?: number
  ): string {
    const alreadyFormattedRe =
      /^(?:option|options)\s+#?\d+(?:\s*,\s*#?\d+)*(?:\s+and\s+#?\d+)?\s+(?:is|are)\s+correct\s+because\s+/i;

    let e = (explanation ?? '').trim();
    if (!e) return '';

    // If it's already formatted, strip the prefix so we can re-format with potentially better indices
    if (alreadyFormattedRe.test(e)) {
      const parts = e.split(/ because /i);
      if (parts.length > 1) e = parts.slice(1).join(' because ').trim();
    }

    // Normalize incoming indices
    let indices: number[] = Array.isArray(correctOptionIndices)
      ? correctOptionIndices.slice() : [];

    // Renumber to the PINNED display order ("All of the above" last) so the FET
    // "Option N" matches what the user sees. The passed indices are positions in
    // the (possibly shuffled) canonical order; remap each through the same pin
    // used for display. pinAllOfTheAboveLast is a no-op without an AOTA option,
    // so non-AOTA questions are unaffected. `pinnedOptions` is used for any
    // subsequent index→option lookups below so they stay consistent.
    const pinnedOptions = pinAllOfTheAboveLast(question?.options ?? [], (o) => o?.text);
    indices = indices.map((n) => pinnedIndex1Based(question?.options ?? [], n, (o) => o?.text));

    // Stabilize: dedupe + sort so multi-answer phrasing is consistent
    indices = Array.from(new Set(indices)).sort((a, b) => a - b);

    // DIAGNOSTIC: Log stack trace for Q1 to identify which caller produces wrong indices
    if (indices.length === 0) return e;

    // Body that follows the "… correct because" prefix: lowercase its leading
    // letter so the composed FET reads as one natural sentence.
    const eLead = this.lowercaseLead(e);

    // Multi-answer
    const qTextNorm = (question?.questionText ?? '').toLowerCase();
    const isExplicitMulti = qTextNorm.includes('all that apply') || qTextNorm.includes('select multiple');

    // Also detect multi-answer from actual data: if multiple correct flags exist, it IS multi-answer.
    const dataCorrectCount = (question?.options ?? []).filter(
      (o: any) => isOptionCorrect(o)
    ).length;
    const isDataMulti = dataCorrectCount > 1;

    if (indices.length > 1 && (question.type === QuestionType.MultipleAnswer || isExplicitMulti || isDataMulti)) {
      question.type = QuestionType.MultipleAnswer;

      const optionsText =
        indices.length > 2
          ? `${indices.slice(0, -1).join(', ')}, and ${indices.slice(-1)}`
          : indices.join(' and ');

      const result = `Options ${optionsText} are correct because ${eLead}`;
      return result;
    }

    // Single-answer (or fallback for multi-indices on a single-answer question)
    if (indices.length >= 1) {
      // STRATEGY: If it's a single-answer question but we have plural indices,
      // we MUST use the one that is supported by the explanation text.
      let targetIndex = indices[0];

      const qTextRef = (question?.questionText || '').toLowerCase();
      const isExplicitMultiRef = qTextRef.includes('apply') || qTextRef.includes('multiple');
      if (!isExplicitMultiRef && !isDataMulti && indices.length > 1) {
        const expLower = e.toLowerCase();
        const verified = indices.filter(idx => {
          const opt = pinnedOptions?.[idx - 1];
          const text = (opt?.text || '').toLowerCase();
          return text.length > 2 && expLower.includes(text);
        });
        if (verified.length === 1) targetIndex = verified[0];
      }

      question.type = QuestionType.SingleAnswer;
      // True/false questions (2 options whose correct answer is literally
      // "True"/"False") read as "The statement is true/false because ..." using
      // the correct option's value, instead of "Option N is correct because ...".
      // Only the displayed prefix changes; the question stays single-answer.
      const tfOpts = question?.options ?? [];
      const tfCorrect = String(tfOpts.find((o: any) => isOptionCorrect(o))?.text ?? '')
        .trim()
        .toLowerCase();
      const isTrueFalse = tfOpts.length === 2 && (tfCorrect === 'true' || tfCorrect === 'false');
      const result = isTrueFalse
        ? `The statement is ${tfCorrect} because ${eLead}`
        : `Option ${targetIndex} is correct because ${eLead}`;
      return result;
    }

    // Zero derived indices -> just return the explanation (no scolding)
    return e;
  }

  syncFormattedExplanationState(
    questionIndex: number,
    formattedExplanation: string
  ): void {
    this.formattedExplanations[questionIndex] = {
      questionIndex,
      explanation: formattedExplanation
    };
  }

  isQuestionValid(question: QuizQuestion): boolean {
    return (
      !!question &&
      !!question.questionText &&
      !this.processedQuestions.has(question.questionText)
    );
  }

  buildQuestionKey(
    questionText: string | null | undefined,
    index?: number
  ): string | null {
    const normalizedText = (questionText ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');

    if (!normalizedText && (index === undefined || index < 0)) return null;

    const indexPart = typeof index === 'number' && index >= 0 ? `|${index}` : '';
    return `${normalizedText}${indexPart}`;
  }

  resetProcessedQuestionsState(): void {
    this.processedQuestions = new Set<string>();
  }

  resetFormatterState(): void {
    this.fetByIndex.clear();
    this.lockedFetIndices.clear();
    this.formattedExplanations = {};
    this.formattedExplanationByQuestionText.clear();
    this.formattedExplanationSig.set('');
    this.processedQuestions = new Set<string>();
    this.explanationsInitializedSig.set(false);
  }

  // Exposed so the facade (ExplanationTextService) can provide it to emitFormatted guardrail
  public latestExplanationIndex: number | null = -1;

  /**
   * Validates FET prefix option numbers against visual data and corrects if needed.
   * Used by emitFormatted in ExplanationTextService to ensure correctness before emission.
   */
  public validateAndCorrectFetPrefix(
    trimmed: string,
    index: number
  ): string {
    try {
      const alreadyFormattedRe =
        /^(?:option|options)\s+#?\d+(?:\s*,\s*#?\d+)*(?:\s+and\s+#?\d+)?\s+(?:is|are)\s+correct\s+because\s+/i;
      const prefixMatch = trimmed.match(
        /^(?:option|options)\s+([^]*?)\s+(?:is|are)\s+correct\s+because\s+/i
      );
      if (prefixMatch?.[1]) {
        const prefixNums = (prefixMatch[1].match(/\d+/g) || []).map(Number).filter(n => n > 0);
        if (prefixNums.length > 0) {
          const quizSvc = this.injector.get(QuizService, null);

          if (quizSvc) {
            const shuffledQs = quizSvc.shuffledQuestions;
            const isShuffled = quizSvc.isShuffleEnabled?.() ?? false;
            const questions = isShuffled && shuffledQs?.length > 0
              ? shuffledQs : quizSvc.questions;
            const qData = Array.isArray(questions) ? questions[index] : null;
            if (qData?.options?.length > 0) {
              const normalize = (s: unknown): string =>
                String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
                  .replace(/\u00A0/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
              const answerTexts = new Set<string>();
              for (const a of (qData.answer ?? [])) {
                const n = normalize((a as any)?.text);
                if (n) answerTexts.add(n);
              }
              let visualIndices: number[] = [];
              if (answerTexts.size > 0) {
                visualIndices = qData.options
                  .map((o: any, i: number) => answerTexts.has(normalize(o?.text)) ? i + 1 : null)
                  .filter((n: number | null): n is number => n !== null);
              }
              if (visualIndices.length === 0) {
                visualIndices = qData.options
                  .map((o: any, i: number) => isOptionCorrect(o) ? i + 1 : null)
                  .filter((n: number | null): n is number => n !== null);
              }
              if (visualIndices.length > 0) {
                const sortedPrefix = [...prefixNums].sort((a, b) => a - b);
                const sortedVisual = [...visualIndices].sort((a, b) => a - b);
                const matches = sortedPrefix.length === sortedVisual.length &&
                  sortedPrefix.every((n, i) => n === sortedVisual[i]);
                if (!matches) {                  let raw = trimmed.replace(alreadyFormattedRe, '').trim();
                  if (!raw) raw = trimmed;
                  return this.formatExplanation(
                    qData, sortedVisual, raw, index
                  );
                }
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      console.error('ExplanationFormatterService.storeFormattedExplanation validation failed:', err);
    }
    return trimmed;
  }
}
