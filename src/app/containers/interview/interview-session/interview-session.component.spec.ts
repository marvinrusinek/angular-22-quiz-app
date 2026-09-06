import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { of, Subject, throwError } from 'rxjs';

import { InterviewSessionComponent } from './interview-session.component';
import { BackendInterviewSessionService } from '../../../shared/services/interview/backend-interview-session.service';
import { InterviewSessionReferenceStorage } from '../../../shared/services/interview/interview-session-reference.storage';
import { InterviewApiService } from '../../../shared/services/api/interview-api.service';
import { InterviewApiError } from '../../../shared/services/api/interview-api.errors';
import { BackendInterviewTimerService } from '../../../shared/services/interview/backend-interview-timer.service';
import type { InterviewSessionViewModel } from '../../../shared/models/interview/interview-view-models';
import type { SaveInterviewAnswerResponse } from '../../../shared/models/api/interview-api.dto';

/**
 * The active session renders BACKEND-SAFE models only: no correctness, no
 * explanation, no local scoring. Multi-select comes from the server type.
 */
const TOKEN = 'a'.repeat(43);

const QUESTIONS = [
  {
    questionId: 'rxjs:q:0', sourceQuizId: 'rxjs',
    questionText: 'Which answer is correct?', type: 'single' as const,
    options: [{ optionId: 101, text: 'A' }, { optionId: 102, text: 'B' }],
    flagged: false
  },
  {
    questionId: 'rxjs:q:1', sourceQuizId: 'rxjs',
    questionText: 'Select all that apply', type: 'multiple' as const,
    options: [{ optionId: 201, text: 'C' }, { optionId: 202, text: 'D' }, { optionId: 203, text: 'E' }],
    flagged: false
  },
  {
    questionId: 'signals:q:0', sourceQuizId: 'signals',
    questionText: 'True or false?', type: 'trueFalse' as const,
    options: [{ optionId: 301, text: 'True' }, { optionId: 302, text: 'False' }],
    flagged: false
  }
];

function session(
  answers = new Map<string, readonly number[]>(),
  flags = new Map<string, boolean>()
): InterviewSessionViewModel {
  return {
    sessionId: 'is_1', status: 'active',
    createdAtMs: 1_700_000_000_000, expiresAtMs: 1_700_000_900_000,
    durationSeconds: 900, remainingSeconds: 900,
    config: { mode: 'custom', difficulty: 'mixed', topicIds: ['rxjs'], questionCount: 3 },
    questions: QUESTIONS,
    answers,
    flags
  };
}

const saved = (questionId: string, ids: number[], answeredCount = 1): SaveInterviewAnswerResponse =>
  ({ saved: true, questionId, selectedOptionIds: ids, answeredCount, questionCount: 3 });

let fixture: ComponentFixture<InterviewSessionComponent>;
let rendered = false;
let component: InterviewSessionComponent;
let backend: BackendInterviewSessionService;
let api: {
  saveAnswer: jest.Mock; submitSession: jest.Mock; resumeSession: jest.Mock; setReviewFlag: jest.Mock;
};
let router: Router;

function render(answers?: Map<string, readonly number[]>, flags?: Map<string, boolean>): void {
  backend = TestBed.inject(BackendInterviewSessionService);
  backend.activateCreatedSession(session(answers, flags), TOKEN);

  fixture = TestBed.createComponent(InterviewSessionComponent);
  rendered = true;
  component = fixture.componentInstance;
  fixture.detectChanges();
}

/** Reach the private submit() the way expiry and the dialog do. */
const invokeSubmit = (): Promise<void> =>
  (component as unknown as { submit: () => Promise<void> }).submit();

/**
 * Saves are serialized per question, so the request is issued a microtask after
 * the click. A gated Subject must not emit before that subscription exists.
 */
const settleMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  sessionStorage.clear();
  api = {
    saveAnswer: jest.fn(), submitSession: jest.fn(), resumeSession: jest.fn(),
    setReviewFlag: jest.fn()
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewSessionComponent],
    providers: [
      provideRouter([]),
      provideNoopAnimations(),
      BackendInterviewSessionService,
      InterviewSessionReferenceStorage,
      BackendInterviewTimerService,
      { provide: InterviewApiService, useValue: api }
    ]
  });
  router = TestBed.inject(Router);
  jest.spyOn(router, 'navigate').mockResolvedValue(true);
});
afterEach(() => {
  // The display countdown runs on a real interval; without a destroy it keeps
  // ticking after the test and jest reports a leaked worker handle.
  if (rendered) {
    fixture.destroy();
    rendered = false;
  }
  sessionStorage.clear();
});

describe('rendering', () => {
  it('renders the hydrated question text', () => {
    render();
    expect(fixture.nativeElement.querySelector('.interview-question').textContent)
      .toContain('Which answer is correct?');
  });

  it('does NOT resume again — the guard already hydrated', () => {
    render();
    expect(api.resumeSession).not.toHaveBeenCalled();
  });

  it('renders a SINGLE question as radios', () => {
    render();
    expect(fixture.nativeElement.querySelectorAll('input[type="radio"]').length).toBe(2);
  });

  it('renders a MULTIPLE question as checkboxes, with no correctness present', () => {
    render();
    component.onNavigate(1);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('input[type="checkbox"]').length).toBe(3);
    expect(component.questionType()).toBe('multiple');
    expect(JSON.stringify(component.currentOptions())).not.toContain('correct');
  });

  it('renders TRUE/FALSE as single-select', () => {
    render();
    component.onNavigate(2);
    fixture.detectChanges();
    expect(component.questionType()).toBe('trueFalse');
    expect(fixture.nativeElement.querySelectorAll('input[type="radio"]').length).toBe(2);
  });

  it('renders no explanation and no correctness classes', () => {
    render();
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).not.toMatch(/correct-option|incorrect-option|explanation/);
  });

  it('restores saved answers and preserves question/option order', () => {
    render(new Map([['rxjs:q:1', [201, 203]]]));
    expect(component.questions().map((q) => q.questionId))
      .toEqual(['rxjs:q:0', 'rxjs:q:1', 'signals:q:0']);
    component.onNavigate(1);
    expect(component.selectedIds()).toEqual([201, 203]);
    expect(component.currentOptions().map((o) => o.optionId)).toEqual([201, 202, 203]);
  });

  it('answered count and paginator markers use CONFIRMED answers', () => {
    render(new Map([['rxjs:q:1', [201]]]));
    expect(component.answeredCount()).toBe(1);
    expect([...component.answeredIndices()]).toEqual([1]);
  });
});

describe('code snippet', () => {
  it('does not render app-code-snippet when the question has none', () => {
    render();
    expect(fixture.nativeElement.querySelector('app-code-snippet')).toBeNull();
  });

  it('renders app-code-snippet with the question when present', () => {
    backend = TestBed.inject(BackendInterviewSessionService);
    backend.activateCreatedSession({
      ...session(),
      questions: [
        { ...QUESTIONS[0]!, codeSnippet: { language: 'typescript', code: 'const x = 1;', filename: 'x.ts' } },
        ...QUESTIONS.slice(1)
      ]
    }, TOKEN);
    fixture = TestBed.createComponent(InterviewSessionComponent);
    rendered = true;
    component = fixture.componentInstance;
    fixture.detectChanges();

    const snippetEl = fixture.nativeElement.querySelector('app-code-snippet');
    expect(snippetEl).not.toBeNull();
    expect(snippetEl.textContent).toContain('const x = 1;');
  });
});

describe('saving', () => {
  it('shows the optimistic selection immediately, then the canonical value', async () => {
    render();
    api.saveAnswer.mockReturnValue(of(saved('rxjs:q:0', [101])));

    const promise = component.onSelectionChange([101]);
    expect(component.selectedIds()).toEqual([101]);
    await promise;
    fixture.detectChanges();

    expect(api.saveAnswer).toHaveBeenCalledWith('is_1', TOKEN, 'rxjs:q:0', [101]);
    expect(component.answeredCount()).toBe(1);
  });

  it('shows a saving indicator and blocks navigation while pending', async () => {
    render();
    const gate = new Subject<SaveInterviewAnswerResponse>();
    api.saveAnswer.mockReturnValue(gate);

    const promise = component.onSelectionChange([101]);
    await settleMicrotasks();
    fixture.detectChanges();

    expect(component.isSavingCurrent()).toBe(true);
    expect(component.navigationBlocked()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Saving');

    gate.next(saved('rxjs:q:0', [101]));
    gate.complete();
    await promise;
    fixture.detectChanges();

    expect(component.navigationBlocked()).toBe(false);
  });

  it('blocks paginator, keyboard and submit while a save is pending', async () => {
    render();
    const gate = new Subject<SaveInterviewAnswerResponse>();
    api.saveAnswer.mockReturnValue(gate);
    const promise = component.onSelectionChange([101]);
    await settleMicrotasks();
    fixture.detectChanges();

    component.onNavigate(2);
    expect(component.currentIndex()).toBe(0);

    component.onGlobalKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(component.currentIndex()).toBe(0);

    component.onShowResults();
    expect(api.submitSession).not.toHaveBeenCalled();

    gate.next(saved('rxjs:q:0', [101]));
    gate.complete();
    await promise;
  });

  it('ROLLS BACK to the confirmed answer, flags it and BLOCKS navigation when a save fails', async () => {
    render(new Map([['rxjs:q:0', [101]]]));
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));

    await component.onSelectionChange([102]);
    fixture.detectChanges();

    // The screen shows the SERVER's answer — never an unsaved one.
    expect(component.selectedIds()).toEqual([101]);
    expect(backend.confirmedAnswers().get('rxjs:q:0')).toEqual([101]);
    expect(component.hasFailedCurrent()).toBe(true);
    expect(component.navigationBlocked()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('could not be saved');
    // ...and there is no Undo: the confirmed state is already what is rendered.
    expect(fixture.nativeElement.textContent).not.toContain('Undo');
  });

  it('retry resends the INTENDED selection and unblocks on success', async () => {
    render(new Map([['rxjs:q:0', [101]]]));
    api.saveAnswer.mockReturnValueOnce(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await component.onSelectionChange([102]);
    expect(component.selectedIds()).toEqual([101]);
    expect(component.navigationBlocked()).toBe(true);

    api.saveAnswer.mockReturnValue(of(saved('rxjs:q:0', [102])));
    await component.retrySave();
    fixture.detectChanges();

    // [102] came from internal retry state, not from what was on screen.
    expect(api.saveAnswer).toHaveBeenLastCalledWith('is_1', TOKEN, 'rxjs:q:0', [102]);
    expect(component.selectedIds()).toEqual([102]);
    expect(component.hasFailedCurrent()).toBe(false);
    expect(component.navigationBlocked()).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('could not be saved');
  });

  it('a newer selection supersedes the failed retry intent', async () => {
    render(new Map([['rxjs:q:0', [101]]]));
    api.saveAnswer.mockReturnValueOnce(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await component.onSelectionChange([102]);

    api.saveAnswer.mockReturnValue(of(saved('rxjs:q:0', [101])));
    await component.onSelectionChange([101]);

    api.saveAnswer.mockClear();
    await component.retrySave();

    expect(api.saveAnswer).not.toHaveBeenCalled();   // no stale [102] resend
    expect(component.selectedIds()).toEqual([101]);
    expect(component.navigationBlocked()).toBe(false);
  });

  it('a FAILED save leaves no paginator marker', async () => {
    render();
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await component.onSelectionChange([101]);
    expect([...component.answeredIndices()]).toEqual([]);
  });
});

describe('navigation', () => {
  it('persists the current index through the service', () => {
    render(new Map([['rxjs:q:0', [101]]]));
    component.onNavigate(1);
    expect(component.currentIndex()).toBe(1);
    expect(TestBed.inject(InterviewSessionReferenceStorage).read()?.currentIndex).toBe(1);
  });

  it('forward keyboard needs an answer; backward is always allowed', () => {
    render();
    component.onGlobalKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(component.currentIndex()).toBe(0);          // unanswered → blocked

    component.onNavigate(1);
    expect(component.currentIndex()).toBe(1);
    component.onGlobalKey(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(component.currentIndex()).toBe(0);
  });

  it('gating never consults correctness or completeness', () => {
    render(new Map([['rxjs:q:1', [201]]]));   // one of three on a multiple
    component.onNavigate(1);
    expect(component.canNavigateNext()).toBe(true);
  });
});

describe('timer', () => {
  it('starts from the SERVER remaining seconds, not a full restart', () => {
    render();
    const timer = TestBed.inject(BackendInterviewTimerService);
    expect(timer.remainingSeconds()).toBe(900);
    expect(timer.durationSeconds()).toBe(900);
  });

  it('has no pause/resume — the server deadline never stops', () => {
    const timer = TestBed.inject(BackendInterviewTimerService) as unknown as Record<string, unknown>;
    expect(timer['pause']).toBeUndefined();
    expect(timer['resume']).toBeUndefined();
  });
});

describe('submission', () => {
  it('submits through the backend and navigates to results', async () => {
    render();
    api.submitSession.mockReturnValue(of({ sessionId: 'is_1' }));

    await invokeSubmit();

    // Only the id and token — no answers, score or reason.
    expect(api.submitSession).toHaveBeenCalledWith('is_1', TOKEN);
    expect(api.submitSession).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/interview/results', 'is_1']);
  });

  it('suppresses duplicate submissions', async () => {
    render();
    api.submitSession.mockReturnValue(of({ sessionId: 'is_1' }));
    await Promise.all([invokeSubmit(), invokeSubmit()]);
    expect(api.submitSession).toHaveBeenCalledTimes(1);
  });

  it('a failed save blocks submission', async () => {
    render();
    api.saveAnswer.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));
    await component.onSelectionChange([101]);

    component.onShowResults();
    expect(api.submitSession).not.toHaveBeenCalled();
  });

  it('EXPIRY submits once and never sends submittedByExpiry', async () => {
    render();
    api.submitSession.mockReturnValue(of({ sessionId: 'is_1' }));

    TestBed.inject(BackendInterviewTimerService).syncFromServer(0, 900);
    await Promise.resolve();
    await Promise.resolve();

    expect(api.submitSession).toHaveBeenCalledTimes(1);
    expect(api.submitSession).toHaveBeenCalledWith('is_1', TOKEN);
  });

  it('a backend outage keeps the session locked and offers retry', async () => {
    render();
    api.submitSession.mockReturnValue(throwError(() => new InterviewApiError('BACKEND_UNAVAILABLE', 0)));

    await invokeSubmit();
    fixture.detectChanges();

    expect(component.submitError()).toBeTruthy();
    expect(router.navigate).not.toHaveBeenCalledWith(['/interview/results', 'is_1']);
    expect(TestBed.inject(InterviewSessionReferenceStorage).read()).not.toBeNull();
  });

  it('the result is held in memory only — never written to storage', async () => {
    render();
    api.submitSession.mockReturnValue(of({ sessionId: 'is_1', total: 3, correct: 2 }));
    await invokeSubmit();

    expect(JSON.stringify(localStorage)).not.toContain('correctOptionIds');
    const raw = sessionStorage.getItem('interviewSessionRef:v2') ?? '';
    expect(Object.keys(JSON.parse(raw)).sort())
      .toEqual(['currentIndex', 'sessionId', 'sessionToken', 'version']);
  });
});

describe('storage security during an active session', () => {
  it('only the minimal v2 reference is stored', () => {
    render(new Map([['rxjs:q:0', [101]]]));
    const raw = sessionStorage.getItem('interviewSessionRef:v2') ?? '';
    for (const banned of [
      'questions', 'options', 'answers', 'correct', 'correctOptionIds',
      'explanation', 'GeneratedAssessment', 'result', 'score', 'durationSeconds', 'expiresAt'
    ]) {
      expect(raw).not.toContain(banned);
    }
    expect(sessionStorage.getItem('interviewSession')).toBeNull();
  });
});
