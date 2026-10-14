/**
 * Contract tests for QuizService's signal + BehaviorSubject sync mirror.
 *
 * Background (from `feedback_cqcc_sync_bs_mirrors`):
 *   QuizService maintains a SIGNAL source-of-truth `currentQuestionIndexSig`
 *   paired with a BehaviorSubject MIRROR `currentQuestionIndexSubject`. The
 *   pair exists because `toObservable(sig)` emits ASYNCHRONOUSLY via
 *   microtask, but the FET / display-text pipelines rely on SYNC emission
 *   (via `.getValue()` or BehaviorSubject `.subscribe()`). Migrating to
 *   pure signals would re-introduce the FET flash bug fixed previously.
 *
 *   The sync contract is enforced by the `set currentQuestionIndex(v)`
 *   setter at quiz.service.ts:57-60:
 *
 *     set currentQuestionIndex(v: number) {
 *       this.currentQuestionIndexSig.set(v);
 *       this.currentQuestionIndexSubject.next(v);
 *     }
 *
 * These tests lock down:
 *   - Writing via the setter updates BOTH sig and subject
 *   - Reading via either accessor returns the same current value
 *   - Direct `currentQuestionIndexSig.set(v)` BYPASSES the subject (this
 *     is the trap — documented as a tripwire)
 *   - The observable accessor emits the new value when the setter is used
 */
// jsdom doesn't expose structuredClone in some versions; polyfill before
// the QuizService module is loaded (its field initializer calls it).
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: any) => JSON.parse(JSON.stringify(v));
}

import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { take } from 'rxjs/operators';

import { QuizService } from './quiz.service';

describe('QuizService sync-BS invariants', () => {
  let service: QuizService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) }
        }
      ]
    });
    service = TestBed.inject(QuizService);
    // Reset to known state. Use the setter to keep sig + subject paired.
    service.currentQuestionIndex = 0;
  });

  // ── setter writes to BOTH sources ─────────────────────────────────

  it('setter writes propagate to both currentQuestionIndexSig and currentQuestionIndexSubject', () => {
    service.currentQuestionIndex = 3;
    expect(service.currentQuestionIndexSig()).toBe(3);
    expect(service.currentQuestionIndexSubject.getValue()).toBe(3);
  });

  it('multiple setter writes keep the pair in sync', () => {
    for (const idx of [0, 5, 2, 9, 1]) {
      service.currentQuestionIndex = idx;
      expect(service.currentQuestionIndexSig()).toBe(idx);
      expect(service.currentQuestionIndexSubject.getValue()).toBe(idx);
    }
  });

  it('getter returns the signal value (single source of truth)', () => {
    service.currentQuestionIndex = 4;
    expect(service.currentQuestionIndex).toBe(4);
    expect(service.currentQuestionIndex).toBe(service.currentQuestionIndexSig());
  });

  // ── trap documentation: direct sig write desynchronizes ───────────

  it('DOCUMENTS TRAP: writing directly to the signal bypasses the subject (de-sync)', () => {
    service.currentQuestionIndex = 1; // both in sync at 1
    expect(service.currentQuestionIndexSig()).toBe(1);
    expect(service.currentQuestionIndexSubject.getValue()).toBe(1);

    // Bypass the setter — write directly to the signal. The subject is NOT
    // updated. This is the regression class the memory warns about: anyone
    // who writes `quizService.currentQuestionIndexSig.set(...)` instead of
    // `quizService.currentQuestionIndex = ...` breaks the sync invariant.
    service.currentQuestionIndexSig.set(7);
    expect(service.currentQuestionIndexSig()).toBe(7);
    expect(service.currentQuestionIndexSubject.getValue()).toBe(1); // STALE
  });

  it('DOCUMENTS TRAP: writing directly to the subject bypasses the signal', () => {
    service.currentQuestionIndex = 2;
    expect(service.currentQuestionIndexSig()).toBe(2);
    expect(service.currentQuestionIndexSubject.getValue()).toBe(2);

    // Same trap in the other direction
    service.currentQuestionIndexSubject.next(8);
    expect(service.currentQuestionIndexSubject.getValue()).toBe(8);
    expect(service.currentQuestionIndexSig()).toBe(2); // STALE
  });

  // ── observable accessor reflects setter writes ────────────────────

  it('currentQuestionIndex$ (observable accessor) emits the value written via the setter', (done) => {
    // The accessor IS the subject as an observable, so subscribing
    // immediately gets the current (BehaviorSubject) value. After a setter
    // write the next sub gets the new value.
    service.currentQuestionIndex = 4;
    service.currentQuestionIndex$.pipe(take(1)).subscribe((v) => {
      expect(v).toBe(4);
      done();
    });
  });

  // ── round-trip / convergence ──────────────────────────────────────

  it('after the trap, restoring via the setter brings the pair back into sync', () => {
    service.currentQuestionIndex = 0;
    service.currentQuestionIndexSig.set(99); // de-sync
    expect(service.currentQuestionIndexSig()).toBe(99);
    expect(service.currentQuestionIndexSubject.getValue()).toBe(0);

    service.currentQuestionIndex = 3; // setter writes both
    expect(service.currentQuestionIndexSig()).toBe(3);
    expect(service.currentQuestionIndexSubject.getValue()).toBe(3);
  });
});
