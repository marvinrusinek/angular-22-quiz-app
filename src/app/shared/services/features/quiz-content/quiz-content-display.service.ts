import { inject, Service, signal } from '@angular/core';
import { combineLatest, Observable } from 'rxjs';
import {
  distinctUntilChanged, map, shareReplay, startWith
} from 'rxjs/operators';

import { ExplanationTextService, FETPayload } from '@shared/services/features/explanation/explanation-text.service';

@Service()
export class QuizContentDisplayService {
  // ═══════════════════════════════════════════════════════════════════════
  // FET State
  // ═══════════════════════════════════════════════════════════════════════

  // Lock flag to prevent displayText$ from overwriting FET
  readonly _fetLockedSig = signal<boolean>(false);
  readonly _lockedForIndexSig = signal<number>(-1);

  // Session-based tracking: which questions have had FET displayed this session
  _fetDisplayedThisSession = new Set<number>();

  _lastQuestionTextByIndex = new Map<number, string>();

  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);

  // ═══════════════════════════════════════════════════════════════════════
  // Formatted Explanation Observables (factory methods)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Creates the reactive FET observable that combines the current index
   * with service cache updates to guarantee latest data.
   */
  createFormattedExplanation$(
    currentIndex$: Observable<number>
  ): Observable<FETPayload> {
    return combineLatest([
      currentIndex$,
      this.explanationTextService.explanationsUpdated
    ]).pipe(
      map(([idx, explanations]) => {
        const explanation = explanations[idx]?.explanation || '';
        return { idx, text: explanation, token: 0 } as FETPayload;
      }),
      distinctUntilChanged((a, b) => a.idx === b.idx && a.text === b.text),
      shareReplay(1)
    );
  }

  /**
   * Creates the active FET text observable that resolves from
   * both fetByIndex map and formattedExplanations record.
   */
  createActiveFetText$(
    currentIndex$: Observable<number>
  ): Observable<string> {
    return combineLatest([
      currentIndex$,
      this.explanationTextService.explanationsUpdated.pipe(startWith({}))
    ]).pipe(
      map(([idx]) => {
        const safeIdx = Number.isFinite(idx) ? Number(idx) : 0;
        const fromMap = this.explanationTextService.fetByIndex?.get(safeIdx)?.trim() || '';
        const fromRecord = this.explanationTextService.formattedExplanations?.[safeIdx]?.explanation?.trim() || '';
        return fromMap || fromRecord;
      }),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

}
