import {
  hasSearchTokens,
  matchesTitleTokens,
  tokenizeSearch
} from './quiz-search';

describe('tokenizeSearch', () => {
  it('lowercases and splits on anything that is not a letter or digit', () => {
    expect(tokenizeSearch('Angular-CLI!')).toEqual(['angular', 'cli']);
    expect(tokenizeSearch('  A   b\tc\n')).toEqual(['a', 'b', 'c']);
    expect(tokenizeSearch('RxJS 7')).toEqual(['rxjs', '7']);
  });

  it('returns [] for empty, blank, punctuation-only and nullish input', () => {
    expect(tokenizeSearch('')).toEqual([]);
    expect(tokenizeSearch('   ')).toEqual([]);
    expect(tokenizeSearch('!!! ... --')).toEqual([]);
    expect(tokenizeSearch(null)).toEqual([]);
    expect(tokenizeSearch(undefined)).toEqual([]);
  });
});

describe('hasSearchTokens', () => {
  it.each([
    ['', false],
    ['   ', false],
    ['!!!', false],
    ['- . ,', false],
    ['a', true],
    [' angular ', true],
    ['!angular!', true]
  ])('%j -> %s', (term, expected) => {
    expect(hasSearchTokens(term)).toBe(expected);
  });
});

describe('matchesTitleTokens', () => {
  const FORMS = 'Angular Forms';

  it('matches "angular f" (partial, in order)', () => {
    expect(matchesTitleTokens(FORMS, 'angular f')).toBe(true);
    expect(matchesTitleTokens(FORMS, 'angular for')).toBe(true);
    expect(matchesTitleTokens(FORMS, 'angular forms')).toBe(true);
  });

  it('matches "forms angular": order no longer matters', () => {
    expect(matchesTitleTokens(FORMS, 'forms angular')).toBe(true);
    expect(matchesTitleTokens(FORMS, 'f ang')).toBe(true);
  });

  it('matches non-consecutive title words', () => {
    const title = 'Getting Started with Angular Forms';
    expect(matchesTitleTokens(title, 'getting forms')).toBe(true);
    expect(matchesTitleTokens(title, 'forms getting')).toBe(true);
    expect(matchesTitleTokens(title, 'started angular')).toBe(true);
    expect(matchesTitleTokens(title, 'with getting forms')).toBe(true);
  });

  it('is case-insensitive on both sides', () => {
    expect(matchesTitleTokens('ANGULAR forms', 'Angular FORMS')).toBe(true);
    expect(matchesTitleTokens('angular forms', 'ANGULAR F')).toBe(true);
  });

  it('ignores extra whitespace and punctuation in the search', () => {
    expect(matchesTitleTokens(FORMS, '  angular    f  ')).toBe(true);
    expect(matchesTitleTokens(FORMS, '\tforms,\nangular!')).toBe(true);
    expect(matchesTitleTokens('Angular-CLI', 'angular cli')).toBe(true);
    expect(matchesTitleTokens('Angular-CLI', 'cli-angular')).toBe(true);
  });

  it('never lets one title word satisfy two search words', () => {
    expect(matchesTitleTokens('Angular Forms', 'angular angular')).toBe(false);
    expect(matchesTitleTokens('Angular Forms', 'ang an a')).toBe(false);
    expect(matchesTitleTokens('Angular Forms', 'f fo')).toBe(false);
  });

  it('matches repeated search words when the title repeats them', () => {
    const title = 'Angular Angular Forms';
    expect(matchesTitleTokens(title, 'angular angular')).toBe(true);
    expect(matchesTitleTokens(title, 'ang angular forms')).toBe(true);
    expect(matchesTitleTokens(title, 'angular angular angular')).toBe(false);
  });

  it('finds an assignment even when a greedy choice would fail', () => {
    // "a" can start both words, "ab" only the second: "a" must take word 1.
    expect(matchesTitleTokens('alpha abc', 'a ab')).toBe(true);
    expect(matchesTitleTokens('alpha abc', 'ab a')).toBe(true);
    expect(matchesTitleTokens('abc abd', 'ab ab')).toBe(true);
    expect(matchesTitleTokens('abc xyz', 'ab ab')).toBe(false);
  });

  it('treats empty, blank and punctuation-only searches as match-all', () => {
    for (const term of ['', '   ', '!!!', '- . ,', null, undefined]) {
      expect(matchesTitleTokens(FORMS, term)).toBe(true);
      expect(matchesTitleTokens('', term)).toBe(true);
    }
  });

  it('is prefix-only: a search word must START a title word', () => {
    expect(matchesTitleTokens('Change Detection', 'ange')).toBe(false);
    expect(matchesTitleTokens(FORMS, 'orms')).toBe(false);
    expect(matchesTitleTokens('Cross Platforms', 'forms')).toBe(false);
    expect(matchesTitleTokens(FORMS, 'angularf')).toBe(false);
    expect(matchesTitleTokens(FORMS, 'angular forms x')).toBe(false);
  });

  it('does not match on unrelated words or missing titles', () => {
    expect(matchesTitleTokens(FORMS, 'zzz')).toBe(false);
    expect(matchesTitleTokens(FORMS, 'angular zzz')).toBe(false);
    expect(matchesTitleTokens(null, 'angular')).toBe(false);
    expect(matchesTitleTokens(undefined, 'a')).toBe(false);
    expect(matchesTitleTokens('', 'a')).toBe(false);
  });
});
