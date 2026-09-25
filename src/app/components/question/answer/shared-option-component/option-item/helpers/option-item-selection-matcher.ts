import { OptionBindings } from '@shared/models/OptionBindings.model';
import { SelectedOption } from '@shared/models/SelectedOption.model';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';

import { QUESTION_ROUTE_REGEX } from '@shared/constants/route-patterns';
import { norm } from '@shared/utils/text-norm';
import { swallow } from '@shared/utils/error-logging';

/**
 * Resolve a usable question index when the input/service value lags behind
 * the URL (refresh on Q2+ sees qIndex=0 before the route resolver runs).
 */
function resolveQIndexFromUrl(qIndex: number): number {
  if (qIndex !== 0) return qIndex;
  try {
    const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
    if (m) {
      const urlIdx = Number(m[1]) - 1;
      if (Number.isFinite(urlIdx) && urlIdx > 0) return urlIdx;
    }
  } catch (err: unknown) { swallow('option-item-selection-matcher.ts resolveQIndexFromUrl', err); }
  return qIndex;
}

export function getSelectionsForBinding(
  selectedOptionService: SelectedOptionService,
  qIndex: number
): any[] {
  const idx = resolveQIndexFromUrl(qIndex);
  const selections = selectedOptionService.getSelectedOptionsForQuestion(idx) ?? [];
  if (selections.length > 0) return selections;
  return selectedOptionService.getRefreshBackup(idx);
}

export function matchesBindingSelection(
  sel: any,
  binding: OptionBindings | undefined,
  displayIndex: number,
  qIndex: number
): boolean {
  const activeQIdx = resolveQIndexFromUrl(qIndex);

  const selQIdx =
    sel.questionIndex ?? (sel as any).qIdx ?? (sel as any).questionIdx;

  if (selQIdx !== undefined && selQIdx !== null && selQIdx !== -1) {
    if (Number(selQIdx) !== activeQIdx) return false;
  }

  if (sel?.selected === false && !sel?.showIcon && !sel?.highlight) {
    return false;
  }

  const selText = norm((sel as any)?.text);
  const bText = norm(binding?.option?.text);
  if (selText && bText) return selText === bText;

  const rawIdx =
    sel?.displayIndex ?? (sel as any)?.index ?? (sel as any)?.idx;
  const normalizedSelectedIndex =
    rawIdx != null && Number.isFinite(Number(rawIdx)) ? Number(rawIdx) : null;

  if (normalizedSelectedIndex != null) {
    if (normalizedSelectedIndex !== displayIndex) return false;

    const selId = sel?.optionId;
    const bId = binding?.option?.optionId;
    const selIdIsReal =
      selId != null && selId !== -1 && String(selId) !== '-1';
    const bIdIsReal =
      bId != null && bId !== -1 && String(bId) !== '-1';
    return !selIdIsReal || !bIdIsReal || String(selId) === String(bId);
  }

  const selId = sel?.optionId;
  const bId = binding?.option?.optionId;
  const selIdIsReal =
    selId != null && selId !== -1 && String(selId) !== '-1';
  const bIdIsReal =
    bId != null && bId !== -1 && String(bId) !== '-1';
  return selIdIsReal && bIdIsReal && String(selId) === String(bId);
}

export function isSelectedForCurrentQuestion(
  selectedOptionService: SelectedOptionService,
  binding: OptionBindings | undefined,
  displayIndex: number,
  qIndex: number
): boolean {
  const selections = getSelectionsForBinding(selectedOptionService, qIndex);
  return selections.some((s: SelectedOption) =>
    matchesBindingSelection(s, binding, displayIndex, qIndex)
  );
}
