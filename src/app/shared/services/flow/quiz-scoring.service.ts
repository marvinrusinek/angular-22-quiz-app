import { Service } from '@angular/core';

import { QuizQuestion } from '@shared/models/QuizQuestion.model';
import { SelectedOption } from '@shared/models/SelectedOption.model';

/**
 * Manages scoring, progress calculation, and expected-correct-count
 * initialization. Extracted from QuizComponent to reduce its size.
 */
@Service()
export class QuizScoringService {
  // ── public methods ──────────────────────────────────────────────

  // ═══════════════════════════════════════════════════════════════
  // BUILD IMMEDIATE SELECTIONS FOR SCORING
  // ═══════════════════════════════════════════════════════════════

  buildImmediateSelectionsForScoring(
    index: number,
    existingSelections: SelectedOption[],
    clickedOption: SelectedOption,
    isSingleAnswerQuestion: boolean
  ): SelectedOption[] {
    const canonicalClicked: SelectedOption = {
      ...clickedOption,
      questionIndex: index,
      selected:
        clickedOption?.selected !== undefined
          ? clickedOption.selected
          : true
    };

    if (isSingleAnswerQuestion) {
      if (canonicalClicked.selected === false) return [];
      return [canonicalClicked];
    }

    const merged = new Map<string, SelectedOption>();
    for (const selection of existingSelections) {
      const key = String(selection?.optionId ?? selection?.text ?? '').trim();
      if (!key) continue;
      merged.set(key, selection);
    }

    const clickedKey = String(
      canonicalClicked?.optionId ?? canonicalClicked?.text ?? ''
    ).trim();

    if (clickedKey) {
      const wasPreviouslySelected = merged.has(clickedKey);
      const explicitSelectedState =
        clickedOption?.selected ??
        (clickedOption as any)?.checked ??
        (clickedOption as any)?.isSelected;
      const shouldSelect = explicitSelectedState === undefined
        ? !wasPreviouslySelected
        : explicitSelectedState === true;

      if (!shouldSelect) {
        merged.delete(clickedKey);
      } else {
        merged.set(clickedKey, canonicalClicked);
      }
    }

    return Array.from(merged.values());
  }

  // ═══════════════════════════════════════════════════════════════
  // HYDRATE QUESTION SET
  // ═══════════════════════════════════════════════════════════════

  hydrateQuestionSet(questions: QuizQuestion[] | null | undefined): QuizQuestion[] {
    if (!Array.isArray(questions) || questions.length === 0) return [];

    return questions.map((question) => ({
      ...question,
      options: Array.isArray(question.options)
        ? question.options.map((option) => ({
          ...option,
          correct: (option.correct as any) === true || (option.correct as any) === 'true',
        }))
        : []
    }));
  }
}