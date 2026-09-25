import { TestBed } from '@angular/core/testing';

import { InterviewSessionReferenceStorage } from './interview-session-reference.storage';
import {
  parseSessionReference,
  SK_INTERVIEW_SESSION_REF
} from '@shared/models/interview/interview-session-reference.model';

const TOKEN = 'a'.repeat(43);

let storage: InterviewSessionReferenceStorage;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [InterviewSessionReferenceStorage] });
  storage = TestBed.inject(InterviewSessionReferenceStorage);
});
afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

const stored = () => JSON.parse(sessionStorage.getItem(SK_INTERVIEW_SESSION_REF) ?? 'null');

describe('round trip', () => {
  it('writes and reads the minimal reference', () => {
    storage.write('is_1', TOKEN, 3);
    expect(storage.read()).toEqual({
      version: 2, sessionId: 'is_1', sessionToken: TOKEN, currentIndex: 3
    });
  });

  it('persists EXACTLY three fields plus the version', () => {
    storage.write('is_1', TOKEN, 0);
    expect(Object.keys(stored()).sort())
      .toEqual(['currentIndex', 'sessionId', 'sessionToken', 'version']);
  });

  it('never stores questions, answers, correctness or explanations', () => {
    storage.write('is_1', TOKEN, 0);
    const raw = sessionStorage.getItem(SK_INTERVIEW_SESSION_REF)!;
    for (const banned of [
      'questions', 'options', 'answers', 'selectedOptionIds', 'correct',
      'isCorrect', 'correctOptionIds', 'explanation', 'assessment', 'result',
      'score', 'percentage', 'expiresAt', 'remainingSeconds'
    ]) {
      expect(raw).not.toContain(banned);
    }
  });

  it('writes to sessionStorage ONLY — never localStorage', () => {
    storage.write('is_1', TOKEN, 0);
    expect(localStorage.getItem(SK_INTERVIEW_SESSION_REF)).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain(TOKEN);
  });

  it('updates only the index', () => {
    storage.write('is_1', TOKEN, 0);
    storage.updateCurrentIndex(7);
    expect(storage.read()).toEqual({
      version: 2, sessionId: 'is_1', sessionToken: TOKEN, currentIndex: 7
    });
  });

  it('ignores an index update with no stored reference', () => {
    storage.updateCurrentIndex(4);
    expect(storage.read()).toBeNull();
  });

  it('clears', () => {
    storage.write('is_1', TOKEN, 0);
    storage.clear();
    expect(storage.read()).toBeNull();
  });
});

describe('untrusted storage is validated', () => {
  const put = (value: string) => sessionStorage.setItem(SK_INTERVIEW_SESSION_REF, value);

  it.each([
    ['malformed JSON', '{ not json'],
    ['an array', '[]'],
    ['null', 'null'],
    ['wrong version', JSON.stringify({ version: 1, sessionId: 'x', sessionToken: TOKEN, currentIndex: 0 })],
    ['missing sessionId', JSON.stringify({ version: 2, sessionToken: TOKEN, currentIndex: 0 })],
    ['blank sessionId', JSON.stringify({ version: 2, sessionId: '  ', sessionToken: TOKEN, currentIndex: 0 })],
    ['missing token', JSON.stringify({ version: 2, sessionId: 'x', currentIndex: 0 })],
    ['negative index', JSON.stringify({ version: 2, sessionId: 'x', sessionToken: TOKEN, currentIndex: -1 })],
    ['float index', JSON.stringify({ version: 2, sessionId: 'x', sessionToken: TOKEN, currentIndex: 1.5 })]
  ])('rejects and removes %s', (_label, value) => {
    put(value);
    expect(storage.read()).toBeNull();
    expect(sessionStorage.getItem(SK_INTERVIEW_SESSION_REF)).toBeNull();
  });

  it.each([
    'questions', 'answers', 'correct', 'correctOptionIds', 'explanation', 'assessment', 'result'
  ])('REJECTS a reference carrying an answer-bearing field: %s', (field) => {
    put(JSON.stringify({
      version: 2, sessionId: 'x', sessionToken: TOKEN, currentIndex: 0, [field]: 'anything'
    }));
    expect(storage.read()).toBeNull();
  });

  it('parseSessionReference is pure and accepts a valid object', () => {
    expect(parseSessionReference({
      version: 2, sessionId: 'x', sessionToken: TOKEN, currentIndex: 2
    })).not.toBeNull();
  });
});

describe('legacy cleanup', () => {
  it('removes the answer-bearing v1 active session key', () => {
    // The real v1 payload: a full generated assessment WITH correctness.
    sessionStorage.setItem('interviewSession', JSON.stringify({
      assessment: {
        questions: [{
          questionText: 'Q?', explanation: 'because',
          options: [{ optionId: 101, text: 'a', correct: true }]
        }]
      },
      answersByIndex: { 0: [101] },
      expiresAt: 123
    }));

    expect(storage.purgeLegacyKeys()).toEqual(['interviewSession']);
    expect(sessionStorage.getItem('interviewSession')).toBeNull();
  });

  it('also removes a localStorage copy defensively', () => {
    localStorage.setItem('interviewSession', '{"assessment":{}}');
    expect(storage.purgeLegacyKeys()).toContain('interviewSession');
    expect(localStorage.getItem('interviewSession')).toBeNull();
  });

  it('is IDEMPOTENT', () => {
    sessionStorage.setItem('interviewSession', '{}');
    expect(storage.purgeLegacyKeys()).toEqual(['interviewSession']);
    expect(storage.purgeLegacyKeys()).toEqual([]);
  });

  it('leaves unrelated application storage untouched', () => {
    const keep: Record<string, string> = {
      assessmentIntegrity: '{"focusLossCount":2}',
      __interviewSeconds: '30',
      'interviewAttemptHistory:v1': '{"version":1,"attempts":[]}',
      'interviewCertificate:v1': '{"unlocked":true}',
      quizBestScores: '{"rxjs":80}',
      quizAchievements: '["first-quiz"]',
      completedQuizIds: '["rxjs"]',
      theme: 'dark'
    };
    for (const [key, value] of Object.entries(keep)) {
      sessionStorage.setItem(key, value);
      localStorage.setItem(key, value);
    }
    sessionStorage.setItem('interviewSession', '{}');

    storage.purgeLegacyKeys();

    for (const [key, value] of Object.entries(keep)) {
      expect(sessionStorage.getItem(key)).toBe(value);
      expect(localStorage.getItem(key)).toBe(value);
    }
  });

  it('does NOT remove the new v2 reference', () => {
    storage.write('is_1', TOKEN, 0);
    storage.purgeLegacyKeys();
    expect(storage.read()).not.toBeNull();
  });

  it('does NOT sanitize interviewAttemptHistory:v1 — that is Stage 9E', () => {
    localStorage.setItem('interviewAttemptHistory:v1', '{"version":1,"attempts":[{"correct":3}]}');
    storage.purgeLegacyKeys();
    expect(localStorage.getItem('interviewAttemptHistory:v1'))
      .toBe('{"version":1,"attempts":[{"correct":3}]}');
  });
});
