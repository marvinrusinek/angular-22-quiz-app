import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import { QuestionVerdictService } from './question-verdict.service';
import { QuestionVerdictError } from './question-verdict.types';
import { setQuizDataCache } from '../../../quiz-data-cache';
import type { Quiz } from '../../../models/Quiz.model';

/**
 * The Topic Quiz correctness authority.
 *
 * The rules asserted here are REPRODUCED from the shipped app, not designed:
 * single/trueFalse resolve on any answer, and multiple resolves on
 * `correctSet ⊆ selectedSet` rather than exact equality. The backend's
 * `/check` endpoint implements the identical rules, so these tests double as
 * the parity contract for the later data-source flip.
 */

/** Mirrors the real bank's conventions, including its round-trip hazards. */
const BANK = [
  {
    quizId: 'rxjs',
    milestone: 'RxJS',
    questions: [
      {
        questionText: 'Which answer is correct?',
        explanation: 'Because a Subject multicasts.',
        options: [
          { text: 'A multicast observable', correct: true },
          { text: 'A pipe' },
          { text: 'A directive' }
        ]
      },
      {
        questionText: 'Select every operator',
        explanation: 'map and filter are operators.',
        options: [
          { text: 'map', correct: true },
          { text: 'filter', correct: true },
          { text: 'Observable' },
          { text: 'Subject' }
        ]
      },
      {
        questionText: 'Is a Subject also an Observable?',
        explanation: 'Subject extends Observable.',
        options: [{ text: 'True', correct: true }, { text: 'False' }]
      },
      {
        // HTML-like option text, exactly as the real bank contains.
        questionText: 'How else can Array&lt;number&gt; be written in <code>TypeScript</code>?',
        explanation: 'Generic array syntax.',
        options: [
          { text: '<router-outlet>', correct: true },
          { text: "this.http.get<User>('/api/users/1')" }
        ]
      },
      {
        // Non-ASCII and whitespace-sensitive.
        questionText: '  Does   café — naïve — résumé  survive?  ',
        explanation: 'Unicode — em dash.',
        options: [{ text: 'Yes — précisément', correct: true }, { text: 'Non' }]
      }
    ]
  },
  {
    quizId: 'signals',
    milestone: 'Signals',
    questions: [
      {
        questionText: 'What does computed() return?',
        explanation: 'A read-only signal.',
        options: [{ text: 'A read-only signal', correct: true }, { text: 'A promise' }]
      }
    ]
  }
] as unknown as Quiz[];

let service: QuestionVerdictService;

const check = (quizId: string, questionText: string, selected: readonly string[]) =>
  firstValueFrom(service.checkAnswer(quizId, questionText, selected));

beforeEach(() => {
  // Fresh copy per test — jsdom here has no structuredClone.
  setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);
  TestBed.configureTestingModule({ providers: [QuestionVerdictService] });
  service = TestBed.inject(QuestionVerdictService);
});

afterEach(() => setQuizDataCache([], []));

describe('single-answer questions', () => {
  const Q = 'Which answer is correct?';

  it('a CORRECT selection resolves, with the correct set and explanation', async () => {
    const result = await check('rxjs', Q, ['A multicast observable']);

    expect(result).toEqual({
      status: 'resolved',
      correct: true,
      correctOptionTexts: ['A multicast observable'],
      explanation: 'Because a Subject multicasts.'
    });
  });

  it('an INCORRECT selection also resolves — the app reveals on first click', async () => {
    const result = await check('rxjs', Q, ['A pipe']);

    expect(result.status).toBe('resolved');
    expect((result as { correct: boolean }).correct).toBe(false);
    expect((result as { correctOptionTexts: readonly string[] }).correctOptionTexts)
      .toEqual(['A multicast observable']);
  });

  it('rejects two selections on a single-answer question', async () => {
    await expect(check('rxjs', Q, ['A pipe', 'A directive'])).rejects.toThrow(QuestionVerdictError);
  });

  it('an empty selection is incomplete, not an error', async () => {
    const result = await check('rxjs', Q, []);
    expect(result).toEqual({ status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 1 });
  });
});

describe('trueFalse questions', () => {
  const Q = 'Is a Subject also an Observable?';

  it('a correct selection resolves', async () => {
    const result = await check('rxjs', Q, ['True']);
    expect(result.status).toBe('resolved');
    expect((result as { correct: boolean }).correct).toBe(true);
  });

  it('an incorrect selection resolves with correct: false', async () => {
    const result = await check('rxjs', Q, ['False']);
    expect(result.status).toBe('resolved');
    expect((result as { correct: boolean }).correct).toBe(false);
  });
});

describe('multiple-answer questions use the SUPERSET rule', () => {
  const Q = 'Select every operator';   // correct: map, filter

  it('one correct of several → incomplete', async () => {
    expect(await check('rxjs', Q, ['map'])).toEqual({
      status: 'incomplete',
      selectedVerdicts: [{ text: 'map', correct: true }],
      remainingCorrectCount: 1
    });
  });

  it('one incorrect → incomplete, with a verdict for that pick only', async () => {
    expect(await check('rxjs', Q, ['Observable'])).toEqual({
      status: 'incomplete',
      selectedVerdicts: [{ text: 'Observable', correct: false }],
      remainingCorrectCount: 2
    });
  });

  it('some correct plus one incorrect → incomplete', async () => {
    expect(await check('rxjs', Q, ['map', 'Observable'])).toEqual({
      status: 'incomplete',
      selectedVerdicts: [
        { text: 'map', correct: true },
        { text: 'Observable', correct: false }
      ],
      remainingCorrectCount: 1
    });
  });

  it('ALL correct → resolved', async () => {
    expect(await check('rxjs', Q, ['map', 'filter'])).toEqual({
      status: 'resolved',
      correct: true,
      correctOptionTexts: ['map', 'filter'],
      explanation: 'map and filter are operators.'
    });
  });

  it('ALL correct PLUS one incorrect → resolved AND correct', async () => {
    // The shipped behaviour: a stray wrong pick neither blocks completion nor
    // costs the point. The UI force-deselects it on resolution.
    const result = await check('rxjs', Q, ['map', 'filter', 'Observable']);

    expect(result.status).toBe('resolved');
    expect((result as { correct: boolean }).correct).toBe(true);
    expect((result as { correctOptionTexts: readonly string[] }).correctOptionTexts).toEqual(['map', 'filter']);
  });

  it('missing one correct plus one incorrect → incomplete', async () => {
    const result = await check('rxjs', Q, ['filter', 'Subject']);
    expect(result.status).toBe('incomplete');
    expect((result as { remainingCorrectCount: number }).remainingCorrectCount).toBe(1);
  });

  it('remainingCorrectCount counts only MISSING CORRECT options', async () => {
    const both = await check('rxjs', Q, ['Observable', 'Subject']);
    expect((both as { remainingCorrectCount: number }).remainingCorrectCount).toBe(2);
  });

  it('NEVER leaks unselected correctness before resolution', async () => {
    const result = await check('rxjs', Q, ['map']);

    // 'filter' is correct but unselected — naming it would let partial play
    // enumerate the answer key one click at a time.
    expect(JSON.stringify(result)).not.toContain('filter');
    expect(result).not.toHaveProperty('correctOptionTexts');
    expect(result).not.toHaveProperty('explanation');
  });
});

describe('expiry reveal', () => {
  it('returns the full correct set and explanation', async () => {
    const result = await firstValueFrom(
      service.revealExpiredQuestion('rxjs', 'Select every operator')
    );

    expect(result).toEqual({
      status: 'expired',
      correctOptionTexts: ['map', 'filter'],
      explanation: 'map and filter are operators.'
    });
  });

  it('works with a partial selection already recorded', async () => {
    await check('rxjs', 'Select every operator', ['map']);
    const result = await firstValueFrom(
      service.revealExpiredQuestion('rxjs', 'Select every operator')
    );

    expect(result.status).toBe('expired');
    expect(service.verdictFor('rxjs', 'Select every operator').phase).toBe('expired');
    expect(service.verdictFor('rxjs', 'Select every operator').correctOptionTexts)
      .toEqual(['map', 'filter']);
  });
});

describe('invalid input fails safely and identically', () => {
  it.each([
    ['unknown quiz', 'nope', 'Which answer is correct?', ['A pipe']],
    ['unknown question', 'rxjs', 'No such question', ['A pipe']],
    ['unknown option', 'rxjs', 'Which answer is correct?', ['No such option']],
    ['option from another question', 'rxjs', 'Which answer is correct?', ['map']],
    ['question from another quiz', 'rxjs', 'What does computed() return?', ['A promise']],
    ['duplicate selection', 'rxjs', 'Select every operator', ['map', 'map']],
    ['too many selections', 'rxjs', 'Is a Subject also an Observable?', ['True', 'False', 'x']],
    ['blank question text', 'rxjs', '   ', ['A pipe']],
    ['blank option text', 'rxjs', 'Which answer is correct?', ['  ']]
  ])('rejects %s', async (_label, quizId, questionText, selected) => {
    await expect(check(quizId, questionText, selected as string[]))
      .rejects.toThrow(QuestionVerdictError);
  });

  it('rejects malformed input without throwing something unexpected', async () => {
    for (const bad of [null, undefined, 'not an array', 42, [null], [42]]) {
      await expect(check('rxjs', 'Which answer is correct?', bad as never))
        .rejects.toThrow(QuestionVerdictError);
    }
  });

  it('gives the SAME message for every rejection — no oracle', async () => {
    const messages = new Set<string>();
    for (const selected of [['No such option'], ['map'], ['A pipe', 'A pipe']]) {
      try {
        await check('rxjs', 'Which answer is correct?', selected);
      } catch (err) {
        messages.add((err as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });

  it('a failed check leaves the LAST CONFIRMED state intact', async () => {
    await check('rxjs', 'Select every operator', ['map']);
    const before = service.verdictFor('rxjs', 'Select every operator');

    await expect(check('rxjs', 'Select every operator', ['bogus'])).rejects.toThrow();

    const after = service.verdictFor('rxjs', 'Select every operator');
    expect(after.phase).toBe('error');
    // The confirmed verdict is NOT discarded — a failed check must never be
    // shown as though it were a recorded answer.
    expect(after.selectedVerdicts.get('map')).toBe(true);
    expect(after.remainingCorrectCount).toBe(before.remainingCorrectCount);
  });
});

describe('text fidelity', () => {
  it('handles HTML-like option text exactly', async () => {
    const Q = 'How else can Array&lt;number&gt; be written in <code>TypeScript</code>?';
    const result = await check('rxjs', Q, ['<router-outlet>']);

    expect(result.status).toBe('resolved');
    expect((result as { correct: boolean }).correct).toBe(true);
    expect((result as { correctOptionTexts: readonly string[] }).correctOptionTexts)
      .toEqual(['<router-outlet>']);
  });

  it('matches a question whose text contains tags and entities', async () => {
    const result = await check(
      'rxjs',
      'How else can Array&lt;number&gt; be written in <code>TypeScript</code>?',
      ["this.http.get<User>('/api/users/1')"]
    );
    expect(result.status).toBe('resolved');
    expect((result as { correct: boolean }).correct).toBe(false);
  });

  it('preserves non-ASCII text and returns the EXACT stored strings', async () => {
    const result = await check('rxjs', '  Does   café — naïve — résumé  survive?  ', ['Yes — précisément']);

    expect(result.status).toBe('resolved');
    expect((result as { correctOptionTexts: readonly string[] }).correctOptionTexts)
      .toEqual(['Yes — précisément']);
  });

  it('normalizes case and whitespace for MATCHING but not for OUTPUT', async () => {
    const result = await check('rxjs', '  WHICH   answer is Correct?  ', ['  a MULTICAST observable ']);

    expect(result.status).toBe('resolved');
    // Returns the stored casing, never the caller's.
    expect((result as { correctOptionTexts: readonly string[] }).correctOptionTexts)
      .toEqual(['A multicast observable']);
  });
});

describe('state tracking', () => {
  const Q = 'Select every operator';

  it('starts idle for an unseen question', () => {
    expect(service.verdictFor('rxjs', Q).phase).toBe('idle');
    expect(service.hasResolved('rxjs', Q)).toBe(false);
  });

  it('records incomplete state with per-selection verdicts', async () => {
    await check('rxjs', Q, ['map', 'Observable']);
    const state = service.verdictFor('rxjs', Q);

    expect(state.phase).toBe('incomplete');
    expect(state.selectedOptionTexts).toEqual(['map', 'Observable']);
    expect(state.remainingCorrectCount).toBe(1);
    expect(state.isResolvedCorrect).toBeNull();
    expect(state.correctOptionTexts).toEqual([]);
    expect(state.explanation).toBeNull();
  });

  it('records resolved state with the reveal', async () => {
    await check('rxjs', Q, ['map', 'filter']);
    const state = service.verdictFor('rxjs', Q);

    expect(state.phase).toBe('resolved');
    expect(state.isResolvedCorrect).toBe(true);
    expect(state.correctOptionTexts).toEqual(['map', 'filter']);
    expect(state.explanation).toBe('map and filter are operators.');
    expect(service.hasResolved('rxjs', Q)).toBe(true);
  });

  it('verdictForOption answers only for SELECTED options', async () => {
    await check('rxjs', Q, ['map']);

    expect(service.verdictForOption('rxjs', Q, 'map')).toBe(true);
    // Unselected — null, not `true`, even though it IS correct.
    expect(service.verdictForOption('rxjs', Q, 'filter')).toBeNull();
    expect(service.verdictForOption('rxjs', Q, 'Observable')).toBeNull();
  });

  it('keys state per quiz and per question', async () => {
    await check('rxjs', Q, ['map', 'filter']);

    expect(service.verdictFor('rxjs', Q).phase).toBe('resolved');
    expect(service.verdictFor('rxjs', 'Which answer is correct?').phase).toBe('idle');
    expect(service.verdictFor('signals', 'What does computed() return?').phase).toBe('idle');
  });

  it('treats case/whitespace variants as the SAME question', async () => {
    await check('rxjs', Q, ['map', 'filter']);
    expect(service.verdictFor('rxjs', '  select   EVERY operator  ').phase).toBe('resolved');
  });

  it('clearQuestion and clearAll reset state', async () => {
    await check('rxjs', Q, ['map', 'filter']);
    service.clearQuestion('rxjs', Q);
    expect(service.verdictFor('rxjs', Q).phase).toBe('idle');

    await check('rxjs', Q, ['map', 'filter']);
    service.clearAll();
    expect(service.verdictFor('rxjs', Q).phase).toBe('idle');
  });
});

describe('containment guarantees', () => {
  it('results expose TEXT ONLY — no source models, ids or indexes', async () => {
    const results = [
      await check('rxjs', 'Select every operator', ['map']),
      await check('rxjs', 'Select every operator', ['map', 'filter']),
      await firstValueFrom(service.revealExpiredQuestion('rxjs', 'Which answer is correct?'))
    ];

    const keysDeep = (value: unknown, out: string[] = []): string[] => {
      if (value === null || typeof value !== 'object') return out;
      if (Array.isArray(value)) { for (const item of value) keysDeep(item, out); return out; }
      for (const [key, nested] of Object.entries(value)) { out.push(key); keysDeep(nested, out); }
      return out;
    };

    const keys = new Set(results.flatMap((result) => keysDeep(result)));
    for (const banned of [
      'optionId', 'questionId', 'id', 'options', 'questions', 'quizId',
      'isCorrect', 'sourceQuizId', 'index', 'displayOrder', 'selected', 'highlight'
    ]) {
      expect(keys.has(banned)).toBe(false);
    }
  });

  it('NEVER writes to localStorage, and writes only EARNED state to sessionStorage', async () => {
    // This asserted that nothing was persisted at all. That rule had a cost
    // nobody had priced: a reload emptied the in-memory store, and the UI then
    // repainted an already-answered question from the bundled answer key — so
    // "persist nothing" was in practice keeping the whole key in the browser.
    //
    // The boundary is now narrower and checkable. localStorage stays forbidden
    // outright: it outlives the session that earned the state. sessionStorage
    // receives terminal verdicts only, and only under the earned-verdict key.
    const localSet = jest.spyOn(Storage.prototype, 'setItem');
    sessionStorage.clear();

    await check('rxjs', 'Select every operator', ['map', 'filter']);
    await firstValueFrom(service.revealExpiredQuestion('rxjs', 'Which answer is correct?'));

    for (const [key] of localSet.mock.calls as [string, string][]) {
      expect(key.startsWith('earnedVerdicts:')).toBe(true);
    }
    expect(localStorage.length).toBe(0);
    localSet.mockRestore();
  });

  it('persists nothing for a question the user has not answered', async () => {
    sessionStorage.clear();

    // One question is answered; a second is never touched.
    await check('rxjs', 'Select every operator', ['map', 'filter']);

    const stored = Object.keys(sessionStorage)
      .filter((k) => k.startsWith('earnedVerdicts:'))
      .map((k) => sessionStorage.getItem(k) ?? '')
      .join(' ');

    expect(stored).toContain('Select every operator');
    // The unanswered question contributes no entry, so its text — and with it
    // any hint about its answers — never reaches storage.
    expect(stored).not.toContain('Which answer is correct?');
  });

  it('mutating a returned result does not corrupt stored state', async () => {
    const result = await check('rxjs', 'Select every operator', ['map', 'filter']);
    (result as unknown as { correctOptionTexts: string[] }).correctOptionTexts.push('TAMPERED');

    const fresh = await check('rxjs', 'Select every operator', ['map', 'filter']);
    expect((fresh as { correctOptionTexts: readonly string[] }).correctOptionTexts).toEqual(['map', 'filter']);
  });
});
