import { Service } from '@angular/core';

import { OptionBindings } from '@shared/models/OptionBindings.model';

@Service()
export class OptionSelectionUiService {
  // ── public methods ──────────────────────────────────────────────

  // Push the newly‐clicked option into history, then synchronize every binding's
  // visual state (selected, highlight, icon, feedback) in one synchronous pass.
  applySingleSelectClick(
    optionBindings: OptionBindings[] | null | undefined,
    rawSelectedId: number | string,
    selectedOptionHistory: (number | string)[]
  ): void {
    // RESOLVE: optionBindings may be a signal (-clean) or plain array (-main)
    const _rawOb = optionBindings as any;
    optionBindings = typeof _rawOb === 'function' ? (_rawOb() ?? []) : (_rawOb ?? []);
    const parsedId =
      typeof rawSelectedId === 'string'
        ? Number.parseInt(rawSelectedId, 10)
        : rawSelectedId;

    if (!Number.isFinite(parsedId)) return;

    // Ignore synthetic "-1 repaint" that runs right after question load
    if (parsedId === -1) return;

    const selectedId = parsedId;

    // Remember every id that has ever been clicked in this question
    if (!selectedOptionHistory.includes(selectedId)) {
      selectedOptionHistory.push(selectedId);
    }

    // Seed history from bindings whose option already reflects a prior click
    // (highlight:true + showIcon:true stamped by rehydrateUiFromState on refresh).
    // selectedOptionHistory is component-local and empty after refresh, so
    // without this, the loop below unhighlights prev-clicked bindings to white.
    for (const b of optionBindings ?? []) {
      const bId = b?.option?.optionId;
      if (bId == null) continue;
      if (b.option?.highlight === true && b.option?.showIcon === true) {
        if (!selectedOptionHistory.includes(bId)) {
          selectedOptionHistory.push(bId);
        }
      }
    }

    // Faster lookups than repeated .includes()
    const historySet = new Set<number | string>(selectedOptionHistory);

    for (const b of optionBindings ?? []) {
      const id = b?.option?.optionId;
      if (id === undefined) continue;

      const isCurrent = id === selectedId;
      const inHistory = historySet.has(id);

      b.option.highlight = isCurrent || inHistory;
      b.option.showIcon = isCurrent || inHistory;

      // Native control state (single truth for selection in UI)
      b.isSelected = isCurrent;

      // Feedback – only current row is true
      if (!b.showFeedbackForOption) b.showFeedbackForOption = {};
      
      b.showFeedbackForOption[id] = isCurrent;

      // Repaint row
      b.directiveInstance?.updateHighlight();
    }
  }
}