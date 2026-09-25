import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { API_BASE_URL } from '@shared/tokens/api-base-url.token';
import { ApiTopicQuizVerdictAdapter } from './api-verdict.adapter';
import { QuestionVerdictService } from './question-verdict.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from './verdict-adapter';

/**
 * FINALIZATION GATING (Stage 10I).
 *
 * A quiz must not be scored while "was this right?" is still in flight or has
 * failed. With the local adapter that could not happen — it answers in the same
 * tick — but once `/check` is a round trip, finalizing early means scoring from
 * a superseded verdict, or falling back to the local answer key.
 *
 * `hasBlockingVerdicts` is the single readiness query. Both Show Results paths
 * consult it: the button hides via `shouldShowResultsButton`, and
 * `advanceToResults` refuses as a backstop.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'rxjs';
const OTHER_QUIZ = 'signals';
const Q1 = 'Select every operator';
const Q2 = 'Which answer is correct?';

let http: HttpTestingController;
let verdicts: QuestionVerdictService;

const url = {
  attempts: (quiz: string) => `${BASE}/quizzes/${quiz}/attempts`,
  start: (quiz: string) => `${BASE}/quizzes/${quiz}/questions/start`,
  check: (quiz: string) => `${BASE}/quizzes/${quiz}/check`
};

const RESOLVED = {
  status: 'resolved', correct: true,
  correctOptionTexts: ['map', 'filter'], explanation: 'e'
};

/**
 * Start a check and return its pending request.
 *
 * The attempt receipt is cached per quiz and the question receipt per question,
 * so a second question in the SAME quiz issues no new attempt request — which
 * is the behaviour the lifecycle tests pin. Matching rather than expecting lets
 * this helper serve both the first and subsequent questions.
 */
function beginCheck(quiz: string, question: string, texts: string[]) {
  verdicts.checkAnswer(quiz, question, texts).subscribe({ error: () => undefined });

  http.match({ method: 'POST', url: url.attempts(quiz) })
    .forEach((req) => req.flush({ attemptReceipt: 'a' }));
  http.match({ method: 'POST', url: url.start(quiz) })
    .forEach((req) => req.flush({ questionReceipt: 'q' }));

  return http.expectOne({ method: 'POST', url: url.check(quiz) });
}

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE },
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useExisting: ApiTopicQuizVerdictAdapter },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } }
    ]
  });

  http = TestBed.inject(HttpTestingController);
  verdicts = TestBed.inject(QuestionVerdictService);
});

afterEach(() => http.verify());

describe('checking blocks finalization', () => {
  it('a check in flight blocks', () => {
    const req = beginCheck(QUIZ, Q1, ['map']);

    expect(verdicts.verdictFor(QUIZ, Q1).phase).toBe('checking');
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);

    req.flush(RESOLVED);
  });

  it('stops blocking once the verdict resolves', () => {
    const req = beginCheck(QUIZ, Q1, ['map', 'filter']);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);

    req.flush(RESOLVED);

    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });

  it('one pending question blocks even when another has resolved', () => {
    const first = beginCheck(QUIZ, Q1, ['map', 'filter']);
    first.flush(RESOLVED);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);

    const second = beginCheck(QUIZ, Q2, ['A pipe']);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);

    second.flush({ status: 'resolved', correct: false, correctOptionTexts: ['x'], explanation: 'e' });
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });
});

describe('error blocks finalization', () => {
  it('a failed check blocks rather than being scored', () => {
    const req = beginCheck(QUIZ, Q1, ['map']);
    req.error(new ProgressEvent('network error'));

    expect(verdicts.verdictFor(QUIZ, Q1).phase).toBe('error');
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);
  });

  it('a successful RETRY clears the block', () => {
    beginCheck(QUIZ, Q1, ['map']).error(new ProgressEvent('network error'));
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);

    // The user changes their selection, which resubmits.
    verdicts.checkAnswer(QUIZ, Q1, ['map', 'filter']).subscribe();
    http.expectOne({ method: 'POST', url: url.check(QUIZ) }).flush(RESOLVED);

    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });
});

describe('states that do NOT block', () => {
  it('an untouched quiz does not block', () => {
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });

  it('an INCOMPLETE verdict does not block', () => {
    // A partially answered multi is a legitimate final state to leave — it
    // simply does not score. Nothing is pending on it.
    const req = beginCheck(QUIZ, Q1, ['map']);
    req.flush({ status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 1 });

    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });

  it('an EXPIRED verdict does not block', () => {
    verdicts.revealExpiredQuestion(QUIZ, Q1).subscribe();
    http.expectOne({ method: 'POST', url: url.attempts(QUIZ) }).flush({ attemptReceipt: 'a' });
    http.expectOne({ method: 'POST', url: url.start(QUIZ) }).flush({ questionReceipt: 'q' });
    http.expectOne({ method: 'POST', url: url.check(QUIZ) }).flush({
      status: 'expired', correctOptionTexts: ['map'], explanation: 'e'
    });

    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });
});

describe('scoping', () => {
  it('another quiz\'s pending check does not block this one', () => {
    const other = beginCheck(OTHER_QUIZ, 'What does computed() return?', ['A promise']);

    expect(verdicts.hasBlockingVerdicts(OTHER_QUIZ)).toBe(true);
    // State survives across a session; another quiz's leftovers must not
    // strand the user here.
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);

    other.flush({ status: 'resolved', correct: false, correctOptionTexts: ['x'], explanation: 'e' });
  });

  it('an unscoped query sees any quiz', () => {
    const req = beginCheck(OTHER_QUIZ, 'What does computed() return?', ['A promise']);
    expect(verdicts.hasBlockingVerdicts()).toBe(true);
    req.flush({ status: 'resolved', correct: false, correctOptionTexts: ['x'], explanation: 'e' });
  });
});

describe('stale responses cannot unblock', () => {
  it('an older response landing last does not clear a newer pending check', () => {
    const first = beginCheck(QUIZ, Q1, ['map']);

    // The user changes their selection before the first response returns.
    verdicts.checkAnswer(QUIZ, Q1, ['map', 'filter']).subscribe({ error: () => undefined });
    const second = http.expectOne({ method: 'POST', url: url.check(QUIZ) });

    // The STALE response arrives first.
    first.flush({ status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 1 });

    // It must not unblock: the latest selection is still unjudged, and scoring
    // from the superseded answer would score the wrong selection.
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);
    expect(verdicts.verdictFor(QUIZ, Q1).phase).toBe('checking');

    second.flush(RESOLVED);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });

  it('a stale FAILURE does not block after the newer check succeeded', () => {
    const first = beginCheck(QUIZ, Q1, ['map']);
    verdicts.checkAnswer(QUIZ, Q1, ['map', 'filter']).subscribe({ error: () => undefined });
    const second = http.expectOne({ method: 'POST', url: url.check(QUIZ) });

    second.flush(RESOLVED);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);

    first.error(new ProgressEvent('network error'));

    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
    expect(verdicts.verdictFor(QUIZ, Q1).phase).toBe('resolved');
  });

  it('DESELECTING back to empty still requires the newest verdict', () => {
    const first = beginCheck(QUIZ, Q1, ['map', 'filter']);

    verdicts.checkAnswer(QUIZ, Q1, []).subscribe({ error: () => undefined });
    const second = http.expectOne({ method: 'POST', url: url.check(QUIZ) });

    first.flush(RESOLVED);
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(true);

    second.flush({ status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 2 });
    expect(verdicts.hasBlockingVerdicts(QUIZ)).toBe(false);
  });
});
