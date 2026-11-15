/**
 * Title search for the quiz catalog. Pure and dependency-free.
 *
 * Rules:
 *  - Case-insensitive, TITLE only.
 *  - Words are runs of [a-z0-9]; punctuation and whitespace only separate
 *    words.
 *  - Every search word must be the START of a title word (prefix only, so
 *    "forms" does not match inside "Platforms").
 *  - Search words may appear in any order and need not be adjacent.
 *  - Each search word needs its OWN title word: one title word can never
 *    satisfy two search words.
 *  - A term with no words (empty, spaces, punctuation only) is an
 *    inactive search and matches everything.
 */

const WORD = /[a-z0-9]+/g;

/** Lowercased words of `text`; [] for empty, blank or punctuation-only. */
export function tokenizeSearch(text: string | null | undefined): string[] {
  return (text ?? '').toLowerCase().match(WORD) ?? [];
}

/** True when `term` contains at least one searchable word. */
export function hasSearchTokens(term: string | null | undefined): boolean {
  return tokenizeSearch(term).length > 0;
}

/** True when every search word maps to a distinct title word it starts. */
export function matchesTitleTokens(
  title: string | null | undefined,
  term: string | null | undefined
): boolean {
  const searchWords = tokenizeSearch(term);
  if (searchWords.length === 0) return true;

  const titleWords = tokenizeSearch(title);
  if (searchWords.length > titleWords.length) return false;

  // Longest (most selective) search words first keeps the search shallow.
  const ordered = [...searchWords].sort((a, b) => b.length - a.length);
  const taken = new Array<boolean>(titleWords.length).fill(false);

  const assign = (index: number): boolean => {
    if (index === ordered.length) return true;
    for (let i = 0; i < titleWords.length; i++) {
      if (taken[i] || !titleWords[i].startsWith(ordered[index])) continue;
      taken[i] = true;
      if (assign(index + 1)) return true;
      taken[i] = false;
    }
    return false;
  };

  return assign(0);
}
