/**
 * Pins the shuffle-aware display-order resolution in QuizService — the source
 * of the display-index bug class that was fixed 3x in prior sessions (reading a
 * question by a DISPLAY index off the wrong/unshuffled array). Locks the three
 * accessors that must agree: getQuestionsInDisplayOrder(), the shuffle-aware
 * `questions` getter, and getDisplayedQuestion(i).
 */
// jsdom doesn't expose structuredClone in some versions; polyfill before the
// QuizService module loads (its field initializer calls it).
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: any) => JSON.parse(JSON.stringify(v));
}

import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuizQuestion } from '@shared/models/QuizQuestion.model';
import { QuizService } from './quiz.service';

describe('QuizService display-order resolution (shuffle-aware)', () => {
  let service: QuizService;

  const q = (text: string): QuizQuestion => ({ questionText: text } as QuizQuestion);
  const original = [q('Q1'), q('Q2'), q('Q3')];
  const shuffled = [q('Q3'), q('Q1'), q('Q2')];

  const setShuffle = (on: boolean): void => {
    jest.spyOn(service, 'isShuffleEnabled').mockReturnValue(on);
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      ],
    });
    service = TestBed.inject(QuizService);
    (service as any)._questions = original;
    service.shuffledQuestions = shuffled;
  });

  describe('shuffle disabled', () => {
    beforeEach(() => setShuffle(false));

    it('getQuestionsInDisplayOrder returns the original order', () => {
      expect(service.getQuestionsInDisplayOrder()).toBe(original);
    });

    it('the questions getter returns the original order', () => {
      expect(service.questions).toBe(original);
    });

    it('getDisplayedQuestion(i) returns the original question at i', () => {
      expect(service.getDisplayedQuestion(0)).toBe(original[0]);
      expect(service.getDisplayedQuestion(2)).toBe(original[2]);
    });
  });

  describe('shuffle enabled', () => {
    beforeEach(() => setShuffle(true));

    it('getQuestionsInDisplayOrder returns the shuffled order', () => {
      expect(service.getQuestionsInDisplayOrder()).toBe(shuffled);
    });

    it('the questions getter returns the shuffled order', () => {
      expect(service.questions).toBe(shuffled);
    });

    it('getDisplayedQuestion(i) returns the SHUFFLED question at i, not the original', () => {
      expect(service.getDisplayedQuestion(0)).toBe(shuffled[0]);
      expect(service.getDisplayedQuestion(0)).not.toBe(original[0]);
    });

    it('falls back to the original order when shuffledQuestions is empty', () => {
      service.shuffledQuestions = [];
      expect(service.getQuestionsInDisplayOrder()).toBe(original);
      expect(service.getDisplayedQuestion(1)).toBe(original[1]);
    });
  });

  it('getDisplayedQuestion returns undefined for an out-of-range index', () => {
    setShuffle(true);
    expect(service.getDisplayedQuestion(99)).toBeUndefined();
  });
});
