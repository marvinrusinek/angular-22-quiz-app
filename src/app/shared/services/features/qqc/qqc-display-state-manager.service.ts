import { Service } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuestionPayload } from '../../../models/QuestionPayload.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { isOptionCorrect } from '../../../utils/is-option-correct';

/**
 * Manages option display preparation and render-readiness logic for QQC.
 * Extracted from QuizQuestionComponent to reduce its size.
 *
 * This service handles pure data transformations for options display.
 * The component retains subject emissions, cdRef calls, and sharedOptionComponent interactions.
 */
@Service()
export class QqcDisplayStateManagerService {

  /**
   * Builds display-ready options from a source question.
   * Returns null if the question has no valid options.
   * Extracted from setOptionsToDisplay().
   */
  buildOptionsToDisplay(
    sourceQuestion: QuizQuestion | null | undefined
  ): Option[] | null {
    if (!sourceQuestion || !Array.isArray(sourceQuestion.options)) return null;

    const validOptions = (sourceQuestion.options ?? []).filter(
      (o: Option) => !!o && typeof o === 'object'
    );
    if (!validOptions.length) return null;

    return validOptions.map((opt: Option, index: number) => ({
      ...opt,
      optionId: opt.optionId ?? index,
      active: opt.active ?? true,
      feedback: opt.feedback ?? '',
      showIcon: opt.showIcon ?? false,
      selected: false,
      highlighted: false
    }));
  }

  /**
   * Compares incoming options with current and determines if a swap is needed.
   * Returns the new options array (with reset selection/highlight flags),
   * a reactive form group, and the serialized representation.
   * Returns null if no change is needed.
   * Extracted from updateOptionsSafely().
   */
  prepareOptionSwap(params: {
    newOptions: Option[];
    currentOptionsJson: string;
  }): {
    needsSwap: boolean;
    cleanedOptions: Option[];
    formGroup: FormGroup;
    serialized: string;
  } {
    const incoming = JSON.stringify(params.newOptions);
    const needsSwap = incoming !== params.currentOptionsJson;

    if (needsSwap) {
      // Clear previous highlight / form flags before we clone
      for (const o of params.newOptions) {
        o.selected = false;
        o.highlight = false;
        o.showIcon = false;
      }

      // Rebuild the reactive form
      const formGroup = new FormGroup({});
      for (const o of params.newOptions) {
        formGroup.addControl(
          `opt_${o.optionId}`,
          new FormControl(false)
        );
      }

      return {
        needsSwap: true,
        cleanedOptions: [...params.newOptions],
        formGroup,
        serialized: incoming
      };
    }

    return {
      needsSwap: false,
      cleanedOptions: params.newOptions,
      formGroup: new FormGroup({}),
      serialized: incoming
    };
  }

  /**
   * Hydrates component state from a QuestionPayload.
   * Returns the derived state without mutating anything.
   * Returns null if hydration should be skipped.
   * Extracted from hydrateFromPayload().
   */
  hydrateFromPayload(params: {
    payload: QuestionPayload;
    currentQuestionText: string | undefined;
    isAlreadyRendered: boolean;
  }): {
    shouldSkip: boolean;
    currentQuestion: QuizQuestion;
    optionsToDisplay: Option[];
    explanationToDisplay: string;
    serializedPayload: string;
  } | null {
    const incomingQuestionText = params.payload?.question?.questionText?.trim();
    const currentQuestionText = params.currentQuestionText?.trim();

    // Skip if same question text and already rendered
    if (
      incomingQuestionText &&
      incomingQuestionText === currentQuestionText &&
      params.isAlreadyRendered
    ) return null;

    const { question, options, explanation } = params.payload;

    return {
      shouldSkip: false,
      currentQuestion: question,
      optionsToDisplay: structuredClone(options),
      explanationToDisplay: explanation?.trim() || '',
      serializedPayload: JSON.stringify(params.payload)
    };
  }

  /**
   * Determines render readiness from current option state.
   * Extracted from updateShouldRenderOptions().
   */
  computeRenderReadiness(options: Option[] | null | undefined): boolean {
    return Array.isArray(options) && options.length > 0;
  }

  /**
   * Applies display order indices to options.
   * Extracted from applyDisplayOrder().
   */
  applyDisplayOrder(options: Option[] | null | undefined): Option[] {
    if (!Array.isArray(options)) return [];
    return options.map((option, index) => ({ ...option, displayOrder: index }));
  }

  /**
   * Resolves correctness and builds display-ready options from a question's
   * raw options and answer values. Returns the mapped options with correct,
   * selected, and displayOrder fields set.
   * Extracted from QuizQuestionComponent.setQuestionOptions().
   */
  buildOptionsWithCorrectness(question: QuizQuestion): Option[] {
    const options = question.options ?? [];

    if (!Array.isArray(options) || options.length === 0) return [];

    const answerValues = (question.answer ?? [])
      .map((answer: any) => answer?.value)
      .filter((value: any): value is Option['value'] => value !== undefined && value !== null);

    // ABSENT CORRECTNESS IS PRESERVED AS ABSENT.
    //
    // This stamped `correct: resolveCorrect(option)` onto every option, and
    // `resolveCorrect` answers false when it cannot tell. An API-sourced option
    // carries no `correct` property and no `answer` array to fall back on, so
    // every option came out of here flagged `correct: false` — a fabricated
    // claim that nothing is correct, written onto the objects the rest of the
    // app reads.
    //
    // That is worse than leaving the field off: `undefined` means "nobody has
    // said", which downstream code tests for, while `false` is an assertion no
    // authority made. Same rule as the producer cleanup in 9b054bb5, and the
    // shape `shared-option-init` already uses.
    const resolveCorrect = (option: Option): boolean | undefined => {
      if (option.correct !== undefined) return isOptionCorrect(option);

      if (Array.isArray(answerValues) && answerValues.length > 0) {
        return answerValues.includes(option.value);
      }

      return undefined;   // unknown, not "not correct"
    };

    return options.map((option, index) => {
      const correct = resolveCorrect(option);
      return {
        ...option,
        ...(correct === undefined ? {} : { correct }),
        selected: false,
        displayOrder: index
      };
    });
  }

  /**
   * Builds clean options for a route change: resets feedback, showIcon, and active state.
   * Extracted from handleRouteChanges().
   */
  buildCleanOptionsForRouteChange(question: QuizQuestion): Option[] {
    const originalOptions = question.options ?? [];
    return originalOptions.map((opt) => ({
      ...opt,
      active: true,
      feedback: undefined,
      showIcon: false
    }));
  }

  /**
   * Determines if the page visibility change should suppress display state updates.
   * Returns true if the update should be suppressed.
   * Extracted from safeSetDisplayState().
   */
  shouldSuppressDisplayState(params: {
    visibilityRestoreInProgress: boolean;
    suppressDisplayStateUntil: number;
  }): boolean {
    return params.visibilityRestoreInProgress || performance.now() < params.suppressDisplayStateUntil;
  }

  /**
   * Disables all option bindings and options to display.
   * Returns the updated arrays for the component to apply.
   * Extracted from disableAllBindingsAndOptions() in QuizQuestionComponent.
   */
  disableAllBindingsAndOptions(
    optionBindings: OptionBindings[],
    optionsToDisplay: Option[]
  ): { optionBindings: OptionBindings[]; optionsToDisplay: Option[] } {
    const disabledBindings = (optionBindings ?? []).map(binding => {
      const updated = { ...binding, disabled: true } as OptionBindings;
      if (updated.option) {
        updated.option = { ...updated.option, active: false } as Option;
      }
      return updated;
    });
    const disabledOptions = (optionsToDisplay ?? []).map(option => ({
      ...option, active: false
    }));
    return { optionBindings: disabledBindings, optionsToDisplay: disabledOptions };
  }
}