import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';

import { API_BASE_URL } from '../../tokens/api-base-url.token';
import { QuestionType } from '../../models/question-type.enum';
import { TopicQuizTypeRegistry } from './topic-quiz-type-registry.service';
import { withCorrectCountBanner } from '../../utils/correct-count-banner';
import { QuizQuestionManagerService } from '../flow/quizquestionmgr.service';

/**
 * The "(N answers are correct)" banner reads a DECLARED count.
 *
 * It used to be `options.filter(isOptionCorrect).length` — which made the
 * banner an answer-key derivative. API-sourced options carry no `correct`, so
 * that count was always 0 and the banner silently disappeared; under shuffle it
 * also needed a canonical re-lookup by text, because the rendered options were
 * empty before the first selection.
 *
 * `correctCount` is CARDINALITY, not identity: how many options are right,
 * never which. The endpoint ships it deliberately — the number has always been
 * on screen before the user answers — and the registry stores it by question
 * text, so the banner needs neither the options nor the local bank.
 *
 * These pin the AUTHORITY and the FAIL-CLOSED rule. The banner's markup is
 * covered by `withCorrectCountBanner`; what matters here is where N comes from.
 */

const BASE = 'http://api.test/api';
const QUIZ = 'rxjs';

const MULTI_Q = 'Which operators flatten an inner observable?';
const SINGLE_Q = 'Is a signal synchronous?';
const UNKNOWN_Q = 'A question the API never described';

/**
 * The banner rule as the component applies it, over a declared count.
 *
 * Uses the SAME two helpers the component does — the manager owns the wording
 * and pluralisation, `withCorrectCountBanner` owns the markup — so this asserts
 * the shipped rule rather than a test-local copy of it.
 */
function bannerFor(
  registry: TopicQuizTypeRegistry,
  manager: QuizQuestionManagerService,
  questionText: string,
  totalOptions?: number
): string {
  const declaredCount = registry.correctCountOf(questionText);
  // FAIL CLOSED: unknown renders no banner, and is never reconstructed locally.
  if (declaredCount === null || declaredCount <= 1) return questionText;
  return withCorrectCountBanner(
    questionText,
    manager.getNumberOfCorrectAnswersText(declaredCount, totalOptions)
  );
}

describe('correct-count banner — declared cardinality, never counted', () => {
  let http: HttpTestingController;
  let registry: TopicQuizTypeRegistry;
  let manager: QuizQuestionManagerService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: BASE },
        TopicQuizTypeRegistry,
        QuizQuestionManagerService
      ]
    });
    http = TestBed.inject(HttpTestingController);
    registry = TestBed.inject(TopicQuizTypeRegistry);
    manager = TestBed.inject(QuizQuestionManagerService);
  });

  afterEach(() => http.verify());

  /** Load the registry from a `/questions` payload shaped like the real one. */
  function load(questions: Record<string, unknown>[]): void {
    registry.load(QUIZ).subscribe();
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`).flush({ quizId: QUIZ, questions });
  }

  /** Exactly what the endpoint sends: texts only, and NO `correct` anywhere. */
  const apiQuestions = [
    {
      questionText: MULTI_Q,
      type: 'multiple',
      difficulty: 'intermediate',
      correctCount: 3,
      options: [{ text: 'mergeMap' }, { text: 'tap' }, { text: 'switchMap' }, { text: 'concatMap' }]
    },
    {
      questionText: SINGLE_Q,
      type: 'single',
      difficulty: 'beginner',
      correctCount: 1,
      options: [{ text: 'Yes' }, { text: 'No' }]
    }
  ];

  it('shows the count BEFORE any selection exists', () => {
    load(apiQuestions);
    // Nothing has been selected and no option carries correctness — the banner
    // still knows there are three.
    expect(bannerFor(registry, manager, MULTI_Q)).toContain('(3 answers are correct)');
  });

  it('API-sourced options carry NO correct flag, yet the count survives', () => {
    load(apiQuestions);
    for (const question of apiQuestions) {
      for (const option of question['options'] as Record<string, unknown>[]) {
        expect(Object.prototype.hasOwnProperty.call(option, 'correct')).toBe(false);
      }
    }
    expect(registry.correctCountOf(MULTI_Q)).toBe(3);
  });

  it('the DECLARED multi-answer type still resolves independently of the count', () => {
    load(apiQuestions);
    expect(registry.isMultiAnswer(MULTI_Q)).toBe(true);
    expect(registry.questionTypeOf(MULTI_Q)).toBe(QuestionType.MultipleAnswer);
    expect(registry.isMultiAnswer(SINGLE_Q)).toBe(false);
  });

  it('a single-answer question renders NO banner', () => {
    load(apiQuestions);
    expect(bannerFor(registry, manager, SINGLE_Q)).toBe(SINGLE_Q);
  });

  it('FAILS CLOSED: an undeclared count renders no banner and is not reconstructed', () => {
    load(apiQuestions);
    expect(registry.correctCountOf(UNKNOWN_Q)).toBeNull();
    // Not "(0 answers are correct)", not a locally counted number — nothing.
    expect(bannerFor(registry, manager, UNKNOWN_Q)).toBe(UNKNOWN_Q);
  });

  it('FAILS CLOSED when the API never answered at all', () => {
    registry.load(QUIZ).subscribe();
    http.expectOne(`${BASE}/quizzes/${QUIZ}/questions`).error(new ProgressEvent('offline'));

    expect(registry.correctCountOf(MULTI_Q)).toBeNull();
    expect(bannerFor(registry, manager, MULTI_Q)).toBe(MULTI_Q);
  });

  it('a server count of -1 ("no usable count") is unknown, not zero', () => {
    load([{ ...apiQuestions[0], correctCount: -1 }]);
    expect(registry.correctCountOf(MULTI_Q)).toBeNull();
    expect(bannerFor(registry, manager, MULTI_Q)).toBe(MULTI_Q);
  });

  it('matches on canonical question text, so shuffle order cannot affect it', () => {
    load(apiQuestions);
    const noisy = `   ${MULTI_Q.toUpperCase()}   `;
    expect(registry.correctCountOf(noisy)).toBe(3);
  });
});
