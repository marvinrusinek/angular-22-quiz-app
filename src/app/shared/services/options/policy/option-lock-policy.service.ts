import { Service, Injector, inject } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { OptionBindings } from '../../../models/OptionBindings.model';

import { QuizService } from '../../data/quiz.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import type { QuestionVerdictState } from '../../features/verdict/question-verdict.types';
import {
  allCorrectSelectedFromVerdict,
  selectedVerdictFor,
  verdictStateForDisplayIndex
} from '../../features/verdict/authorized-correctness';
import { norm } from '../../../utils/text-norm';

export interface LockIncorrectResult {
  shouldLockIncorrectOptions: boolean;
  lockedIncorrectOptionIds: Set<number>;
  resolvedTypeForLock: QuestionType;
  hasCorrectSelectionForLock: boolean;
  allCorrectSelectedForLock: boolean;
}

@Service()
export class OptionLockPolicyService {
  // ── injects ─────────────────────────────────────────────────────
  private injector = inject(Injector);

  // ── public methods ──────────────────────────────────────────────
  updateLockedIncorrectOptions(params: {
    bindings: OptionBindings[];
    forceDisableAll: boolean;
    resolvedType: QuestionType;
    computeShouldLockIncorrectOptions: (
      resolvedType: QuestionType,
      hasCorrectSelection: boolean,
      allCorrectSelected: boolean
    ) => boolean;
  }): LockIncorrectResult {
    const bindings = params.bindings ?? [];

    if (!bindings.length) {
      return this.buildLockResult(false, new Set<number>(), params.resolvedType, false, false);
    }

    if (params.forceDisableAll) {
      const locked = this.applyForceDisableAll(bindings);
      return this.buildLockResult(true, locked, params.resolvedType, false, false);
    }

    const { hasCorrectSelection, allCorrectSelected, isPerfect } =
      this.computeSelectionState(bindings);

    const shouldLockIncorrect = params.computeShouldLockIncorrectOptions(
      params.resolvedType,
      hasCorrectSelection,
      allCorrectSelected
    );

    if (!shouldLockIncorrect && !isPerfect) {
      this.unlockAllBindings(bindings);
      return this.buildLockResult(
        false, new Set<number>(), params.resolvedType, hasCorrectSelection, allCorrectSelected
      );
    }

    const locked = this.applyGranularLocking(
      bindings, isPerfect, allCorrectSelected, hasCorrectSelection, params.resolvedType
    );
    return this.buildLockResult(
      true, locked, params.resolvedType, hasCorrectSelection, allCorrectSelected
    );
  }

  private buildLockResult(
    shouldLock: boolean,
    locked: Set<number>,
    resolvedType: QuestionType,
    hasCorrectSelection: boolean,
    allCorrectSelected: boolean
  ): LockIncorrectResult {
    return {
      shouldLockIncorrectOptions: shouldLock,
      lockedIncorrectOptionIds: locked,
      resolvedTypeForLock: resolvedType,
      hasCorrectSelectionForLock: hasCorrectSelection,
      allCorrectSelectedForLock: allCorrectSelected
    };
  }

  // Disable every binding and return the set of their optionIds.
  private applyForceDisableAll(bindings: OptionBindings[]): Set<number> {
    for (const b of bindings) {
      b.disabled = true;
      if (b.option) b.option.active = false;
    }
    return new Set(
      bindings
        .map(b => b.option?.optionId)
        .filter((id): id is number => typeof id === 'number')
    );
  }

  // Resolve canonical correctness, backfill binding flags, and derive selection state.
  private computeSelectionState(bindings: OptionBindings[]): {
    hasCorrectSelection: boolean;
    allCorrectSelected: boolean;
    isPerfect: boolean;
  } {
    // AUTHORIZED FIRST. Everything this method needs — did they pick a right
    // one, are all the right ones picked, did they also pick a wrong one — is
    // answerable from the verdict WITHOUT knowing the correctness of options
    // they have not selected. That matters: mid-question, an unselected
    // option's correctness is not ours to know, and deriving locking from it
    // is how the answer key leaks into the UI.
    const verdictState = this.resolveVerdictState();
    if (verdictState) {
      const authorized = this.applyAuthorizedCorrectness(bindings, verdictState);
      if (authorized) return authorized;
    }

    // NOTHING IS AUTHORIZED YET — idle, a check in flight, or an error.
    //
    // This used to rebuild the correct set from `quizInitialState` and lock from
    // it. Under the API adapter the phase is `checking` for the whole in-flight
    // window after every click, so that path ran on ordinary play and decided
    // locking from the ANSWER KEY before the server had answered — the exact
    // authority Stage 10 removes.
    //
    // What can honestly be said without it:
    //
    //   hasCorrectSelection  yes, from verdicts ALREADY authorized on the
    //                        user's own earlier picks for this question
    //   allCorrectSelected   NO. Completion is the server's to declare, and
    //                        "not yet told" is not "yes".
    //   isPerfect            NO, for the same reason.
    //
    // `b.isCorrect` is now written ONLY by applyAuthorizedCorrectness, so it
    // carries no local-bank opinion; an option the verdict has not spoken about
    // stays `null`/`undefined` and is neither locked nor revealed. Reporting
    // completion as false here means untouched options stay interactive until
    // the verdict lands, which is the conservative direction: a lock that
    // arrives a round trip late is recoverable, a lock applied to a question
    // the server never called complete is not.
    const hasCorrectSelection = bindings.some(
      (b) => b.isSelected && b.isCorrect === true
    );

    return { hasCorrectSelection, allCorrectSelected: false, isPerfect: false };
  }

  /** The recorded verdict for the question currently on screen, if any. */
  private resolveVerdictState(): QuestionVerdictState | null {
    try {
      const quizSvc = this.injector.get(QuizService, null);
      const verdicts = this.injector.get(QuestionVerdictService, null);
      if (!quizSvc || !verdicts) return null;

      const idx = (quizSvc as any)?.currentQuestionIndex;
      if (!Number.isFinite(idx) || idx < 0) return null;

      return verdictStateForDisplayIndex(quizSvc, idx, verdicts);
    } catch {
      return null;
    }
  }

  /**
   * Derive the selection state from the verdict, and backfill what the verdict
   * has authorized onto the bindings.
   *
   * Returns null when the verdict says nothing yet (idle/checking/error), so
   * the caller can fall back rather than mistake silence for "no correct
   * options selected".
   */
  private applyAuthorizedCorrectness(
    bindings: OptionBindings[],
    state: QuestionVerdictState
  ): { hasCorrectSelection: boolean; allCorrectSelected: boolean; isPerfect: boolean } | null {
    // On a terminal phase the whole correct set is authorized, so every binding
    // can be told what it is. While incomplete, only the user's own picks carry
    // a verdict — the rest stay unknown rather than being forced to false.
    //
    // `expired` is terminal but `allCorrectSelectedFromVerdict` answers null for
    // it — the deadline passing says nothing about whether the user had picked
    // everything. So the REVEAL is decided here, before that null check, or a
    // timed-out question would surface no correct answers at all.
    const revealed = state.phase === 'resolved' || state.phase === 'expired'
      ? new Set(state.correctOptionTexts.map((text) => norm(text)))
      : null;

    const allCorrectSelected = allCorrectSelectedFromVerdict(state);
    if (allCorrectSelected === null && !revealed) return null;   // idle | checking | error

    for (const b of bindings) {
      const text = b?.option?.text;
      if (revealed) {
        b.isCorrect = revealed.has(norm(text ?? ''));
        continue;
      }
      const own = selectedVerdictFor(state, text);
      if (own !== undefined) b.isCorrect = own;
    }

    const hasCorrectSelection = bindings.some((b) => b.isSelected && b.isCorrect === true);
    const hasIncorrectSelection = bindings.some((b) => b.isSelected && b.isCorrect === false);

    // On `expired` the completion question is unanswered, and an expiry is not
    // an achievement — treat it as not-complete rather than inferring it from
    // the revealed set, which would hand a timed-out question a perfect lock.
    const complete = allCorrectSelected === true;

    return {
      hasCorrectSelection,
      allCorrectSelected: complete,
      isPerfect: complete && !hasIncorrectSelection
    };
  }

  // Re-enable every binding (no locking applies).
  private unlockAllBindings(bindings: OptionBindings[]): void {
    for (const b of bindings) {
      b.disabled = false;
      if (b.option) b.option.active = true;
    }
  }

  // Apply granular per-binding locking and return the set of locked indices.
  private applyGranularLocking(
    bindings: OptionBindings[],
    isPerfect: boolean,
    allCorrectSelected: boolean,
    hasCorrectSelection: boolean,
    resolvedType: QuestionType
  ): Set<number> {
    const locked = new Set<number>();
    for (const b of bindings) {
      // GRANULAR LOCKING:
      // 1. If perfectly resolved, disable everything.
      // 2. If all correct found but not perfect, disable UNSELECTED options ONLY.
      //    (This allows the user to unselect the incorrect ones).
      // 3. If single answer and correct selection found, disable everything.
      let shouldDisable = false;
      if (isPerfect) {
        shouldDisable = true;
      } else if (allCorrectSelected) {
        // Multi-answer: Got all corrects, but maybe some incorrects too.
        // Disable everything EXCEPT the currently selected ones (to allow unselecting).
        shouldDisable = !b.isSelected;
      } else if (resolvedType === QuestionType.SingleAnswer && hasCorrectSelection) {
        // Single-answer: unlock the selected one so it stays 'alive', lock others
        shouldDisable = !b.isSelected;
      }

      b.disabled = shouldDisable;
      if (b.option) b.option.active = !shouldDisable;

      const bIdx = b.index;
      if (shouldDisable && bIdx != null) locked.add(bIdx);
    }
    return locked;
  }

}