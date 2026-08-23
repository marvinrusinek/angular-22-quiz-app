import {
  allCorrectSelectedFromVerdict,
  selectedVerdictFor,
  verdictStateForDisplayIndex
} from '../services/features/verdict/authorized-correctness';
import { withCorrectCountBanner } from './correct-count-banner';
import { bannerCorrectCount, declaredIsMultiAnswer } from './question-type-authority';
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
  /**
   * Declared question metadata from `GET /questions` — the source of the
   * "(N answers are correct)" count. Optional so callers that predate it keep
   * working; absent means the banner simply does not render, which is the
   * correct fail-closed behaviour for a number nobody has authorized.
   */
  topicQuizTypeRegistry?: any;
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
  const selectedTexts = new Set<string>(
    ((((d.selectedOptionService as any).selectedOptionsMap?.get?.(idx)) ?? []) as any[])
      .filter((o) => o?.selected !== false)
      .map((o) => norm(o?.text))
  );
  // SINGLE-VS-MULTIPLE IS DECLARED, NOT COUNTED.
  //
  // This read `pristine.length > 1` — the bundled answer key — which made the
  // "(N answers are correct)" banner depend on the very asset the migration
  // removes. With an empty bank every question reads as single-answer, so the
  // banner silently vanishes even though `correctCount` has already been
  // fetched and is sitting unused. Counting also can't be right in principle:
  // a declared MULTIPLE question with one correct option is still multiple.
  //
  // `resolveIsMultiAnswer` is the existing authority helper — the declared
  // `type` wins, and the fallback is consulted only when nothing was declared,
  // which keeps quizzes playable while the type request is in flight.
  //
  // THE FALLBACK NO LONGER COUNTS THE BANK. It was `pristine.length > 1`, a
  // read of the bundled answer key. The registry describes the SAME quiz from
  // `/questions` and is already this function's authority for the banner count,
  // so it answers the identical question without the asset.
  //
  // UNKNOWN MUST NOT COLLAPSE TO SINGLE. When neither the stamped type nor the
  // registry knows, this keeps the question MULTI rather than single, and the
  // difference is not cosmetic: `isSingleAnswered` is `!isMultiAnswer && one
  // correct pick`, so calling an unknown question single-answer reveals its
  // explanation after a single correct click — disclosing the answer to a
  // multi-answer question the user has not finished. `heading-fet-authority`
  // pins exactly that. Treating unknown as multi withholds instead, which is
  // the safe direction: it can delay a FET, never leak one.
  const declaredMulti =
    declaredIsMultiAnswer(dq) ?? d.topicQuizTypeRegistry?.isMultiAnswer?.(qText) ?? null;
  const isMultiAnswer = declaredMulti !== false;
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

  // Single-answer "answered correctly", from the user's OWN verdicted pick.
  //
  // `idle` used to fall back to matching the selection against the pristine
  // correct set. That arm is gone with the bank, and it could only ever have
  // returned 0 in practice: `idle` means no check has been submitted, and a
  // selection submits one — so there is nothing selected for it to match.
  const selectedCorrectFromAuthority =
    verdict && verdict.phase !== 'idle'
      ? [...selectedTexts].filter((t) => selectedVerdictFor(verdict, t) === true).length
      : 0;

  // Compose the multi-answer "(N answers are correct)" banner into the question
  // markup, byte-identical to the legacy buildQuestionDisplay path (same helper +
  // formatter). Required now that the computed drives the DOM directly: without
  // this the banner span is missing in single-source mode.
  //
  // THE COUNT IS DECLARED METADATA, NOT A LOCAL TALLY.
  //
  // `pristine.length` counted the bundled answer key, which made the banner a
  // reason the asset had to stay. `GET /questions` declares `correctCount`
  // alongside the type, so both facts about a question arrive from the same
  // authoritative load.
  //
  // NULL IS NOT ZERO. Unknown means the banner does not render — a supplemental
  // hint is worth losing; a wrong or locally-reconstructed one is not.
  let questionHtml = qText;
  const totalOpts = (dq.options?.length ?? 0);
  const bannerCount = bannerCorrectCount(isMultiAnswer, d.topicQuizTypeRegistry, dq.questionText);

  if (bannerCount !== null && totalOpts > 0) {
    const banner = d.quizQuestionManagerService.getNumberOfCorrectAnswersText(
      bannerCount, totalOpts
    );
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
    // are correct.
    //
    // The pristine comparison that stood in while no verdict existed is gone
    // with the bank. The two remaining fallbacks are RECORDED completion state,
    // not an answer key: `isMultiAnswerComplete` is written when an authorized
    // verdict established completion, and the FET bypass is set by the click
    // pipeline after the same. Neither asks which options are correct.
    isMultiAnswerComplete:
      verdictComplete !== null
        ? verdictComplete
        : d.quizService.isMultiAnswerComplete?.(idx) === true
          || ets.fetBypassForQuestion?.get?.(idx) === true,
    isSingleAnswered: !isMultiAnswer && selectedCorrectFromAuthority > 0,
    // A LIVE timeout only.
    //
    // `shouldShowFet` lets a timeout override the revisit guard, because a
    // question timing out under the user's nose must reveal its answer even
    // though `isNavigatingToPrevious` can still be stale-true from the nav that
    // brought them there. But the timer also expires a question the moment the
    // user RETURNS to it after its signed deadline has passed — Previous, or
    // coming back to the browser tab. That is not a reveal to perform, it is a
    // reveal that already happened, and treating it as live put the explanation
    // in the heading where the question text belongs.
    isTimedOut: d.timerService.expiredForQuestionIndexSig?.() === idx
      && d.timerService.expiredOnArrivalSig?.() !== idx,
    hasInteracted: d.quizStateService.hasUserInteracted?.(idx) === true,
    optionsReady: typeof document !== 'undefined'
      && document.querySelectorAll('.option-row').length > 0,
    isNavigatingToPrevious: d.quizNavigationService.isNavigatingToPreviousSig?.() === true,
    interactedThisVisit: d.quizStateService.wasInteractedThisVisit?.(idx) === true,
    deferFeedback: d.feedbackPolicyService?.feedbackMode?.() === 'deferred',
  };
}
