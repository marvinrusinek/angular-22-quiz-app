import { Service, inject } from '@angular/core';

import { OptionBindings } from '@shared/models';

import { SelectedOptionService } from '@shared/services/state/selectedoption.service';

@Service()
export class OptionLockService {
  // ── injects ─────────────────────────────────────────────────────
  private selectedOptionService = inject(SelectedOptionService);

  // ── public methods ──────────────────────────────────────────────
  isLocked(
    binding: OptionBindings,
    displayIndex: number,
    questionIndex: number
  ): boolean {
    try {
      // Prefer stable optionId; fallback to display index
      const id = binding.option.optionId ?? displayIndex;
      return this.selectedOptionService.isOptionLocked(questionIndex, id);
    } catch {
      return false;
    }
  }
}