/**
 * "All of the above" helpers.
 *
 * The option shuffle can place an "All of the above"-style option anywhere.
 * For display we always want it LAST. Doing this at the render chokepoint
 * (a computed over the option bindings) — rather than at the many upstream
 * option-resolution sites — keeps every setter mutually consistent (nothing
 * diverges to flicker on) while guaranteeing the rendered order is always
 * AOTA-last, regardless of which setter won.
 */

/** True for an "All of the above"-style text (HTML/entities/trailing punctuation ignored). */
export function isAllOfTheAbove(text: unknown): boolean {
  const normalized = String(text ?? '')
    .replace(/<[^>]*>/g, ' ') // strip any HTML tags
    .replace(/&nbsp;/gi, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '') // drop trailing punctuation
    .trim();
  return normalized === 'all of the above';
}

/**
 * Return a NEW array with any "All of the above" item(s) moved to the END,
 * preserving the relative order of everything else. Idempotent — re-applying to
 * an already-pinned array yields the same order, so it can't cause churn.
 * Returns the input unchanged when there's nothing to pin.
 */
export function pinAllOfTheAboveLast<T>(items: T[], getText: (item: T) => unknown): T[] {
  if (!Array.isArray(items) || items.length < 2) return items;
  if (!items.some((item) => isAllOfTheAbove(getText(item)))) return items;
  const rest = items.filter((item) => !isAllOfTheAbove(getText(item)));
  const aota = items.filter((item) => isAllOfTheAbove(getText(item)));
  return [...rest, ...aota];
}

/**
 * Map a 1-based option index in the canonical array to its 1-based index AFTER
 * AOTA is pinned last — i.e. the number the user actually sees. Used so
 * feedback/FET "Option N" text matches the pinned display order. Returns the
 * input index unchanged when there's nothing to remap (no AOTA, out of range).
 */
export function pinnedIndex1Based<T>(
  items: T[],
  canonicalIndex1Based: number,
  getText: (item: T) => unknown
): number {
  if (!Array.isArray(items) || canonicalIndex1Based < 1 || canonicalIndex1Based > items.length) {
    return canonicalIndex1Based;
  }
  const target = items[canonicalIndex1Based - 1];
  const pinned = pinAllOfTheAboveLast(items, getText);
  const pos = pinned.indexOf(target);
  return pos >= 0 ? pos + 1 : canonicalIndex1Based;
}
