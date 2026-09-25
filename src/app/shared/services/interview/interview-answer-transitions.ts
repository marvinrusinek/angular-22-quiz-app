import type { InterviewQuestionViewModel } from '@shared/models/interview/interview-view-models';

/**
 * PURE local selection transitions.
 *
 * These reproduce the audited Interview UI behaviour exactly
 * (interview-options.component.ts:54-70) and never inspect correctness — there
 * is none in the active model to inspect.
 *
 *   single / trueFalse   selecting replaces; selecting the SAME option again
 *                        leaves it selected (it does not clear)
 *   multiple             toggle; may reach empty; may include every option
 */

/** Canonical ascending order, matching what the backend stores and returns. */
export function canonicalize(selectedOptionIds: readonly number[]): number[] {
  return [...new Set(selectedOptionIds)].sort((a, b) => a - b);
}

export function isMultiSelect(question: InterviewQuestionViewModel): boolean {
  return question.type === 'multiple';
}

export function ownsOption(question: InterviewQuestionViewModel, optionId: number): boolean {
  return question.options.some((option) => option.optionId === optionId);
}

/**
 * Apply a click to the current selection and return the COMPLETE next
 * selection — the same replacement payload the backend expects.
 *
 * Returns the current selection unchanged when the option does not belong to
 * the question, so a stale render can never inject a foreign option id.
 */
export function toggleOption(
  question: InterviewQuestionViewModel,
  current: readonly number[],
  optionId: number
): number[] {
  if (!ownsOption(question, optionId)) return canonicalize(current);

  if (!isMultiSelect(question)) {
    // Replacement. Re-clicking the selected option keeps it selected.
    return [optionId];
  }

  const next = new Set(current);
  if (next.has(optionId)) {
    next.delete(optionId);
  } else {
    next.add(optionId);
  }
  return canonicalize([...next]);
}

/** True when two selections are equivalent as sets. */
export function sameSelection(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((value) => set.has(value));
}
