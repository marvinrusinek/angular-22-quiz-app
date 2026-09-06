import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { InterviewApiService } from './interview-api.service';
import { InterviewApiError } from './interview-api.errors';
import { API_BASE_URL } from '../../tokens/api-base-url.token';
import type {
  ActiveInterviewSessionDto,
  InterviewResultDto
} from '../../models/api/interview-api.dto';

const BASE = 'http://localhost:3000/api';
const TOKEN = 'a'.repeat(43);
const SESSION = 'is_abc123';

let api: InterviewApiService;
let http: HttpTestingController;

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: BASE },
      InterviewApiService
    ]
  });
  api = TestBed.inject(InterviewApiService);
  http = TestBed.inject(HttpTestingController);
});
afterEach(() => http.verify());

function activeDto(overrides: Partial<ActiveInterviewSessionDto> = {}): ActiveInterviewSessionDto {
  return {
    sessionId: SESSION,
    sessionToken: TOKEN,
    status: 'active',
    createdAt: '2026-08-02T10:00:00.000Z',
    expiresAt: '2026-08-02T10:15:00.000Z',
    durationSeconds: 900,
    remainingSeconds: 900,
    config: { mode: 'custom', difficulty: 'mixed', topicIds: ['rxjs'], questionCount: 2 },
    questions: [
      {
        questionId: 'rxjs:q:0',
        sourceQuizId: 'rxjs',
        questionText: 'Which answer is correct?',
        type: 'single',
        options: [{ optionId: 101, text: 'A' }, { optionId: 102, text: 'B' }],
        flagged: false
      },
      {
        questionId: 'rxjs:q:1',
        sourceQuizId: 'rxjs',
        questionText: 'Pick two',
        type: 'multiple',
        options: [{ optionId: 201, text: 'C' }, { optionId: 202, text: 'D' }, { optionId: 203, text: 'E' }],
        flagged: false
      }
    ],
    answers: [],
    ...overrides
  };
}

describe('createSession', () => {
  it('POSTs a PRESET request with only the preset id', () => {
    api.createSession({ mode: 'preset', presetId: 'junior' }).subscribe();

    const req = http.expectOne(`${BASE}/interview-sessions`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ mode: 'preset', presetId: 'junior' });
    // No topics, count, duration or quotas — the preset owns those.
    expect(Object.keys(req.request.body as object).sort()).toEqual(['mode', 'presetId']);
    req.flush(activeDto());
  });

  it('POSTs a CUSTOM request with only the permitted fields', () => {
    api.createSession({
      mode: 'custom', difficulty: 'mixed', topicIds: ['rxjs', 'signals'], questionCount: 10
    }).subscribe();

    const req = http.expectOne(`${BASE}/interview-sessions`);
    expect(Object.keys(req.request.body as object).sort())
      .toEqual(['difficulty', 'mode', 'questionCount', 'topicIds']);
    // Duration is derived server-side and must never be sent.
    expect(JSON.stringify(req.request.body)).not.toContain('duration');
    req.flush(activeDto());
  });

  it('does NOT attach an Authorization header — there is no token yet', () => {
    api.createSession({ mode: 'preset', presetId: 'junior' }).subscribe();
    const req = http.expectOne(`${BASE}/interview-sessions`);
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush(activeDto());
  });

  it('returns the session and the token separately', (done) => {
    api.createSession({ mode: 'preset', presetId: 'junior' }).subscribe((created) => {
      expect(created.sessionToken).toBe(TOKEN);
      expect(created.session.sessionId).toBe(SESSION);
      expect(created.session.questions).toHaveLength(2);
      done();
    });
    http.expectOne(`${BASE}/interview-sessions`).flush(activeDto());
  });

  it('fails when the response omits a token', (done) => {
    const { sessionToken, ...withoutToken } = activeDto();
    void sessionToken;
    api.createSession({ mode: 'preset', presetId: 'junior' }).subscribe({
      error: (err: InterviewApiError) => {
        expect(err).toBeInstanceOf(InterviewApiError);
        done();
      }
    });
    http.expectOne(`${BASE}/interview-sessions`).flush(withoutToken);
  });
});

describe('session-scoped calls attach the bearer token', () => {
  it('resume', () => {
    api.resumeSession(SESSION, TOKEN).subscribe();
    const req = http.expectOne(`${BASE}/interview-sessions/${SESSION}`);
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    req.flush(activeDto({ sessionToken: undefined }));
  });

  it('saveAnswer', () => {
    api.saveAnswer(SESSION, TOKEN, 'rxjs:q:1', [203, 201]).subscribe();
    const req = http.expectOne(`${BASE}/interview-sessions/${SESSION}/answers/rxjs%3Aq%3A1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(req.request.body).toEqual({ selectedOptionIds: [203, 201] });
    req.flush({ saved: true, questionId: 'rxjs:q:1', selectedOptionIds: [201, 203], answeredCount: 1, questionCount: 2 });
  });

  it('submit sends an EMPTY body', () => {
    api.submitSession(SESSION, TOKEN).subscribe();
    const req = http.expectOne(`${BASE}/interview-sessions/${SESSION}/submit`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    req.flush(resultDto());
  });

  it('getResult', () => {
    api.getResult(SESSION, TOKEN).subscribe();
    const req = http.expectOne(`${BASE}/interview-sessions/${SESSION}/result`);
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    req.flush(resultDto());
  });
});

describe('the token never appears in a URL', () => {
  it('for any session-scoped call', () => {
    api.resumeSession(SESSION, TOKEN).subscribe();
    api.saveAnswer(SESSION, TOKEN, 'q1', [1]).subscribe();
    api.submitSession(SESSION, TOKEN).subscribe();
    api.getResult(SESSION, TOKEN).subscribe();

    for (const req of http.match(() => true)) {
      expect(req.request.urlWithParams).not.toContain(TOKEN);
      expect(req.request.url).not.toContain(TOKEN);
      req.flush(req.request.method === 'GET' && req.request.url.endsWith('/result')
        ? resultDto()
        : req.request.url.endsWith('/submit') ? resultDto()
        : req.request.method === 'PUT'
          ? { saved: true, questionId: 'q1', selectedOptionIds: [1], answeredCount: 1, questionCount: 2 }
          : activeDto({ sessionToken: undefined }));
    }
  });

  it('encodes an opaque session id into the path', () => {
    api.resumeSession('is_a/b', TOKEN).subscribe();
    const req = http.expectOne((r) => r.url.includes('interview-sessions'));
    expect(req.request.url).toContain('is_a%2Fb');
    req.flush(activeDto({ sessionToken: undefined }));
  });
});

describe('active responses carry no correctness', () => {
  it('the mapped session exposes no correctness field anywhere', (done) => {
    api.resumeSession(SESSION, TOKEN).subscribe((session) => {
      const serialized = JSON.stringify(session, (_key, value: unknown) =>
        value instanceof Map ? [...value] : value);
      for (const banned of ['isCorrect', 'correctOptionIds', 'explanation']) {
        expect(serialized).not.toContain(banned);
      }
      for (const question of session.questions) {
        for (const option of question.options) {
          expect(Object.keys(option).sort()).toEqual(['optionId', 'text']);
        }
      }
      done();
    });
    http.expectOne(`${BASE}/interview-sessions/${SESSION}`).flush(activeDto({ sessionToken: undefined }));
  });
});

describe('error mapping', () => {
  const cases: [number, object, string][] = [
    [401, {}, 'UNAUTHORIZED'],
    [400, {}, 'BAD_REQUEST'],
    [409, { error: { code: 'CONFLICT', message: 'x' } }, 'CONFLICT'],
    [409, { error: { code: 'SESSION_EXPIRED', message: 'x' } }, 'SESSION_EXPIRED'],
    [404, {}, 'UNAUTHORIZED'],
    [500, {}, 'BACKEND_UNAVAILABLE'],
    [418, {}, 'UNKNOWN']
  ];

  it.each(cases)('status %i maps to %s', async (status, body, code) => {
    const failure = new Promise<InterviewApiError>((resolve) => {
      api.resumeSession(SESSION, TOKEN).subscribe({ error: resolve });
    });
    http.expectOne(`${BASE}/interview-sessions/${SESSION}`)
      .flush(body, { status, statusText: 'err' });

    const err = await failure;
    expect(err.code).toBe(code);
    expect(err.userMessage).toBeTruthy();
  });

  it('a network failure becomes BACKEND_UNAVAILABLE and is retryable', (done) => {
    api.resumeSession(SESSION, TOKEN).subscribe({
      error: (err: InterviewApiError) => {
        expect(err.code).toBe('BACKEND_UNAVAILABLE');
        expect(err.retryable).toBe(true);
        done();
      }
    });
    http.expectOne(`${BASE}/interview-sessions/${SESSION}`)
      .error(new ProgressEvent('network error'));
  });

  it('never surfaces the raw backend message to the user', (done) => {
    api.submitSession(SESSION, TOKEN).subscribe({
      error: (err: InterviewApiError) => {
        expect(err.userMessage).not.toContain('SQLITE');
        expect(err.userMessage).not.toContain('constraint');
        done();
      }
    });
    http.expectOne(`${BASE}/interview-sessions/${SESSION}/submit`)
      .flush({ error: { code: 'INTERNAL', message: 'SQLITE_CONSTRAINT failed' } },
        { status: 500, statusText: 'err' });
  });
});

function resultDto(): InterviewResultDto {
  return {
    sessionId: SESSION,
    status: 'submitted',
    submittedAt: '2026-08-02T10:05:00.000Z',
    submittedByExpiry: false,
    total: 2, answered: 1, unanswered: 1, correct: 1, incorrect: 0, percentage: 50,
    durationSeconds: 900, timeUsedSeconds: 300, timeRemainingSeconds: 600,
    config: { mode: 'custom', difficulty: 'mixed', topicIds: ['rxjs'], questionCount: 2 },
    performance: {
      byTopic: [{ topicId: 'rxjs', title: 'RxJS', correct: 1, incorrect: 0, unanswered: 1, total: 2, percentage: 50 }]
    },
    review: [
      {
        questionId: 'rxjs:q:0', sourceQuizId: 'rxjs', questionText: 'Which answer is correct?',
        type: 'single', options: [{ optionId: 101, text: 'A' }, { optionId: 102, text: 'B' }],
        selectedOptionIds: [101], correctOptionIds: [101], explanation: 'Because A.', flagged: false
      },
      {
        questionId: 'rxjs:q:1', sourceQuizId: 'rxjs', questionText: 'Pick two',
        type: 'multiple', options: [{ optionId: 201, text: 'C' }, { optionId: 202, text: 'D' }],
        selectedOptionIds: [], correctOptionIds: [201, 202], explanation: 'Because C and D.', flagged: false
      }
    ]
  };
}
