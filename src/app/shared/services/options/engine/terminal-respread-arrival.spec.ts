import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { Observable, Subject, of } from 'rxjs';

import { SocAnswerProcessingService } from './soc-answer-processing.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { QuestionVerdictService } from '../../features/verdict/question-verdict.service';
import { TOPIC_QUIZ_VERDICT_ADAPTER } from '../../features/verdict/verdict-adapter';
import type { QuestionCheckResult, QuestionExpiredResult } from '../../features/verdict/question-verdict.types';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../../features/timer/timer.service';
import { API_BASE_URL } from '../../../tokens/api-base-url.token';

/**
 * THE LIFECYCLE, not the helper.
 *
 * The terminal repaint — correct options stay live, the losers grey out — used
 * to run from the click. Under the API adapter the check is still in flight at
 * that moment: the phase is `checking`, nothing is authorized, and the only
 * thing left to paint from was the local answer key. The repaint was synchronous
 * BECAUSE the key was in the browser, so it could not have survived its removal.
 *
 * These tests drive the REAL QuestionVerdictService through a controllable
 * adapter, so the response can be held open and the in-flight window actually
 * observed. Stubbing `verdictFor` would prove the helper and miss the point.
 *
 * Every fixture's local bank is either INVERTED or has no `correct` property at
 * all, so a repaint that matched the answer key could only have come from the
 * bank — and the bank is wrong here.
 */

const QUIZ = 'rxjs';
const QUESTION = 'Which are RxJS operators?';
const OTHER_QUESTION = 'What does an Observable model?';

/** Truth: 'map' and 'filter'. The bank below never says so. */
const CORRECT_TEXTS = ['map', 'filter'];
const ALL_TEXTS = ['map', 'Subject', 'filter', 'Observable'];

let service: SocAnswerProcessingService;
let verdicts: QuestionVerdictService;
let responses: Subject<QuestionCheckResult>;

/** Adapter whose response the test holds open until it chooses to answer. */
class ControllableAdapter {
  check(): Observable<QuestionCheckResult> {
    return responses.asObservable();
  }
  revealExpired(): Observable<QuestionExpiredResult> {
    return of({ status: 'expired', correctOptionTexts: [], explanation: '' } as QuestionExpiredResult);
  }
}

/**
 * `mode` decides what the local bank claims:
 *  - lying: exactly inverted — Subject/Observable marked correct
 *  - bare:  no `correct` property anywhere
 */
function makeComp(
  mode: 'lying' | 'bare' = 'lying',
  order: 'forward' | 'reversed' = 'forward',
  questionText: string = QUESTION
) {
  const texts = order === 'forward' ? [...ALL_TEXTS] : [...ALL_TEXTS].reverse();
  const opts = texts.map((text, i) => {
    if (mode === 'bare') return { optionId: i + 1, text };
    return { optionId: i + 1, text, correct: !CORRECT_TEXTS.includes(text) };
  });

  let bindings = opts.map((o, i) => ({
    option: { ...o, active: true },
    index: i,
    isSelected: false,
    isCorrect: null as boolean | null,
    disabled: false
  }));

  let setCount = 0;
  let current = questionText;

  return {
    optionBindings: Object.assign(() => bindings, {
      set: (next: any[]) => { bindings = next; setCount++; }
    }),
    currentQuestion: () => ({ questionText: current, options: opts }),
    cdRef: { markForCheck: () => undefined, detectChanges: () => undefined },
    get bindings() { return bindings; },
    get repaints() { return setCount; },
    navigateTo: (q: string) => { current = q; },
    indexOfText: (t: string) => texts.indexOf(t)
  };
}

/** Put the question into the in-flight `checking` phase, as a click does. */
function beginCheck(selected: string[], questionText = QUESTION) {
  verdicts.checkAnswer(QUIZ, questionText, selected).subscribe({ error: () => undefined });
}

const resolvedAllCorrect = (): QuestionCheckResult => ({
  status: 'resolved',
  correct: true,
  correctOptionTexts: [...CORRECT_TEXTS],
  explanation: 'map and filter are operators.'
});

/** Let the respread's queueMicrotask run. */
const flush = () => Promise.resolve().then(() => undefined);

beforeEach(() => {
  responses = new Subject<QuestionCheckResult>();

  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      { provide: API_BASE_URL, useValue: 'https://api.test/api' },
      { provide: TOPIC_QUIZ_VERDICT_ADAPTER, useClass: ControllableAdapter },
      {
        provide: QuizService,
        useValue: {
          quizId: QUIZ,
          questions: [{ questionText: QUESTION, options: [] }],
          getQuestionsInDisplayOrder: () => [{ questionText: QUESTION, options: [] }],
          isShuffleEnabled: () => false,
          shuffledQuestions: [],
          totalQuestions: () => 1,
          getPristineCorrectTextsForQuestion: () => new Set<string>(),
          quizReset$: of(undefined)
        }
      },
      {
        provide: SelectedOptionService,
        useValue: {
          uiSelectedTextsForQuestion: () => new Set<string>(),
          stopTimer$: of(undefined),
          selectedOptionsMap: new Map(),
          clickConfirmedDotStatus: new Map()
        }
      },
      { provide: TimerService, useValue: { stopTimer: () => undefined, resetTimer: () => undefined } },
      { provide: FeedbackService, useValue: { setCorrectMessage: () => '' } }
    ]
  });

  service = TestBed.inject(SocAnswerProcessingService);
  verdicts = TestBed.inject(QuestionVerdictService);
});

/** The click-time registration. */
const scheduleRespread = (c: any) => (service as any).scheduleTerminalRespread(c);

const disabledTexts = (c: any) =>
  c.bindings.filter((b: any) => b.disabled).map((b: any) => b.option.text).sort();

describe('while the check is in flight, nothing is repainted', () => {
  it('does not grey anything out on the completing click', async () => {
    const c = makeComp();
    beginCheck(['map', 'filter']);       // phase is now `checking`
    scheduleRespread(c);
    await flush();

    expect(verdicts.verdictFor(QUIZ, QUESTION).phase).toBe('checking');
    expect(c.repaints).toBe(0);
    expect(c.bindings.every((b: any) => b.disabled === false)).toBe(true);
  });

  it('leaves every option neutral — the bank cannot fill the gap', async () => {
    const c = makeComp();                 // bank claims Subject+Observable correct
    beginCheck(['map', 'filter']);
    scheduleRespread(c);
    await flush();

    expect(c.bindings.every((b: any) => b.isCorrect === null)).toBe(true);
    expect(c.bindings.every((b: any) => b.option.active === true)).toBe(true);
  });
});

describe('the repaint happens when the verdict arrives', () => {
  it('greys the losers and keeps the authorized correct options live', async () => {
    const c = makeComp();
    beginCheck(['map', 'filter']);
    scheduleRespread(c);
    await flush();
    expect(c.repaints).toBe(0);

    responses.next(resolvedAllCorrect());
    await flush();

    expect(c.repaints).toBe(1);
    expect(disabledTexts(c)).toEqual(['Observable', 'Subject']);
    expect(c.bindings[c.indexOfText('map')].disabled).toBe(false);
    expect(c.bindings[c.indexOfText('filter')].disabled).toBe(false);
  });

  it('stamps correctness and active state from the authorized set', async () => {
    const c = makeComp();
    beginCheck(['map', 'filter']);
    scheduleRespread(c);
    responses.next(resolvedAllCorrect());
    await flush();

    expect(c.bindings[c.indexOfText('map')].isCorrect).toBe(true);
    expect(c.bindings[c.indexOfText('Subject')].isCorrect).toBe(false);
    expect(c.bindings[c.indexOfText('map')].option.active).toBe(true);
    expect(c.bindings[c.indexOfText('Subject')].option.active).toBe(false);
  });

  it('OVERRIDES a bank whose flags are exactly inverted', async () => {
    const c = makeComp('lying');
    beginCheck(['map', 'filter']);
    scheduleRespread(c);
    responses.next(resolvedAllCorrect());
    await flush();

    // The bank marked Subject/Observable correct. If it had leaked, THOSE would
    // be the enabled ones.
    expect(disabledTexts(c)).toEqual(['Observable', 'Subject']);
  });

  it('works with `correct` absent from the data entirely — the 10J proof', async () => {
    const c = makeComp('bare');
    expect(c.bindings.every((b: any) => (b.option as any).correct === undefined)).toBe(true);

    beginCheck(['map', 'filter']);
    scheduleRespread(c);
    await flush();
    expect(c.repaints).toBe(0);           // nothing local to paint from, and none used

    responses.next(resolvedAllCorrect());
    await flush();

    expect(disabledTexts(c)).toEqual(['Observable', 'Subject']);
  });

  it('matches by TEXT, so a reversed display order still repaints correctly', async () => {
    const c = makeComp('bare', 'reversed');   // Observable, filter, Subject, map
    beginCheck(['map', 'filter']);
    scheduleRespread(c);
    responses.next(resolvedAllCorrect());
    await flush();

    expect(c.bindings[c.indexOfText('map')].disabled).toBe(false);
    expect(c.bindings[c.indexOfText('filter')].disabled).toBe(false);
    expect(c.bindings[c.indexOfText('Observable')].disabled).toBe(true);
  });
});

describe('a wrong extra selection keeps its own repaint', () => {
  it('does not grey out when something wrong is also selected', async () => {
    const c = makeComp();
    beginCheck(['map', 'filter', 'Subject']);
    scheduleRespread(c);

    // Superset rule: resolved CORRECT even with a wrong extra. The respread gate
    // is PERFECT, though — a wrong pick must keep its red repaint rather than be
    // greyed out with the losers.
    responses.next({
      status: 'resolved',
      correct: true,
      correctOptionTexts: [...CORRECT_TEXTS],
      explanation: 'x'
    });
    await flush();

    expect(verdicts.verdictFor(QUIZ, QUESTION).isResolvedCorrect).toBe(true);
    expect(c.repaints).toBe(0);
  });
});

describe('stale and duplicate responses', () => {
  it('does not repaint a question the user has navigated away from', async () => {
    const c = makeComp();
    beginCheck(['map', 'filter']);
    scheduleRespread(c);

    c.navigateTo(OTHER_QUESTION);         // moved on before the answer came back
    responses.next(resolvedAllCorrect());
    await flush();

    expect(c.repaints).toBe(0);
  });

  it('repaints once even though every click registered the intent', async () => {
    const c = makeComp();
    beginCheck(['map']);
    scheduleRespread(c);
    scheduleRespread(c);
    scheduleRespread(c);

    responses.next(resolvedAllCorrect());
    await flush();

    expect(c.repaints).toBe(1);
  });

  it('ignores a repeated terminal publication', async () => {
    const c = makeComp();
    beginCheck(['map', 'filter']);
    scheduleRespread(c);

    responses.next(resolvedAllCorrect());
    await flush();
    const afterFirst = c.repaints;

    responses.next(resolvedAllCorrect());
    await flush();

    expect(c.repaints).toBe(afterFirst);
  });
});

describe('an already-terminal question repaints immediately', () => {
  it('does not wait for an arrival that has already happened', async () => {
    // The local adapter resolves DURING the click, before the click-time code
    // runs — so the arrival event is already spent by the time this registers.
    beginCheck(['map', 'filter']);
    responses.next(resolvedAllCorrect());

    const c = makeComp();                 // e.g. a revisit of a finished question
    expect(verdicts.verdictFor(QUIZ, QUESTION).phase).toBe('resolved');

    scheduleRespread(c);
    await flush();

    expect(c.repaints).toBe(1);
    expect(disabledTexts(c)).toEqual(['Observable', 'Subject']);
  });
});

describe('the terminal arrival stream', () => {
  it('announces only terminal phases, never checking', async () => {
    const seen: string[] = [];
    verdicts.terminalVerdicts$.subscribe((e) => seen.push(e.state.phase));

    beginCheck(['map']);                  // writes `checking` — must not announce
    expect(seen).toEqual([]);

    responses.next(resolvedAllCorrect());
    expect(seen).toEqual(['resolved']);
  });
});
