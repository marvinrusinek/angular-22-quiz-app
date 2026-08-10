import {
  allCorrectSelectedFromVerdict,
  selectedVerdictFor,
  verdictStateForDisplayIndex
} from '../services/features/verdict/authorized-correctness';
import { withCorrectCountBanner } from './correct-count-banner';
import { HeadingInputs } from './heading-model';
import { withTerminalPeriod } from './terminal-period';
import { norm } from './text-norm';

/**
 * Shared gatherer for the heading model's inputs (Phase 3 step 1).
 *
 * Both the dev-only shadow validator (heading-shadow.ts) and the component's
 * reactive `headingHtml` computed call this, so the shadow's validated agreement
 * with the live heading transfers directly to the computed — they read the exact
 * same state. Kept dependency-light (services typed loosely) to avoid import
 * cycles; the callers pass their real, typed service instances.
 */
export interface HeadingInputDeps {
  idx: number;
  quizService: any;
  explanationTextService: any;
  timerService: any;
  selectedOptionService: any;
  quizStateService: any;
  quizNavigationService: any;
  quizQuestionManagerService: any;
  // Optional so existing callers keep working; when present and 'deferred'
  // (Interview Mode) the heading is forced to the question text.
  feedbackPolicyService?: any;
  /**
   * The correctness authority. Optional so callers that predate it still work,
   * but when present it decides BOTH whether the FET may show and what it says.
   */
  questionVerdictService?: any;
}

/**
 * Build the HeadingInputs for a display index from live service state. Returns
 * null when there is no displayed question for the index (caller should skip).
 */
export function buildHeadingInputs(d: HeadingInputDeps): HeadingInputs | null {
  const { idx } = d;
  const dq = d.quizService.getQuestionsInDisplayOrder?.()?.[idx];   // shuffle-aware
  if (!dq) {
    return null;
  }

  const qText = dq.questionText ?? '';
  const pristine = Array.from(d.quizService.getPristineCorrectTextsForQuestion?.(qText) ?? [])
    .map((t: any) => norm(t));
  const selectedTexts = new Set<string>(
    ((((d.selectedOptionService as any).selectedOptionsMap?.get?.(idx)) ?? []) as any[])
      .filter((o) => o?.selected !== false)
      .map((o) => norm(o?.text))
  );
  const isMultiAnswer = pristine.length > 1;
  const selectedCorrect = pristine.filter((t) => selectedTexts.has(t));
  const ets = d.explanationTextService;

  // ── The authority for showing an explanation ─────────────────────
  //
  // Whether the FET may appear, and what it says, both come from the verdict.
  // Previously both were derived from the local bank: completion by comparing
  // the user's picks against pristine correct texts, and the text itself from
  // the formatter's read of `question.explanation`. That made the answer key
  // the thing deciding when the user had earned the answer key.
  //
  // The verdict only carries an explanation once it is terminal, so there is
  // nothing to disclose early even if the local bank is sitting right there.
  const verdict = verdictStateForDisplayIndex(d.quizService, idx, d.questionVerdictService);
  const verdictComplete = allCorrectSelectedFromVerdict(verdict);
  const authorizedExplanation =
    verdict && (verdict.phase === 'resolved' || verdict.phase === 'expired')
      ? (verdict.explanation ?? '')
      : '';

  // Single-answer "answered correctly", from the user's OWN verdicted pick
  // rather than by matching their selection against the pristine correct set.
  // `idle` means nothing has been checked, so the old comparison still stands.
  const selectedCorrectFromAuthority =
    verdict && verdict.phase !== 'idle'
      ? [...selectedTexts].filter((t) => selectedVerdictFor(verdict, t) === true).length
      : selectedCorrect.length;

  // Compose the multi-answer "(N answers are correct)" banner into the question
  // markup, byte-identical to the legacy buildQuestionDisplay path (same helper +
  // formatter). Required now that the computed drives the DOM directly: without
  // this the banner span is missing in single-source mode.
  let questionHtml = qText;
  const totalOpts = (dq.options?.length ?? 0);
  if (isMultiAnswer && totalOpts > 0) {
    const banner = d.quizQuestionManagerService.getNumberOfCorrectAnswersText(pristine.length, totalOpts);
    questionHtml = withCorrectCountBanner(qText, banner);
  }

  // End the FET with a period when it has none (any source below). Normalized
  // here, at the single display read point, so it applies no matter which store
  // (formattedExplanations / fetByIndex / timeoutFetByIndex) supplied it.
  // WORDING is still the formatter's job; AUTHORIZATION is the verdict's.
  //
  // The two are not interchangeable. The verdict carries the bank's raw
  // explanation ("using #name=... are the two steps to display a validation
  // error"), while what the user reads is composed — the formatter prefixes it
  // with which options were correct ("map and filter are correct because ...").
  // Preferring the verdict's text here swapped composed prose for raw prose and
  // changed six E2E expectations, which is a UX change this migration must not
  // make.
  //
  // So these stores supply the words, and the gates below decide whether the
  // words may be shown at all. Composing the authorized explanation is the next
  // step of the explanation-pipeline migration, not this one.
  const _fetHtml = withTerminalPeriod(
    (ets.formattedExplanations?.[idx]?.explanation ?? '')
      || (ets.fetByIndex?.get?.(idx) ?? '')
      || (ets.timeoutFetByIndex?.get?.(idx) ?? '')   // durable timeout FET (purge-proof)
      // Last resort: the verdict's own raw explanation, so an authorized reveal
      // is never silently blank when the formatter has not run.
      || authorizedExplanation
  );
  return {
    questionHtml,
    fetHtml: _fetHtml,
    isMultiAnswer,
    // Completion decides when a multi-answer question earns its explanation.
    // The verdict answers it from the user's own selections plus the count of
    // correct options still outstanding — never from which unselected options
    // are correct. Falls back to the pristine comparison only while no verdict
    // has been recorded (idle), which is also the only time it cannot lie.
    isMultiAnswerComplete:
      verdictComplete !== null
        ? verdictComplete
        : (pristine.length > 0 && selectedCorrect.length >= pristine.length)
          || d.quizService.multiAnswerCompletion?.get?.(idx) === true
          || ets.fetBypassForQuestion?.get?.(idx) === true,
    isSingleAnswered: !isMultiAnswer && selectedCorrectFromAuthority > 0,
    isTimedOut: d.timerService.expiredForQuestionIndexSig?.() === idx,
    hasInteracted: d.quizStateService.hasUserInteracted?.(idx) === true,
    optionsReady: typeof document !== 'undefined'
      && document.querySelectorAll('.option-row').length > 0,
    isNavigatingToPrevious: d.quizNavigationService.isNavigatingToPreviousSig?.() === true,
    interactedThisVisit: d.quizStateService.wasInteractedThisVisit?.(idx) === true,
    deferFeedback: d.feedbackPolicyService?.feedbackMode?.() === 'deferred',
  };
}
