import { Injectable } from '@angular/core';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { SelectedOption } from '../../models/SelectedOption.model';

import { OptionIdResolverService } from './option-id-resolver.service';
import { QuestionVerdictService } from '../features/verdict/question-verdict.service';
import { QuizService } from '../data/quiz.service';

import { isOptionCorrect } from '../../utils/is-option-correct';
import { norm } from '../../utils/text-norm';
import { swallow } from '../../utils/error-logging';

export interface ResolutionStatus {
  resolved: boolean;
  correctTotal: number;
  correctSelected: number;
  incorrectSelected: number;
  remainingCorrect: number;
  /**
   * Did an AUTHORIZED evaluation produce these numbers?
   *
   * False for idle/checking/error — the counts are then all zero because
   * nothing is known, NOT because nothing was correct. Callers that would treat
   * "0 correct" as a judgement must check this first; without it, "unanswered"
   * and "answered entirely wrongly" look identical.
   */
  evaluated: boolean;
}

/** Nothing is known yet. Zeros here mean "unknown", not "none". */
const UNEVALUATED: ResolutionStatus = {
  resolved: false,
  correctTotal: 0,
  correctSelected: 0,
  incorrectSelected: 0,
  remainingCorrect: 0,
  evaluated: false
};

@Injectable({ providedIn: 'root' })
export class AnswerEvaluationService {
  constructor(
    private quizService: QuizService,
    private idResolver: OptionIdResolverService,
    /** The correctness authority. See areAllCorrectAnswersSelected below. */
    private verdicts: QuestionVerdictService
  ) {}

  // ── Question completeness ──────────────────────────────────

  /**
   * Has this question been completed?
   *
   * EXACT-SET semantics, preserved from the original implementation: every
   * correct option selected AND nothing incorrect selected. That is stricter
   * than the Topic Quiz SCORING rule (`correctSet ⊆ selectedSet`), and
   * deliberately so — the two answer different questions, and the caller
   * (`answer-selection.service#updateQuestionCompletionState`) has always used
   * the strict one.
   *
   * Correctness now comes from the verdict via `getResolutionStatus`, rather
   * than a second interpretation of the same state. `strict: true` reproduces
   * the old rule exactly: resolved (superset) AND no incorrect selections.
   *
   * `evaluated` is what makes idle/checking/error safe. Those return zero
   * counts because nothing is KNOWN, not because nothing was correct — reading
   * `resolved` alone would be right by luck here, but wrong the moment a caller
   * starts trusting the counts.
   */
  isQuestionComplete(
    question: QuizQuestion,
    selected: SelectedOption[]
  ): boolean {
    if (!question || !Array.isArray(question.options)) return false;

    // No selection is not completion, whatever the verdict says. Kept ahead of
    // the status call so an unanswered question never even looks it up.
    if (!selected || selected.length === 0) return false;

    const status = this.getResolutionStatus(question, selected as unknown as Option[], true);

    // Unanswered, in flight, or failed — none of which is complete, and none
    // of which entitles this to consult `option.correct`.
    if (!status.evaluated) return false;

    return status.resolved;
  }

  // ── Resolution status ──────────────────────────────────────

  isQuestionResolvedCorrectly(
    question: QuizQuestion,
    selected: Array<SelectedOption | Option> | null
  ): boolean {
    return this.getResolutionStatus(question, selected as Option[], true).resolved;
  }

  getResolutionStatus(
    question: QuizQuestion,
    selected: Option[],
    strict: boolean = false
  ): ResolutionStatus {
    if (!question) return UNEVALUATED;

    // VERDICT FIRST. It is the correctness authority, and — critically — it
    // also tells us when correctness is simply NOT KNOWN. Absence of a verdict
    // used to fall through to the local bank; it now means unanswered, pending
    // or failed, none of which entitle anyone to read the answer key.
    const fromVerdict = this.statusFromVerdict(question, strict);
    if (fromVerdict) return fromVerdict;

    // TEMPORARY: no quiz/question identity to key a verdict by (a caller
    // outside a live attempt). Removed with the public bank.
    const questionOptions = this.resolveAuthoritativeOptions(question);
    const correctTotal =
      questionOptions.filter(o => this.idResolver.coerceToBoolean(o.correct)).length;

    const { correctSelected, incorrectSelected } =
      this.countSelectedCorrectness(questionOptions, selected);

    const remainingCorrect = Math.max(correctTotal - correctSelected, 0);
    let resolved = correctTotal > 0 && remainingCorrect === 0;

    if (strict) resolved = resolved && incorrectSelected === 0;

    return { resolved, correctTotal, correctSelected, incorrectSelected,
      remainingCorrect, evaluated: true };
  }

  /**
   * Resolution status from the AUTHORIZED verdict, or null when this question
   * cannot be keyed to one at all.
   *
   * Counts come from `selectedVerdicts`, which covers only options the user
   * actually picked — the same restriction the backend applies, so an
   * unselected option's correctness is never inferred here either.
   */
  private statusFromVerdict(
    question: QuizQuestion,
    strict: boolean
  ): ResolutionStatus | null {
    const quizId = this.quizService?.quizId;
    const questionText = question?.questionText;
    if (!quizId || !questionText) return null;

    const state = this.verdicts.verdictFor(quizId, questionText);

    // Untouched, in flight, or failed. All three are "not known" — and none of
    // them is permission to consult the local bank.
    if (state.phase === 'idle' || state.phase === 'checking' || state.phase === 'error') {
      return UNEVALUATED;
    }

    let correctSelected = 0;
    let incorrectSelected = 0;
    for (const wasCorrect of state.selectedVerdicts.values()) {
      if (wasCorrect) correctSelected++;
      else incorrectSelected++;
    }

    if (state.phase === 'incomplete') {
      const remainingCorrect = state.remainingCorrectCount ?? 0;
      return {
        resolved: false,
        correctTotal: correctSelected + remainingCorrect,
        correctSelected,
        incorrectSelected,
        remainingCorrect,
        evaluated: true
      };
    }

    // resolved | expired — terminal, so the full correct set is authorized.
    // `isResolvedCorrect` rather than the phase: a single-answer question
    // resolves on a wrong click too, and expiry reveals without crediting.
    const resolved = state.isResolvedCorrect === true;
    return {
      resolved: strict ? resolved && incorrectSelected === 0 : resolved,
      correctTotal: state.correctOptionTexts.length,
      correctSelected,
      incorrectSelected,
      remainingCorrect: 0,
      evaluated: true
    };
  }

  // Resolve the authoritative option set, overriding stale live correct-flags
  // with the live questions[] array when counts disagree.
  //
  // S5b: the `quizInitialState` global-bank scan that used to run first here
  // is gone — it cross-referenced the ENTIRE pristine bundle across every
  // quiz, the same global-bank shape as the already-removed `resolveCorrectIndices`
  // Source 3, and only ever runs at all when `statusFromVerdict` returns null
  // (no quizId/questionText to key a verdict by — a caller outside a live
  // attempt, not the "verdict unevaluated" case, which `statusFromVerdict`
  // already answers on its own). The `quizService.questions` cross-reference
  // stays: it reads the CURRENT quiz's own live question array, not a
  // cross-quiz bank — the same distinction that keeps `resolveCorrectIndices`
  // Source 2 in place.
  private resolveAuthoritativeOptions(question: QuizQuestion): Option[] {
    let questionOptions = Array.isArray(question.options) ? question.options : [];
    try {
      const qText = norm(question.questionText);
      const rawQs: any[] = this.quizService?.questions ?? [];
      const rawQ = qText
        ? rawQs.find(r => norm(r?.questionText) === qText)
        : null;
      if (rawQ && Array.isArray(rawQ.options)) {
        const rawCorrectCount = rawQ.options.filter((o: any) =>
          isOptionCorrect(o)
        ).length;
        const currentCorrectCount = questionOptions.filter(o =>
          this.idResolver.coerceToBoolean(o.correct)
        ).length;
        if (rawCorrectCount > currentCorrectCount) {
          questionOptions = rawQ.options;
        }
      }
    } catch (err: unknown) { swallow('answer-evaluation.service.ts', err); /* ignore and keep original */ }
    return questionOptions;
  }

  // Match a selection to its option index via text, id, synthetic-id, then index.
  private matchSelectionIndex(sel: any, questionOptions: Option[], hasRealIds: boolean): number {
    let matchedIdx = -1;

    // STRATEGY 1: TEXT MATCH
    if (sel.text) {
      const selText = norm(sel.text);
      matchedIdx = questionOptions.findIndex(o =>
        o.text && norm(o.text) === selText
      );
    }

    // STRATEGY 2: ID MATCH
    if (matchedIdx === -1 && sel.optionId != null && hasRealIds) {
      const selIdStr = String(sel.optionId);
      matchedIdx = questionOptions.findIndex(o =>
        o.optionId != null && String(o.optionId) === selIdStr
      );
    }

    // STRATEGY 3: Synthetic ID Modulo
    if (matchedIdx === -1 && typeof sel.optionId === 'number' && sel.optionId > 100) {
      const potentialIdx = (sel.optionId % 100) - 1;
      if (potentialIdx >= 0 && potentialIdx < questionOptions.length) {
        matchedIdx = potentialIdx;
      }
    }

    // STRATEGY 4: Explicit index fallback
    if (matchedIdx === -1 && typeof (sel as any).index === 'number') {
      const idx = (sel as any).index;
      if (idx >= 0 && idx < questionOptions.length) {
        matchedIdx = idx;
      }
    }

    return matchedIdx;
  }

  // Tally correct/incorrect selections, de-duping by matched option index.
  private countSelectedCorrectness(
    questionOptions: Option[],
    selected: Option[]
  ): { correctSelected: number; incorrectSelected: number } {
    let correctSelected = 0;
    let incorrectSelected = 0;

    const selectedArr = Array.isArray(selected) ? selected : [];
    const seenIndicesInQuestion = new Set<number>();

    const hasRealIds = questionOptions.some(o => o.optionId != null);
    for (const sel of selectedArr) {
      if (!sel) continue;
      if ((sel as any).selected === false) continue;

      const matchedIdx = this.matchSelectionIndex(sel, questionOptions, hasRealIds);

      if (matchedIdx !== -1) {
        if (seenIndicesInQuestion.has(matchedIdx)) continue;
        seenIndicesInQuestion.add(matchedIdx);

        const isCorrect = this.idResolver.coerceToBoolean(questionOptions[matchedIdx].correct);
        if (isCorrect) {
          correctSelected++;
        } else {
          incorrectSelected++;
        }
      } else {
        if (this.idResolver.coerceToBoolean(sel.correct)) {
          correctSelected++;
        } else {
          incorrectSelected++;
        }
      }
    }

    return { correctSelected, incorrectSelected };
  }

  // ── Multi-answer detection ─────────────────────────────────
  /**
   * Is this a multiple-answer question?
   *
   * TYPE IS DECLARED, NOT INFERRED. `GET /api/quizzes/:quizId/questions` returns
   * `type` on every question, so counting correct options to guess it is both
   * unnecessary and impossible after the cutover — the count is exactly the
   * fact the answer key withholds.
   *
   * The single/trueFalse branch is explicit rather than falling through to the
   * count, so a declared type is always trusted.
   */
  isMultiAnswerQuestion(questionIndex: number): boolean {
    const q = this.quizService.questions?.[questionIndex];
    if (!q) return false;

    if (q.type === QuestionType.MultipleAnswer) return true;
    if (q.type === QuestionType.SingleAnswer || q.type === QuestionType.TrueFalse) return false;

    // COMPATIBILITY, REMOVE IN 10J: questions loaded from the local
    // `quiz.json` carry no `type` field at all (see the quiz-data notes), so
    // until question loading moves to the API there is nothing else to read.
    // This is the last correctness read in this service, and it is a DATA
    // SOURCE dependency rather than a correctness decision.
    if (!Array.isArray(q.options)) return false;
    return q.options.filter((o: Option) => isOptionCorrect(o)).length > 1;
  }

  // ── Static correctness checks ──────────────────────────────
  /**
   * Has this question reached its correct terminal state?
   *
   * Drives the multi-answer completion lock, the incorrect-option highlight and
   * the timer stop, so its answer must not change during this migration.
   *
   * CORRECTNESS COMES FROM QuestionVerdictService, not from `option.correct`.
   * The verdict is recorded when the selection is submitted
   * (SelectedOptionService#submitToVerdictService); this only reads it, because
   * it is called during rendering and must stay side-effect free.
   *
   * `isResolvedCorrect` rather than the phase alone: a SINGLE-answer question
   * resolves on a wrong click too, and that must still report false here.
   *
   * COMPATIBILITY SEAM: when no verdict has been recorded yet — a code path
   * that queries before any selection was published — this falls back to the
   * local computation below. Removing that fallback is deferred until the
   * remaining substages have moved every writer onto the service; doing it now
   * would turn any missed writer into a silent behaviour change rather than a
   * test failure.
   */
  areAllCorrectAnswersSelected(
    question: QuizQuestion,
    selectedOptionIds: Set<number>
  ): boolean {
    const quizId = this.quizService?.quizId;
    const questionText = question?.questionText;

    if (quizId && questionText) {
      const verdict = this.verdicts.verdictFor(quizId, questionText);
      if (verdict.isResolvedCorrect === true) return true;
      if (verdict.phase === 'incomplete') return false;
      // 'idle' | 'checking' | 'error' | resolved-but-incorrect → fall through.
    }

    const correctIds = question.options
      .filter(o => isOptionCorrect(o))
      .map(o => o.optionId)
      .filter((id): id is number => typeof id === 'number');

    if (correctIds.length === 0) return false;

    const selectedStrings = new Set(Array.from(selectedOptionIds).map(id => String(id)));

    for (const id of correctIds) {
      if (!selectedStrings.has(String(id))) return false;
    }

    return true;
  }

}