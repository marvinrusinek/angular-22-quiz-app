import { Service, effect, inject, untracked } from '@angular/core';

import { QuestionVerdictService } from './question-verdict.service';
import { QuizService } from '@shared/services/data/quiz.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';

/**
 * Writes correctness-dependent dot state when a verdict ARRIVES.
 *
 * ── Why this exists ────────────────────────────────────────────────
 *
 * The click path writes the dot itself when the verdict is already known,
 * which is what happens with the local adapter. Under the API adapter the
 * verdict is a round trip, so at click time there is nothing to write — and
 * inventing a value from `option.correct` is exactly the coupling being
 * removed. The click path therefore registers what it is waiting for, and this
 * service completes the write when the answer lands.
 *
 * ── One ownership point ────────────────────────────────────────────
 *
 * Deliberately the ONLY place that mirrors verdicts into the dot maps
 * asynchronously. Scattering subscriptions across components is how the
 * timeout race in 10F happened — two subscribers to one event, ordered by
 * registration.
 *
 * ── Not a second cache ─────────────────────────────────────────────
 *
 * `pending` holds no correctness, only "question X is waiting on option Y's
 * verdict". The verdict itself stays in QuestionVerdictService, so the
 * stale-response generation protection there covers this path too: a superseded
 * response never reaches the state this reads.
 */
@Service()
export class TopicQuizDotVerdictSyncService {
  private readonly verdicts = inject(QuestionVerdictService);
  private readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);

  /** Display index → the click whose verdict has not arrived yet. */
  private readonly pending = new Map<number, { quizId: string; questionText: string; optionText: string }>();

  constructor() {
    // Reacts to the verdict map; writes are untracked so mutating the dot maps
    // cannot feed back into this effect.
    effect(() => {
      this.verdicts.states();
      untracked(() => this.drainPending());
    });
  }

  /**
   * Note that a click is waiting on its verdict.
   *
   * Keyed by display index because that is how the dot maps are keyed, and
   * because a newer click on the SAME question should replace an older pending
   * one rather than queue behind it.
   */
  awaitVerdict(qIdx: number, quizId: string, questionText: string, optionText: string): void {
    if (!quizId || !questionText || !optionText) return;
    this.pending.set(qIdx, { quizId, questionText, optionText });
    // The verdict may already have landed between submission and this call.
    this.drainPending();
  }

  /** Stop waiting — e.g. the question was cleared or the quiz restarted. */
  cancel(qIdx: number): void {
    this.pending.delete(qIdx);
  }

  clear(): void {
    this.pending.clear();
  }

  private drainPending(): void {
    if (this.pending.size === 0) return;

    for (const [qIdx, wait] of [...this.pending]) {
      const clickedIsCorrect = this.verdicts.verdictForOption(
        wait.quizId, wait.questionText, wait.optionText
      );
      if (clickedIsCorrect === null) continue;   // still checking

      this.pending.delete(qIdx);
      this.selectedOptionService.clickConfirmedDotStatus.set(qIdx, clickedIsCorrect ? 'correct' : 'wrong');
      this.selectedOptionService.lastClickedCorrectByQuestion.set(qIdx, clickedIsCorrect);
    }
  }

  /**
   * Display index of a question, SHUFFLE-AWARE.
   *
   * `questions[i]` is the wrong question when shuffle is active, because the
   * dot maps are keyed by DISPLAY index. Resolving through the display-order
   * array is what stops a verdict for question A updating question B's dot.
   *
   * Exposed for the click path, which knows the index already but uses this to
   * verify it, and for tests.
   */
  displayIndexOf(questionText: string): number {
    const inDisplayOrder = (this.quizService as any)?.getQuestionsInDisplayOrder?.() as
      | { questionText?: string }[]
      | undefined;
    if (!Array.isArray(inDisplayOrder)) return -1;

    const target = canonical(questionText);
    return inDisplayOrder.findIndex((q) => canonical(q?.questionText ?? '') === target);
  }
}

/** Matches the verdict service's key canonicalization closely enough to compare. */
function canonical(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}
