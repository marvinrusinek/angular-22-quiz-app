/**
 * FET (Formatted Explanation Text) integration tests.
 *
 * Covers the most fragile parts of the FET pipeline:
 *  - QuestionHeadingService: signal-bound DOM-write owner
 *  - ExplanationFormatterService.getCorrectOptionIndices: index resolution
 *    (single, multi, internal `correct` flag, type inference)
 *  - ExplanationFormatterService.formatExplanation: prefix generation
 *    ("Option N is correct because ..." vs "Options A and B are correct ...")
 *  - storeFormattedExplanation + getFormattedSync: cache round-trip
 *
 * These guard the regressions that cost the most debug time historically:
 * - Wrong index in the FET prefix (visual numbering vs internal numbering)
 * - Single-answer phrasing leaking into a multi-answer question
 * - FET disappearing on revisit because cache wasn't populated
 */
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuestionType } from '../../../models/question-type.enum';
import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationFormatterService } from './explanation-formatter.service';
import { QuizService } from '../../data/quiz.service';
import { QuizShuffleService } from '../../flow/quiz-shuffle.service';

describe('FET display integration', () => {
  // ── ExplanationFormatterService ──────────────────────────────

  describe('ExplanationFormatterService', () => {
    let service: ExplanationFormatterService;
    let quizServiceMock: any;
    let shuffleServiceMock: any;

    const makeOption = (
      text: string,
      correct: boolean,
      optionId = 0
    ): Option => ({
      optionId,
      text,
      correct,
      value: optionId
    });

    const singleAnswerQ: QuizQuestion = {
      questionText: 'What is 2 + 2?',
      type: QuestionType.SingleAnswer,
      options: [
        makeOption('3', false, 1),
        makeOption('4', true, 2),
        makeOption('5', false, 3)
      ],
      explanation: '2 + 2 equals 4.'
    };

    const multiAnswerQ: QuizQuestion = {
      questionText: 'Which are even numbers?',
      type: QuestionType.MultipleAnswer,
      options: [
        makeOption('1', false, 1),
        makeOption('2', true, 2),
        makeOption('3', false, 3),
        makeOption('4', true, 4)
      ],
      explanation: 'Both 2 and 4 are even.'
    };

    beforeEach(() => {
      quizServiceMock = {
        quizId: 'integration-quiz',
        questions: [singleAnswerQ, multiAnswerQ],
        shuffledQuestions: [],
        quizInitialState: [
          { quizId: 'integration-quiz', questions: [singleAnswerQ, multiAnswerQ] }
        ],
        isShuffleEnabled: jest.fn().mockReturnValue(false),
        getCurrentQuestionIndex: jest.fn().mockReturnValue(0),
        getPristineQuestion: jest.fn((i: number) => [singleAnswerQ, multiAnswerQ][i] ?? null),
        quizDataLoader: { getCanonicalQuestions: jest.fn().mockReturnValue([singleAnswerQ, multiAnswerQ]) }
      };
      shuffleServiceMock = {
        toOriginalIndex: jest.fn((_id: string, idx: number) => idx)
      };

      TestBed.configureTestingModule({
        providers: [
          ExplanationFormatterService,
          { provide: QuizService, useValue: quizServiceMock },
          { provide: QuizShuffleService, useValue: shuffleServiceMock },
          { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'integration-quiz' } }, params: of({}) } }
        ]
      });
      service = TestBed.inject(ExplanationFormatterService);
    });

    // ── getCorrectOptionIndices ────────────────────────────────

    describe('getCorrectOptionIndices', () => {
      it('returns the 1-based index of the single correct option', () => {
        const result = service.getCorrectOptionIndices(singleAnswerQ, singleAnswerQ.options, 0);
        expect(result).toEqual([2]);
      });

      it('returns all 1-based indices for a multi-answer question', () => {
        const result = service.getCorrectOptionIndices(multiAnswerQ, multiAnswerQ.options, 1);
        expect(result).toEqual([2, 4]);
      });

      it('returns sorted, deduplicated indices', () => {
        const dupOpts: Option[] = [
          makeOption('A', true, 1),
          makeOption('B', true, 2)
        ];
        const q: QuizQuestion = {
          questionText: 'unique-dedup-test',
          type: QuestionType.MultipleAnswer,
          options: dupOpts,
          explanation: 'both'
        };
        // Inject the question into the mock's lookup so the internal
        // rawOpts resolution matches the option array under test.
        quizServiceMock.questions = [q];
        const result = service.getCorrectOptionIndices(q, dupOpts, 0);
        expect(result).toEqual([1, 2]);
      });

      it('returns [] when no options are correct', () => {
        const opts: Option[] = [
          makeOption('a', false, 1),
          makeOption('b', false, 2)
        ];
        const q: QuizQuestion = {
          questionText: 'unique-no-correct',
          type: QuestionType.SingleAnswer,
          options: opts,
          explanation: 'n/a'
        };
        quizServiceMock.questions = [q];
        const result = service.getCorrectOptionIndices(q, opts, 0);
        expect(result).toEqual([]);
      });
    });

    // ── formatExplanation ──────────────────────────────────────

    describe('formatExplanation', () => {
      it('formats a single-answer explanation with "Option N is correct because ..."', () => {
        const result = service.formatExplanation(singleAnswerQ, [2], singleAnswerQ.explanation!, 0);
        expect(result).toBe('Option 2 is correct because 2 + 2 equals 4.');
      });

      it('formats a 2-answer multi explanation with "Options A and B are correct because ..."', () => {
        const result = service.formatExplanation(multiAnswerQ, [2, 4], multiAnswerQ.explanation!, 1);
        // The explanation body's leading letter is lowercased so it reads as one
        // sentence after "… correct because" ("Both" -> "both").
        expect(result).toBe('Options 2 and 4 are correct because both 2 and 4 are even.');
      });

      it('formats a 3-answer multi explanation with "Options A, B and C ..."', () => {
        const q: QuizQuestion = {
          questionText: 'Pick the primes',
          type: QuestionType.MultipleAnswer,
          options: [
            makeOption('2', true, 1),
            makeOption('3', true, 2),
            makeOption('4', false, 3),
            makeOption('5', true, 4)
          ],
          explanation: 'Primes have exactly two divisors.'
        };
        const result = service.formatExplanation(q, [1, 2, 4], q.explanation!, 0);
        expect(result).toBe('Options 1, 2, and 4 are correct because primes have exactly two divisors.');
      });

      it('returns the raw explanation when correctIndices is empty', () => {
        const result = service.formatExplanation(singleAnswerQ, [], 'because', 0);
        expect(result).toBe('because');
      });

      it('returns empty string when explanation is empty', () => {
        const result = service.formatExplanation(singleAnswerQ, [2], '', 0);
        expect(result).toBe('');
      });

      it('strips an already-formatted prefix before re-formatting', () => {
        const already = 'Option 1 is correct because the moon is round.';
        const result = service.formatExplanation(singleAnswerQ, [2], already, 0);
        // Re-formatted with the NEW index (2), not the stale 1
        expect(result).toBe('Option 2 is correct because the moon is round.');
      });

      it('infers MultipleAnswer when data shows >1 correct, regardless of input indices count', () => {
        // Caller passes a single index but the question data has 2 correct opts → multi phrasing
        const result = service.formatExplanation(multiAnswerQ, [2, 4], multiAnswerQ.explanation!, 1);
        expect(result.startsWith('Options ')).toBe(true);
      });
    });

    // ── storeFormattedExplanation + getFormattedSync ───────────

    describe('storeFormattedExplanation + getFormattedSync', () => {
      it('writes the formatted text into the cache, retrievable by index', () => {
        service.storeFormattedExplanation(
          0,
          'Option 2 is correct because 2 + 2 equals 4.',
          singleAnswerQ,
          singleAnswerQ.options
        );
        expect(service.getFormattedSync(0)).toBe('Option 2 is correct because 2 + 2 equals 4.');
      });

      it('does not overwrite when called with empty/whitespace explanation', () => {
        service.storeFormattedExplanation(0, 'original', singleAnswerQ);
        const stored = service.getFormattedSync(0);
        service.storeFormattedExplanation(0, '   ', singleAnswerQ);
        expect(service.getFormattedSync(0)).toBe(stored);
      });

      it('does not store for negative indices', () => {
        service.storeFormattedExplanation(-1, 'should not store', singleAnswerQ);
        expect(service.getFormattedSync(-1)).toBeUndefined();
      });

      it('stores independently per question index', () => {
        service.storeFormattedExplanation(0, 'first', singleAnswerQ);
        service.storeFormattedExplanation(1, 'second', multiAnswerQ);
        // Each index is formatted using its own question's correct indices
        // (a terminal period is appended when the FET has none).
        expect(service.getFormattedSync(0)).toBe('Option 2 is correct because first.');
        expect(service.getFormattedSync(1)).toBe('Options 2 and 4 are correct because second.');
      });
    });

    // ── End-to-end: format → store → retrieve ──────────────────

    describe('end-to-end FET round-trip', () => {
      it('single-answer Q1 → produces the expected cached text', () => {
        const indices = service.getCorrectOptionIndices(singleAnswerQ, singleAnswerQ.options, 0);
        const formatted = service.formatExplanation(singleAnswerQ, indices, singleAnswerQ.explanation!, 0);
        service.storeFormattedExplanation(0, formatted, singleAnswerQ, singleAnswerQ.options);
        expect(service.getFormattedSync(0)).toBe('Option 2 is correct because 2 + 2 equals 4.');
      });

      it('multi-answer Q2 → produces the expected cached text with multi phrasing', () => {
        const indices = service.getCorrectOptionIndices(multiAnswerQ, multiAnswerQ.options, 1);
        const formatted = service.formatExplanation(multiAnswerQ, indices, multiAnswerQ.explanation!, 1);
        service.storeFormattedExplanation(1, formatted, multiAnswerQ, multiAnswerQ.options);
        expect(service.getFormattedSync(1)).toBe('Options 2 and 4 are correct because both 2 and 4 are even.');
      });
    });
  });
});
