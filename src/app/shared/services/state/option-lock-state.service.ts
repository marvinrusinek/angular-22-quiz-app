import { Service } from '@angular/core';

@Service()
export class OptionLockStateService {
  // ── properties ──────────────────────────────────────────────────
  private _lockedByQuestion = new Map<number, Set<string | number>>();
  private _questionLocks = new Set<number>();
  public _lockedOptionsMap: Map<number, Set<number>> = new Map();

  // ── public methods ──────────────────────────────────────────────

  // ── Option-level locking ───────────────────────────────────

  isOptionLocked(qIndex: number, optId: string | number): boolean {
    return this._lockedByQuestion.get(qIndex)?.has(String(optId)) ?? false;
  }

  lockOption(qIndex: number, optId: string | number): void {
    let set = this._lockedByQuestion.get(qIndex);
    if (!set) {
      set = new Set<string | number>();
      this._lockedByQuestion.set(qIndex, set);
    }
    set.add(String(optId));
  }

  unlockOption(qIndex: number, optId: string | number): void {
    const set = this._lockedByQuestion.get(qIndex);
    if (set) set.delete(String(optId));
  }

  unlockAllOptionsForQuestion(qIndex: number): void {
    this._lockedByQuestion.delete(qIndex);
  }

  lockMany(qIndex: number, optIds: (string | number)[]): void {
    let set = this._lockedByQuestion.get(qIndex);
    if (!set) {
      set = new Set<string | number>();
      this._lockedByQuestion.set(qIndex, set);
    }
    for (const id of optIds) set!.add(String(id));
  }

  // ── Question-level locking ─────────────────────────────────

  lockQuestion(qIndex: number): void {
    if (Number.isFinite(qIndex)) this._questionLocks.add(qIndex);
  }

  unlockQuestion(qIndex: number): void {
    this._questionLocks.delete(qIndex);
  }

  isQuestionLocked(qIndex: number): boolean {
    return this._questionLocks.has(qIndex);
  }

  resetLocksForQuestion(qIndex: number): void {
    this._lockedByQuestion.delete(qIndex);
    this._questionLocks.delete(qIndex);
  }

  // ── Bulk clear ─────────────────────────────────────────────

  clearLockedOptionsMap(qIndex?: number): void {
    if (qIndex !== undefined) {
      this._lockedOptionsMap.delete(qIndex);
    } else {
      this._lockedOptionsMap.clear();
    }
  }

  clearAll(): void {
    this._lockedByQuestion.clear();
    this._questionLocks.clear();
    this._lockedOptionsMap.clear();
  }
}
