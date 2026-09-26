import { Service, inject } from '@angular/core';

import { SelectedOption } from '@shared/models';

import { OptionIdResolverService } from './option-id-resolver.service';

/**
 * Map-keyed feedback cache.
 *
 * Components manage their own `showFeedbackForOption` properties for
 * UI rendering; this service only stores the per-question feedback
 * map that qqc-reset-manager rebuilds + reads when re-entering an
 * answered question.
 */
@Service()
export class OptionFeedbackStateService {
  // ── injects ─────────────────────────────────────────────────────
  private idResolver = inject(OptionIdResolverService);

  // ── properties ──────────────────────────────────────────────────
  private feedbackByQuestion = new Map<number, Record<string, boolean>>();

  // ── public methods ──────────────────────────────────────────────

  // ── Read ────────────────────────────────────────────────────

  getFeedbackForQuestion(questionIndex: number): Record<string, boolean> {
    return { ...(this.feedbackByQuestion.get(questionIndex) ?? {}) };
  }

  // ── Write / Publish ─────────────────────────────────────────

  deleteFeedbackForQuestion(questionIndex: number): void {
    this.feedbackByQuestion.delete(questionIndex);
  }

  // ── Sync / Build ────────────────────────────────────────────

  syncFeedbackForQuestion(
    questionIndex: number,
    selections: SelectedOption[],
    _currentQuestionIndex: number | null | undefined,
    isMultiAnswer: boolean
  ): void {
    if (!Array.isArray(selections) || selections.length === 0) {
      this.feedbackByQuestion.delete(questionIndex);
      return;
    }

    const feedbackMap = this.buildFeedbackMap(questionIndex, selections, isMultiAnswer);
    this.feedbackByQuestion.set(questionIndex, feedbackMap);
  }

  buildFeedbackMap(
    questionIndex: number,
    selections: SelectedOption[],
    isMultiAnswer: boolean
  ): Record<string, boolean> {
    const feedbackMap: Record<string, boolean> = {};

    const targetSelections = isMultiAnswer && selections.length > 0
      ? [selections[selections.length - 1]] : selections;

    for (const selection of targetSelections ?? []) {
      if (!selection) continue;

      const keys = this.collectFeedbackKeys(questionIndex, selection);
      for (const key of keys) {
        if (key) feedbackMap[String(key)] = true;
      }
    }

    return feedbackMap;
  }

  // ── Republish ───────────────────────────────────────────────

  republishFeedbackForQuestion(
    questionIndex: number,
    selections: SelectedOption[],
    _currentQuestionIndex: number | null | undefined,
    isMultiAnswer: boolean
  ): void {
    if (!Array.isArray(selections) || selections.length === 0) {
      this.feedbackByQuestion.delete(questionIndex);
      return;
    }

    let feedback = this.feedbackByQuestion.get(questionIndex);
    if (!feedback || Object.keys(feedback).length === 0) {
      feedback = this.buildFeedbackMap(questionIndex, selections, isMultiAnswer);
      this.feedbackByQuestion.set(questionIndex, feedback);
    }
  }

  // ── Bulk clear ──────────────────────────────────────────────

  clearAll(): void {
    this.feedbackByQuestion.clear();
  }

  // ── private methods ─────────────────────────────────────────────
  private collectFeedbackKeys(
    questionIndex: number,
    selection: SelectedOption
  ): Array<string | number> {
    const keys = new Set<string | number>();

    const normalizedSelectionId = this.idResolver.normalizeOptionId(selection.optionId);
    if (normalizedSelectionId && String(normalizedSelectionId) !== '-1') {
      keys.add(normalizedSelectionId);
    }

    const numericSelectionId = this.idResolver.extractNumericId(selection.optionId);
    if (numericSelectionId !== null && String(numericSelectionId) !== '-1') {
      keys.add(numericSelectionId);
    }

    if (selection.optionId !== undefined && selection.optionId !== null && String(selection.optionId) !== '-1') {
      keys.add(selection.optionId);
    }

    const options = this.idResolver.getKnownOptions(questionIndex);
    if (options.length > 0) {
      const resolvedIndex = this.idResolver.resolveOptionIndexFromSelection(
        options,
        selection
      );

      if (
        resolvedIndex !== null &&
        resolvedIndex >= 0 &&
        resolvedIndex < options.length
      ) {
        const option: any = options[resolvedIndex];

        const normalizedOptionId = this.idResolver.normalizeOptionId(option?.optionId);
        if (normalizedOptionId && String(normalizedOptionId) !== '-1') {
          keys.add(normalizedOptionId);
        }

        const numericOptionId = this.idResolver.extractNumericId(option?.optionId);
        if (numericOptionId !== null && String(numericOptionId) !== '-1') {
          keys.add(numericOptionId);
        }

        if (option?.optionId !== undefined && option?.optionId !== null && String(option.optionId) !== '-1') {
          keys.add(option.optionId);
        }

        keys.add(resolvedIndex);
      }
    }

    return Array.from(keys);
  }
}