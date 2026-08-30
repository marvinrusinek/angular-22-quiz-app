import { Option } from '../../../models/Option.model';
import { Quiz, QuizDifficulty } from '../../../models/Quiz.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { AssessmentConfig } from '../../../models/AssessmentConfig.model';

import { getQuizData, setQuizDataCache } from '../../../quiz-data-cache';
import { ArrayUtils } from '../../../utils/array-utils';

import { AssessmentBuilderService } from './assessment-builder.service';

// ── fixtures ──────────────────────────────────────────────────────
function makeOption(text: string, correct = false): Option {
  return { text, correct };
}

function makeQuestion(text: string, options: Option[]): QuizQuestion {
  return { questionText: text, options, explanation: `${text} explanation` };
}

function makeQuiz(quizId: string, difficulty: QuizDifficulty, n: number): Quiz {
  const questions = Array.from({ length: n }, (_, i) =>
    makeQuestion(`${quizId}-q${i + 1}`, [
      makeOption(`${quizId}-q${i + 1}-A`, true),
      makeOption(`${quizId}-q${i + 1}-B`),
      makeOption(`${quizId}-q${i + 1}-C`),
      makeOption(`${quizId}-q${i + 1}-D`)
    ])
  );
  return { quizId, milestone: quizId, summary: '', image: '', difficulty, questions };
}

// Standard catalog: beginner ts(10)+templates(10), intermediate router(8)+forms(3),
// advanced rxjs(10). Total 41 questions.
function standardCatalog(): Quiz[] {
  return [
    makeQuiz('ts', 'beginner', 10),
    makeQuiz('templates', 'beginner', 10),
    makeQuiz('router', 'intermediate', 8),
    makeQuiz('forms', 'intermediate', 3),
    makeQuiz('rxjs', 'advanced', 10)
  ];
}

const config = (
  difficulty: AssessmentConfig['difficulty'],
  topicIds: string[],
  questionCount: AssessmentConfig['questionCount']
): AssessmentConfig => ({ difficulty, topicIds, questionCount });

const qKey = (q: QuizQuestion) => `${q.sourceQuizId}::${q.questionText}`;

describe('AssessmentBuilderService', () => {
  let service: AssessmentBuilderService;

  beforeEach(() => {
    service = new AssessmentBuilderService();
    setQuizDataCache(standardCatalog(), []);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setQuizDataCache([], []);
  });

  // 5: filters by selected topic ids
  it('only draws questions from the selected topic ids', () => {
    const result = service.build(config('mixed', ['ts', 'rxjs'], 10));
    const sources = new Set(result.questions.map((q) => q.sourceQuizId));
    expect(sources).toEqual(new Set(['ts', 'rxjs']));
  });

  // 6–8: exact counts + duration
  it('builds exactly 10 questions', () => {
    const result = service.build(config('mixed', ['ts', 'templates'], 10));
    expect(result.questions).toHaveLength(10);
    expect(result.durationSeconds).toBe(15 * 60);
  });

  it('builds exactly 20 questions', () => {
    const result = service.build(config('mixed', ['ts', 'templates', 'rxjs'], 20));
    expect(result.questions).toHaveLength(20);
    expect(result.durationSeconds).toBe(30 * 60);
  });

  it('builds exactly 30 questions', () => {
    const result = service.build(config('mixed', ['ts', 'templates', 'rxjs'], 30));
    expect(result.questions).toHaveLength(30);
    expect(result.durationSeconds).toBe(45 * 60);
  });

  // 9: balances across selected topics (7,7,6)
  it('balances questions across selected topics as evenly as possible', () => {
    const result = service.build(config('mixed', ['ts', 'templates', 'rxjs'], 20));
    const perTopic = new Map<string, number>();
    for (const q of result.questions) {
      perTopic.set(q.sourceQuizId!, (perTopic.get(q.sourceQuizId!) ?? 0) + 1);
    }
    expect([...perTopic.values()].sort()).toEqual([6, 7, 7]);
  });

  // 10: redistributes when one topic lacks enough
  it('redistributes the remainder when one topic lacks enough questions', () => {
    // forms has only 3; ts + templates have 10 each. 20 requested.
    const result = service.build(config('mixed', ['forms', 'ts', 'templates'], 20));
    const perTopic = new Map<string, number>();
    for (const q of result.questions) {
      perTopic.set(q.sourceQuizId!, (perTopic.get(q.sourceQuizId!) ?? 0) + 1);
    }
    expect(result.questions).toHaveLength(20);
    expect(perTopic.get('forms')).toBe(3);                 // all it has, no more
    expect(perTopic.get('ts')! + perTopic.get('templates')!).toBe(17);  // remainder spread
  });

  // 11: rejects an insufficient pool
  it('rejects a configuration whose pool cannot satisfy the count', () => {
    expect(() => service.build(config('intermediate', ['forms'], 10))).toThrow();
  });

  // 12: never duplicates questions
  it('never includes a duplicate question', () => {
    const result = service.build(config('mixed', ['ts', 'templates', 'router', 'forms', 'rxjs'], 30));
    const keys = result.questions.map(qKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // 13: preserves source-topic metadata
  it('preserves each question source-topic metadata', () => {
    const selected = ['ts', 'router'];
    const result = service.build(config('mixed', selected, 10));
    for (const q of result.questions) {
      expect(selected).toContain(q.sourceQuizId);
    }
  });

  // 14: does not mutate source quiz data
  it('does not mutate the source quiz catalog', () => {
    const before = JSON.stringify(getQuizData());
    const result = service.build(config('mixed', ['ts', 'templates'], 10));
    // mutate the generated assessment aggressively
    for (const q of result.questions) {
      for (const o of q.options) { o.selected = true; o.highlight = true; }
    }
    result.questions[0].options[0].text = 'MUTATED';
    expect(JSON.stringify(getQuizData())).toBe(before);
  });

  // 15: resets mutable answer state
  it('resets mutable option state on the generated questions', () => {
    const result = service.build(config('mixed', ['ts'], 10));
    for (const q of result.questions) {
      expect(q.selectedOptions).toEqual([]);
      for (const o of q.options) {
        expect(o.selected).toBe(false);
        expect(o.highlight).toBe(false);
        expect(o.showIcon).toBe(false);
        expect(typeof o.optionId).toBe('number');
      }
    }
  });

  // 16: keeps "All of the above" last after shuffling
  it('keeps "All of the above" as the last option after shuffling', () => {
    // Every question carries an AOTA option in a non-last position; a pool of 10
    // means all are included at count 10, so we can assert on every one.
    const questions = Array.from({ length: 10 }, (_, i) =>
      makeQuestion(`aota-q${i + 1}`, [
        makeOption(`First-${i}`),
        makeOption('All of the above', true),
        makeOption(`Second-${i}`),
        makeOption(`Third-${i}`)
      ])
    );
    setQuizDataCache(
      [{ quizId: 'aota', milestone: 'aota', summary: '', image: '', difficulty: 'beginner', questions }],
      []
    );

    const result = service.build(config('mixed', ['aota'], 10));
    expect(result.questions).toHaveLength(10);
    for (const q of result.questions) {
      const last = q.options[q.options.length - 1];
      expect(last.text).toBe('All of the above');
    }
  });

  // 17: deterministic when randomness is mocked
  it('produces deterministic selection when ArrayUtils.shuffleArray is mocked', () => {
    jest.spyOn(ArrayUtils, 'shuffleArray').mockImplementation((arr) => arr);
    const a = service.build(config('mixed', ['ts', 'templates', 'rxjs'], 20));
    const b = service.build(config('mixed', ['ts', 'templates', 'rxjs'], 20));
    expect(a.questions.map(qKey)).toEqual(b.questions.map(qKey));
  });
});
