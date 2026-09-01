import { TestBed } from '@angular/core/testing';

import { AssessmentBuilderService } from './assessment-builder.service';
import { setQuizDataCache, getQuizData } from '../../../quiz-data-cache';
import { ArrayUtils } from '../../../utils/array-utils';
import { Quiz } from '../../../models/Quiz.model';
// S6p (Angular Stage 14): src/assets/data/quiz.json was deleted — see
// shared/testing/quiz-catalog-fixture.json (test-only, never bundled).
import quizData from '../../../testing/quiz-catalog-fixture.json';

const REAL_CATALOG = ((quizData as { quizzes?: unknown[] }).quizzes ?? quizData) as Quiz[];

function service(): AssessmentBuilderService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [AssessmentBuilderService] });
  return TestBed.inject(AssessmentBuilderService);
}

describe('AssessmentBuilderService.buildPractice — weak areas generation', () => {
  beforeEach(() => setQuizDataCache(REAL_CATALOG, []));
  afterEach(() => setQuizDataCache(REAL_CATALOG, []));

  it('returns null for ZERO weak topics — never an empty session', () => {
    expect(service().buildPractice([])).toBeNull();
  });

  it('builds from ONE weak topic', () => {
    const built = service().buildPractice(['rxjs'])!;
    expect(built.questions).toHaveLength(10);
    expect(built.questions.every((q) => q.sourceQuizId === 'rxjs')).toBe(true);
  });

  it('balances across TWO weak topics', () => {
    const built = service().buildPractice(['rxjs', 'signals'])!;
    const perTopic = new Map<string, number>();
    for (const q of built.questions) {
      perTopic.set(q.sourceQuizId!, (perTopic.get(q.sourceQuizId!) ?? 0) + 1);
    }
    expect(built.questions).toHaveLength(10);
    // Round-robin: 10 across 2 topics → 5/5, never 10/0.
    expect([...perTopic.values()].sort()).toEqual([5, 5]);
  });

  it('balances across THREE weak topics without one crowding out the others', () => {
    const built = service().buildPractice(['rxjs', 'signals', 'change-detection'])!;
    const perTopic = new Map<string, number>();
    for (const q of built.questions) {
      perTopic.set(q.sourceQuizId!, (perTopic.get(q.sourceQuizId!) ?? 0) + 1);
    }
    expect(built.questions).toHaveLength(10);
    expect(perTopic.size).toBe(3);
    // 10 across 3 → 4/3/3; the largest share may exceed the smallest by 1 only.
    const counts = [...perTopic.values()].sort((a, b) => a - b);
    expect(counts[counts.length - 1] - counts[0]).toBeLessThanOrEqual(1);
  });

  it('caps at 10 questions even when far more are available', () => {
    const built = service().buildPractice(['rxjs', 'signals', 'testing'])!;
    expect(built.questions.length).toBeLessThanOrEqual(10);
    expect(built.questions).toHaveLength(10);
  });

  it('returns FEWER than 10 when the eligible bank is smaller', () => {
    const trimmed = REAL_CATALOG.map((q) =>
      q.quizId === 'rxjs' ? { ...q, questions: (q.questions ?? []).slice(0, 4) } : q
    );
    setQuizDataCache(trimmed as Quiz[], []);
    const built = service().buildPractice(['rxjs'])!;
    expect(built.questions).toHaveLength(4);
  });

  it('returns null when the weak topics hold no questions at all', () => {
    const gutted = REAL_CATALOG.map((q) =>
      q.quizId === 'rxjs' ? { ...q, questions: [] } : q
    );
    setQuizDataCache(gutted as Quiz[], []);
    expect(service().buildPractice(['rxjs'])).toBeNull();
  });

  it('contains NO duplicate questions', () => {
    for (let run = 0; run < 10; run++) {
      const built = service().buildPractice(['rxjs', 'signals'])!;
      const texts = built.questions.map((q) => q.questionText);
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it('does NOT mutate the canonical question bank', () => {
    const before = JSON.stringify(getQuizData());
    const built = service().buildPractice(['rxjs', 'signals'])!;
    // Mutating a generated question must not reach the catalog.
    built.questions[0].questionText = 'MUTATED';
    (built.questions[0].options ?? [])[0]!.selected = true;
    expect(JSON.stringify(getQuizData())).toBe(before);
  });

  it('resets answer state on every generated question', () => {
    const built = service().buildPractice(['rxjs'])!;
    for (const q of built.questions) {
      expect(q.selectedOptions).toEqual([]);
      for (const o of q.options ?? []) {
        expect(o.selected).toBe(false);
        expect(o.highlight).toBe(false);
        expect(o.showIcon).toBe(false);
      }
    }
  });

  it('uses the shared ArrayUtils.shuffleArray rather than a second shuffle', () => {
    const spy = jest.spyOn(ArrayUtils, 'shuffleArray');
    service().buildPractice(['rxjs']);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('keeps "All of the above" last after option shuffling', () => {
    const svc = service();
    for (let run = 0; run < 8; run++) {
      const built = svc.buildPractice(['rxjs', 'signals', 'testing'])!;
      for (const q of built.questions) {
        const idx = (q.options ?? []).findIndex((o) => /all of the above/i.test(o.text ?? ''));
        if (idx >= 0) expect(idx).toBe((q.options ?? []).length - 1);
      }
    }
  });

  it('stamps stable source-topic metadata on every question', () => {
    const built = service().buildPractice(['rxjs', 'signals'])!;
    const allowed = new Set(['rxjs', 'signals']);
    for (const q of built.questions) {
      expect(typeof q.sourceQuizId).toBe('string');
      expect(allowed.has(q.sourceQuizId!)).toBe(true);
    }
  });

  it('is UNTIMED — no countdown is derived', () => {
    const built = service().buildPractice(['rxjs'])!;
    expect(built.durationSeconds).toBe(0);
    expect(built.title).toBe('Weak Areas Practice');
  });

  it('produces a differently shuffled session on a later run', () => {
    const svc = service();
    const a = svc.buildPractice(['rxjs', 'signals'])!.questions.map((q) => q.questionText).join('|');
    let differed = false;
    for (let i = 0; i < 10 && !differed; i++) {
      const b = svc.buildPractice(['rxjs', 'signals'])!.questions.map((q) => q.questionText).join('|');
      if (a !== b) differed = true;
    }
    expect(differed).toBe(true);
  });

  it('ignores duplicate topic ids in the input', () => {
    const built = service().buildPractice(['rxjs', 'rxjs', 'rxjs'])!;
    expect(built.questions.every((q) => q.sourceQuizId === 'rxjs')).toBe(true);
    expect(new Set(built.questions.map((q) => q.questionText)).size).toBe(built.questions.length);
  });
});
