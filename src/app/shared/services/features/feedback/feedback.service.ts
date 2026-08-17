import { forwardRef, inject, Service, Injector } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { QUESTION_ROUTE_REGEX } from '../../../constants/route-patterns';
import { pinAllOfTheAboveLast, pinnedIndex1Based } from '../../../utils/all-of-the-above';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

@Service()
export class FeedbackService {
  // ── injects ─────────────────────────────────────────────────────
  // ExplanationTextService is forwardRef'd to preserve the circular-DI
  // workaround the original constructor used (FeedbackService is consumed
  // by Quiz/FET/explanation pipelines that can resolve in either order).
  private readonly explanationTextService = inject<ExplanationTextService>(
    forwardRef(() => ExplanationTextService) as any
  );
  private readonly injector = inject(Injector);
  private readonly selectedOptionService = inject(SelectedOptionService);

  public generateFeedbackForOptions(
    _correctOptions: Option[],
    optionsToDisplay: Option[]
  ): string {
    const validOptionsToDisplay = (optionsToDisplay || []).filter(opt => opt && typeof opt === 'object');

    if (validOptionsToDisplay.length === 0) return 'Feedback unavailable.';

    const correctFeedback = this.setCorrectMessage(validOptionsToDisplay);
    if (!correctFeedback?.trim()) return 'Feedback unavailable.';

    return correctFeedback;
  }

  public buildFeedbackMessage(
    question: QuizQuestion,
    selected: Array<SelectedOption | Option> | null,
    _strict: boolean = false,
    timedOut: boolean = false,
    displayIndex?: number,
    optionsToDisplay?: Option[],
    targetOption?: Option
  ): string {
    if (timedOut) return '';

    // URL-authoritative early exit: reconcile recorded clicks against the URL
    // question's correct options; a clean win returns "You're right!" directly.
    const _urlShortCircuit = this.tryUrlAuthoritativeShortCircuit(selected, targetOption);
    if (_urlShortCircuit !== null) return _urlShortCircuit;

    const quizSvc = this.injector.get(QuizService, null);
    const currentIndex = quizSvc?.currentQuestionIndex;

    // Resolve the canonical question the user is actually on (callers may pass a
    // stale `question` object) so feedback option numbers reflect it.
    const { resolvedQuestion, resolvedIdx } = this.resolveCanonicalQuestion(question, optionsToDisplay, quizSvc);

    const idxForLookup = resolvedIdx >= 0
      ? resolvedIdx
      : (typeof displayIndex === 'number' && displayIndex >= 0
        ? displayIndex
        : (typeof currentIndex === 'number' ? currentIndex : undefined));

    let correctIndices = this.computeCorrectIndices(question, resolvedQuestion, idxForLookup, quizSvc);

    const optionsRaw = optionsToDisplay || (question.options || []);

    // Prefer the resolved question's options as the truth source (optionsToDisplay
    // can carry stale `correct` flags from a prior render), then cross-validate.
    const truthOptions: Option[] = (resolvedQuestion?.options?.length
      ? resolvedQuestion.options
      : optionsRaw) as Option[];
    correctIndices = this.crossValidateCorrectIndices(correctIndices, truthOptions);

    // ── UNKNOWN IS NOT WRONG ─────────────────────────────────────────
    //
    // Empty means nobody has said which options are correct: the verdict is
    // still `checking` (or idle/error) and, since questions come from
    // `/questions`, there are no `correct` flags to fall back on.
    //
    // Every branch below treats "not in correctIndices" as WRONG, so an empty
    // set made a correct click render "Not this one, try again!" — on the very
    // click whose answer was still in flight. The local key used to hide this
    // by answering instantly.
    //
    // A blank message is the honest transient state, and the component
    // recomputes when the terminal verdict lands. Deliberately NOT
    // reconstructed from `quizInitialState` or the pristine sets.
    if (correctIndices.length === 0) {
      return '';
    }

    const isMultiMode =
      correctIndices.length > 1 ||
      question.type === QuestionType.MultipleAnswer ||
      (question as any).multipleAnswer === true;

    const { numCorrectSelected, numIncorrectSelected, dedupedSelected } =
      this.countSelectedCorrectness(selected, optionsRaw, correctIndices, resolvedQuestion, quizSvc, isMultiMode, targetOption, idxForLookup);

    const totalCorrectRequired = correctIndices.length > 0 ? correctIndices.length : 1;
    // Resolved ONLY when every correct option is selected AND no incorrect option
    // is selected. Selecting any wrong option must yield "Not this one, try
    // again!", never the win — even if all correct options are also selected (or
    // a transient all-selected render inflates the correct count).
    const isMultiResolved = isMultiMode
      && numCorrectSelected >= totalCorrectRequired
      && numIncorrectSelected === 0;
    if (isMultiResolved) return this.buildCorrectFeedback(correctIndices);

    if (!selected || dedupedSelected.length === 0) return '';

    if (isMultiMode) {
      return this.buildMultipleAnswerFeedback(
        targetOption, optionsRaw, correctIndices,
        numCorrectSelected, numIncorrectSelected, totalCorrectRequired
      );
    }
    return this.buildSingleAnswerFeedback(numCorrectSelected, numIncorrectSelected, correctIndices);
  }

  /**
   * URL-AUTHORITATIVE EARLY-EXIT: on /question/{quizId}/{N}, reconcile every
   * recorded click (targetOption, the selected array, the selection service)
   * against the URL question's correct options. Single-answer: any one correct
   * match wins. Multi-answer: all correct selected with zero incorrect. Returns
   * the "You're right!" message, or null to fall through. Extracted verbatim.
   */
  private tryUrlAuthoritativeShortCircuit(
    selected: Array<SelectedOption | Option> | null,
    targetOption?: Option
  ): string | null {
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        const quizSvcEarly: any = this.injector.get(QuizService, null);
        // SHUFFLE-AWARE: urlIdx is a DISPLAY index. Indexing the raw `questions`
        // array (original order) by it resolves the wrong question in shuffled
        // mode, so the correct/incorrect text sets below would be for a different
        // question — making an incorrect pick go unrecognized and firing a
        // premature "You're right!". Resolve the displayed question instead.
        const urlQ: any = quizSvcEarly?.getDisplayedQuestion?.(urlIdx)
          ?? (quizSvcEarly?.questions ?? [])[urlIdx];
        const urlOpts: any[] = urlQ?.options ?? [];
        if (urlOpts.length > 0) {
          const { correctIdxsURL, correctTextsURL, allTextsURL } = this.buildUrlCorrectSets(urlOpts);

          if (correctTextsURL.size > 0) {
            const candidateTexts = this.gatherUrlCandidateTexts(selected, targetOption, urlIdx, quizSvcEarly);

            const isMultiURL = correctTextsURL.size > 1;
            let candidateCorrect = 0;
            let candidateIncorrect = 0;
            for (const t of candidateTexts) {
              if (correctTextsURL.has(t)) candidateCorrect++;
              else if (allTextsURL.has(t)) candidateIncorrect++;
            }

            const allCorrectChosen = candidateCorrect >= correctTextsURL.size;
            const noIncorrectChosen = candidateIncorrect === 0;

            const shouldShortCircuit = isMultiURL
              ? (allCorrectChosen && noIncorrectChosen)
              : (candidateCorrect >= 1);

            if (shouldShortCircuit) {
              return this.buildCorrectFeedback(correctIdxsURL);
            }
          }
        }
      }
    } catch { /* non-browser env */ }
    return null;
  }

  /** Build the URL question's correct-index set, correct-text set, and all-text set. Extracted verbatim. */
  private buildUrlCorrectSets(urlOpts: any[]): { correctIdxsURL: number[]; correctTextsURL: Set<string>; allTextsURL: Set<string> } {
    const correctIdxsURL: number[] = [];
    const correctTextsURL = new Set<string>();
    const allTextsURL = new Set<string>();
    for (const [i, o] of urlOpts.entries()) {
      const text = norm(o?.text);
      if (text) allTextsURL.add(text);
      if (isOptionCorrect(o)) {
        correctIdxsURL.push(i + 1);
        if (text) correctTextsURL.add(text);
      }
    }
    return { correctIdxsURL, correctTextsURL, allTextsURL };
  }

  /**
   * Gather every candidate selected text for the URL question: the clicked
   * target, the passed selected array, and the live selection service.
   * Extracted verbatim.
   */
  private gatherUrlCandidateTexts(
    selected: Array<SelectedOption | Option> | null,
    targetOption: Option | undefined,
    urlIdx: number,
    quizSvcEarly: any
  ): Set<string> {
    const candidateTexts = new Set<string>();
    if (targetOption?.text) {
      candidateTexts.add(norm(targetOption.text));
    }
    for (const s of (selected ?? []) as any[]) {
      if (s?.text) candidateTexts.add(norm(s.text));
    }
    try {
      const liveSelections =
        quizSvcEarly?.selectedOptionService?.getSelectedOptionsForQuestion?.(urlIdx) ??
        this.selectedOptionService?.getSelectedOptionsForQuestion?.(urlIdx) ?? [];
      for (const s of liveSelections) {
        if (s?.text) candidateTexts.add(norm(s.text));
      }
    } catch { /* ignore */ }
    // Cross-visit union (live bindings ∪ first-visit snapshot): the live
    // selection service resets on navigation, so on a COMPLETING click made on
    // REVISIT it would miss the first-visit correct pick and the win message
    // ("You're right! …") would never fire. uiSelectedTexts remembers it.
    try {
      const uiTexts = this.selectedOptionService?.uiSelectedTextsForQuestion?.(urlIdx);
      if (uiTexts) for (const t of uiTexts) candidateTexts.add(norm(t));
    } catch { /* ignore */ }
    return candidateTexts;
  }

  /**
   * Resolve the canonical question the user is actually looking at: parse the
   * URL first (most reliable), then text-match the passed question against
   * quizService.questions[]. Extracted verbatim.
   */
  private resolveCanonicalQuestion(
    question: QuizQuestion,
    optionsToDisplay: Option[] | undefined,
    quizSvc: any
  ): { resolvedQuestion: QuizQuestion; resolvedIdx: number } {
    let resolvedQuestion: QuizQuestion = question ?? {
      questionText: '', options: optionsToDisplay ?? [], explanation: '',
      type: QuestionType.SingleAnswer
    };
    let resolvedIdx = -1;
    try {
      const allQs: QuizQuestion[] = quizSvc?.questions ?? [];

      try {
        const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
        if (m) {
          const urlIdx = Number(m[1]) - 1;
          // SHUFFLE-AWARE: resolve the DISPLAYED question at this display index so
          // the correct-option numbers in the feedback match the order the user
          // sees. allQs (original order) indexed by a display index is the wrong
          // question once questions/options are shuffled.
          const displayedQ: QuizQuestion = quizSvc?.getDisplayedQuestion?.(urlIdx) ?? allQs[urlIdx];
          if (urlIdx >= 0 && displayedQ?.options?.length) {
            resolvedIdx = urlIdx;
            resolvedQuestion = displayedQ;
          }
        }
      } catch { /* non-browser env */ }

      // Fallback: text-match the passed question (legacy behaviour).
      if (resolvedIdx < 0) {
        const passedText = norm(question?.questionText);
        if (passedText && allQs.length) {
          resolvedIdx = allQs.findIndex(
            (q) => norm(q?.questionText) === passedText
          );
          if (resolvedIdx >= 0 && allQs[resolvedIdx]?.options?.length) {
            resolvedQuestion = allQs[resolvedIdx];
          }
        }
      }
    } catch {}
    return { resolvedQuestion, resolvedIdx };
  }

  /**
   * Compute the 1-based correct option indices: prefer the canonical question's
   * own correct flags, then ExplanationTextService, then a text-match against
   * quizService questions. Extracted verbatim.
   */
  private computeCorrectIndices(
    question: QuizQuestion,
    resolvedQuestion: QuizQuestion,
    idxForLookup: number | undefined,
    quizSvc: any
  ): number[] {
    let correctIndices: number[] = [];
    const canonicalOpts: Option[] = (resolvedQuestion?.options ?? []) as Option[];
    for (const [i, o] of canonicalOpts.entries()) {
      if (isOptionCorrect(o)) correctIndices.push(i + 1);
    }
    if (correctIndices.length === 0) {
      correctIndices = this.explanationTextService.getCorrectOptionIndices(
        resolvedQuestion,
        canonicalOpts,
        idxForLookup
      );
    }

    if ((!correctIndices || correctIndices.length === 0) && quizSvc) {
      const qText = norm(question.questionText);
      if (qText) {
        const allQuestions = (quizSvc as any)._questions || quizSvc.questions || [];
        const sourceQ = allQuestions.find(
          (q: QuizQuestion) => norm(q.questionText) === qText
        );
        if (sourceQ?.options) {
          const foundIndices = sourceQ.options
            .map((o: Option, i: number) =>
              isOptionCorrect(o) ? i + 1 : null
            )
            .filter((n: number | null): n is number => n !== null);
          if (foundIndices.length > 0) correctIndices = foundIndices;
        }
      }
    }
    return correctIndices;
  }

  /**
   * GUARDRAIL: cross-validate the computed correct indices against the visual
   * correct flags of the truth options; on mismatch trust the visual flags.
   * Extracted verbatim.
   */
  private crossValidateCorrectIndices(correctIndices: number[], truthOptions: Option[]): number[] {
    if (truthOptions.length > 0) {
      const visualCorrect = truthOptions
        .map((o: Option, i: number) => isOptionCorrect(o) ? i + 1 : null)
        .filter((n: number | null): n is number => n !== null);

      if (visualCorrect.length > 0) {
        const sortedCalc = [...correctIndices].sort((a, b) => a - b);
        const sortedVisual = [...visualCorrect].sort((a, b) => a - b);
        const match = sortedCalc.length === sortedVisual.length &&
          sortedCalc.every((n, i) => n === sortedVisual[i]);

        if (!match) return visualCorrect;
      }
    }
    return correctIndices;
  }

  /**
   * Count the user's correct/incorrect selections (deduped, canonical-text
   * matched) and, for multi-answer, cross-check against the raw options.
   * Returns the counts plus the deduped selection list. Extracted verbatim.
   */
  private countSelectedCorrectness(
    selected: Array<SelectedOption | Option> | null,
    optionsRaw: Option[],
    correctIndices: number[],
    resolvedQuestion: QuizQuestion,
    quizSvc: any,
    isMultiMode: boolean,
    targetOption?: Option,
    displayIndex?: number
  ): { numCorrectSelected: number; numIncorrectSelected: number; dedupedSelected: any[] } {
    const dedupedSelected = this.dedupeSelected(selected);
    const canonicalOptionsForMatch = this.resolveCanonicalOptionsForMatch(quizSvc, resolvedQuestion);
    let { numCorrectSelected, numIncorrectSelected } =
      this.evaluateSelectionCounts(dedupedSelected, optionsRaw, correctIndices, canonicalOptionsForMatch);
    if (isMultiMode && optionsRaw.length > 0) {
      ({ numCorrectSelected, numIncorrectSelected } =
        this.crossCheckMultiCounts(
          optionsRaw, targetOption, numCorrectSelected, numIncorrectSelected, correctIndices, displayIndex
        ));
    }

    // ── THE AUTHORITATIVE COUNT, LAST WORD ───────────────────────────
    //
    // Everything above counts from the per-click `selected` array (plus a
    // reconciliation pass over the option objects). On a REVISIT that array
    // holds only THIS visit's click, so a question whose correct options were
    // chosen across two visits counted 1 instead of 3 and reported
    // "select 2 more" — while the app's own `/check` payload, sent moments
    // earlier, listed all three.
    //
    // Both authoritative facts are already in hand: WHICH options are correct
    // (`correctIndices`, resolved from `authorizedCorrectTexts`) and WHICH the
    // user has selected (`uiSelectedTextsForQuestion` — the same union
    // submitted to `/check`). Their intersection is the count.
    //
    // `Math.max` so this can only RAISE a count the earlier passes undercounted;
    // it never discards a selection they saw and this set does not. Nothing
    // here reads `option.correct` or the pristine key.
    const authoritative = this.authoritativeSelectionCounts(
      optionsRaw, correctIndices, displayIndex
    );
    if (authoritative) {
      numCorrectSelected = Math.max(numCorrectSelected, authoritative.correct);
      numIncorrectSelected = Math.max(numIncorrectSelected, authoritative.incorrect);
    }

    return { numCorrectSelected, numIncorrectSelected, dedupedSelected };
  }

  /**
   * Selected-correct / selected-incorrect from AUTHORIZED identity alone.
   *
   * Null when nothing is authorized yet, or when the app has no recorded
   * selection set for this question — both mean "cannot answer", never zero.
   *
   * Text identity throughout, normalized with the same `norm` the verdict
   * helpers use, and resolved against the options AS DISPLAYED, so shuffle
   * needs no special handling.
   */
  private authoritativeSelectionCounts(
    optionsRaw: Option[],
    correctIndices: number[],
    displayIndex?: number
  ): { correct: number; incorrect: number } | null {
    if (!correctIndices.length || displayIndex == null || displayIndex < 0) return null;

    const ui = this.selectedOptionService?.uiSelectedTextsForQuestion?.(displayIndex);
    if (!ui || ui.size === 0) return null;

    const correctTexts = new Set<string>();
    const allTexts = new Set<string>();
    for (const [i, option] of optionsRaw.entries()) {
      const t = norm(option?.text);
      if (!t) continue;
      allTexts.add(t);
      if (correctIndices.includes(i + 1)) correctTexts.add(t);
    }
    if (correctTexts.size === 0) return null;

    let correct = 0;
    let incorrect = 0;
    for (const text of ui) {
      if (correctTexts.has(text)) correct++;
      else if (allTexts.has(text)) incorrect++;
    }
    return { correct, incorrect };
  }

  /** Deduplicate the selected options by optionId (or text). Extracted verbatim. */
  private dedupeSelected(selected: Array<SelectedOption | Option> | null): any[] {
    const selectedArr = (selected ?? []) as any[];
    const normalizedSelected = new Map<string, any>();
    for (const sel of selectedArr) {
      const id = sel.optionId != null ? String(sel.optionId) : sel.text;
      if (id) normalizedSelected.set(id, sel);
    }
    return Array.from(normalizedSelected.values());
  }

  /**
   * Canonical options to text-match selections against: the URL question's
   * options (never mutated by gameplay), falling back to the resolved question.
   * Extracted verbatim.
   */
  private resolveCanonicalOptionsForMatch(quizSvc: any, resolvedQuestion: QuizQuestion): Option[] {
    let canonicalOptionsForMatch: Option[] = [];
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        // SHUFFLE-AWARE: text-match selections against the DISPLAYED question's
        // options. Indexing the raw `questions` array by a display index gives a
        // different question in shuffled mode, so a correct pick would be tallied
        // against the wrong correct-set and the "select N more" count comes out
        // wrong (or a correct pick reads as incorrect).
        const displayedQ: any = quizSvc?.getDisplayedQuestion?.(urlIdx);
        const allQs: any[] = quizSvc?.questions ?? [];
        const srcOpts: any[] = (displayedQ?.options?.length ? displayedQ.options : allQs[urlIdx]?.options) ?? [];
        if (urlIdx >= 0 && srcOpts.length) {
          canonicalOptionsForMatch = srcOpts as Option[];
        }
      }
    } catch { /* non-browser env */ }
    if (canonicalOptionsForMatch.length === 0) {
      canonicalOptionsForMatch = (resolvedQuestion?.options ?? []) as Option[];
    }
    return canonicalOptionsForMatch;
  }

  /**
   * Per-selection correctness tally: an option counts as correct via its own
   * flag, its visual position matching a correct index, or the canonical-by-text
   * lookup. Extracted verbatim.
   */
  private evaluateSelectionCounts(
    dedupedSelected: any[],
    optionsRaw: Option[],
    correctIndices: number[],
    canonicalOptionsForMatch: Option[]
  ): { numCorrectSelected: number; numIncorrectSelected: number } {
    let numCorrectSelected = 0;
    let numIncorrectSelected = 0;
    for (const sel of dedupedSelected) {
      let visualIdx = sel.displayIndex;
      if (visualIdx === undefined || visualIdx < 0) {
        visualIdx = optionsRaw.findIndex((o: Option) =>
          o === sel ||
          (o.optionId != null && sel.optionId != null && String(o.optionId) === String(sel.optionId)) ||
          (o.text && sel.text && String(o.text).trim() === String(sel.text).trim())
        );
      }

      // Canonical-by-text lookup survives bindings whose `correct: true` was
      // wiped after Q->Q->Q navigation.
      let canonicalCorrect = false;
      if (sel?.text && canonicalOptionsForMatch.length) {
        const selText = String(sel.text).trim();
        const match = canonicalOptionsForMatch.find(
          (o: Option) => o?.text && String(o.text).trim() === selText
        );
        if (match) canonicalCorrect = isOptionCorrect(match);
      }

      const isCorrect = isOptionCorrect(sel) ||
        (visualIdx >= 0 && correctIndices.includes(visualIdx + 1)) ||
        canonicalCorrect;

      if (isCorrect) {
        numCorrectSelected++;
      } else {
        numIncorrectSelected++;
      }
    }
    return { numCorrectSelected, numIncorrectSelected };
  }

  /**
   * Multi-answer cross-check: recount correct/incorrect directly from the raw
   * options (plus the just-clicked target), and adopt those counts when they
   * find MORE correct selections than the selection-array tally. Extracted verbatim.
   */
  private crossCheckMultiCounts(
    optionsRaw: Option[],
    targetOption: Option | undefined,
    numCorrectSelected: number,
    numIncorrectSelected: number,
    correctIndices: number[] = [],
    displayIndex?: number
  ): { numCorrectSelected: number; numIncorrectSelected: number } {
    // ── RECONCILIATION IS AUTHORIZED ─────────────────────────────────
    //
    // This exists for REVISITS: `selectedOptionsMap` holds only the current
    // visit's clicks, while the option objects keep `selected` across visits.
    // Recovering the true count therefore means classifying the SELECTED
    // options — and it did that with `isOptionCorrect(o)`.
    //
    // API-sourced options carry no `correct`, so every selected option counted
    // as INCORRECT, the recovery produced a lower number than the live count,
    // and a question with every correct option chosen still read
    // "select 1 more correct answer".
    //
    // `correctIndices` is the authorized identity already resolved upstream
    // (from `authorizedCorrectTexts`, matched against the DISPLAYED options and
    // expressed as 1-based display positions), so classifying by membership
    // reuses that single derivation rather than adding a second matcher — and
    // it is shuffle-correct for the same reason.
    const hasAuthorizedIdentity = correctIndices.length > 0;
    const isCorrectAt = (option: Option, index: number): boolean =>
      hasAuthorizedIdentity ? correctIndices.includes(index + 1) : isOptionCorrect(option);

    // CROSS-VISIT SELECTIONS. `o.selected` is rebuilt per visit, so on a REVISIT
    // the first visit's picks are absent from it and the recovery this method
    // exists to perform recovers nothing — a question with every correct option
    // chosen across two visits still read "select N more".
    //
    // `uiSelectedTextsForQuestion` is the union the rest of the revisit work
    // already relies on (bindings ∪ first-visit snapshot), and it is used a few
    // methods below for exactly this reason. Selection is the USER'S OWN
    // history, not answer-key material.
    const uiSelected = displayIndex != null
      ? (this.selectedOptionService?.uiSelectedTextsForQuestion?.(displayIndex) ?? null)
      : null;

    const isSelected = (option: Option): boolean =>
      option.selected === true
      || (!!uiSelected && !!option?.text && uiSelected.has(norm(option.text)));

    let rawCorrectSelected = 0;
    let rawIncorrectSelected = 0;
    for (const [i, o] of optionsRaw.entries()) {
      if (isSelected(o)) {
        if (isCorrectAt(o, i)) {
          rawCorrectSelected++;
        } else {
          rawIncorrectSelected++;
        }
      }
    }

    const targetIdx = targetOption
      ? optionsRaw.findIndex(o =>
          o === targetOption ||
          (o.optionId != null && targetOption.optionId != null
            && String(o.optionId) === String(targetOption.optionId)) ||
          (o.text && targetOption.text
            && String(o.text).trim() === String(targetOption.text).trim()))
      : -1;

    if (targetOption && targetOption.selected
        && (targetIdx >= 0 ? isCorrectAt(targetOption, targetIdx) : isOptionCorrect(targetOption))) {
      const alreadyCounted = optionsRaw.some((o, i) =>
        o.selected && isCorrectAt(o, i) &&
        ((o.text && targetOption.text && String(o.text).trim() === String(targetOption.text).trim()) ||
          (o.optionId != null && targetOption.optionId != null && String(o.optionId) === String(targetOption.optionId)))
      );
      if (!alreadyCounted) rawCorrectSelected++;
    }
    if (rawCorrectSelected > numCorrectSelected) {
      return { numCorrectSelected: rawCorrectSelected, numIncorrectSelected: rawIncorrectSelected };
    }
    return { numCorrectSelected, numIncorrectSelected };
  }

  /** Format the "The correct answer(s) is/are Option(s) …" reveal clause. Extracted verbatim. */
  private formatRevealMessage(indices: number[]): string {
    // The incoming indices are positions in the displayed (shuffled) question.
    // Renumber them to the pinned display order ("All of the above" last) so the
    // revealed "Option N" matches the visible position — an AOTA question always
    // reads Option 4. Resolved via the same displayed-question source the rest of
    // the numbering uses; no-op when there's no AOTA option.
    const pinned = this.toPinnedRevealIndices(indices);
    const deduped = Array.from(new Set(pinned)).sort((a, b) => a - b);
    if (deduped.length === 0) return '';
    if (deduped.length === 1) return `The correct answer is Option ${deduped[0]}.`;
    const list = `${deduped.slice(0, -1).join(', ')}${deduped.length > 2 ? ',' : ''} and ${deduped[deduped.length - 1]}`;
    return `The correct answers are Options ${list}.`;
  }

  /** Map 1-based reveal indices to the pinned (AOTA-last) display order. */
  private toPinnedRevealIndices(indices: number[]): number[] {
    try {
      const quizSvc: any = this.injector.get(QuizService, null);
      const idx = quizSvc?.currentQuestionIndex;
      const displayOpts: Option[] =
        (quizSvc?.getDisplayedQuestion?.(idx)?.options) ?? [];
      if (!displayOpts.length) return indices;
      return indices.map((n) => pinnedIndex1Based(displayOpts, n, (o: any) => o?.text));
    } catch {
      return indices;
    }
  }

  /** "You're right!" plus the reveal clause. Extracted verbatim (shared by every correct path). */
  private buildCorrectFeedback(correctIndices: number[]): string {
    return `You're right! ${this.formatRevealMessage(correctIndices)}`;
  }

  /** "That's correct! Please select N more correct answer(s)." Extracted verbatim. */
  private buildPartialFeedback(totalCorrectRequired: number, numCorrectSelected: number): string {
    const remainingTotal = Math.max(totalCorrectRequired - numCorrectSelected, 0);
    const remainingText = remainingTotal === 1
      ? '1 more correct answer'
      : `${remainingTotal} more correct answers`;
    return `That's correct! Please select ${remainingText}.`;
  }

  /** Is the just-clicked target option correct (by flag or by matched position)? Extracted verbatim. */
  private isTargetOptionCorrect(targetOption: Option, optionsRaw: Option[], correctIndices: number[]): boolean {
    const matchIdx = optionsRaw.findIndex(o =>
      o === targetOption ||
      (o.optionId != null && targetOption.optionId != null && String(o.optionId) === String(targetOption.optionId)) ||
      (o.text && targetOption.text && String(o.text).trim() === String(targetOption.text).trim())
    );
    return isOptionCorrect(targetOption) ||
      (matchIdx >= 0 && correctIndices.includes(matchIdx + 1));
  }

  /**
   * Multi-answer message: a clicked target option drives individual feedback
   * (correct → all-selected vs partial, else "not this one"); without a target
   * option fall back to the aggregate counts. Extracted verbatim.
   */
  private buildMultipleAnswerFeedback(
    targetOption: Option | undefined,
    optionsRaw: Option[],
    correctIndices: number[],
    numCorrectSelected: number,
    numIncorrectSelected: number,
    totalCorrectRequired: number
  ): string {
    if (targetOption) {
      if (this.isTargetOptionCorrect(targetOption, optionsRaw, correctIndices)) {
        if (numCorrectSelected >= totalCorrectRequired && numIncorrectSelected === 0) {
          return this.buildCorrectFeedback(correctIndices);
        }
        return this.buildPartialFeedback(totalCorrectRequired, numCorrectSelected);
      }
      return 'Not this one, try again!';
    }

    // Fallback/Legacy logic for when targetOption isn't provided
    if (numIncorrectSelected > 0) return 'Not this one, try again!';
    if (numCorrectSelected >= totalCorrectRequired) {
      return this.buildCorrectFeedback(correctIndices);
    }
    if (numCorrectSelected > 0) {
      return this.buildPartialFeedback(totalCorrectRequired, numCorrectSelected);
    }
    return 'Please select the correct answers to continue.';
  }

  /** Single-answer message: one correct with no incorrect → correct, else "not this one". Extracted verbatim. */
  private buildSingleAnswerFeedback(numCorrectSelected: number, numIncorrectSelected: number, correctIndices: number[]): string {
    if (numCorrectSelected >= 1 && numIncorrectSelected === 0) {
      return this.buildCorrectFeedback(correctIndices);
    }
    return 'Not this one, try again!';
  }

  public setCorrectMessage(
    optionsToDisplay?: Option[],
    question?: QuizQuestion
  ): string {
    if (!optionsToDisplay || optionsToDisplay.length === 0) {
      return 'Feedback unavailable.';
    }

    const quizSvc = this.injector.get(QuizService, null);
    const currentIndex = quizSvc?.currentQuestionIndex;
    // Resolve canonical question by text-match against quizService.questions[]
    let canonicalQ: QuizQuestion | undefined = question;
    try {
      const allQs: QuizQuestion[] = quizSvc?.questions ?? [];
      const passedText = norm(question?.questionText);
      if (passedText && allQs.length) {
        const idx = allQs.findIndex(q => norm(q?.questionText) === passedText);
        if (idx >= 0 && allQs[idx]?.options?.length) canonicalQ = allQs[idx];
      }
    } catch {}
    // Number options in the PINNED display order ("All of the above" last) so the
    // message matches what the user sees. pinAllOfTheAboveLast is a no-op when
    // there's no AOTA, so non-AOTA questions are unaffected.
    const directFromCanonical: number[] = [];
    for (const [i, o] of pinAllOfTheAboveLast(canonicalQ?.options ?? [], (o) => o?.text).entries()) {
      if (isOptionCorrect(o)) directFromCanonical.push(i + 1);
    }
    const indices = directFromCanonical.length > 0
      ? directFromCanonical
      : this.explanationTextService.getCorrectOptionIndices(question!, pinAllOfTheAboveLast(optionsToDisplay ?? [], (o) => o?.text), typeof currentIndex === 'number' ? currentIndex : undefined);
    const deduped = Array.from(new Set(indices)).sort((a, b) => a - b);
    if (deduped.length === 0) return 'No correct options found.';

    const optionsText = deduped.length === 1 ? 'answer is Option' : 'answers are Options';
    const optionStrings = deduped.length > 1
      ? `${deduped.slice(0, -1).join(', ')}${deduped.length > 2 ? ',' : ''} and ${deduped.slice(-1)}`
      : `${deduped[0]}`;

    return `The correct ${optionsText} ${optionStrings}.`;
  }
}