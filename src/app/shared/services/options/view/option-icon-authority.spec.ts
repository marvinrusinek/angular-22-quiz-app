import { OptionService } from './option.service';
import type { OptionBindings } from '../../../models/OptionBindings.model';

/**
 * THE ICON REPORTS A VERDICT — IT DOES NOT REACH ONE.
 *
 * ── The regression this pins ──────────────────────────────────────
 *
 * Clicking the CORRECT answer stamped a ✗ on it for as long as `/check` was in
 * flight, alongside the red background fixed in 130eb7a1.
 *
 * `getOptionIcon` decided correctness itself:
 *
 *     if (option.correct) return 'check';
 *     if (binding.isSelected && !option.correct) return 'close';
 *
 * An API-backed option carries NO `correct` field — `questionFromApiView` never
 * sets one, and `topic-quiz-content.spec.ts` pins that. So `!option.correct` was
 * vacuously true and every selected option got the cross the instant it was
 * clicked, before any verdict existed.
 *
 * Correctness is now an argument. The caller supplies what the verdict
 * authorized, and `undefined` — the default — renders nothing rather than
 * inventing a result.
 *
 * There is deliberately no `option.correct` anywhere in these tests: the whole
 * point is that the field cannot influence the outcome.
 */

let service: OptionService;

beforeEach(() => {
  service = new OptionService();
});

/** A binding with NO `correct` field — the shape the API actually returns. */
const binding = (over: Partial<OptionBindings> = {}): OptionBindings =>
  ({
    option: { optionId: 1, text: 'map' },
    isSelected: false,
    index: 0,
    ...over
  }) as unknown as OptionBindings;

describe('the icon while nothing is authorized', () => {
  it('shows NO icon for a selected option with an unknown verdict', () => {
    // THE REGRESSION: this returned 'close' for the entire pending window.
    expect(service.getOptionIcon(binding({ isSelected: true }), 0, undefined)).toBe('');
  });

  it('shows no icon for an unselected option with an unknown verdict', () => {
    expect(service.getOptionIcon(binding({ isSelected: false }), 0, undefined)).toBe('');
  });

  it('defaults to no icon when the caller supplies no correctness at all', () => {
    // A caller that cannot establish correctness must get the neutral render,
    // never a fabricated one.
    expect(service.getOptionIcon(binding({ isSelected: true }), 0)).toBe('');
  });
});

describe('the icon once the verdict authorizes a result', () => {
  it('shows check when the option is authorized correct', () => {
    expect(service.getOptionIcon(binding({ isSelected: true }), 0, true)).toBe('check');
  });

  it('shows close when the SELECTED option is authorized wrong', () => {
    expect(service.getOptionIcon(binding({ isSelected: true }), 0, false)).toBe('close');
  });

  it('shows NO close on an option the player never selected, even when wrong', () => {
    // The cross is a statement about the player's own pick. Stamping it on an
    // untouched option discloses the standing of something they never chose.
    expect(service.getOptionIcon(binding({ isSelected: false }), 0, false)).toBe('');
  });

  it('still shows check on a correct option the player never selected — the reveal', () => {
    expect(service.getOptionIcon(binding({ isSelected: false }), 0, true)).toBe('check');
  });
});

describe('showIcon === false suppresses everything', () => {
  it.each([[true], [false], [undefined]] as const)(
    'renders no icon when showIcon is false, whatever the verdict says (%s)',
    (correctness) => {
      const b = binding({ option: { optionId: 1, text: 'map', showIcon: false }, isSelected: true } as any);
      expect(service.getOptionIcon(b, 0, correctness)).toBe('');
    }
  );
});

describe('a local correct flag cannot influence the icon', () => {
  it('ignores option.correct === true when the verdict says unknown', () => {
    // The bank field is the thing this migration removes. Even when present and
    // lying, it must not produce an icon.
    const b = binding({ option: { optionId: 1, text: 'map', correct: true }, isSelected: true } as any);
    expect(service.getOptionIcon(b, 0, undefined)).toBe('');
  });

  it('ignores option.correct === false when the verdict says correct', () => {
    const b = binding({ option: { optionId: 1, text: 'map', correct: false }, isSelected: true } as any);
    expect(service.getOptionIcon(b, 0, true)).toBe('check');
  });
});
