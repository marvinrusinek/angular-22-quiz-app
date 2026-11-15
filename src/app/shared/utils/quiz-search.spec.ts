import {
  editDistanceWithin,
  hasSearchTokens,
  isAdjacentSwap,
  matchesTitleFuzzy,
  matchesTitleTokens,
  maxTypos,
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
    expect(matchesTitleTokens(FORMS, 'angular forms x')).toBe(false);
    expect(matchesTitleTokens(FORMS, 'angularx')).toBe(false);
    expect(matchesTitleTokens(FORMS, 'ularf')).toBe(false); // not a start
  });

  it('does not match on unrelated words or missing titles', () => {
    expect(matchesTitleTokens(FORMS, 'zzz')).toBe(false);
    expect(matchesTitleTokens(FORMS, 'angular zzz')).toBe(false);
    expect(matchesTitleTokens(null, 'angular')).toBe(false);
    expect(matchesTitleTokens(undefined, 'a')).toBe(false);
    expect(matchesTitleTokens('', 'a')).toBe(false);
  });
});

describe('maxTypos', () => {
  it.each([
    ['a', 0],
    ['rxjs', 0],
    ['abcd', 0],
    ['abcde', 1],
    ['abcdefg', 1],
    ['abcdefgh', 2],
    ['dependency', 2]
  ])('%j allows %i typo(s)', (word, expected) => {
    expect(maxTypos(word)).toBe(expected);
  });
});

describe('editDistanceWithin (bounded Damerau)', () => {
  it('counts insert, delete, substitute and adjacent swap as 1', () => {
    expect(editDistanceWithin('templats', 'templates', 2)).toBe(1);
    expect(editDistanceWithin('templaates', 'templates', 2)).toBe(1);
    expect(editDistanceWithin('tempxates', 'templates', 2)).toBe(1);
    expect(editDistanceWithin('angualr', 'angular', 2)).toBe(1);
    expect(editDistanceWithin('pipse', 'pipes', 2)).toBe(1);
    expect(editDistanceWithin('rotuer', 'router', 2)).toBe(1);
  });

  it('is 0 for equal words and symmetric', () => {
    expect(editDistanceWithin('angular', 'angular', 2)).toBe(0);
    expect(editDistanceWithin('forms', 'froms', 2)).toBe(
      editDistanceWithin('froms', 'forms', 2)
    );
  });

  it('returns max + 1 once the distance exceeds the bound', () => {
    expect(editDistanceWithin('abc', 'xyz', 1)).toBe(2);
    expect(editDistanceWithin('abcdef', 'abc', 2)).toBe(3); // length gap
    expect(editDistanceWithin('kitten', 'sitting', 2)).toBe(3);
  });
});

describe('matchesTitleFuzzy', () => {
  it.each([
    ['templats', 'Templates'],
    ['directves', 'Directives'],
    ['signls', 'Angular Signals'],
    ['materail', 'Angular Material'],
    ['performnace', 'Angular Performance'],
    ['detecton', 'Change Detection'],
    ['typscript', 'TypeScript'],
    ['angualr', 'Angular Forms'],
    ['pipse', 'Pipes'],
    ['rotuer', 'Angular Router'],
    ['compnent archtecture', 'Component Architecture'],
    ['dependancy injection', 'Dependency Injection']
  ])('tolerates the typo in "%s" -> %s', (term, title) => {
    expect(matchesTitleFuzzy(title, term)).toBe(true);
  });

  it('still honours any order and the distinct-word rule', () => {
    expect(matchesTitleFuzzy('Angular Forms', 'froms angular')).toBe(true);
    expect(matchesTitleFuzzy('Angular Forms', 'angualr angualr')).toBe(false);
  });

  it('keeps exact and prefix matches matching', () => {
    expect(matchesTitleFuzzy('Angular Forms', 'angular f')).toBe(true);
    expect(matchesTitleFuzzy('Angular Forms', 'forms angular')).toBe(true);
  });

  it('gives words of 4 letters or fewer no general typo tolerance', () => {
    expect(matchesTitleFuzzy('Pipes', 'pips')).toBe(false); // substitution
    expect(matchesTitleFuzzy('Angular Forms', 'fors')).toBe(false); // deletion
    expect(matchesTitleFuzzy('Advanced DI', 'dj')).toBe(false);
    expect(matchesTitleFuzzy('RxJS', 'rxjz')).toBe(false);
  });

  it('keeps 3-letter and shorter words strictly exact', () => {
    expect(matchesTitleFuzzy('Angular Forms', 'fmo')).toBe(false);
    expect(matchesTitleFuzzy('Advanced DI', 'id')).toBe(false);
    expect(matchesTitleFuzzy('Templates', 'tem')).toBe(true); // plain prefix
  });

  it('allows one typo for 5-7 letters but not two', () => {
    expect(matchesTitleFuzzy('Templates', 'templat')).toBe(true); // prefix
    expect(matchesTitleFuzzy('Templates', 'tempxat')).toBe(true); // 1 typo
    expect(matchesTitleFuzzy('Templates', 'tempxxt')).toBe(false); // 2 typos
  });

  it('allows two typos for 8+ letters but not three', () => {
    expect(matchesTitleFuzzy('Performance', 'perfxrmxnce')).toBe(true);
    expect(matchesTitleFuzzy('Performance', 'perfxrmxnxe')).toBe(false);
  });

  it('does not match unrelated words', () => {
    for (const w of ['react', 'redux', 'python', 'docker', 'hooks', 'state']) {
      expect(matchesTitleFuzzy('Angular Forms', w)).toBe(false);
    }
    expect(matchesTitleFuzzy('Angular Forms', 'zzzzzz')).toBe(false);
  });

  it('is deterministic and treats an empty term as match-all', () => {
    const a = matchesTitleFuzzy('Change Detection', 'detecton');
    expect(matchesTitleFuzzy('Change Detection', 'detecton')).toBe(a);
    expect(matchesTitleFuzzy('Anything', '')).toBe(true);
    expect(matchesTitleFuzzy('Anything', '!!!')).toBe(true);
  });
});

describe('isAdjacentSwap', () => {
  it('is true for exactly one adjacent swap', () => {
    expect(isAdjacentSwap('fomr', 'form')).toBe(true);
    expect(isAdjacentSwap('tmep', 'temp')).toBe(true);
    expect(isAdjacentSwap('rotu', 'rout')).toBe(true);
    expect(isAdjacentSwap('ab', 'ba')).toBe(true);
    expect(isAdjacentSwap('abca', 'acba')).toBe(true);
  });

  it('is false for equal, substituted, distant or different-length words', () => {
    expect(isAdjacentSwap('form', 'form')).toBe(false);
    expect(isAdjacentSwap('fors', 'form')).toBe(false);
    expect(isAdjacentSwap('mrof', 'form')).toBe(false); // not adjacent
    expect(isAdjacentSwap('fomr', 'forms')).toBe(false);
    expect(isAdjacentSwap('abcd', 'acbe')).toBe(false);
    expect(isAdjacentSwap('a', 'a')).toBe(false);
  });
});

describe('joined-word prefixes (exact matching)', () => {
  const FORMS = 'Angular Forms';

  it('matches words written together, the last one possibly cut short', () => {
    expect(matchesTitleTokens(FORMS, 'angularf')).toBe(true);
    expect(matchesTitleTokens(FORMS, 'angularfo')).toBe(true);
    expect(matchesTitleTokens(FORMS, 'angularforms')).toBe(true);
    expect(matchesTitleTokens('Angular-CLI', 'angularc')).toBe(true);
    expect(matchesTitleTokens('Change Detection', 'changede')).toBe(true);
    expect(matchesTitleTokens('Dependency Injection', 'dependencyi')).toBe(true);
  });

  it('joins only CONSECUTIVE words, from the start of a word, in order', () => {
    const title = 'Getting Started with Angular Forms';
    expect(matchesTitleTokens(title, 'startedwith')).toBe(true);
    expect(matchesTitleTokens(title, 'withangularf')).toBe(true);
    expect(matchesTitleTokens(title, 'gettingwith')).toBe(false); // skips one
    expect(matchesTitleTokens(title, 'formsangular')).toBe(false); // reversed
    expect(matchesTitleTokens(FORMS, 'angularforn')).toBe(false); // mismatch
    expect(matchesTitleTokens(FORMS, 'angularx')).toBe(false);
  });

  it('uses up every title word it spans', () => {
    expect(matchesTitleTokens(FORMS, 'angularf forms')).toBe(false);
    expect(matchesTitleTokens(FORMS, 'forms angularf')).toBe(false);
    expect(matchesTitleTokens(FORMS, 'angularf angular')).toBe(false);
    expect(matchesTitleTokens('Angular Forms Basics', 'angularf basics')).toBe(
      true
    );
    expect(matchesTitleTokens('Angular Forms Basics', 'b angularf')).toBe(true);
  });

  it('is not combined with typo tolerance', () => {
    // Only joining could match these; the fuzzy matcher never joins.
    expect(matchesTitleTokens('Component Architecture', 'componentarch')).toBe(
      true
    );
    expect(matchesTitleFuzzy('Component Architecture', 'componentarch')).toBe(
      false
    );
  });

  it('a joined spelling is not a typo of its first word either', () => {
    expect(matchesTitleFuzzy(FORMS, 'angularf')).toBe(false);
    expect(matchesTitleFuzzy(FORMS, 'angularfo')).toBe(false);
    expect(matchesTitleFuzzy(FORMS, 'angularf forms')).toBe(false);
    // ...while a genuine extra letter is still a typo.
    expect(matchesTitleFuzzy('Templates', 'templatess')).toBe(true);
  });
});

describe('four-letter adjacent swaps (fuzzy fallback)', () => {
  it.each([
    ['fomr', 'Angular Forms'],
    ['tmep', 'Templates'],
    ['rotu', 'Angular Router'],
    ['cahn', 'Change Detection'],
    ['htpt', 'Angular HTTP']
  ])('"%s" fits %s', (term, title) => {
    expect(matchesTitleFuzzy(title, term)).toBe(true);
  });

  it('does not fit unrelated titles or non-swap near misses', () => {
    expect(matchesTitleFuzzy('Angular Forms', 'tmep')).toBe(false);
    expect(matchesTitleFuzzy('Templates', 'fomr')).toBe(false);
    expect(matchesTitleFuzzy('Angular Forms', 'fmor')).toBe(false);
    expect(matchesTitleFuzzy('Angular Forms', 'fmo')).toBe(false);
  });
});
