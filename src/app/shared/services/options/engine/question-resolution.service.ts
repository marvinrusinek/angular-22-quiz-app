import { inject, Service } from '@angular/core';

import { SK_DOT_CONFIRMED, SK_MULTI_PERFECT, SK_SEL_Q } from '../../../constants/session-keys';
import { readSessionString } from '../../../utils/session-storage';

import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import type { QuestionVerdictState } from '../../features/verdict/question-verdict.types';
import {
  allCorrectSelectedFromVerdict,
  authorizedCorrectTexts,
  selectedVerdictFor,
  verdictStateForDisplayIndex
} from '../../features/verdict/authorized-correctness';
import { QuizService } from '../../data/quiz.service';
import { TopicQuizTypeRegistry } from '../../api/topic-quiz-type-registry.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

import { isOptionCorrect } from '../../../utils/is-option-correct';
import { declaredIsMultiAnswer } from '../../../utils/question-type-authority';
import { norm } from '../../../utils/text-norm';
import { swallow } from '../../../utils/error-logging';

/**
 * THREE AUTHORITIES, DELIBERATELY NOT ONE.
 *
 * This carried a single `correctOpts: any[]` that six consumers used for three
 * different questions: how to paint the user's OWN picks, what the full correct
 * set is, and whether the question is multi-answer. The bundled answer key
 * could answer all three at any moment, so the conflation was invisible.
 *
 * The verdict cannot, and must not. A multi-answer question sits in `incomplete`
 * for the whole time the user is answering it, and the full correct set is
 * withheld until it resolves — that withholding is the point of the migration.
 * Migrating `correctOpts` to the reveal therefore broke every multi-answer
 * behaviour at once (10 browser tests), because painting a user's own selection
 * was reaching for identity it is not entitled to.
 *
 * Split by authority, each with an honest empty state:
 */
export interface QuestionResolutionResult {
  fullyResolvedCorrect: boolean;
  fullyResolvedWrong: boolean;
  dot: 'correct' | 'wrong' | undefined;
  multiPerfect: boolean;
  scoredCorrect: boolean;
  computedPerfect: boolean;
  computedImperfect: boolean;
  /**
   * How the user's OWN picks were judged, keyed by canonical option text.
   *
   * Populated from `incomplete` onwards — a pick can be judged the moment it is
   * submitted, without disclosing anything about options left untouched. This is
   * the ONLY correctness available mid-question, and the only thing that may
   * paint a selection.
   *
   * An option absent from this map is not "wrong"; it is unjudged.
   */
  selectedVerdicts: ReadonlyMap<string, boolean>;
  /**
   * The full correct-option identity — the authorized REVEAL.
   *
   * EMPTY until the question reaches a terminal verdict. Empty means "not
   * revealed yet", never "no option is correct".
   *
   * A set of canonical texts rather than option objects: consumers only ask
   * whether an option is a member, and handing them the objects would invite
   * reconstructing the answer key from the reveal.
   */
  revealedCorrectOptionTexts: ReadonlySet<string>;
  /** Question type, from the DECLARED API type — never counted from correctness. */
  isMultiAnswer: boolean;
  liveSel: any[];
}

@Service()
export class QuestionResolutionService {
  private readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly verdicts = inject(QuestionVerdictService);
  private readonly typeRegistry = inject(TopicQuizTypeRegistry);

  resolveQuestionState(
    qIdx: number,
    opts?: {
      includeDot?: boolean;
      includeSelections?: boolean;
      includeWrongDetection?: boolean;
    }
  ): QuestionResolutionResult {
    const includeDot = opts?.includeDot !== false;
    const includeSelections = opts?.includeSelections !== false;
    const includeWrongDetection = opts?.includeWrongDetection === true;

    const s = this.gatherSignals(qIdx, includeDot, includeSelections);

    const fullyResolvedCorrect = this.combineFullyResolvedCorrect(
      s.scoredCorrect, s.isMultiAnswer, s.multiPerfect, s.computedPerfect, s.dot
    );
    const fullyResolvedWrong = includeWrongDetection
      ? this.combineFullyResolvedWrong(s.scoredCorrect, s.isMultiAnswer, s.computedImperfect, s.dot, s.multiPerfect)
      : false;

    return { fullyResolvedCorrect, fullyResolvedWrong, ...s };
  }

  // Gather the per-signal facts that feed the combine steps
  private gatherSignals(
    qIdx: number,
    includeDot: boolean,
    includeSelections: boolean
  ): Omit<QuestionResolutionResult, 'fullyResolvedCorrect' | 'fullyResolvedWrong'> {
    const dot = includeDot ? this.resolveDotSignal(qIdx) : undefined;
    const multiPerfect = this.resolveMultiPerfect(qIdx);
    const scoredCorrect = this.resolveScoredCorrect(qIdx);
    const verdictState = this.resolveVerdictState(qIdx);

    // #4 — the user's own picks. Available from `incomplete` onwards.
    const selectedVerdicts: ReadonlyMap<string, boolean> =
      verdictState?.selectedVerdicts ?? new Map<string, boolean>();

    // #3/#5/#6 — the reveal. `authorizedCorrectTexts` returns null until a
    // terminal phase; an empty set here means "not revealed", not "none correct".
    const revealedCorrectOptionTexts: ReadonlySet<string> =
      authorizedCorrectTexts(this.quizService, qIdx, this.verdicts) ?? new Set<string>();

    // #1 — TYPE, from the declared metadata. This was `correctOpts.length > 1`,
    // which made the question's type a derivative of its answer key: with the
    // reveal withheld mid-question, every multi-answer question read as single.
    const isMultiAnswer = this.resolveIsMultiAnswerDeclared(qIdx);

    const { liveSel, computedPerfect, computedImperfect } = includeSelections
      ? this.resolveSelectionSignals(qIdx, verdictState)
      : { liveSel: [], computedPerfect: false, computedImperfect: false };

    return {
      dot,
      multiPerfect,
      scoredCorrect,
      computedPerfect,
      computedImperfect,
      selectedVerdicts,
      revealedCorrectOptionTexts,
      isMultiAnswer,
      liveSel,
    };
  }

  // Signal 1: dot status
  private resolveDotSignal(qIdx: number): 'correct' | 'wrong' | undefined {
    let dot = this.selectedOptionService.clickConfirmedDotStatus?.get?.(qIdx) as 'correct' | 'wrong' | undefined;
    if (!dot) {
      try {
        const stored = sessionStorage.getItem(SK_DOT_CONFIRMED + qIdx);
        if (stored === 'correct' || stored === 'wrong') dot = stored;
      } catch (err: unknown) { swallow('question-resolution.service.ts resolveDotSignal', err); }
    }
    return dot;
  }

  // Signal 2: multi-answer perfect flag
  private resolveMultiPerfect(qIdx: number): boolean {
    let multiPerfect = this.quizService.isQuestionResolved(qIdx);
    if (!multiPerfect) {
      multiPerfect = readSessionString(SK_MULTI_PERFECT + qIdx) === 'true';
    }
    return multiPerfect;
  }

  // Signal 3: scoring map (must use original index in shuffled mode)
  private resolveScoredCorrect(qIdx: number): boolean {
    const scoreMap = this.quizService?.questionCorrectness as Map<number, boolean> | undefined;
    if (!scoreMap) return false;
    const qs: any = this.quizService;
    const isShuf = qs?.isShuffleEnabled?.() && qs?.shuffledQuestions?.length > 0;
    if (!isShuf) {
      return scoreMap.get(qIdx) === true;
    }
    let effectiveQuizId = qs?.quizId || '';
    if (!effectiveQuizId) {
      try { effectiveQuizId = localStorage.getItem('lastQuizId') || ''; } catch (err: unknown) { swallow('question-resolution.service.ts resolveScoredCorrect', err); }
    }
    if (!effectiveQuizId) return false;
    const origIdx = qs?.scoringService?.quizShuffleService?.toOriginalIndex?.(effectiveQuizId, qIdx);
    if (typeof origIdx === 'number' && origIdx >= 0) {
      return scoreMap.get(origIdx) === true;
    }
    return false;
  }

  /**
   * Signal 4: is this question multi-answer? DECLARED, never counted.
   *
   * This was `correctOpts.length > 1` — the size of the answer key. That made
   * a question TYPE a derivative of its correctness, so once the reveal is
   * withheld mid-question every multi-answer question reads as single-answer.
   *
   * Unknown fails closed as MULTI rather than single: single-answer paths
   * disclose after one correct pick, so guessing "single" on an unknown
   * multi-answer question leaks its answer. Guessing "multi" only withholds.
   */
  private resolveIsMultiAnswerDeclared(qIdx: number): boolean {
    try {
      const qs: any = this.quizService;
      const question =
        qs?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? qs?.questions?.[qIdx]
        ?? qs?.shuffledQuestions?.[qIdx];
      const declared =
        declaredIsMultiAnswer(question)
        ?? this.typeRegistry?.isMultiAnswer?.(question?.questionText)
        ?? null;
      return declared !== false;
    } catch {
      return true;   // fail closed — withhold rather than disclose
    }
  }
  // Signal 5: selection comparison
  /** The recorded verdict for this display index, or null when unavailable. */
  private resolveVerdictState(qIdx: number): QuestionVerdictState | null {
    try {
      return verdictStateForDisplayIndex(this.quizService, qIdx, this.verdicts);
    } catch {
      return null;
    }
  }

  private resolveSelectionSignals(
    qIdx: number,
    verdictState: QuestionVerdictState | null
  ): { liveSel: any[]; computedPerfect: boolean; computedImperfect: boolean } {
    let sel: any[] = [];
    try {
      const raw = sessionStorage.getItem(SK_SEL_Q + qIdx);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) sel = parsed;
      }
    } catch (err: unknown) { swallow('question-resolution.service.ts resolveSelectionSignals', err); }
    if (sel.length === 0) {
      sel = this.selectedOptionService.getSelectedOptionsForQuestion?.(qIdx) ?? [];
    }

    const liveSel = sel.filter((s: any) =>
      s?.selected === true || s?.showIcon === true || s?.highlight === true
    );

    let computedPerfect = false;
    let computedImperfect = false;

    // AUTHORIZED PATH.
    //
    // "Perfect" here is stricter than the verdict's own correct/incorrect: it
    // means every correct option was picked AND nothing wrong was. The verdict
    // resolves multi-answer on the audited SUPERSET rule, which tolerates extra
    // wrong picks, so `isResolvedCorrect` alone is NOT the same question and
    // swapping it in would call a selection with wrong extras perfect.
    //
    // Both halves are answerable from authorized facts anyway: completion from
    // the verdict, and "nothing wrong was picked" from the user's OWN selected
    // verdicts. Neither needs to know about an option they never touched.
    const authorizedComplete = allCorrectSelectedFromVerdict(verdictState);
    if (authorizedComplete !== null) {
      if (liveSel.length > 0) {
        const anyWrongPicked = liveSel.some(
          (s: any) => selectedVerdictFor(verdictState, s?.text) === false
        );
        computedPerfect = authorizedComplete && !anyWrongPicked;
        computedImperfect = !computedPerfect;
      }
      return { liveSel, computedPerfect, computedImperfect };
    }

    // NO BANK FALLBACK. This rebuilt the correct set from the bundled key and
    // compared it against the saved selection whenever no verdict existed.
    //
    // Its stated justification was that "a revisit in a fresh session must
    // still restore correctly" — measured against the committed build, that
    // restore does not happen, and the cases that DO restore are carried by
    // the earned-verdict snapshot, which is authorized rather than local.
    //
    // With no verdict, neither perfect nor imperfect is claimed: both are
    // assertions about correctness, and calling an unfinished selection
    // "imperfect" says the user got something wrong when nobody has said so.
    return { liveSel, computedPerfect, computedImperfect };
  }

  // Combine: fullyResolvedCorrect
  private combineFullyResolvedCorrect(
    scoredCorrect: boolean,
    isCanonMulti: boolean,
    multiPerfect: boolean,
    computedPerfect: boolean,
    dot: 'correct' | 'wrong' | undefined
  ): boolean {
    return (
      (scoredCorrect && (!isCanonMulti || multiPerfect || computedPerfect)) ||
      computedPerfect ||
      (!isCanonMulti && dot === 'correct') ||
      (isCanonMulti && multiPerfect)
    );
  }

  // Combine: fullyResolvedWrong
  private combineFullyResolvedWrong(
    scoredCorrect: boolean,
    isCanonMulti: boolean,
    computedImperfect: boolean,
    dot: 'correct' | 'wrong' | undefined,
    multiPerfect: boolean
  ): boolean {
    return (
      (!scoredCorrect || isCanonMulti) &&
      (computedImperfect ||
        dot === 'wrong' ||
        (isCanonMulti && dot === 'correct' && !multiPerfect))
    );
  }

  /**
   * Is this option part of the AUTHORIZED REVEAL?
   *
   * Replaces `isOptionCanonCorrect(option, correctOpts)`, which answered two
   * different questions depending on what the caller passed: "was my pick
   * right?" and "is this one of the correct answers?". The first is available
   * mid-question from the selected verdicts; the second is not available at
   * all until the reveal. Sharing one helper hid that distinction, which is
   * how selection painting ended up reaching for the full correct set.
   *
   * Membership only, and only meaningful once the set is non-empty.
   */
  isOptionInRevealedCorrectSet(
    option: { text?: string } | null | undefined,
    revealed: ReadonlySet<string>
  ): boolean {
    const text = norm(option?.text);
    return !!text && revealed.has(text);
  }

  /**
   * How was the user's OWN pick judged? undefined when it carries no verdict.
   *
   * The only correctness that may paint a selection before the question
   * resolves. Absent is UNJUDGED, never wrong.
   */
  selectedVerdictForOption(
    option: { text?: string } | null | undefined,
    selectedVerdicts: ReadonlyMap<string, boolean>
  ): boolean | undefined {
    const raw = option?.text;
    if (!raw) return undefined;
    const direct = selectedVerdicts.get(raw);
    if (direct !== undefined) return direct;
    const target = norm(raw);
    for (const [text, correct] of selectedVerdicts) {
      if (norm(text) === target) return correct;
    }
    return undefined;
  }
}
