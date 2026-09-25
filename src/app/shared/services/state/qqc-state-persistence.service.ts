import { Service } from '@angular/core';

import { Option } from '@shared/models/Option.model';
import { swallow } from '@shared/utils/error-logging';

/**
 * Parameters for saving QQC state to sessionStorage.
 */
export interface QqcSaveStateParams {
  questionIndex: number;
  explanationText: string;
  displayMode: string;
  optionsToDisplay: Option[];
  selectedOptions: any[];
  feedbackText: string;
}

/**
 * Raw data restored from sessionStorage.
 * The component is responsible for applying this to its own state.
 */
export interface QqcRestoredState {
  explanationText: string;
  displayMode: 'question' | 'explanation';
  parsedOptions: any[] | null;
  selectedOptions: any[];
  feedbackText: string;
}

@Service()
export class QqcStatePersistenceService {
  // ── public methods ──────────────────────────────────────────────

  /**
   * Saves quiz question state to sessionStorage.
   * Preserves explanation text, display mode, options, selected options,
   * and feedback text keyed by question index.
   */
  saveState(params: QqcSaveStateParams): void {
    try {
      const { questionIndex } = params;

      if (params.explanationText) {
        sessionStorage.setItem(
          `explanationText_${questionIndex}`,
          params.explanationText
        );
      }

      if (params.displayMode) {
        sessionStorage.setItem(
          `displayMode_${questionIndex}`,
          params.displayMode
        );      }

      if (params.optionsToDisplay?.length > 0) {
        sessionStorage.setItem(
          `options_${questionIndex}`,
          JSON.stringify(params.optionsToDisplay)
        );
      }

      if (params.selectedOptions?.length > 0) {
        sessionStorage.setItem(
          `selectedOptions_${questionIndex}`,
          JSON.stringify(params.selectedOptions)
        );
      }

      if (params.feedbackText) {
        sessionStorage.setItem(`feedbackText_${questionIndex}`, params.feedbackText);
      }
    } catch (err) {
      swallow('qqc-state-persistence.service#1', err);
    }
  }

  /**
   * Reads quiz question state from sessionStorage.
   * Returns raw parsed data; the component applies it to its own state.
   */
  restoreState(questionIndex: number): QqcRestoredState {
    const storageIndex = !Number.isNaN(questionIndex) ? questionIndex : 0;

    const explanationKey = `explanationText_${storageIndex}`;
    const displayModeKey = `displayMode_${storageIndex}`;
    const optionsKey = `options_${storageIndex}`;
    const selectedOptionsKey = `selectedOptions_${storageIndex}`;
    const feedbackKey = `feedbackText_${storageIndex}`;

    // Restore explanation text. Read ONLY the per-question key — the
    // legacy non-indexed 'explanationText' fallback was last written by
    // whichever question saved most recently (typically Q1 after a
    // forward walk), so falling back to it leaks Q1's state into Q3's
    // restore on visibility-change / direct URL load. Same pattern for
    // displayMode, options, selectedOptions, feedbackText below.
    const explanationText = sessionStorage.getItem(explanationKey) || '';

    // Restore display mode (per-question key only)
    const rawDisplayMode = sessionStorage.getItem(displayModeKey);
    const displayMode: 'question' | 'explanation' =
      rawDisplayMode === 'explanation' ? 'explanation' : 'question';

    // Restore options (per-question key only)
    let parsedOptions: any[] | null = null;
    const optionsData = sessionStorage.getItem(optionsKey);
    if (optionsData) {
      try {
        const parsed = JSON.parse(optionsData);
        if (Array.isArray(parsed) && parsed.length > 0) parsedOptions = parsed;
      } catch (err) {
        swallow('qqc-state-persistence.service#2', err);
      }
    }

    // Restore selected options (per-question key only)
    let selectedOptions: any[] = [];
    const selectedOptionsData = sessionStorage.getItem(selectedOptionsKey);
    if (selectedOptionsData) {
      try {
        const parsed = JSON.parse(selectedOptionsData);
        if (Array.isArray(parsed) && parsed.length > 0) {
          selectedOptions = parsed.filter((o: any) => o.optionId !== undefined);
        }
      } catch (err) {
        swallow('qqc-state-persistence.service#3', err);
      }
    }

    // Restore feedback text (per-question key only)
    const feedbackText = sessionStorage.getItem(feedbackKey) || '';

    return {
      explanationText,
      displayMode,
      parsedOptions,
      selectedOptions,
      feedbackText
    };
  }
}