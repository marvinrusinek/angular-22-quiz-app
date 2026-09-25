import { inject, Service } from '@angular/core';
import { BehaviorSubject, merge, Observable, ReplaySubject } from 'rxjs';
import { distinctUntilChanged, map, startWith } from 'rxjs/operators';

import { ExplanationFormatterService } from './explanation-formatter.service';

import { swallow } from '@shared/utils/error-logging';

/**
 * Owns the per-question reactive storage that drives explanation/FET
 * rendering: text streams (`_textMap`, `_byIndex`) and visibility gates
 * (`_gate`, `_gatesByIndex`). Extracted from
 * `ExplanationDisplayStateService` so that service can stay under 1k
 * lines and so the storage layer is testable in isolation from the
 * lock/visibility/context state that lives on the parent.
 */
@Service()
export class ExplanationGateService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly formatter = inject(ExplanationFormatterService);

  // Per-index BehaviorSubject mirrors of the latest explanation text.
  public readonly _byIndex = new Map<number, BehaviorSubject<string | null>>();
  // Per-index BehaviorSubject gates ("should this index render now").
  public readonly _gate = new Map<number, BehaviorSubject<boolean>>();
  // Legacy/secondary gates by index — closed by external nav reset paths.
  public readonly _gatesByIndex = new Map<number, BehaviorSubject<boolean>>();
  // Per-index ReplaySubject text streams (preferred over _byIndex).
  private readonly _textMap = new Map<number, { text$: ReplaySubject<string> }>();

  // Coalesced gate write — only emits when the value actually changes.
  setGate(index: number, show: boolean): void {
    const idx = Math.max(0, Number(index) || 0);
    if (!this._gate.has(idx)) {
      this._gate.set(idx, new BehaviorSubject<boolean>(false));
    }
    const bs = this._gate.get(idx)!;
    if (bs.getValue() !== show) bs.next(show);
  }

  // Lazily create the per-index text + gate streams.
  getOrCreate(index: number): {
    text$: ReplaySubject<string>;
    gate$: BehaviorSubject<boolean>;
  } {
    let textEntry = this._textMap.get(index);
    if (!textEntry) {
      textEntry = { text$: new ReplaySubject<string>(1) };
      this._textMap.set(index, textEntry);
    }

    if (!this._byIndex.has(index)) {
      this._byIndex.set(index, new BehaviorSubject<string | null>(null));
    }

    if (!this._gate.has(index)) {
      this._gate.set(index, new BehaviorSubject<boolean>(false));
    }

    return {
      text$: textEntry.text$,
      gate$: this._gate.get(index)!
    };
  }

  // Reactive merge of per-index stream + formatter dictionary updates.
  getExplanationText$(index: number): Observable<string | null> {
    const { text$ } = this.getOrCreate(index);
    const existing =
      this.formatter.formattedExplanations[index]?.explanation ||
      this.formatter.fetByIndex.get(index) || '';

    return merge(
      text$,
      this.formatter.explanationsUpdated$.pipe(
        map(dict => dict[index]?.explanation || ''),
        distinctUntilChanged()
      )
    ).pipe(
      startWith(existing),
      distinctUntilChanged()
    );
  }

  // Close the secondary `_gatesByIndex` entry for one index, if present.
  closeGateForIndex(index: number): void {
    const gate = this._gatesByIndex.get(index);
    if (gate) gate.next(false);
  }

  // Close the primary `_gate` entry for one index, if present.
  closePrimaryGate(index: number): void {
    try {
      this._gate.get(index)?.next(false);
    } catch (err: unknown) { swallow('explanation-gate.service.ts closePrimaryGate', err); }
  }

  // Drop the text-stream entry for a single index (used by purge flows).
  deleteText(index: number): void {
    this._textMap?.delete?.(index);
  }

  // Drop every text-stream entry (used by full reset).
  clearTextMap(): void {
    this._textMap?.clear?.();
  }

  // Clear the secondary gates map (used by closeAllGates).
  clearGatesByIndex(): void {
    this._gatesByIndex.clear();
  }
}