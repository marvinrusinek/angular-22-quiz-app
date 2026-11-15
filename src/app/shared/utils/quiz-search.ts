/**
 * Title search for the quiz catalog. Pure and dependency-free.
 *
 * Rules:
 *  - Case-insensitive, TITLE only.
 *  - Words are runs of [a-z0-9]; punctuation and whitespace only separate
 *    words.
 *  - Every search word must be the START of a title word (prefix only, so
 *    "forms" does not match inside "Platforms").
 *  - A search word may also be several CONSECUTIVE title words written
 *    together, the last one possibly cut short: "angularf" is "Angular" +
 *    the start of "Forms". Exact matching only; never combined with typos.
 *  - Search words may appear in any order and need not be adjacent.
 *  - Each search word needs its OWN title words: a title word can never
 *    satisfy two search words, and a joined word uses up every title word
 *    it spans.
 *  - A term with no words (empty, spaces, punctuation only) is an
 *    inactive search and matches everything.
 *
 * Typo tolerance (matchesTitleFuzzy) is a FALLBACK the caller uses only when
 * nothing matches strictly. It never mixes with, or outranks, strict matches.
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

/** An inclusive run of title-word indexes [first, last]. */
type Run = readonly [first: number, last: number];

/**
 * Every run of CONSECUTIVE title words that `word` spells: whole words
 * joined together, the last one possibly only a prefix. A single-word prefix
 * is the one-word run.
 */
function joinedRuns(word: string, titleWords: readonly string[]): Run[] {
  const runs: Run[] = [];
  for (let first = 0; first < titleWords.length; first++) {
    let joined = '';
    for (let last = first; last < titleWords.length; last++) {
      const next = joined + titleWords[last];
      if (next.startsWith(word)) {
        runs.push([first, last]);
        break;
      }
      // Still a strict prefix of the search word: keep joining words.
      if (!word.startsWith(next)) break;
      joined = next;
    }
  }
  return runs;
}

/**
 * Single title words a search word may stand for (no joining). A word that
 * spells consecutive title words ('angularf' = Angular + Forms) is not a
 * typo of the first of them, so those starting positions are vetoed.
 */
function singleRuns(
  word: string,
  titleWords: readonly string[],
  fits: (searchWord: string, titleWord: string) => boolean
): Run[] {
  const spelledAsRun = new Set(
    joinedRuns(word, titleWords)
      .filter(([first, last]) => last > first)
      .map(([first]) => first)
  );
  const runs: Run[] = [];
  for (const [index, titleWord] of titleWords.entries()) {
    if (!spelledAsRun.has(index) && fits(word, titleWord)) {
      runs.push([index, index]);
    }
  }
  return runs;
}

/**
 * True when every search word can be given its OWN run of title words
 * (small backtracking assignment); no title word is used twice.
 */
function assignDistinct(
  searchWords: readonly string[],
  titleWords: readonly string[],
  runsFor: (searchWord: string) => Run[]
): boolean {
  // Longest (most selective) search words first keeps the search shallow.
  const ordered = [...searchWords].sort((x, y) => y.length - x.length);
  const taken = new Array<boolean>(titleWords.length).fill(false);

  const assign = (index: number): boolean => {
    if (index === ordered.length) return true;
    for (const [first, last] of runsFor(ordered[index])) {
      let free = true;
      for (let i = first; i <= last; i++) {
        if (taken[i]) free = false;
      }
      if (!free) continue;
      for (let i = first; i <= last; i++) taken[i] = true;
      if (assign(index + 1)) return true;
      for (let i = first; i <= last; i++) taken[i] = false;
    }
    return false;
  };

  return assign(0);
}

/**
 * Exact match: every search word is a prefix of one title word, or several
 * consecutive title words written together; no title word is used twice.
 */
export function matchesTitleTokens(
  title: string | null | undefined,
  term: string | null | undefined
): boolean {
  const searchWords = tokenizeSearch(term);
  if (searchWords.length === 0) return true;
  const titleWords = tokenizeSearch(title);
  return assignDistinct(searchWords, titleWords, (word) =>
    joinedRuns(word, titleWords)
  );
}

// ── typo tolerance ──────────────────────────────────────────────────────

/**
 * Typos allowed in a search word of this length. Words of 4 letters or fewer
 * get no general edits (one edit changes their meaning too often); a 4-letter
 * word gets only the adjacent swap in `isAdjacentSwap`.
 */
export function maxTypos(word: string): number {
  if (word.length >= 8) return 2;
  if (word.length >= 5) return 1;
  return 0;
}

/**
 * Bounded Damerau (optimal string alignment) distance: insert, delete,
 * substitute, or swap two adjacent letters, each costing 1. Returns
 * `max + 1` as soon as the distance is known to exceed `max`.
 */
export function editDistanceWithin(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;

  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2] + 1);
      }
      row[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/** True when `a` is `b` with exactly one pair of adjacent letters swapped. */
export function isAdjacentSwap(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 2) return false;
  let first = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    first = i;
    break;
  }
  if (first < 0 || first + 1 >= a.length) return false;
  return (
    a[first] === b[first + 1] &&
    a[first + 1] === b[first] &&
    a.slice(first + 2) === b.slice(first + 2)
  );
}

/**
 * A search word fits a title word when it is a prefix of it, or within
 * `maxTypos` edits of the whole word or of its same-length start (so a typo
 * in a half-typed word still matches). A 4-letter word fits when it is one
 * adjacent swap of the word's first four letters ("fomr" for "forms").
 */
function fitsWithTypos(searchWord: string, titleWord: string): boolean {
  if (titleWord.startsWith(searchWord)) return true;
  if (searchWord.length === 4) {
    return isAdjacentSwap(searchWord, titleWord.slice(0, 4));
  }
  const max = maxTypos(searchWord);
  if (max === 0) return false;
  return (
    editDistanceWithin(searchWord, titleWord, max) <= max ||
    editDistanceWithin(searchWord, titleWord.slice(0, searchWord.length), max) <=
      max
  );
}

/**
 * Typo-tolerant version of matchesTitleTokens: same any-order, distinct-word
 * rules, but each search word may also be a near miss (see maxTypos). It
 * works on single title words only: joined-word matching is exact-only. Use
 * it only as a fallback when no title matches exactly.
 */
export function matchesTitleFuzzy(
  title: string | null | undefined,
  term: string | null | undefined
): boolean {
  const searchWords = tokenizeSearch(term);
  if (searchWords.length === 0) return true;
  const titleWords = tokenizeSearch(title);
  return assignDistinct(searchWords, titleWords, (word) =>
    singleRuns(word, titleWords, fitsWithTypos)
  );
}
