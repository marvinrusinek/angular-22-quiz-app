import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { API_BASE_URL } from '@shared/tokens/api-base-url.token';
import { ApiTopicQuizVerdictAdapter } from './api-verdict.adapter';
import { QuestionVerdictService } from './question-verdict.service';
import { TopicQuizDotVerdictSyncService } from './dot-verdict-sync.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from './verdict-adapter';
import { QuizService } from '@shared/services/data/quiz.service';
import { SelectedOptionService } from '@shared/services/state/selectedoption.service';
import { setQuizDataCache } from '@shared/quiz-data-cache';
import type { Quiz } from '@shared/models/Quiz.model';

/**
 * ASYNC DOT STATUS (Stage 10E).
 *
 * Dot correctness used to be stamped synchronously at click time from
 * `option.correct`. That is only possible while the answer key is in the
 * browser. Under the API adapter the verdict is a round trip, so the dot must
 * stay silent until it lands — and then update.
 *
 * The mandatory proof is the pair of tests where the local flags LIE. If the
 * dot follows the verdict in both directions, its authority is genuinely the
 * backend rather than coincidental agreement with the bank.
 */

const BASE = 'https://api.test/api';
const QUIZ = 'rxjs';
const SINGLE = 'Which answer is correct?';
const MULTI = 'Select every operator';

// LOCAL flags are deliberately inverted from what the backend will say:
//   'A pipe' is flagged correct locally; the verdict says false.
//   'A multicast observable' has no local flag; the verdict says true.
const QUESTIONS = [
  {
    questionText: SINGLE,
    explanation: 'local explanation',
    options: [
      { text: 'A multicast observable' },      // verdict: CORRECT
      { text: 'A pipe', correct: true }         // verdict: INCORRECT
    ]
  },
  {
    questionText: MULTI,
    explanation: 'local explanation',
    options: [
      { text: 'map', correct: true },
      { text: 'filter', correct: true },
      { text: 'Observable' }
    ]
  }
];

const BANK = [
  { quizId: QUIZ, milestone: 'RxJS', questions: QUESTIONS }
] as unknown as Quiz[];

if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}

let http: HttpTestingController;
let verdicts: QuestionVerdictService;
let sync: TopicQuizDotVerdictSyncService;
let selectedOptionService: SelectedOptionService;
let quizService: QuizService;

/**
 * Flush pending effects.
 *
 * The sync service reacts through an Angular `effect`, which runs during change
 * detection. There is no component fixture here, so the tests drive that
 * explicitly — this is what a real CD pass does after a response lands.
 */
function settle(): void {
  const bed = TestBed as unknown as { tick?: () => void; flushEffects?: () => void };
  if (typeof bed.tick === 'function') bed.tick();
  else if (typeof bed.flushEffects === 'function') bed.flushEffects();
}

const dotFor = (idx: number) => {
  settle();
  return selectedOptionService.clickConfirmedDotStatus.get(idx);
};
const lastCorrectFor = (idx: number) => {
  settle();
  return selectedOptionService.lastClickedCorrectByQuestion.get(idx);
};

const url = {
  attempts: `${BASE}/quizzes/${QUIZ}/attempts`,
  start: `${BASE}/quizzes/${QUIZ}/questions/start`,
  check: `${BASE}/quizzes/${QUIZ}/check`
};

/** Submit a selection and register the dot wait, the way the click path does. */
function click(qIdx: number, questionText: string, selected: string[], clicked: string): void {
  verdicts.checkAnswer(QUIZ, questionText, selected).subscribe({ error: () => undefined });
  sync.awaitVerdict(qIdx, QUIZ, questionText, clicked);
}

function grantReceipts(): void {
  http.expectOne({ method: 'POST', url: url.attempts }).flush({ attemptReceipt: 'a' });
  http.expectOne({ method: 'POST', url: url.start }).flush({ questionReceipt: 'q' });
}

beforeEach(() => {
  setQuizDataCache(JSON.parse(JSON.stringify(BANK)) as Quiz[], []);

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
  sync = TestBed.inject(TopicQuizDotVerdictSyncService);
  selectedOptionService = TestBed.inject(SelectedOptionService);
  quizService = TestBed.inject(QuizService);
  (quizService as any).quizId = QUIZ;
  quizService.questionsSig.set(JSON.parse(JSON.stringify(QUESTIONS)) as never);
});

/**
 * Drain the question-TYPE request.
 *
 * QuizService.initializeData now asks TopicQuizTypeRegistry for this quiz's
 * declared types, because type used to be inferred by counting correct
 * options. Unrelated to dot state, but a real consequence of constructing
 * QuizService with an API base URL, so the spec accounts for it.
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

describe('pending verdict', () => {
  it('writes NO dot state while the check is in flight', () => {
    click(0, SINGLE, ['A pipe'], 'A pipe');
    grantReceipts();

    // The local flag says 'A pipe' is correct. Nothing may be painted from it.
    expect(dotFor(0)).toBeUndefined();
    expect(lastCorrectFor(0)).toBeUndefined();

    http.expectOne({ method: 'POST', url: url.check }).flush({
      status: 'resolved', correct: false, correctOptionTexts: ['A multicast observable'], explanation: 'e'
    });
  });

  it('updates the dot once the verdict arrives', () => {
    click(0, SINGLE, ['A multicast observable'], 'A multicast observable');
    grantReceipts();
    expect(dotFor(0)).toBeUndefined();

    http.expectOne({ method: 'POST', url: url.check }).flush({
      status: 'resolved', correct: true, correctOptionTexts: ['A multicast observable'], explanation: 'e'
    });

    expect(dotFor(0)).toBe('correct');
    expect(lastCorrectFor(0)).toBe(true);
  });
});

describe('the backend overrules the local answer key', () => {
  it('a locally-CORRECT option the verdict rejects produces a WRONG dot', () => {
    expect(QUESTIONS[0]!.options[1]!.correct).toBe(true);   // local says correct

    click(0, SINGLE, ['A pipe'], 'A pipe');
    grantReceipts();
    http.expectOne({ method: 'POST', url: url.check }).flush({
      status: 'resolved', correct: false, correctOptionTexts: ['A multicast observable'], explanation: 'e'
    });

    expect(dotFor(0)).toBe('wrong');
    expect(lastCorrectFor(0)).toBe(false);
  });

  it('a locally-UNFLAGGED option the verdict accepts produces a CORRECT dot', () => {
    expect(QUESTIONS[0]!.options[0]!).not.toHaveProperty('correct');   // local says nothing

    click(0, SINGLE, ['A multicast observable'], 'A multicast observable');
    grantReceipts();
    http.expectOne({ method: 'POST', url: url.check }).flush({
      status: 'resolved', correct: true, correctOptionTexts: ['A multicast observable'], explanation: 'e'
    });

    expect(dotFor(0)).toBe('correct');
    expect(lastCorrectFor(0)).toBe(true);
  });
});

describe('single answer', () => {
  it('a terminal verdict does NOT imply correct', () => {
    click(0, SINGLE, ['A pipe'], 'A pipe');
    grantReceipts();
    http.expectOne({ method: 'POST', url: url.check }).flush({
      status: 'resolved', correct: false, correctOptionTexts: ['A multicast observable'], explanation: 'e'
    });

    // Resolved, but wrong. The dot must reflect the second fact, not the first.
    expect(verdicts.verdictFor(QUIZ, SINGLE).phase).toBe('resolved');
    expect(dotFor(0)).toBe('wrong');
  });
});

describe('multiple answer', () => {
  it('a first CORRECT pick marks the dot correct while the question stays incomplete', () => {
    click(1, MULTI, ['map'], 'map');
    grantReceipts();
    http.expectOne({ method: 'POST', url: url.check }).flush({
      status: 'incomplete',
      selectedVerdicts: [{ text: 'map', correct: true }],
      remainingCorrectCount: 1
    });

    expect(dotFor(1)).toBe('correct');
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('incomplete');
  });

  it('an INCORRECT-only pick marks the dot wrong and stays incomplete', () => {
    click(1, MULTI, ['Observable'], 'Observable');
    grantReceipts();
    http.expectOne({ method: 'POST', url: url.check }).flush({
      status: 'incomplete',
      selectedVerdicts: [{ text: 'Observable', correct: false }],
      remainingCorrectCount: 2
    });

    expect(dotFor(1)).toBe('wrong');
    expect(verdicts.verdictFor(QUIZ, MULTI).phase).toBe('incomplete');
  });

  it('SUPERSET completion resolves even with an incorrect pick present', () => {
    click(1, MULTI, ['map', 'filter', 'Observable'], 'filter');
    grantReceipts();
    http.expectOne({ method: 'POST', url: url.check }).flush({
      status: 'resolved', correct: true, correctOptionTexts: ['map', 'filter'], explanation: 'e'
    });

    expect(verdicts.verdictFor(QUIZ, MULTI).isResolvedCorrect).toBe(true);
    expect(dotFor(1)).toBe('correct');
  });
});

describe('stale responses', () => {
  it('an older response cannot overwrite the newer dot', () => {
    click(1, MULTI, ['Observable'], 'Observable');
    grantReceipts();
    const first = http.expectOne({ method: 'POST', url: url.check });

    // The user clicks again before the first response lands.
    click(1, MULTI, ['Observable', 'map'], 'map');
    const second = http.expectOne({ method: 'POST', url: url.check });

    second.flush({
      status: 'incomplete',
      selectedVerdicts: [{ text: 'Observable', correct: false }, { text: 'map', correct: true }],
      remainingCorrectCount: 1
    });
    expect(dotFor(1)).toBe('correct');   // 'map' was the newer click

    // The stale response arrives afterwards and must not move the dot.
    first.flush({
      status: 'incomplete',
      selectedVerdicts: [{ text: 'Observable', correct: false }],
      remainingCorrectCount: 2
    });

    expect(dotFor(1)).toBe('correct');
    expect(lastCorrectFor(1)).toBe(true);
  });
});

describe('shuffle-aware mapping', () => {
  it('resolves a question to its DISPLAY index, not its source index', () => {
    // Shuffled: the multi question is displayed first.
    const shuffled = [QUESTIONS[1], QUESTIONS[0]];
    (quizService as any).getQuestionsInDisplayOrder = () => shuffled;

    expect(sync.displayIndexOf(MULTI)).toBe(0);
    expect(sync.displayIndexOf(SINGLE)).toBe(1);
  });

  it('matches ignoring case and surrounding whitespace', () => {
    (quizService as any).getQuestionsInDisplayOrder = () => QUESTIONS;
    expect(sync.displayIndexOf('  SELECT   every OPERATOR  ')).toBe(1);
  });

  it('returns -1 for a question that is not displayed', () => {
    (quizService as any).getQuestionsInDisplayOrder = () => QUESTIONS;
    expect(sync.displayIndexOf('Not in this quiz')).toBe(-1);
  });

  it('a verdict for question A never writes question B\'s dot', () => {
    // Shuffled so the multi question is at display index 0.
    (quizService as any).getQuestionsInDisplayOrder = () => [QUESTIONS[1], QUESTIONS[0]];

    click(0, MULTI, ['map'], 'map');
    grantReceipts();
    http.expectOne({ method: 'POST', url: url.check }).flush({
      status: 'incomplete',
      selectedVerdicts: [{ text: 'map', correct: true }],
      remainingCorrectCount: 1
    });

    expect(dotFor(0)).toBe('correct');
    expect(dotFor(1)).toBeUndefined();   // the single question is untouched
  });
});

describe('lifecycle', () => {
  it('cancel() stops a pending wait from ever writing', () => {
    click(0, SINGLE, ['A pipe'], 'A pipe');
    grantReceipts();

    sync.cancel(0);

    http.expectOne({ method: 'POST', url: url.check }).flush({
      status: 'resolved', correct: false, correctOptionTexts: ['A multicast observable'], explanation: 'e'
    });

    expect(dotFor(0)).toBeUndefined();
  });

  it('a failed check leaves the dot untouched rather than guessing', () => {
    click(0, SINGLE, ['A pipe'], 'A pipe');
    grantReceipts();

    http.expectOne({ method: 'POST', url: url.check })
      .error(new ProgressEvent('network error'));

    expect(dotFor(0)).toBeUndefined();
    expect(lastCorrectFor(0)).toBeUndefined();
  });

  it('rendering a question does not submit or write a dot', () => {
    // No click, no awaitVerdict — pure render traffic.
    expect(dotFor(0)).toBeUndefined();
    expect(dotFor(1)).toBeUndefined();
    http.expectNone({ method: 'POST', url: url.check });
  });
});
