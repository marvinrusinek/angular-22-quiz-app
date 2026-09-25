import { inject, Injector, Service } from '@angular/core';

import { QuizQuestion } from '@shared/models/QuizQuestion.model';
import { Option } from '@shared/models/Option.model';
import { ScoreAnalysisItem } from '@shared/models/Final-Result.model';
import { norm } from '@shared/utils/text-norm';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { QuestionVerdictService } from '@shared/services/features/verdict/question-verdict.service';
import { QuizService } from '@shared/services/data/quiz.service';

/**
 * Builds the per-question review analysis from the CURRENT (fresh) selection
 * state, at completion. It intentionally mirrors AccordionComponent's
 * correctness logic (option matching + normalized text comparison) so the
 * captured counts are identical to what the review shows on a fresh completion.
 *
 * Why this exists: the accordion re-derives correctness from live selection maps
 * (SelectedOptionService), which get wiped when the user leaves Results. By
 * capturing this analysis into the persisted FinalResult snapshot at completion,
 * the review stays correct on REVISIT (matched by question text, so it's immune
 * to the wipe AND to any shuffle/order change). Pure over its inputs.
 */
@Service()
export class ScoreAnalysisService {
  private readonly selectedOptionService = inject(SelectedOptionService);
  // Resolved lazily: injecting QuizService directly drags its whole loader
  // chain (QuizDataLoaderService -> ActivatedRoute) into every consumer of this
  // otherwise-pure service, including tests that have no router.
  private readonly injector = inject(Injector);

  buildAnalysis(questions: readonly QuizQuestion[]): ScoreAnalysisItem[] {
    const quizId = this.resolveQuizId();

    return (questions ?? []).map((q, i) => {
      const options = q.options ?? [];
      const selected = this.getSelectedOptions(options, i);
      const selectedTexts = selected.map((s) => norm(s.text));
      const questionText = q.questionText ?? '';

      // AUTHORIZED REVEAL, from the verdict history rather than a scan of
      // `o.correct === true`. This is the review data the user actually earned:
      // the question reached a terminal state, so the server released its
      // correct options and explanation. Reading the bank here would rebuild
      // the answer key at exactly the moment it is supposed to be unnecessary.
      const authorized = this.authorizedReveal(quizId, questionText);

      // NO AUTHORIZED REVEAL MEANS UNANSWERED — never "consult the bank".
      //
      // Every non-terminal phase lands here and they all mean the same thing
      // for review purposes: nothing was authorized, so nothing is disclosed
      // and nothing is credited.
      //
      //   idle      the question was never answered (skipped, or the quiz was
      //             finalized before the user reached it) — legitimately a zero
      //   incomplete answered but never completed. This one used to fall
      //             through to the scan, and that was a real scoring defect: a
      //             user could pick an option the LOCAL flags call correct,
      //             leave a multi-answer question unfinished, and be credited,
      //             because the scan compares against the bank's idea of the
      //             correct set rather than the server's
      //   checking  still in flight; the finalization gate blocks Results here
      //   error     the check failed; guessing an outcome would invent a score
      //
      // The bank scan that used to sit here is gone. It was the last place
      // Results could rebuild the answer key at exactly the moment it is meant
      // to be unnecessary.
      const correctTexts = authorized
        ? authorized.correctOptionTexts.map((t) => norm(t))
        : [];

      // Mirror the accordion exactly: ALL correct answers must be selected.
      // With no authorized reveal `correctTexts` is empty, so this is false —
      // an unanswered question contributes zero rather than being judged.
      const wasCorrect = correctTexts.length > 0
        && correctTexts.every((ct) => selectedTexts.includes(ct));

      // Ids are resolved FROM the authorized texts, not by re-reading
      // correctness — kept only so snapshots persisted by earlier builds and
      // the existing accordion continue to render.
      const correctOptionIds = correctTexts
        .map((ct) => options.find((o) => norm(o.text ?? '') === ct))
        .map((o) => (o?.optionId != null ? String(o.optionId) : ''))
        .filter((id) => id.length > 0);

      return {
        questionIndex: i,
        questionText,
        wasCorrect,
        selectedOptionIds: selected.map((s) => s.optionId).filter((id) => id.length > 0),
        correctOptionIds,
        selectedOptionTexts: selected.map((s) => s.text),
        correctOptionTexts: authorized ? [...authorized.correctOptionTexts] : correctTexts,
        explanation: authorized ? authorized.explanation : null
      };
    });
  }

  /**
   * The terminal verdict's reveal for one question, or null.
   *
   * Only `resolved` and `expired` carry an authorized reveal. `incomplete`
   * deliberately does not — an unfinished question's correct set is exactly
   * what must not leak — and `idle`/`checking`/`error` have nothing to give.
   */
  /**
   * Did the verdict positively establish that this question was NOT completed?
   *
   * Distinct from "no verdict": `incomplete` is an answer, `idle` is silence.
   * Only the former may veto credit on its own.
   */
  private isIncomplete(quizId: string | undefined, questionText: string): boolean {
    if (!quizId || !questionText) return false;

    const verdicts = this.tryGet<QuestionVerdictService>(QuestionVerdictService);
    return verdicts?.verdictFor(quizId, questionText).phase === 'incomplete';
  }

  private authorizedReveal(
    quizId: string | undefined,
    questionText: string
  ): { correctOptionTexts: readonly string[]; explanation: string | null } | null {
    if (!quizId || !questionText) return null;

    const verdicts = this.tryGet<QuestionVerdictService>(QuestionVerdictService);
    if (!verdicts) return null;

    const state = verdicts.verdictFor(quizId, questionText);
    if (state.phase !== 'resolved' && state.phase !== 'expired') return null;
    if (state.correctOptionTexts.length === 0) return null;

    return { correctOptionTexts: state.correctOptionTexts, explanation: state.explanation };
  }

  /**
   * Resolve a dependency without letting ITS dependencies break this service.
   *
   * QuizService pulls in a loader chain that needs the router, and this service
   * is otherwise pure over its inputs — a caller that only wants review
   * analysis should not fail because the router is absent. A miss means no
   * authorized reveal, which falls back rather than throwing.
   */
  private tryGet<T>(token: any): T | null {
    try {
      return this.injector.get(token, null) as T | null;
    } catch {
      return null;
    }
  }

  private resolveQuizId(): string | undefined {
    const quizService = this.tryGet<any>(QuizService);
    const quizId = quizService?.quizId;
    return typeof quizId === 'string' && quizId.length > 0 ? quizId : undefined;
  }

  // ── selection reading (mirrors AccordionComponent.getSelectedOptionsForQuestion) ──
  private getSelectedOptions(options: Option[], index: number): { text: string; optionId: string }[] {
    const raw = this.selectedOptionService.rawSelectionsMap.get(index);
    const source: { optionId?: number; text?: string }[] =
      raw && raw.length > 0 ? raw : (this.selectedOptionService.selectedOptionsMap.get(index) ?? []);

    return source
      .map((sel) => {
        const idx = this.matchOption(options, sel);
        const text = sel.text || (idx >= 0 ? options[idx]?.text : '') || '';
        const optionId =
          idx >= 0 && options[idx]?.optionId != null
            ? String(options[idx].optionId)
            : sel.optionId != null
              ? String(sel.optionId)
              : '';
        return { text, optionId };
      })
      .filter((o) => o.text.length > 0);
  }

  private matchOption(options: Option[], sel: { optionId?: number; text?: string }): number {
    let idx = options.findIndex(
      (o) =>
        o.optionId != null && sel.optionId != null && sel.optionId !== -1 &&
        String(o.optionId) === String(sel.optionId)
    );
    if (idx === -1 && sel.text) {
      idx = options.findIndex((o) => o.text === sel.text);
    }
    if (idx === -1 && typeof sel.optionId === 'number' && sel.optionId >= 0 && sel.optionId < options.length) {
      idx = sel.optionId;
    }
    return idx;
  }
}
