import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { AnswerBindingsService } from './answer-bindings.service';
import { AnswerOptionsService } from './answer-options.service';
import { QqcQlOptionBuildService } from '../qqc/qqc-ql-option-build.service';
import type { Option } from '../../../models/Option.model';

/**
 * Building a binding must not consult the answer key.
 *
 * There are six `OptionBindings` constructors in this codebase. Each one used
 * to copy the option's own `correct` flag onto the binding, which made every
 * constructor a second answer-key surface: anything reading `binding.isCorrect`
 * was reading `quiz.json` one hop removed. Two of them are covered here; the
 * other four are covered alongside their own services.
 *
 * `buildFallbackBinding` was the worst of the six. It did not just copy a
 * boolean — it chose the user-visible feedback sentence from the flag, so the
 * answer key reached the screen directly, for options nobody had selected and
 * before any verdict authorized a reveal.
 *
 * Every fixture below either LIES about correctness or omits the field
 * entirely. If construction ever consults it again, these fail.
 */

// jsdom lacks structuredClone; rebuildOptionBindings deep-clones with it.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

const bare = (): Option => ({ optionId: 9, text: 'Bare option' } as Option);
const lyingTrue = (): Option => ({ optionId: 1, text: 'Claims correct', correct: true } as Option);
const lyingFalse = (): Option => ({ optionId: 2, text: 'Claims wrong', correct: false } as Option);

let answerBindings: AnswerBindingsService;
let optionBuild: QqcQlOptionBuildService;

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      AnswerBindingsService,
      AnswerOptionsService,
      QqcQlOptionBuildService
    ]
  });
  answerBindings = TestBed.inject(AnswerBindingsService);
  optionBuild = TestBed.inject(QqcQlOptionBuildService);
});

describe('answer-bindings.buildFallbackBinding', () => {
  it('reports unknown correctness for an option with no `correct` property', () => {
    const b = answerBindings.buildFallbackBinding(bare(), 0);

    expect(b.isCorrect).toBeNull();
    expect(b.highlightCorrect).toBe(false);
    expect(b.highlightIncorrect).toBe(false);
  });

  it('ignores a local correct=true', () => {
    const b = answerBindings.buildFallbackBinding(lyingTrue(), 0);

    expect(b.isCorrect).toBeNull();
    expect(b.highlightCorrect).toBe(false);
  });

  it('ignores a local correct=false — unknown is not "known wrong"', () => {
    const b = answerBindings.buildFallbackBinding(lyingFalse(), 0);

    expect(b.isCorrect).toBeNull();
    expect(b.isCorrect).not.toBe(false);
    expect(b.highlightIncorrect).toBe(false);
  });

  // SECURITY REGRESSION. The answer key must not reach the screen as prose.
  it('does not congratulate an option just because it is locally flagged correct', () => {
    const b = answerBindings.buildFallbackBinding(lyingTrue(), 0);

    expect(b.feedback).toBe('');
    expect(b.feedback).not.toMatch(/great job/i);
  });

  it('does not tell the user an option is wrong from a local flag', () => {
    const b = answerBindings.buildFallbackBinding(lyingFalse(), 0);

    expect(b.feedback).toBe('');
    expect(b.feedback).not.toMatch(/not quite/i);
  });

  it('still preserves feedback the option genuinely carries', () => {
    const withText = { ...lyingTrue(), feedback: '  Authored explanation.  ' } as Option;

    expect(answerBindings.buildFallbackBinding(withText, 0).feedback)
      .toBe('Authored explanation.');
  });

  it('rebuilds a whole array without consulting correctness', () => {
    const rebuilt = answerBindings.rebuildOptionBindings([bare(), lyingTrue(), lyingFalse()]);

    expect(rebuilt).toHaveLength(3);
    expect(rebuilt.every((b) => b.isCorrect === null)).toBe(true);
    expect(rebuilt.every((b) => b.feedback === '')).toBe(true);
  });
});

describe('qqc-ql-option-build.buildOptionBindings', () => {
  it('reports unknown correctness for options with no `correct` property', () => {
    const bindings = optionBuild.buildOptionBindings([bare(), { text: 'Another' } as Option], false);

    expect(bindings).toHaveLength(2);
    expect(bindings.every((b) => b.isCorrect === null)).toBe(true);
    expect(bindings.every((b) => b.highlightCorrect === false)).toBe(true);
    expect(bindings.every((b) => b.highlightIncorrect === false)).toBe(true);
  });

  it('ignores lying local flags in both directions', () => {
    const bindings = optionBuild.buildOptionBindings([lyingTrue(), lyingFalse()], true);

    expect(bindings[0].isCorrect).toBeNull();
    expect(bindings[1].isCorrect).toBeNull();
  });

  // Input type comes from the caller's explicit multi-answer decision, never
  // from counting correct options — a count would collapse every question to a
  // radio group once options arrive without correctness.
  it('renders radio for a single-answer question even with several correct flags', () => {
    const lyingMulti = [lyingTrue(), { ...lyingFalse(), correct: true } as Option];

    expect(optionBuild.buildOptionBindings(lyingMulti, false)[0].appHighlightInputType)
      .toBe('radio');
  });

  it('renders checkbox for a multiple-answer question with only one correct flag', () => {
    expect(optionBuild.buildOptionBindings([lyingTrue(), lyingFalse()], true)[0].appHighlightInputType)
      .toBe('checkbox');
  });

  it('still carries selection state, which is not correctness', () => {
    const selected = { ...bare(), selected: true } as Option;
    const bindings = optionBuild.buildOptionBindings([selected, bare()], false);

    expect(bindings[0].isSelected).toBe(true);
    expect(bindings[1].isSelected).toBe(false);
  });
});
