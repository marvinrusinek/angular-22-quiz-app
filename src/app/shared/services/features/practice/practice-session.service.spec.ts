import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';

import { PracticeSessionService } from './practice-session.service';
import { AssessmentBuilderService } from '../assessment/assessment-builder.service';
import { TopicPerformanceHistoryService } from '../../progress/topic-performance-history.service';
import { WeakAreasService } from '../../progress/weak-areas.service';
import { TopicQuizQuestionsService } from '../../api/topic-quiz-questions.service';
import { PracticeVerdictService } from './practice-verdict.service';
import { SK_PRACTICE_SESSION, SK_TOPIC_PERFORMANCE_HISTORY } from '../../../constants/session-keys';
import { setQuizDataCache } from '../../../quiz-data-cache';
import { Quiz } from '../../../models/Quiz.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { QuestionType } from '../../../models/question-type.enum';
import quizData from '../../../../../assets/data/quiz.json';

const REAL_CATALOG = ((quizData as { quizzes?: unknown[] }).quizzes ?? quizData) as Quiz[];

const weakIds = signal<string[]>(['rxjs', 'signals']);
const weakAreasStub = { weakTopicIds: weakIds } as unknown as WeakAreasService;

/**
 * Stands in for `GET /quizzes/:id/questions`.
 *
 * Emits exactly what the endpoint emits: question text, the DECLARED type, and
 * option TEXTS — with no `correct`, no `answer` and no `explanation`. The type
 * is derived here the same way the SERVER derives it (`quiz.validation.ts`:
 * more than one correct option means `multiple`), because the local bank
 * carries no type field of its own.
 */
const questionsApiStub = {
  loadQuestions: (quizId: string) => {
    const quiz = REAL_CATALOG.find((q) => (q.quizId ?? (q as { id?: string }).id) === quizId);
    const views = (quiz?.questions ?? []).map((q) => {
      const correctCount = (q.options ?? []).filter((o) => o.correct === true).length;
      return {
        questionText: q.questionText,
        type: correctCount > 1 ? 'multiple' : 'single',
        difficulty: 'beginner',
        correctCount,
        options: (q.options ?? []).map((o) => ({ text: o.text }))
      };
    });
    return of(views);
  }
} as unknown as TopicQuizQuestionsService;

/**
 * Stands in for `POST /check`.
 *
 * Resolution is EXPLICITLY granted by the spec via `markResolved`, mirroring a
 * verdict arriving from the server. Nothing here inspects `option.correct`, so
 * a session can only be scored by something authorized saying so.
 */
class VerdictStub {
  private readonly resolved = new Set<string>();
  private readonly correct = new Map<string, readonly string[]>();

  private key(quizId: string, text: string): string {
    return `${quizId}::${(text ?? '').trim().toLowerCase()}`;
  }

  markResolved(quizId: string, questionText: string, correctTexts: readonly string[] = []): void {
    this.resolved.add(this.key(quizId, questionText));
    this.correct.set(this.key(quizId, questionText), correctTexts);
  }

  isResolved(quizId: string, questionText: string): boolean {
    return this.resolved.has(this.key(quizId, questionText));
  }

  verdictFor(quizId: string, questionText: string) {
    return {
      resolved: this.isResolved(quizId, questionText),
      terminal: this.isResolved(quizId, questionText),
      selectedVerdicts: new Map<string, boolean>(),
      correctTexts: this.correct.get(this.key(quizId, questionText)) ?? [],
      remainingCorrectCount: null,
      explanation: '',
      errored: false
    };
  }

  unresolve(quizId: string, questionText: string): void {
    this.resolved.delete(this.key(quizId, questionText));
  }

  verdicts = signal(new Map());
  clear(): void { this.resolved.clear(); this.correct.clear(); }
}

let verdictStub: VerdictStub;

function service(): PracticeSessionService {
  TestBed.resetTestingModule();
  verdictStub = new VerdictStub();
  TestBed.configureTestingModule({
    providers: [
      PracticeSessionService,
      AssessmentBuilderService,
      TopicPerformanceHistoryService,
      { provide: WeakAreasService, useValue: weakAreasStub },
      { provide: TopicQuizQuestionsService, useValue: questionsApiStub },
      { provide: PracticeVerdictService, useValue: verdictStub }
    ]
  });
  return TestBed.inject(PracticeSessionService);
}

/**
 * Answer every question correctly and land on the last one, ready to submit.
 *
 * API-sourced options carry no `correct`, so the ids come from the CATALOG by
 * matching option text — the same text identity the server uses. The verdict
 * stub is then told the question resolved, standing in for `POST /check`.
 */
function answerAllCorrectly(svc: PracticeSessionService): void {
  for (let i = 0; i < svc.total(); i++) {
    const question = svc.questions()[i];
    const ids = correctIdsFromCatalog(question);
    svc.select(i, ids);
    verdictStub.markResolved(
      question.sourceQuizId ?? '',
      question.questionText ?? '',
      correctTextsFromCatalog(question)
    );
  }
  svc.goTo(svc.total() - 1);
}

/** The catalog entry for a generated question, matched by exact text. */
function catalogQuestionFor(question: QuizQuestion): QuizQuestion | undefined {
  const quiz = REAL_CATALOG.find(
    (q) => (q.quizId ?? (q as { id?: string }).id) === question.sourceQuizId
  );
  return (quiz?.questions ?? []).find((q) => q.questionText === question.questionText);
}

function correctTextsFromCatalog(question: QuizQuestion): string[] {
  return (catalogQuestionFor(question)?.options ?? [])
    .filter((o) => o.correct === true)
    .map((o) => o.text ?? '');
}

/** Ids of the correct options AS RENDERED, resolved by text against the catalog. */
function correctIdsFromCatalog(question: QuizQuestion): number[] {
  const wanted = new Set(correctTextsFromCatalog(question));
  return (question.options ?? [])
    .filter((o) => wanted.has(o.text ?? ''))
    .map((o) => o.optionId)
    .filter((id): id is number => id != null);
}

/** An id the catalog says is NOT correct, for the wrong-answer cases. */
function wrongIdFromCatalog(question: QuizQuestion): number {
  const wanted = new Set(correctTextsFromCatalog(question));
  return (question.options ?? [])
    .filter((o) => !wanted.has(o.text ?? ''))
    .map((o) => o.optionId)
    .find((id): id is number => id != null)!;
}

/** The server authorizes this question — the verdict arriving. */
function resolveCurrent(svc: PracticeSessionService, index: number): void {
  const q = svc.questions()[index];
  verdictStub.markResolved(q.sourceQuizId ?? '', q.questionText ?? '', correctTextsFromCatalog(q));
}

/** The server does NOT authorize this question. */
function unresolveCurrent(svc: PracticeSessionService, index: number): void {
  const q = svc.questions()[index];
  verdictStub.unresolve(q.sourceQuizId ?? '', q.questionText ?? '');
}

function completeSession(svc: PracticeSessionService): void {
  answerAllCorrectly(svc);
  svc.submit();
}

function reset(): void {
  sessionStorage.clear();
  localStorage.clear();
  setQuizDataCache(REAL_CATALOG, []);
  weakIds.set(['rxjs', 'signals']);
}

describe('PracticeSessionService — generation', () => {
  beforeEach(reset);
  afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('starts a session from the CURRENT weak topics', async () => {
    const svc = service();
    expect(await svc.start()).toBe(true);
    expect(svc.hasSession()).toBe(true);
    expect(svc.total()).toBe(10);
    expect(svc.sessionId()).toMatch(/^wap_/);
    expect(svc.currentIndex()).toBe(0);
    expect(svc.status()).toBe('active');
  });

  it('refuses to start when there are NO weak topics', async () => {
    weakIds.set([]);
    const svc = service();
    expect(await svc.start()).toBe(false);
    expect(svc.hasSession()).toBe(false);
    expect(sessionStorage.getItem(SK_PRACTICE_SESSION)).toBeNull();
  });

  it('creates a NEW session id and reshuffles on each start — never a replay', async () => {
    const svc = service();
    await svc.start();
    const first = { id: svc.sessionId(), order: svc.questions().map((q) => q.questionText).join('|') };

    let differed = false;
    for (let i = 0; i < 10 && !differed; i++) {
      await svc.start();
      if (svc.questions().map((q) => q.questionText).join('|') !== first.order) differed = true;
    }
    expect(svc.sessionId()).not.toBe(first.id);
    expect(differed).toBe(true);
  });
});

describe('PracticeSessionService — the advance gate', () => {
  beforeEach(reset);
  afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('blocks Next until the current question is answered', async () => {
    const svc = service();
    await svc.start();
    expect(svc.canAdvance()).toBe(false);
    expect(svc.canGoNext()).toBe(false);

    svc.next();
    expect(svc.currentIndex()).toBe(0);   // did not move
  });

  it('SINGLE: a WRONG answer still unlocks Next but does NOT resolve', async () => {
    const svc = service();
    await svc.start();
    const index = svc.questions().findIndex((q) => correctIdsFromCatalog(q).length === 1);
    svc.goTo(index);

    svc.select(index, [wrongIdFromCatalog(svc.questions()[index])]);
    expect(svc.canAdvance()).toBe(true);        // Next enabled on a wrong single answer
    expect(svc.isCurrentResolved()).toBe(false); // ...but no FET, no lock
  });

  it('SINGLE: the selection can be CHANGED to the correct one, which resolves', async () => {
    const svc = service();
    await svc.start();
    const index = svc.questions().findIndex((q) => correctIdsFromCatalog(q).length === 1);
    svc.goTo(index);

    svc.select(index, [wrongIdFromCatalog(svc.questions()[index])]);
    svc.select(index, correctIdsFromCatalog(svc.questions()[index]));   // not locked — change allowed
    // The verdict for the corrected pick arrives from the server.
    resolveCurrent(svc, index);
    expect(svc.isCurrentResolved()).toBe(true);
    expect(svc.canAdvance()).toBe(true);
  });

  it('MULTI: a PARTIAL answer does not unlock Next; the complete set does', async () => {
    const svc = service();
    await svc.start();
    const index = svc.questions().findIndex((q) => correctIdsFromCatalog(q).length > 1);
    if (index === -1) return;   // this generated set had no multi-answer question

    svc.goTo(index);
    const correct = correctIdsFromCatalog(svc.questions()[index]);
    svc.select(index, [correct[0]]);
    expect(svc.canAdvance()).toBe(false);
    expect(svc.isCurrentResolved()).toBe(false);
    svc.next();
    expect(svc.currentIndex()).toBe(index);   // partial cannot skip ahead

    svc.select(index, correct);
    resolveCurrent(svc, index);
    expect(svc.canAdvance()).toBe(true);
    expect(svc.isCurrentResolved()).toBe(true);
  });

  it('offers Submit only on the LAST question, under the same gate', async () => {
    const svc = service();
    await svc.start();
    expect(svc.canSubmit()).toBe(false);

    svc.goTo(svc.total() - 1);
    expect(svc.isLastQuestion()).toBe(true);
    expect(svc.canSubmit()).toBe(false);            // unanswered

    svc.select(svc.total() - 1, correctIdsFromCatalog(svc.questions()[svc.total() - 1]));
    resolveCurrent(svc, svc.total() - 1);
    expect(svc.canSubmit()).toBe(true);
    expect(svc.canGoNext()).toBe(false);            // no question after the last
  });
});

describe('PracticeSessionService — navigation and answers', () => {
  beforeEach(reset);
  afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('moves Previous/Next within bounds once the gate passes', async () => {
    const svc = service();
    await svc.start();
    expect(svc.canGoPrevious()).toBe(false);

    svc.select(0, correctIdsFromCatalog(svc.questions()[0]));
    // The verdict must ARRIVE before the gate opens. Without this the test
    // depends on whether the shuffle happened to put a single-answer question
    // first, since only a declared multi-answer question needs resolution.
    resolveCurrent(svc, 0);
    svc.next();
    expect(svc.currentIndex()).toBe(1);
    expect(svc.canGoPrevious()).toBe(true);

    svc.previous();
    expect(svc.currentIndex()).toBe(0);

    svc.previous();                       // already at the start
    expect(svc.currentIndex()).toBe(0);
  });

  it('Previous is NEVER gated — a wrong answer can always be revisited', async () => {
    const svc = service();
    await svc.start();
    svc.select(0, correctIdsFromCatalog(svc.questions()[0]));
    resolveCurrent(svc, 0);
    svc.next();
    svc.select(1, []);                 // nothing selected on question 2
    expect(svc.canGoPrevious()).toBe(true);
    svc.previous();
    expect(svc.currentIndex()).toBe(0);
  });

  it('ignores out-of-range jumps', async () => {
    const svc = service();
    await svc.start();
    svc.goTo(-1);
    expect(svc.currentIndex()).toBe(0);
    svc.goTo(999);
    expect(svc.currentIndex()).toBe(0);
  });

  it('tracks answered indices and completion', async () => {
    const svc = service();
    await svc.start();
    expect(svc.allAnswered()).toBe(false);

    for (let i = 0; i < svc.total(); i++) {
      const first = svc.questions()[i].options?.[0]?.optionId;
      svc.select(i, [first!]);
    }
    expect(svc.answeredCount()).toBe(svc.total());
    expect(svc.allAnswered()).toBe(true);
  });

  it('an empty selection does not count as answered', async () => {
    const svc = service();
    await svc.start();
    svc.select(0, []);
    expect(svc.answeredIndices().has(0)).toBe(false);
  });

  it('locks answers after submission', async () => {
    const svc = service();
    await svc.start();
    completeSession(svc);

    const last = svc.total() - 1;
    const before = svc.answersByIndex()[last];
    svc.select(last, [wrongIdFromCatalog(svc.questions()[last])]);
    expect(svc.answersByIndex()[last]).toEqual(before);   // unchanged
  });
});

describe('PracticeSessionService — submission and scoring', () => {
  beforeEach(reset);
  afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('refuses to submit before the gate passes', async () => {
    const svc = service();
    await svc.start();
    svc.submit();
    expect(svc.status()).toBe('active');
    expect(svc.result()).toBeNull();
    expect(svc.hasResult()).toBe(false);
  });

  it('scores an all-correct session as 100%', async () => {
    const svc = service();
    await svc.start();
    completeSession(svc);

    const result = svc.result()!;
    expect(svc.status()).toBe('submitted');
    expect(result.total).toBe(svc.total());
    expect(result.correct).toBe(svc.total());
    expect(result.percentage).toBe(100);
    expect(result.sessionId).toBe(svc.sessionId());
  });

  it('counts a wrong single answer against the score', async () => {
    const svc = service();
    await svc.start();
    const index = svc.questions().findIndex((q) => correctIdsFromCatalog(q).length === 1);
    answerAllCorrectly(svc);
    svc.select(index, [wrongIdFromCatalog(svc.questions()[index])]);
    unresolveCurrent(svc, index);   // the server does not authorize a wrong pick
    svc.submit();

    const result = svc.result()!;
    expect(result.correct).toBe(svc.total() - 1);
    expect(result.review[index].isCorrect).toBe(false);
  });

  it('builds a per-topic breakdown whose totals sum to the question count', async () => {
    const svc = service();
    await svc.start();
    completeSession(svc);

    const result = svc.result()!;
    expect(result.perTopic.length).toBeGreaterThan(0);
    expect(result.perTopic.reduce((sum, t) => sum + t.total, 0)).toBe(result.total);
    for (const topic of result.perTopic) expect(topic.topicName).toBeTruthy();
  });

  it('produces one Review entry per question, each with its explanation', async () => {
    const svc = service();
    await svc.start();
    completeSession(svc);

    const result = svc.result()!;
    expect(result.review.length).toBe(result.total);
    expect(result.review.every((entry) => entry.correctTexts.length > 0)).toBe(true);
  });

  it('submit is idempotent and keeps the FIRST result', async () => {
    const svc = service();
    await svc.start();
    completeSession(svc);
    const first = svc.result();

    svc.submit();
    expect(svc.result()).toBe(first);
    expect(svc.status()).toBe('submitted');
  });

  it('hasSession flips to false and hasResult to true after submission', async () => {
    const svc = service();
    await svc.start();
    expect(svc.hasSession()).toBe(true);
    completeSession(svc);
    expect(svc.hasSession()).toBe(false);
    expect(svc.hasResult()).toBe(true);
  });
});

describe('PracticeSessionService — topic-performance recording', () => {
  beforeEach(reset);
  afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('records the attempt EXACTLY ONCE under practice:{sessionId}', async () => {
    const svc = service();
    const history = TestBed.inject(TopicPerformanceHistoryService);
    await svc.start();
    completeSession(svc);

    const attemptId = `practice:${svc.sessionId()}`;
    expect(history.hasRecorded(attemptId)).toBe(true);
    const afterFirst = history.records().length;

    // Results remount / refresh / repeated calls must all be no-ops.
    svc.ensureRecorded();
    svc.ensureRecorded();
    svc.submit();
    expect(history.records().length).toBe(afterFirst);
  });

  it('records the SAME counts the result displays', async () => {
    const svc = service();
    const history = TestBed.inject(TopicPerformanceHistoryService);
    await svc.start();
    const index = svc.questions().findIndex((q) => correctIdsFromCatalog(q).length === 1);
    answerAllCorrectly(svc);
    svc.select(index, [wrongIdFromCatalog(svc.questions()[index])]);
    svc.submit();

    const attemptId = `practice:${svc.sessionId()}`;
    const recorded = history.records().filter((r) => r.attemptId === attemptId);
    for (const topic of svc.result()!.perTopic) {
      const match = recorded.find((r) => r.topicId === topic.topicId)!;
      expect(match.correct).toBe(topic.correct);
      expect(match.total).toBe(topic.total);
      expect(match.source).toBe('weak-areas-practice');
    }
  });

  it('a Results REMOUNT after a refresh does not duplicate the record', async () => {
    const svc = service();
    await svc.start();
    completeSession(svc);
    const attemptId = `practice:${svc.sessionId()}`;
    const before = JSON.parse(localStorage.getItem(SK_TOPIC_PERFORMANCE_HISTORY)!).records.length;

    // A refresh builds a NEW service from the persisted snapshot.
    const resumed = service();
    resumed.ensureRecorded();
    const history = TestBed.inject(TopicPerformanceHistoryService);
    expect(history.hasRecorded(attemptId)).toBe(true);
    expect(history.records().length).toBe(before);
  });

  it('does not record anything when nothing was submitted', async () => {
    const svc = service();
    const history = TestBed.inject(TopicPerformanceHistoryService);
    await svc.start();
    svc.ensureRecorded();
    expect(history.records().length).toBe(0);
  });
});

describe('PracticeSessionService — Practice Again', () => {
  beforeEach(reset);
  afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('records the finished attempt, then generates a NEW session', async () => {
    const svc = service();
    const history = TestBed.inject(TopicPerformanceHistoryService);
    await svc.start();
    completeSession(svc);
    const finishedId = svc.sessionId();

    expect(await svc.practiceAgain()).toBe(true);
    expect(history.hasRecorded(`practice:${finishedId}`)).toBe(true);
    expect(svc.sessionId()).not.toBe(finishedId);
    expect(svc.status()).toBe('active');
    expect(svc.result()).toBeNull();
    expect(svc.currentIndex()).toBe(0);
    expect(svc.answersByIndex()).toEqual({});   // not a replay
  });

  it('returns FALSE when no weak topics remain, without emptying the session', async () => {
    const svc = service();
    await svc.start();
    completeSession(svc);

    weakIds.set([]);                       // nothing left to practise
    expect(await svc.practiceAgain()).toBe(false);
    expect(svc.total()).toBeGreaterThan(0); // previous session untouched, not blanked
    expect(svc.status()).toBe('submitted');
  });

  it('still records the completed attempt even when no weak topics remain', async () => {
    const svc = service();
    const history = TestBed.inject(TopicPerformanceHistoryService);
    await svc.start();
    completeSession(svc);
    const finishedId = svc.sessionId();

    weakIds.set([]);
    await svc.practiceAgain();
    expect(history.hasRecorded(`practice:${finishedId}`)).toBe(true);
  });
});

describe('PracticeSessionService — refresh and exact resume', () => {
  beforeEach(reset);
  afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('resumes the IDENTICAL session after a refresh — questions and option order', async () => {
    const svc = service();
    await svc.start();
    const before = {
      id: svc.sessionId(),
      texts: svc.questions().map((q) => q.questionText),
      optionOrder: svc.questions().map((q) => (q.options ?? []).map((o) => o.optionId).join(','))
    };
    svc.goTo(3);
    const chosen = svc.questions()[3].options![1].optionId!;
    svc.select(3, [chosen]);

    // A refresh constructs a NEW service, which rehydrates from sessionStorage.
    const resumed = service();
    expect(resumed.sessionId()).toBe(before.id);
    expect(resumed.questions().map((q) => q.questionText)).toEqual(before.texts);
    expect(resumed.questions().map((q) => (q.options ?? []).map((o) => o.optionId).join(',')))
      .toEqual(before.optionOrder);          // option ORDER preserved, not reshuffled
    expect(resumed.currentIndex()).toBe(3);
    expect(resumed.answersByIndex()[3]).toEqual([chosen]);
    expect(resumed.status()).toBe('active');
  });

  it('RESULTS survive a refresh with the identical score, not a recomputation', async () => {
    const svc = service();
    await svc.start();
    completeSession(svc);
    const before = svc.result()!;

    const resumed = service();
    expect(resumed.status()).toBe('submitted');
    expect(resumed.hasResult()).toBe(true);
    expect(resumed.result()!.sessionId).toBe(before.sessionId);
    expect(resumed.result()!.completedAt).toBe(before.completedAt);
    expect(resumed.result()!.correct).toBe(before.correct);
    expect(resumed.result()!.percentage).toBe(before.percentage);
    expect(resumed.result()!.review.length).toBe(before.review.length);
  });

  it('does not resume when nothing is stored', async () => {
    expect(service().hasSession()).toBe(false);
  });

  it('ignores a malformed or wrong-version snapshot', async () => {
    sessionStorage.setItem(SK_PRACTICE_SESSION, '{ not json');
    expect(() => service()).not.toThrow();
    expect(service().hasSession()).toBe(false);

    sessionStorage.setItem(SK_PRACTICE_SESSION, JSON.stringify({ version: 99, questions: [{}], sessionId: 'x' }));
    expect(service().hasSession()).toBe(false);

    sessionStorage.setItem(SK_PRACTICE_SESSION, JSON.stringify({ version: 1, questions: [], sessionId: 'x' }));
    expect(service().hasSession()).toBe(false);
  });

  it('falls back to ACTIVE when a snapshot claims submitted but carries no result', async () => {
    const svc = service();
    await svc.start();
    const raw = JSON.parse(sessionStorage.getItem(SK_PRACTICE_SESSION)!);
    raw.status = 'submitted';
    raw.result = null;
    sessionStorage.setItem(SK_PRACTICE_SESSION, JSON.stringify(raw));

    const resumed = service();
    expect(resumed.status()).toBe('active');
    expect(resumed.hasResult()).toBe(false);
    expect(resumed.hasSession()).toBe(true);
  });

  it('rejects a persisted result belonging to a DIFFERENT session', async () => {
    const svc = service();
    await svc.start();
    completeSession(svc);
    const raw = JSON.parse(sessionStorage.getItem(SK_PRACTICE_SESSION)!);
    raw.result.sessionId = 'someone-elses-session';
    sessionStorage.setItem(SK_PRACTICE_SESSION, JSON.stringify(raw));

    expect(service().hasResult()).toBe(false);
  });

  it('clamps an out-of-range stored index', async () => {
    const svc = service();
    await svc.start();
    const raw = JSON.parse(sessionStorage.getItem(SK_PRACTICE_SESSION)!);
    raw.currentIndex = 999;
    sessionStorage.setItem(SK_PRACTICE_SESSION, JSON.stringify(raw));
    expect(service().currentIndex()).toBe(0);
  });

  it('clear() drops the session and its snapshot but KEEPS recorded history', async () => {
    const svc = service();
    await svc.start();
    completeSession(svc);
    const attemptId = `practice:${svc.sessionId()}`;

    svc.clear();
    expect(svc.hasSession()).toBe(false);
    expect(svc.hasResult()).toBe(false);
    expect(sessionStorage.getItem(SK_PRACTICE_SESSION)).toBeNull();
    expect(service().hasSession()).toBe(false);

    // Topic-performance history is durable and must NOT be wiped by leaving.
    expect(TestBed.inject(TopicPerformanceHistoryService).hasRecorded(attemptId)).toBe(true);
  });
});

describe('PracticeSessionService — the API is the ONLY question source', () => {
  beforeEach(reset);
  afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('refuses to start when the questions API fails — NO local-bank fallback', async () => {
    TestBed.resetTestingModule();
    verdictStub = new VerdictStub();
    TestBed.configureTestingModule({
      providers: [
        PracticeSessionService,
        AssessmentBuilderService,
        TopicPerformanceHistoryService,
        { provide: WeakAreasService, useValue: weakAreasStub },
        {
          provide: TopicQuizQuestionsService,
          useValue: {
            loadQuestions: () => throwError(() => new Error('network down'))
          } as unknown as TopicQuizQuestionsService
        },
        { provide: PracticeVerdictService, useValue: verdictStub }
      ]
    });
    const svc = TestBed.inject(PracticeSessionService);

    // The local bank is fully populated and would happily supply questions —
    // which is exactly why this must still refuse.
    expect(REAL_CATALOG.length).toBeGreaterThan(0);
    expect(await svc.start()).toBe(false);
    expect(svc.hasSession()).toBe(false);
    expect(svc.total()).toBe(0);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  it('practice questions arrive WITHOUT an answer key', async () => {
    const svc = service();
    expect(await svc.start()).toBe(true);

    for (const question of svc.questions()) {
      expect(Object.prototype.hasOwnProperty.call(question, 'explanation')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(question, 'answer')).toBe(false);
      for (const option of question.options ?? []) {
        expect(Object.prototype.hasOwnProperty.call(option, 'correct')).toBe(false);
      }
    }
    expect(JSON.stringify(svc.questions())).not.toContain('"correct"');
  });

  it('every practice question carries a DECLARED type', async () => {
    const svc = service();
    await svc.start();
    for (const question of svc.questions()) {
      expect([
        QuestionType.SingleAnswer, QuestionType.MultipleAnswer, QuestionType.TrueFalse
      ]).toContain(question.type);
    }
  });
});
