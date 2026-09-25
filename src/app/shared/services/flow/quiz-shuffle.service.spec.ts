import { QuestionType } from '@shared/models/question-type.enum';

import { Option } from '@shared/models/Option.model';
import { QuizQuestion } from '@shared/models/QuizQuestion.model';

import { ArrayUtils } from '@shared/utils/array-utils';

import { QuizShuffleService } from './quiz-shuffle.service';

describe('QuizShuffleService', () => {
  let service: QuizShuffleService;

  const mockOptions: Option[] = [
    { text: 'Option A', correct: true, value: 1 },
    { text: 'Option B', correct: false, value: 2 },
    { text: 'Option C', correct: false, value: 3 },
    { text: 'Option D', correct: false, value: 4 }
  ];

  const mockQuestions: QuizQuestion[] = [
    {
      questionText: 'Question 1',
      options: [...mockOptions],
      explanation: 'Explanation 1',
      type: QuestionType.SingleAnswer
    },
    {
      questionText: 'Question 2',
      options: [
        { text: 'True', correct: true, value: 1 },
        { text: 'False', correct: false, value: 2 }
      ],
      explanation: 'Explanation 2',
      type: QuestionType.SingleAnswer
    },
    {
      questionText: 'Question 3',
      options: [...mockOptions],
      explanation: 'Explanation 3',
      type: QuestionType.MultipleAnswer,
      answer: [
        { text: 'Option A', correct: true, value: 1 },
        { text: 'Option C', correct: true, value: 3 }
      ]
    },
  ];

  // Mock localStorage
  let store: Record<string, string> = {};
  beforeAll(() => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => store[key] ?? null);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => { store[key] = val; });
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => { delete store[key]; });
    // Object.keys(localStorage) is used by clearAll
    Object.defineProperty(window, 'localStorage', {
      value: new Proxy(Storage.prototype, {
        get(target, prop) {
          if (prop === 'getItem') return (key: string) => store[key] ?? null;
          if (prop === 'setItem') return (key: string, val: string) => { store[key] = val; };
          if (prop === 'removeItem') return (key: string) => { delete store[key]; };
          return Reflect.get(target, prop);
        },
        ownKeys() { return Object.keys(store); },
        getOwnPropertyDescriptor(_, key) {
          if (key in store) return { configurable: true, enumerable: true, value: store[key as string] };
          return undefined;
        },
      }),
      writable: true
    });
  });

  beforeEach(() => {
    store = {};
    service = new QuizShuffleService();
    service.clearAll();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  // ── prepareShuffle ──────────────────────────────────────────

  describe('prepareShuffle', () => {
    it('should create a shuffle state for a quiz', () => {
      service.prepareShuffle('quiz-1', mockQuestions);
      expect(service.hasShuffleState('quiz-1')).toBe(true);
    });

    it('should create a question order matching the number of questions', () => {
      service.prepareShuffle('quiz-1', mockQuestions);
      const state = service.getShuffleState('quiz-1');
      expect(state).toBeDefined();
      expect(state!.questionOrder.length).toBe(mockQuestions.length);
    });

    it('should contain all original indices in the question order', () => {
      service.prepareShuffle('quiz-1', mockQuestions);
      const state = service.getShuffleState('quiz-1');
      const sorted = [...state!.questionOrder].sort();
      expect(sorted).toEqual([0, 1, 2]);
    });

    it('should create option orders for each question', () => {
      service.prepareShuffle('quiz-1', mockQuestions);
      const state = service.getShuffleState('quiz-1');
      expect(state!.optionOrder.size).toBe(mockQuestions.length);
    });

    it('should not recreate shuffle state on second call (idempotent)', () => {
      service.prepareShuffle('quiz-1', mockQuestions);
      const firstState = service.getShuffleState('quiz-1');
      service.prepareShuffle('quiz-1', mockQuestions);
      const secondState = service.getShuffleState('quiz-1');
      expect(firstState!.questionOrder).toEqual(secondState!.questionOrder);
    });

    it('should use identity option order when shuffleOptions is false', () => {
      service.prepareShuffle('quiz-1', mockQuestions, {
        shuffleQuestions: true,
        shuffleOptions: false,
      });
      const state = service.getShuffleState('quiz-1');
      for (const [, order] of state!.optionOrder.entries()) {
        const expected = Array.from({ length: order.length }, (_, i) => i);
        expect(order).toEqual(expected);
      }
    });
  });

  // ── assignOptionIds ─────────────────────────────────────────

  describe('assignOptionIds', () => {
    it('should assign globally unique numeric IDs', () => {
      const result = service.assignOptionIds(mockOptions, 0);
      expect(result[0].optionId).toBe(101);
      expect(result[1].optionId).toBe(102);
      expect(result[2].optionId).toBe(103);
      expect(result[3].optionId).toBe(104);
    });

    it('should use question index for unique ID ranges', () => {
      const q0 = service.assignOptionIds(mockOptions, 0);
      const q1 = service.assignOptionIds(mockOptions, 1);
      expect(q0[0].optionId).toBe(101);
      expect(q1[0].optionId).toBe(201);
    });

    it('should handle empty options', () => {
      const result = service.assignOptionIds([], 0);
      expect(result).toEqual([]);
    });

    it('should preserve option text', () => {
      const result = service.assignOptionIds(mockOptions, 0);
      expect(result[0].text).toBe('Option A');
      expect(result[3].text).toBe('Option D');
    });
  });

  // ── toOriginalIndex ─────────────────────────────────────────

  describe('toOriginalIndex', () => {
    it('should map display index to original index', () => {
      service.prepareShuffle('quiz-1', mockQuestions, {
        shuffleQuestions: false,
        shuffleOptions: false
      });
      expect(service.toOriginalIndex('quiz-1', 0)).toBe(0);
      expect(service.toOriginalIndex('quiz-1', 1)).toBe(1);
      expect(service.toOriginalIndex('quiz-1', 2)).toBe(2);
    });

    it('should return null for unknown quiz', () => {
      expect(service.toOriginalIndex('unknown', 0)).toBeNull();
    });

    it('should return null for out-of-bounds index', () => {
      service.prepareShuffle('quiz-1', mockQuestions);
      expect(service.toOriginalIndex('quiz-1', 99)).toBeNull();
    });
  });

  // ── toOriginalIndex — permutation contract (index-model rewrite) ─
  // Pins the map's invariants under an ACTUAL (non-identity) shuffle, so the
  // rewrite can treat the URL display index → original index mapping as a
  // trustworthy bijection. Forces a known order by stubbing ArrayUtils.shuffleArray.
  describe('toOriginalIndex — permutation contract', () => {
    const fixedOrder = [2, 0, 1]; // display 0→orig 2, 1→orig 0, 2→orig 1

    beforeEach(() => {
      jest
        .spyOn(ArrayUtils, 'shuffleArray')
        .mockImplementation(() => [...fixedOrder]);
    });

    afterEach(() => {
      (ArrayUtils.shuffleArray as jest.Mock).mockRestore?.();
    });

    it('maps each display index to the forced original index', () => {
      service.prepareShuffle('quiz-perm', mockQuestions);
      expect(service.toOriginalIndex('quiz-perm', 0)).toBe(2);
      expect(service.toOriginalIndex('quiz-perm', 1)).toBe(0);
      expect(service.toOriginalIndex('quiz-perm', 2)).toBe(1);
    });

    it('is a bijection — every display index maps to a distinct original index covering 0..n-1', () => {
      service.prepareShuffle('quiz-perm', mockQuestions);
      const n = mockQuestions.length;
      const mapped = Array.from({ length: n }, (_, d) =>
        service.toOriginalIndex('quiz-perm', d)
      );
      expect(mapped.every((v) => typeof v === 'number')).toBe(true);
      expect([...mapped].sort()).toEqual([0, 1, 2]); // permutation of 0..n-1
      expect(new Set(mapped).size).toBe(n); // all distinct
    });

    it('is stable across a persistence reload (new service instance reads localStorage)', () => {
      service.prepareShuffle('quiz-perm', mockQuestions);
      const before = [0, 1, 2].map((d) => service.toOriginalIndex('quiz-perm', d));

      // Simulate a page reload: a fresh service must rehydrate from storage.
      const reloaded = new QuizShuffleService();
      const after = [0, 1, 2].map((d) => reloaded.toOriginalIndex('quiz-perm', d));

      expect(after).toEqual(before);
      expect(after).toEqual([2, 0, 1]);
    });
  });

  // ── alignAnswersWithOptions ─────────────────────────────────

  describe('alignAnswersWithOptions', () => {
    const opts: Option[] = [
      { optionId: 1, text: 'Alpha', correct: true, value: 1 },
      { optionId: 2, text: 'Beta', correct: false, value: 2 },
      { optionId: 3, text: 'Gamma', correct: true, value: 3 }
    ];

    it('should align answers by optionId', () => {
      const answers: Option[] = [
        { optionId: 1, text: 'Alpha', correct: true, value: 1 }
      ];
      const result = service.alignAnswersWithOptions(answers, opts);
      expect(result.length).toBe(1);
      expect(result[0].optionId).toBe(1);
    });

    it('should align answers by text when IDs don\'t match', () => {
      const answers: Option[] = [
        { text: 'Beta', correct: false, value: 99 },
      ];
      const result = service.alignAnswersWithOptions(answers, opts);
      expect(result.length).toBe(1);
      expect(result[0].text).toBe('Beta');
    });

    it('should return empty array for empty options', () => {
      const result = service.alignAnswersWithOptions([{ text: 'X', value: 1 }], []);
      expect(result).toEqual([]);
    });

    it('should deduplicate aligned answers', () => {
      const answers: Option[] = [
        { optionId: 1, text: 'Alpha', correct: true, value: 1 },
        { optionId: 1, text: 'Alpha', correct: true, value: 1 },
      ];
      const result = service.alignAnswersWithOptions(answers, opts);
      expect(result.length).toBe(1);
    });

    it('should fall back to correct options when no match', () => {
      const answers: Option[] = [
        { text: 'Nonexistent', value: 999 },
      ];
      const result = service.alignAnswersWithOptions(answers, opts);
      expect(result.length).toBe(2);
      expect(result.every(o => o.correct)).toBe(true);
    });
  });

  // ── buildShuffledQuestions ─��────────────────────────────────

  describe('buildShuffledQuestions', () => {
    it('should return all questions', () => {
      service.prepareShuffle('quiz-1', mockQuestions, {
        shuffleQuestions: false,
        shuffleOptions: false
      });
      const result = service.buildShuffledQuestions('quiz-1', mockQuestions);
      expect(result.length).toBe(mockQuestions.length);
    });

    it('should normalize options with numeric IDs', () => {
      service.prepareShuffle('quiz-1', mockQuestions, {
        shuffleQuestions: false,
        shuffleOptions: false,
      });
      const result = service.buildShuffledQuestions('quiz-1', mockQuestions);
      for (const q of result) {
        for (const opt of q.options) {
          expect(typeof opt.optionId).toBe('number');
        }
      }
    });

    it('should return fallback when no shuffle state exists', () => {
      const result = service.buildShuffledQuestions('no-state', mockQuestions);
      expect(result.length).toBe(mockQuestions.length);
    });

    it('should handle empty questions array', () => {
      const result = service.buildShuffledQuestions('quiz-1', []);
      expect(result).toEqual([]);
    });
  });

  // ── clear / clearAll ────────────────────────────────────────

  describe('clear / clearAll', () => {
    it('should clear state for a specific quiz', () => {
      service.prepareShuffle('quiz-1', mockQuestions);
      service.prepareShuffle('quiz-2', mockQuestions);
      service.clear('quiz-1');
      expect(service.hasShuffleState('quiz-1')).toBe(false);
      expect(service.hasShuffleState('quiz-2')).toBe(true);
    });

    it('should clear all shuffle states', () => {
      service.prepareShuffle('quiz-1', mockQuestions);
      service.prepareShuffle('quiz-2', mockQuestions);
      service.clearAll();
      expect(service.hasShuffleState('quiz-1')).toBe(false);
      expect(service.hasShuffleState('quiz-2')).toBe(false);
    });
  });

  // ── getQuestionAtDisplayIndex ───────────────────────────────

  describe('getQuestionAtDisplayIndex', () => {
    it('should return the question at the display index', () => {
      service.prepareShuffle('quiz-1', mockQuestions, {
        shuffleQuestions: false,
        shuffleOptions: false
      });
      const result = service.getQuestionAtDisplayIndex('quiz-1', 0, mockQuestions);
      expect(result).not.toBeNull();
      expect(result!.questionText).toBe('Question 1');
    });

    it('should return null for unknown quiz', () => {
      const result = service.getQuestionAtDisplayIndex('unknown', 0, mockQuestions);
      expect(result).toBeNull();
    });

    it('should normalize options with IDs', () => {
      service.prepareShuffle('quiz-1', mockQuestions, {
        shuffleQuestions: false,
        shuffleOptions: false
      });
      const result = service.getQuestionAtDisplayIndex('quiz-1', 0, mockQuestions);
      expect(result!.options.every(o => typeof o.optionId === 'number')).toBe(true);
    });
  });
});