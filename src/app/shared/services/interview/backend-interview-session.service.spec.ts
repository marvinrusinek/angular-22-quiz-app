import { TestBed } from '@angular/core/testing';
import { of, throwError, Observable, Subject } from 'rxjs';

import { BackendInterviewSessionService } from './backend-interview-session.service';
import { InterviewSessionReferenceStorage } from './interview-session-reference.storage';
import { InterviewApiService } from '../api/interview-api.service';
import { InterviewApiError } from '../api/interview-api.errors';
import { canonicalize, toggleOption } from './interview-answer-transitions';
import type {
  InterviewQuestionViewModel,
  InterviewSessionViewModel
} from '../../models/interview/interview-view-models';
import type { SaveInterviewAnswerResponse } from '../../models/api/interview-api.dto';

const TOKEN = 'a'.repeat(43);

const single: InterviewQuestionViewModel = {
  questionId: 'q:single', sourceQuizId: 'rxjs', questionText: 'One?', type: 'single',
  options: [{ optionId: 101, text: 'a' }, { optionId: 102, text: 'b' }]
};
const multi: InterviewQuestionViewModel = {
  questionId: 'q:multi', sourceQuizId: 'rxjs', questionText: 'Many?', type: 'multiple',
  options: [{ optionId: 401, text: 'c' }, { optionId: 402, text: 'd' }, { optionId: 403, text: 'e' }]
};
const trueFalse: InterviewQuestionViewModel = {
  questionId: 'q:tf', sourceQuizId: 'signals', questionText: 'T/F?', type: 'trueFalse',
  options: [{ optionId: 501, text: 'True' }, { optionId: 502, text: 'False' }]
};

function session(overrides: Partial<InterviewSessionViewModel> = {}): InterviewSessionViewModel {
  return {
    sessionId: 'is_1', status: 'active',
    createdAtMs: 1_700_000_000_000, expiresAtMs: 1_700_000_900_000,
    durationSeconds: 900, remainingSeconds: 900,
    config: { mode: 'custom', difficulty: 'mixed', topicIds: ['rxjs'], questionCount: 3 },
    questions: [single, multi, trueFalse],
    answers: new Map(),
    ...overrides,
    flags: overrides.flags ?? new Map()
  };
}

function saveResponse(
  questionId: string, ids: number[], answeredCount = 1
): SaveInterviewAnswerResponse {
  return { saved: true, questionId, selectedOptionIds: ids, answeredCount, questionCount: 3 };
}

function flagResponse(questionId: string, flagged: boolean) {
  return { questionId, flagged };
}

let service: BackendInterviewSessionService;
let api: { resumeSession: jest.Mock; saveAnswer: jest.Mock; setReviewFlag: jest.Mock };

beforeEach(() => {
  sessionStorage.clear();
  api = { resumeSession: jest.fn(), saveAnswer: jest.fn(), setReviewFlag: jest.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      BackendInterviewSessionService,
      InterviewSessionReferenceStorage,
      { provide: InterviewApiService, useValue: api }
    ]
  });
  service = TestBed.inject(BackendInterviewSessionService);
});
afterEach(() => sessionStorage.clear());

describe('pure selection transitions', () => {
  it('SINGLE replaces, and re-clicking keeps it selected', () => {
    expect(toggleOption(single, [], 101)).toEqual([101]);
    expect(toggleOption(single, [101], 102)).toEqual([102]);
    expect(toggleOption(single, [101], 101)).toEqual([101]);   // not cleared
  });

  it('TRUE/FALSE behaves exactly like single', () => {
    expect(toggleOption(trueFalse, [501], 501)).toEqual([501]);
    expect(toggleOption(trueFalse, [501], 502)).toEqual([502]);
  });

  it('MULTIPLE toggles, may clear, may select all', () => {
    expect(toggleOption(multi, [], 401)).toEqual([401]);
    expect(toggleOption(multi, [401], 403)).toEqual([401, 403]);
    expect(toggleOption(multi, [401, 403], 401)).toEqual([403]);
    expect(toggleOption(multi, [403], 403)).toEqual([]);
    expect(toggleOption(multi, [401, 402], 403)).toEqual([401, 402, 403]);
  });

  it('IGNORES an option that does not belong to the question', () => {
    expect(toggleOption(single, [101], 999)).toEqual([101]);
  });

  it('canonicalizes ascending and de-duplicates', () => {
    expect(canonicalize([403, 401, 401])).toEqual([401, 403]);
  });
});

describe('hydration', () => {
  it('activates a created session and persists the minimal reference', () => {
    service.activateCreatedSession(session(), TOKEN);

    expect(service.status()).toBe('active');
    expect(service.sessionId()).toBe('is_1');
    expect(service.questionCount()).toBe(3);
    expect(service.currentIndex()).toBe(0);
    expect(TestBed.inject(InterviewSessionReferenceStorage).read()).toEqual({
      version: 2, sessionId: 'is_1', sessionToken: TOKEN, currentIndex: 0
    });
  });

  it('preserves question and option ORDER exactly', () => {
    service.activateCreatedSession(session(), TOKEN);
    expect(service.questions().map((q) => q.questionId)).toEqual(['q:single', 'q:multi', 'q:tf']);
    expect(service.questions()[1]!.options.map((o) => o.optionId)).toEqual([401, 402, 403]);
  });

  it('preserves explicit types', () => {
    service.activateCreatedSession(session(), TOKEN);
    expect(service.questions().map((q) => q.type)).toEqual(['single', 'multiple', 'trueFalse']);
  });

  it('restores saved answers and the answered count', () => {
    service.activateCreatedSession(
      session({ answers: new Map([['q:multi', [401, 403]]]) }), TOKEN
    );
    expect(service.selectionFor('q:multi')).toEqual([401, 403]);
    expect(service.answeredCount()).toBe(1);
  });

  it('state contains NO correctness or explanation', () => {
    service.activateCreatedSession(session({ answers: new Map([['q:multi', [401]]]) }), TOKEN);
    const snapshot = JSON.stringify({
      questions: service.questions(),
      answers: [...service.displayedAnswers()],
      config: service.config()
    });
    for (const banned of ['correct', 'isCorrect', 'correctOptionIds', 'explanation', 'score', 'percentage']) {
      expect(snapshot).not.toContain(banned);
    }
  });

  it('clamps the persisted index on resume', async () => {
    TestBed.inject(InterviewSessionReferenceStorage).write('is_1', TOKEN, 99);
    api.resumeSession.mockReturnValue(of(session()));

    expect(await service.resumeFromStoredReference()).toEqual({ kind: 'active' });
    expect(service.currentIndex()).toBe(2);   // clamped to last question
  });

  it('restores a valid index on resume', async () => {
    TestBed.inject(InterviewSessionReferenceStorage).write('is_1', TOKEN, 1);
    api.resumeSession.mockReturnValue(of(session()));
    await service.resumeFromStoredReference();
    expect(service.currentIndex()).toBe(1);
  });

  it('setCurrentIndex clamps and persists only the index', () => {
    service.activateCreatedSession(session(), TOKEN);
    service.setCurrentIndex(50);
    expect(service.currentIndex()).toBe(2);
    expect(TestBed.inject(InterviewSessionReferenceStorage).read()?.currentIndex).toBe(2);
  });
});

describe('resume outcomes', () => {
  it('returns none with no stored reference', async () => {
    expect(await service.resumeFromStoredReference()).toEqual({ kind: 'none' });
    expect(api.resumeSession).not.toHaveBeenCalled();
  });

  it.each([
    ['SESSION_EXPIRED', 409, 'expired'],
    ['CONFLICT', 409, 'submitted'],
    ['BACKEND_UNAVAILABLE', 0, 'unavailable']
  ])('%s maps to %s', async (code, status, kind) => {
    TestBed.inject(InterviewSessionReferenceStorage).write('is_1', TOKEN, 0);
    api.resumeSession.mockReturnValue(
      throwError(() => new InterviewApiError(code as 'CONFLICT', status))
    );
    expect(await service.resumeFromStoredReference()).toEqual({ kind });
  });

  it('UNAUTHORIZED clears the dead reference', async () => {
    const storage = TestBed.inject(InterviewSessionReferenceStorage);
    storage.write('is_1', TOKEN, 0);
    api.resumeSession.mockReturnValue(
      throwError(() => new InterviewApiError('UNAUTHORIZED', 401))
    );

    expect(await service.resumeFromStoredReference()).toEqual({ kind: 'unauthorized' });
    expect(storage.read()).toBeNull();
  });

  it('resumes exactly ONCE per call — no duplicate request', async () => {
    TestBed.inject(InterviewSessionReferenceStorage).write('is_1', TOKEN, 0);
    api.resumeSession.mockReturnValue(of(session()));
    await service.resumeFromStoredReference();
    expect(api.resumeSession).toHaveBeenCalledTimes(1);
  });
});

describe('optimistic saving', () => {
  beforeEach(() => service.activateCreatedSession(session(), TOKEN));

  it('updates the UI immediately, then applies the canonical server value', async () => {
    api.saveAnswer.mockReturnValue(of(saveResponse('q:multi', [401, 403])));

    const promise = service.updateAnswer('q:multi', [403, 401]);
    expect(service.selectionFor('q:multi')).toEqual([401, 403]);   // optimistic, canonicalized

    expect(await promise).toEqual({ kind: 'saved', selectedOptionIds: [401, 403] });
    expect(service.selectionFor('q:multi')).toEqual([401, 403]);
    expect(service.answeredCount()).toBe(1);                        // from the SERVER
  });

  it('sends the COMPLETE replacement selection', async () => {
    api.saveAnswer.mockReturnValue(of(saveResponse('q:multi', [401, 402])));
    await service.updateAnswer('q:multi', [402, 401]);
    expect(api.saveAnswer).toHaveBeenCalledWith('is_1', TOKEN, 'q:multi', [401, 402]);
  });

  it('clearing sends an empty array', async () => {
    api.saveAnswer.mockReturnValue(of(saveResponse('q:multi', [], 0)));
    await service.updateAnswer('q:multi', []);
    expect(api.saveAnswer).toHaveBeenCalledWith('is_1', TOKEN, 'q:multi', []);
    expect(service.selectionFor('q:multi')).toEqual([]);
    expect(service.answeredCount()).toBe(0);
  });

  it('rejects a question outside the session without calling the API', async () => {
    const outcome = await service.updateAnswer('q:nope', [1]);
    expect(outcome.kind).toBe('failed');
    expect(api.saveAnswer).not.toHaveBeenCalled();
  });

  it('tracks pending state per question', async () => {
    const gate = new Subject<SaveInterviewAnswerResponse>();
    api.saveAnswer.mockReturnValue(gate);

    const promise = service.updateAnswer('q:single', [101]);
    expect(service.isQuestionSaving('q:single')).toBe(true);
    expect(service.hasPendingSaves()).toBe(true);
    expect(service.pendingSaveCount()).toBe(1);

    gate.next(saveResponse('q:single', [101]));
    gate.complete();
    await promise;

    expect(service.isQuestionSaving('q:single')).toBe(false);
    expect(service.pendingSaveCount()).toBe(0);
  });

  it('hydrated answers are NOT marked pending', () => {
    service.activateCreatedSession(session({ answers: new Map([['q:single', [101]]]) }), TOKEN);
    expect(service.hasPendingSaves()).toBe(false);
    expect(service.isQuestionSaving('q:single')).toBe(false);
  });
});

describe('failed saves', () => {
  beforeEach(() => service.activateCreatedSession(
    session({ answers: new Map([['q:single', [101]]]) }), TOKEN
  ));

  /**
   * What the user SEES is always the confirmed server state. A failed save is
   * rolled back on screen and flagged; the attempted selection survives only as
   * internal retry intent, so the UI can never present an unsaved answer as
   * though the backend had accepted it.
   */
  it('restores the last CONFIRMED selection when the latest save fails', async () => {
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));

    const outcome = await service.updateAnswer('q:single', [102]);
    expect(outcome.kind).toBe('failed');
    expect(service.selectionFor('q:single')).toEqual([101]);       // rolled back
    expect(service.confirmedAnswers().get('q:single')).toEqual([101]);
    expect(service.hasFailedSave('q:single')).toBe(true);
    expect(service.hasUnsavedChanges()).toBe(true);
    expect(service.error()?.code).toBe('BACKEND_UNAVAILABLE');
  });

  it('a failed save does not leave the question CONFIRMED as answered', async () => {
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await service.updateAnswer('q:multi', [401]);

    expect(service.confirmedAnswers().has('q:multi')).toBe(false);
    expect(service.selectionFor('q:multi')).toEqual([]);
  });

  it('retryFailedSave resends the INTENDED selection, not the displayed one', async () => {
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await service.updateAnswer('q:single', [102]);
    expect(service.selectionFor('q:single')).toEqual([101]);   // display shows the old answer

    api.saveAnswer.mockClear();
    api.saveAnswer.mockReturnValue(of(saveResponse('q:single', [102])));
    const outcome = await service.retryFailedSave('q:single');

    // [102] — the value the user chose, recovered from internal retry state.
    expect(api.saveAnswer).toHaveBeenCalledWith(expect.anything(), TOKEN, 'q:single', [102]);
    expect(outcome?.kind).toBe('saved');
    expect(service.selectionFor('q:single')).toEqual([102]);
    expect(service.confirmedAnswers().get('q:single')).toEqual([102]);
    expect(service.hasFailedSave('q:single')).toBe(false);
    expect(service.hasUnsavedChanges()).toBe(false);
    await expect(service.awaitPendingSaves()).resolves.toBeUndefined();
  });

  it('retryFailedSave is a no-op when nothing failed', async () => {
    await expect(service.retryFailedSave('q:single')).resolves.toBeNull();
    expect(api.saveAnswer).not.toHaveBeenCalled();
  });

  it('a NEWER selection supersedes the failed retry intent', async () => {
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await service.updateAnswer('q:single', [102]);

    // The user picks something else instead of retrying.
    api.saveAnswer.mockReturnValue(of(saveResponse('q:single', [103])));
    await service.updateAnswer('q:single', [103]);

    api.saveAnswer.mockClear();
    // Nothing is outstanding, so there is no stale [102] left to resend.
    expect(await service.retryFailedSave('q:single')).toBeNull();
    expect(api.saveAnswer).not.toHaveBeenCalled();
    expect(service.selectionFor('q:single')).toEqual([103]);
  });

  /**
   * Ordering guard: a slow FAILURE for an older attempt must not undo a newer
   * attempt that already succeeded, or the user would watch a saved answer
   * revert itself.
   */
  it('a STALE failure cannot roll back a newer confirmed save', async () => {
    let failFirst!: (err: unknown) => void;
    api.saveAnswer
      .mockReturnValueOnce(new Observable((subscriber) => { failFirst = (e) => subscriber.error(e); }))
      .mockReturnValue(of(saveResponse('q:multi', [402])));

    const first = service.updateAnswer('q:multi', [401]);
    await Promise.resolve();

    // The older request fails only AFTER a newer one has been requested.
    const second = service.updateAnswer('q:multi', [402]);
    failFirst(new InterviewApiError('BACKEND_UNAVAILABLE', 0));

    expect((await first).kind).toBe('superseded');
    expect((await second).kind).toBe('saved');

    expect(service.selectionFor('q:multi')).toEqual([402]);
    expect(service.confirmedAnswers().get('q:multi')).toEqual([402]);
    expect(service.hasFailedSave('q:multi')).toBe(false);
    expect(service.hasUnsavedChanges()).toBe(false);
  });

  it('a retry after failure succeeds', async () => {
    api.saveAnswer.mockReturnValueOnce(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await service.updateAnswer('q:single', [102]);

    api.saveAnswer.mockReturnValue(of(saveResponse('q:single', [102])));
    expect((await service.updateAnswer('q:single', [102])).kind).toBe('saved');
    expect(service.selectionFor('q:single')).toEqual([102]);
    expect(service.error()).toBeNull();
  });
});

describe('per-question sequencing', () => {
  beforeEach(() => service.activateCreatedSession(session(), TOKEN));

  it('SERIALIZES saves for one question, so the last write is the last selection', async () => {
    const order: number[][] = [];
    api.saveAnswer.mockImplementation((_s, _t, _q, ids: number[]) => {
      order.push(ids);
      return of(saveResponse('q:multi', ids));
    });

    const first = service.updateAnswer('q:multi', [401]);
    const second = service.updateAnswer('q:multi', [401, 403]);
    await Promise.all([first, second]);

    expect(order).toEqual([[401], [401, 403]]);   // in order, never crossed
    expect(service.selectionFor('q:multi')).toEqual([401, 403]);
  });

  it('a STALE success does not overwrite a newer selection', async () => {
    const slow = new Subject<SaveInterviewAnswerResponse>();
    const fast = new Subject<SaveInterviewAnswerResponse>();
    api.saveAnswer.mockReturnValueOnce(slow).mockReturnValueOnce(fast);

    const v1 = service.updateAnswer('q:multi', [401]);
    const v2 = service.updateAnswer('q:multi', [401, 403]);

    // v1 is in flight; v2 is queued behind it. Settle v1 LAST-arriving data
    // first, then v2 — the final state must be v2's.
    slow.next(saveResponse('q:multi', [401]));
    slow.complete();
    await v1;

    fast.next(saveResponse('q:multi', [401, 403]));
    fast.complete();
    await v2;

    expect(service.selectionFor('q:multi')).toEqual([401, 403]);
  });

  it('a stale FAILURE does not roll back a newer optimistic value', async () => {
    const failing = new Subject<SaveInterviewAnswerResponse>();
    api.saveAnswer.mockReturnValueOnce(failing).mockReturnValueOnce(of(saveResponse('q:multi', [401, 403])));

    const v1 = service.updateAnswer('q:multi', [401]);
    const v2 = service.updateAnswer('q:multi', [401, 403]);

    failing.error(new InterviewApiError('BACKEND_UNAVAILABLE', 0));
    const firstOutcome = await v1;
    await v2;

    expect(firstOutcome.kind).toBe('superseded');
    expect(service.selectionFor('q:multi')).toEqual([401, 403]);
  });

  it('DIFFERENT questions save concurrently', async () => {
    const a = new Subject<SaveInterviewAnswerResponse>();
    const b = new Subject<SaveInterviewAnswerResponse>();
    api.saveAnswer.mockReturnValueOnce(a).mockReturnValueOnce(b);

    const first = service.updateAnswer('q:single', [101]);
    const second = service.updateAnswer('q:multi', [401]);

    // Pending is marked synchronously; the request itself is dispatched on the
    // per-question chain, so flush microtasks before asserting on the API.
    expect(service.pendingSaveCount()).toBe(2);
    await Promise.resolve();
    await Promise.resolve();

    // Both are in flight at once — neither blocks the other.
    expect(api.saveAnswer).toHaveBeenCalledTimes(2);

    b.next(saveResponse('q:multi', [401], 1)); b.complete();
    a.next(saveResponse('q:single', [101], 2)); a.complete();
    await Promise.all([first, second]);

    expect(service.selectionFor('q:single')).toEqual([101]);
    expect(service.selectionFor('q:multi')).toEqual([401]);
  });

  it('one click produces exactly ONE save request', async () => {
    api.saveAnswer.mockReturnValue(of(saveResponse('q:single', [101])));
    await service.updateAnswer('q:single', [101]);
    expect(api.saveAnswer).toHaveBeenCalledTimes(1);
  });
});

describe('awaitPendingSaves', () => {
  beforeEach(() => service.activateCreatedSession(session(), TOKEN));

  it('resolves after every save succeeds', async () => {
    api.saveAnswer.mockReturnValue(of(saveResponse('q:single', [101])));
    await service.updateAnswer('q:single', [101]);
    await expect(service.awaitPendingSaves()).resolves.toBeUndefined();
  });

  it('resolves immediately when nothing is pending', async () => {
    await expect(service.awaitPendingSaves()).resolves.toBeUndefined();
  });

  it('REJECTS when the latest save failed', async () => {
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await service.updateAnswer('q:single', [101]);
    await expect(service.awaitPendingSaves()).rejects.toBeInstanceOf(InterviewApiError);
  });

  it('resolves when a later save repaired an earlier failure', async () => {
    api.saveAnswer.mockReturnValueOnce(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await service.updateAnswer('q:single', [101]);

    api.saveAnswer.mockReturnValue(of(saveResponse('q:single', [102])));
    await service.updateAnswer('q:single', [102]);

    await expect(service.awaitPendingSaves()).resolves.toBeUndefined();
  });
});

describe('Mark for Review', () => {
  beforeEach(() => service.activateCreatedSession(session(), TOKEN));

  it('marking an UNANSWERED question never answers it', async () => {
    api.setReviewFlag.mockReturnValue(of(flagResponse('q:single', true)));
    await service.setFlagged('q:single', true);

    expect(service.isFlagged('q:single')).toBe(true);
    expect(service.selectionFor('q:single')).toEqual([]);
    expect(service.confirmedAnswers().has('q:single')).toBe(false);
    expect(service.answeredCount()).toBe(0);
  });

  it('shows the optimistic mark immediately, then the confirmed value', async () => {
    api.setReviewFlag.mockReturnValue(of(flagResponse('q:single', true)));
    const promise = service.setFlagged('q:single', true);
    expect(service.isFlagged('q:single')).toBe(true);   // optimistic
    await promise;
    expect(service.isFlagged('q:single')).toBe(true);
    expect(service.confirmedFlagged().has('q:single')).toBe(true);
  });

  it('unmarking clears the flag and persists', async () => {
    api.setReviewFlag.mockReturnValueOnce(of(flagResponse('q:single', true)));
    await service.setFlagged('q:single', true);

    api.setReviewFlag.mockReturnValue(of(flagResponse('q:single', false)));
    await service.setFlagged('q:single', false);

    expect(service.isFlagged('q:single')).toBe(false);
    expect(service.confirmedFlagged().has('q:single')).toBe(false);
  });

  it('marking an ANSWERED question does not alter its answer, and vice versa', async () => {
    api.saveAnswer.mockReturnValue(of(saveResponse('q:single', [101])));
    await service.updateAnswer('q:single', [101]);

    api.setReviewFlag.mockReturnValue(of(flagResponse('q:single', true)));
    await service.setFlagged('q:single', true);

    expect(service.selectionFor('q:single')).toEqual([101]);   // answer untouched
    expect(service.isFlagged('q:single')).toBe(true);          // AND marked

    api.saveAnswer.mockReturnValue(of(saveResponse('q:single', [102])));
    await service.updateAnswer('q:single', [102]);
    expect(service.isFlagged('q:single')).toBe(true);           // mark untouched by the answer save
    expect(service.selectionFor('q:single')).toEqual([102]);
  });

  it('a FAILED mark save rolls back to the last confirmed value — never blocks submission', async () => {
    api.setReviewFlag.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await service.setFlagged('q:single', true);

    expect(service.isFlagged('q:single')).toBe(false);   // rolled back
    await expect(service.awaitPendingSaves()).resolves.toBeUndefined();
  });

  it('hydrating a session with a persisted flag restores it', () => {
    service.activateCreatedSession(session({ flags: new Map([['q:multi', true]]) }), TOKEN);
    expect(service.isFlagged('q:multi')).toBe(true);
    expect(service.confirmedFlagged().has('q:multi')).toBe(true);
  });

  it('does not answer or reveal correctness through the flag state', () => {
    service.activateCreatedSession(session({ flags: new Map([['q:multi', true]]) }), TOKEN);
    const snapshot = JSON.stringify([...service.confirmedFlagged()]);
    expect(snapshot).not.toMatch(/correct|isCorrect|explanation/i);
  });

  it('awaitPendingSaves WAITS for an in-flight mark before resolving', async () => {
    const gate = new Subject<{ questionId: string; flagged: boolean }>();
    api.setReviewFlag.mockReturnValue(gate);

    const markPromise = service.setFlagged('q:single', true);
    let settled = false;
    const waiter = service.awaitPendingSaves().then(() => { settled = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);   // the mark save has not settled yet

    gate.next(flagResponse('q:single', true));
    gate.complete();
    await markPromise;
    await waiter;

    expect(settled).toBe(true);
    expect(service.isFlagged('q:single')).toBe(true);   // the mark survived the race
  });
});

describe('clearSession', () => {
  it('wipes state and the stored reference', () => {
    service.activateCreatedSession(session(), TOKEN);
    service.clearSession();

    expect(service.status()).toBe('idle');
    expect(service.questionCount()).toBe(0);
    expect(service.answeredCount()).toBe(0);
    expect(TestBed.inject(InterviewSessionReferenceStorage).read()).toBeNull();
  });

  it('also wipes Mark-for-Review state', async () => {
    service.activateCreatedSession(session({ flags: new Map([['q:single', true]]) }), TOKEN);
    expect(service.isFlagged('q:single')).toBe(true);

    service.clearSession();
    expect(service.isFlagged('q:single')).toBe(false);
    expect(service.confirmedFlagged().size).toBe(0);
  });
});
