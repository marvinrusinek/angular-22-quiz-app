import { Service } from '@angular/core';

import { OptionBindings } from '@shared/models';

@Service()
export class OptionSelectionPolicyService {
  // ── public methods ──────────────────────────────────────────────
  enforceSingleSelection(params: {
    optionBindings: OptionBindings[];
    selectedBinding: OptionBindings;
    showFeedbackForOption: Record<number, boolean>;
    updateFeedbackState: (id: number) => void;
  }): void {
    const { selectedBinding } = params;
    // RESOLVE: optionBindings may be a signal (-clean) or plain array (-main)
    const _raw = (params as any).optionBindings;
    const optionBindings: any[] = typeof _raw === 'function' ? (_raw() ?? []) : (_raw ?? []);

    for (const binding of optionBindings) {
      const isTarget = binding === selectedBinding;

      if (!isTarget && binding.isSelected) {
        if (binding.option) binding.option.selected = false;
        binding.isSelected = false;  // sync both flags
      }
    }
  }
}