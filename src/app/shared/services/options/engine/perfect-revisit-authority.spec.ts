import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { SharedOptionBindingService } from './shared-option-binding.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import type { OptionBindings } from '../../../models/OptionBindings.model';

/**
 * Restoring a question that was already answered perfectly.
 *
 * The restore path decided which options to light up and which to grey out by
 * reading `option.correct` — so the visual state of a revisited question was a
 * direct rendering of the answer key. That is a disclosure surface even though
 * the question is over: it means the bank, not the user's earned result, is
 * what shapes the screen.
 *
 * Two authorized sources replace it. A perfect revisit is TERMINAL, so the
 * verdict's correct set is legitimately available. When no verdict was
 * recorded — a revisit in a fresh session — the user's own remembered picks
 * are used instead, and on a perfect answer those ARE the correct set, so the
 * fallback is exact rather than approximate.
 *
 * Every fixture below carries `correct` flags that LIE. If the bank ever
 * shapes this state again, these fail.
 */

// jsdom lacks structuredClone; the binding service clones options with it.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

let service: SharedOptionBindingService;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' }
    ]
  });
  service = TestBed.inject(SharedOptionBindingService);
});

/** Reach the private restore helper without loosening its visibility. */
const applyResolved = (
  b: OptionBindings,
  match: any,
  authorized: ReadonlySet<string> | null
) => (service as any).applyResolvedBindingState(b, match, authorized);

const binding = (text: string, correct?: boolean): OptionBindings =>
  ({
    option: { optionId: 1, text, ...(correct === undefined ? {} : { correct }) },
    isSelected: false,
    isCorrect: null
  }) as unknown as OptionBindings;

describe('the verdict decides what a perfect revisit shows', () => {
  const authorized = new Set(['map', 'filter']);

  it('lights up a correct option the user picked', () => {
    // Local flag says WRONG; the verdict says right. The verdict wins.
    const b = binding('map', false);
    applyResolved(b, { selected: true }, authorized);

    expect(b.isSelected).toBe(true);
    expect(b.option.highlight).toBe(true);
    expect((b.option as any).active).toBe(true);
  });

  it('greys an option the verdict does not list, whatever the bank claims', () => {
    // Local flag says CORRECT; the verdict does not list it. Stays greyed.
    const b = binding('Observable', true);
    applyResolved(b, { selected: true }, authorized);

    expect(b.isSelected).toBe(false);
    expect(b.option.highlight).toBe(false);
    expect((b.option as any).active).toBe(false);
  });

  it('works on options with no `correct` property at all', () => {
    const b = binding('filter');
    applyResolved(b, { selected: true }, authorized);

    expect((b.option as any).active).toBe(true);
    expect(b.option.showIcon).toBe(true);
  });

  it('locks every option on a revisit, correct or not', () => {
    const right = binding('map', false);
    const wrong = binding('Observable', true);
    applyResolved(right, { selected: true }, authorized);
    applyResolved(wrong, null, authorized);

    expect(right.disabled).toBe(true);
    expect(wrong.disabled).toBe(true);
  });
});

describe('with no verdict recorded, the user\'s own picks are the authority', () => {
  it('lights up what the user actually chose', () => {
    // No verdict (fresh session). The bank says this option is wrong; the
    // user's remembered pick says they chose it, and on a PERFECT answer
    // chosen means correct.
    const b = binding('map', false);
    applyResolved(b, { selected: true }, null);

    expect(b.isSelected).toBe(true);
    expect((b.option as any).active).toBe(true);
  });

  it('greys what the user did not choose, even if the bank calls it correct', () => {
    const b = binding('filter', true);
    applyResolved(b, null, null);

    expect(b.isSelected).toBe(false);
    expect((b.option as any).active).toBe(false);
  });

  it('treats a previously-clicked marker as a pick', () => {
    // showIcon without `selected` is how a restored earlier click is recorded.
    const b = binding('map');
    applyResolved(b, { selected: false, showIcon: true }, null);

    expect(b.isSelected).toBe(true);
    expect(b.option.showIcon).toBe(true);
  });
});

describe('option text identity is shuffle-safe', () => {
  it('matches by text, so display order cannot mis-assign state', () => {
    const authorized = new Set(['filter']);
    // Reversed display order; 'filter' is authorized wherever it sits.
    const first = binding('Observable', true);
    const second = binding('filter', false);
    applyResolved(first, { selected: true }, authorized);
    applyResolved(second, { selected: true }, authorized);

    expect((first.option as any).active).toBe(false);
    expect((second.option as any).active).toBe(true);
  });

  it('tolerates whitespace and case drift in the option text', () => {
    const b = binding('  MAP  ');
    applyResolved(b, { selected: true }, new Set(['map']));

    expect((b.option as any).active).toBe(true);
  });
});
