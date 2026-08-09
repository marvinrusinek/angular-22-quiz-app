import { inject, Service } from '@angular/core';

import { SK_DOT_CONFIRMED, SK_MULTI_PERFECT, SK_SEL_Q } from '../../../constants/session-keys';
import { readSessionString } from '../../../utils/session-storage';

import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import type { QuestionVerdictState } from '../../features/verdict/question-verdict.types';
import {
  allCorrectSelectedFromVerdict,
  selectedVerdictFor,
  verdictStateForDisplayIndex
} from '../../features/verdict/authorized-correctness';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';
import { swallow } from '../../../utils/error-logging';

export interface QuestionResolutionResult {
  fullyResolvedCorrect: boolean;
  fullyResolvedWrong: boolean;
  dot: 'correct' | 'wrong' | undefined;
  multiPerfect: boolean;
  scoredCorrect: boolean;
  computedPerfect: boolean;
  computedImperfect: boolean;
  correctOpts: any[];
  isCanonMulti: boolean;
  liveSel: any[];
}

@Service()
export class QuestionResolutionService {
  private readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly verdicts = inject(QuestionVerdictService);

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
      s.scoredCorrect, s.isCanonMulti, s.multiPerfect, s.computedPerfect, s.dot
    );
    const fullyResolvedWrong = includeWrongDetection
      ? this.combineFullyResolvedWrong(s.scoredCorrect, s.isCanonMulti, s.computedImperfect, s.dot, s.multiPerfect)
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
    const correctOpts = this.resolvePristineCorrectOpts(qIdx);
    const isCanonMulti = correctOpts.length > 1;
    const { liveSel, computedPerfect, computedImperfect } = includeSelections
      ? this.resolveSelectionSignals(qIdx, correctOpts, this.resolveVerdictState(qIdx))
      : { liveSel: [], computedPerfect: false, computedImperfect: false };

    return {
      dot,
      multiPerfect,
      scoredCorrect,
      computedPerfect,
      computedImperfect,
      correctOpts,
      isCanonMulti,
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
    let multiPerfect = this.quizService._multiAnswerPerfect.get(qIdx) === true;
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

  // Signal 4: pristine correct options from quizInitialState
  private resolvePristineCorrectOpts(qIdx: number): any[] {
    const optsForQ: any[] =
      this.quizService?.questions?.[qIdx]?.options
      ?? this.quizService?.shuffledQuestions?.[qIdx]?.options
      ?? [];

    let correctOpts: any[] = [];
    try {
      const pq = this.quizService?.getPristineQuestionByText(
        this.quizService?.questions?.[qIdx]?.questionText
        ?? optsForQ?.[0]?.questionText
      );
      if (pq) {
        correctOpts = (pq.options ?? []).filter(
          (o: any) => isOptionCorrect(o)
        );
      }
    } catch (err: unknown) { swallow('question-resolution.service.ts resolvePristineCorrectOpts', err); }
    if (correctOpts.length === 0) {
      correctOpts = optsForQ.filter(
        (o: any) => isOptionCorrect(o)
      );
    }
    return correctOpts;
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
    correctOpts: any[],
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

    // REMOVE WITH THE REMAINING CORRECTNESS MIGRATION — reached only when no
    // verdict has been recorded (idle/checking/error), where the pristine
    // comparison is still the only answer available. Absence of a verdict is
    // not a negative one, so falling back here rather than reporting "not
    // perfect" preserves revisit behaviour in a fresh session.
    if (correctOpts.length > 0 && liveSel.length > 0) {
      const wasPicked = (canon: any): boolean => {
        const cid = canon?.optionId;
        const ctxt = norm(canon?.text);
        return liveSel.some((s: any) =>
          (cid != null && s?.optionId === cid) ||
          (!!ctxt && norm(s?.text) === ctxt)
        );
      };
      const isCanonCorrectSel = (sItem: any): boolean => {
        const sid = sItem?.optionId;
        const stxt = norm(sItem?.text);
        return correctOpts.some((c: any) =>
          (sid != null && c?.optionId === sid) ||
          (!!stxt && norm(c?.text) === stxt)
        );
      };

      const allCovered = correctOpts.every(wasPicked);
      const noExtras = liveSel.every(isCanonCorrectSel);
      if (allCovered && noExtras) {
        computedPerfect = true;
      } else {
        computedImperfect = true;
      }
    }
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

  /** Check whether a single option is among the canonical correct set. */
  isOptionCanonCorrect(
    option: { optionId?: number; text?: string } | null | undefined,
    correctOpts: any[]
  ): boolean {
    if (!option || !correctOpts.length) return false;
    const optId = option.optionId;
    const optText = norm(option.text);
    return correctOpts.some((c: any) =>
      (optId != null && c?.optionId === optId) ||
      (!!optText && norm(c?.text) === optText)
    );
  }
}
