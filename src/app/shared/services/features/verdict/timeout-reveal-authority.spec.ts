import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { API_BASE_URL } from '../../../tokens/api-base-url.token';
import { ApiTopicQuizVerdictAdapter } from './api-verdict.adapter';
import { QuestionVerdictService } from './question-verdict.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from './verdict-adapter';
import { QuizService } from '../../data/quiz.service';
import { setQuizDataCache } from '../../../quiz-data-cache';
import {
  isCurrentOptionCorrect,
  isTimeoutRevealAuthorized
} from '../../../../components/question/answer/shared-option-component/option-item/helpers/option-item-correctness';
import type { Quiz } from '../../../models/Quiz.model';
import type { OptionBindings } from '../../../models/OptionBindings.model';

/**
 * TIMEOUT REVEAL AUTHORITY (Stage 10F).
 *
 * The race this closes: `TimerService` sets the expired flag and emits
 * `expired$` in one tick, and TWO independent subscribers act on it — the
 * option renderer, and the orchestrator that calls `revealExpiredQuestion`.
 * Their order is subscription-registration order, so the renderer could paint
 * while the verdict was still `idle`. Something had to fill that gap, and what
 * filled it was a direct read of the local answer key.
 *
 * The rule now: "the timer ran out" never authorizes correctness. Only an
 * `expired` verdict does.
 *
 * The decisive tests are the two where the local `correct` flags LIE. If the UI
 * still follows the backend, its authority is genuinely the verdict rather than
 * a coincidental agreement with the bank it is about to lose.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'rxjs';
const QUESTION = 'Select every operator';

// The LOCAL bank deliberately disagrees with the backend:
//   'Observable' is flagged correct here but is NOT in the authorized reveal.
//   'filter'     is flagged incorrect here but IS in the authorized reveal.
const LYING_QUESTIONS = [
  {
    questionText: QUESTION,
    explanation: 'LOCAL explanation that must never be shown.',
    options: [
      { text: 'map', correct: true },
      { text: 'filter' },                     // backend says CORRECT
      { text: 'Observable', correct: true }    // backend says INCORRECT
    ]
  }
];

const LYING_BANK = [
  { quizId: QUIZ, milestone: 'RxJS', questions: LYING_QUESTIONS }
] as unknown as Quiz[];

const AUTHORIZED_CORRECT = ['map', 'filter'];
const AUTHORIZED_EXPLANATION = 'map and filter are operators.';

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

let http: HttpTestingController;
let verdicts: QuestionVerdictService;
let quizService: QuizService;

const bindingFor = (text: string): OptionBindings =>
  ({ option: { text } } as unknown as OptionBindings);

/** What option-item asks when deciding whether to paint an option green. */
const paintsCorrect = (text: string): boolean =>
  isTimeoutRevealAuthorized(quizService, 0, verdicts)
  && isCurrentOptionCorrect(bindingFor(text), quizService, 0, verdicts);

function flushReveal(): void {
  http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/attempts` })
    .flush({ attemptReceipt: 'a' });
  http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/questions/start` })
    .flush({ questionReceipt: 'q' });
  http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/check` }).flush({
    status: 'expired',
    correctOptionTexts: AUTHORIZED_CORRECT,
    explanation: AUTHORIZED_EXPLANATION
  });
}

beforeEach(() => {
  setQuizDataCache(JSON.parse(JSON.stringify(LYING_BANK)) as Quiz[], []);

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
  quizService = TestBed.inject(QuizService);
  (quizService as any).quizId = QUIZ;
  // Stated explicitly through the setter. These specs used to set only the
  // SIGNAL and let QuizService's constructor seed the backing array from the
  // mocked bank. S4 removed that constructor-time seed (it was handing every
  // session the FIRST quiz in the bank regardless of route), so a spec that
  // needs questions now has to say so.
  quizService.questions = JSON.parse(JSON.stringify(LYING_BANK[0]!.questions)) as never;
});

/**
 * Drain the question-TYPE request.
 *
 * QuizService.initializeData now asks TopicQuizTypeRegistry for this quiz's
 * declared types, because type used to be inferred by counting correct
 * options. It is unrelated to the reveal under test here, but it is a real
 * consequence of constructing QuizService with an API base URL, so the spec
 * accounts for it rather than pretending it does not happen.
 */
function drainTypeRequests(): void {
  for (const req of http.match((r) => r.url.endsWith('/questions'))) {
    req.flush({ quizId: QUIZ, questions: [] });
  }
}

afterEach(() => {
  drainTypeRequests();
  http.verify();
  setQuizDataCache([], []);
});

describe('before the reveal response arrives', () => {
  it('the reveal is NOT authorized while the request is in flight', () => {
    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe();

    expect(isTimeoutRevealAuthorized(quizService, 0, verdicts)).toBe(false);

    flushReveal();
  });

  it('paints NO option correct while the reveal is pending', () => {
    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe();

    // Including the one the local bank would have painted immediately.
    for (const text of ['map', 'filter', 'Observable']) {
      expect(paintsCorrect(text)).toBe(false);
    }

    flushReveal();
  });

  it('exposes NO explanation while the reveal is pending', () => {
    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe();

    expect(verdicts.verdictFor(QUIZ, QUESTION).explanation).toBeNull();

    flushReveal();
  });
});

describe('after the authorized reveal', () => {
  beforeEach(() => {
    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe();
    flushReveal();
  });

  it('transitions the verdict to expired', () => {
    expect(verdicts.verdictFor(QUIZ, QUESTION).phase).toBe('expired');
    expect(isTimeoutRevealAuthorized(quizService, 0, verdicts)).toBe(true);
  });

  it('paints the AUTHORIZED correct options', () => {
    expect(paintsCorrect('map')).toBe(true);
    expect(paintsCorrect('filter')).toBe(true);
  });

  it('takes the explanation from the RESPONSE, not the local question', () => {
    const state = verdicts.verdictFor(QUIZ, QUESTION);
    expect(state.explanation).toBe(AUTHORIZED_EXPLANATION);
    expect(state.explanation).not.toContain('must never be shown');
  });

  it('does not claim the user answered correctly', () => {
    // Expiry reveals the answer; it does not award the question.
    expect(verdicts.verdictFor(QUIZ, QUESTION).isResolvedCorrect).toBeNull();
  });
});

describe('the backend overrules the local answer key', () => {
  beforeEach(() => {
    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe();
    flushReveal();
  });

  it('an option the LOCAL bank calls correct is NOT painted when unauthorized', () => {
    // `Observable` carries `correct: true` locally. The reveal omits it.
    expect(LYING_QUESTIONS[0]!.options[2]!.correct).toBe(true);
    expect(paintsCorrect('Observable')).toBe(false);
  });

  it('an option the LOCAL bank calls incorrect IS painted when authorized', () => {
    // `filter` has no local `correct` flag at all. The reveal includes it.
    expect(LYING_QUESTIONS[0]!.options[1]!).not.toHaveProperty('correct');
    expect(paintsCorrect('filter')).toBe(true);
  });
});

describe('failure stays closed', () => {
  it('a failed reveal paints nothing and does NOT fall back to the bank', (done) => {
    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe({
      error: () => {
        expect(isTimeoutRevealAuthorized(quizService, 0, verdicts)).toBe(false);
        for (const text of ['map', 'filter', 'Observable']) {
          expect(paintsCorrect(text)).toBe(false);
        }
        expect(verdicts.verdictFor(QUIZ, QUESTION).correctOptionTexts).toEqual([]);
        done();
      }
    });

    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/attempts` })
      .flush({ attemptReceipt: 'a' });
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/questions/start` })
      .flush({ questionReceipt: 'q' });
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/check` })
      .error(new ProgressEvent('network error'));
  });

  it('a server refusing to expire does not authorize a reveal', (done) => {
    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe({
      error: () => {
        expect(isTimeoutRevealAuthorized(quizService, 0, verdicts)).toBe(false);
        done();
      }
    });

    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/attempts` })
      .flush({ attemptReceipt: 'a' });
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/questions/start` })
      .flush({ questionReceipt: 'q' });
    // The signed deadline has not passed, so the server answers normally.
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/check` })
      .flush({ status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 2 });
  });
});

describe('duplicate expiry and revisit', () => {
  it('reuses the question receipt — a revisit does not buy another 30 seconds', () => {
    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe();
    flushReveal();

    // The user navigates away and back; the question is still expired.
    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe();

    http.expectNone({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/attempts` });
    http.expectNone({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/questions/start` });
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/check` }).flush({
      status: 'expired',
      correctOptionTexts: AUTHORIZED_CORRECT,
      explanation: AUTHORIZED_EXPLANATION
    });

    expect(verdicts.verdictFor(QUIZ, QUESTION).phase).toBe('expired');
  });

  it('the authorized expired state SURVIVES a revisit', () => {
    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe();
    flushReveal();

    // Nothing re-requested; the state simply persists in memory.
    expect(verdicts.verdictFor(QUIZ, QUESTION).phase).toBe('expired');
    expect(paintsCorrect('filter')).toBe(true);
    expect(verdicts.verdictFor(QUIZ, QUESTION).explanation).toBe(AUTHORIZED_EXPLANATION);
  });

  it('a stale normal /check response cannot overwrite the expired verdict', () => {
    // A selection check is already in flight when the timer runs out.
    verdicts.checkAnswer(QUIZ, QUESTION, ['map']).subscribe({ error: () => undefined });
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/attempts` })
      .flush({ attemptReceipt: 'a' });
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/questions/start` })
      .flush({ questionReceipt: 'q' });
    const pendingCheck = http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/check` });

    verdicts.revealExpiredQuestion(QUIZ, QUESTION).subscribe();
    http.expectOne({ method: 'POST', url: `${BASE}/quizzes/${QUIZ}/check` }).flush({
      status: 'expired',
      correctOptionTexts: AUTHORIZED_CORRECT,
      explanation: AUTHORIZED_EXPLANATION
    });
    expect(verdicts.verdictFor(QUIZ, QUESTION).phase).toBe('expired');

    // The older selection response lands afterwards and must be ignored.
    pendingCheck.flush({ status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: 1 });

    expect(verdicts.verdictFor(QUIZ, QUESTION).phase).toBe('expired');
    expect(paintsCorrect('filter')).toBe(true);
  });
});
