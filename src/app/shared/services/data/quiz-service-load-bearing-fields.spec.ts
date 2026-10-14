/**
 * Load-bearing field tripwires on QuizService.
 *
 * These tests exist NOT to test behavior, but to assert that specific
 * fields exist on the service with the expected shape. Each one
 * corresponds to a 2026-05-31 regression where the field LOOKED dead
 * (no grep hits, no obvious subscribers) but removing it broke the
 * browser. The hidden consumer was never identified.
 *
 * If you arrive at one of these tests because it's failing — STOP. The
 * field you removed has a subscriber the grep can't find. Restore the
 * field and re-read the linked memory before proceeding.
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
import { Subject } from 'rxjs';
import { of } from 'rxjs';

import { QuizService } from './quiz.service';

describe('QuizService load-bearing fields (tripwires)', () => {
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
  });

  /**
   * MEMORY: feedback_optionsSource_subject_load_bearing
   *
   * 2026-05-31: removed `optionsSource` because it had 2 writers and 0
   * subscribers per grep. Broke option-highlight rehydration on revisit
   * (Q5/Q6 unshuff). Reverted in commit `ed199f82`. The hidden subscriber
   * was never identified.
   *
   * If THIS test fails, you have removed `optionsSource`. Do not remove
   * it. Read feedback_optionsSource_subject_load_bearing.md.
   */
  it('exposes optionsSource as a Subject<Option[]> (load-bearing — see memory)', () => {
    expect(service.optionsSource).toBeDefined();
    expect(service.optionsSource).toBeInstanceOf(Subject);
    // Must support .next() without throwing — that's what 2 callers do
    expect(() => service.optionsSource.next([])).not.toThrow();
  });

  /**
   * QuizService.questions$ feeds the rest of the app's reactive surface.
   * If removed, downstream BehaviorSubject subscriptions break.
   */
  it('exposes questions$ as an Observable', () => {
    expect(service.questions$).toBeDefined();
    expect(typeof service.questions$.subscribe).toBe('function');
  });

  /**
   * The sync mirror BehaviorSubject for the current index is paired with
   * the signal — both must remain. See feedback_cqcc_sync_bs_mirrors.
   */
  it('exposes currentQuestionIndexSubject as a BehaviorSubject (sync-BS mirror — see memory)', () => {
    expect(service.currentQuestionIndexSubject).toBeDefined();
    expect(typeof service.currentQuestionIndexSubject.next).toBe('function');
    expect(typeof service.currentQuestionIndexSubject.getValue).toBe('function');
  });

  /**
   * Pristine helpers (added 2026-05-31 in commit b256e9fb). Must remain
   * even though they are unused by today's consumers — they exist for
   * future migration off inline `for (quiz) for (pq)` walks.
   */
  it('exposes getPristineCorrectTextsForQuestion / Options / Count helpers', () => {
    expect(typeof service.getPristineCorrectTextsForQuestion).toBe('function');
    expect(typeof service.getPristineCorrectOptionsForQuestion).toBe('function');
    expect(typeof service.getPristineCorrectCountForQuestion).toBe('function');
  });
});
