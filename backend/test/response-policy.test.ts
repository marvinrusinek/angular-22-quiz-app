import { findPolicyViolation, isKeyBanned, normalizeKey } from '../src/api/response-policy';

describe('key normalization', () => {
  it('collapses casing and separators so naming drift cannot slip past', () => {
    for (const variant of ['is_correct', 'isCorrect', 'IsCorrect', 'IS_CORRECT', 'is-correct']) {
      expect(normalizeKey(variant)).toBe('iscorrect');
    }
  });

  it('keeps distinct names distinct — matching is exact, not substring', () => {
    expect(normalizeKey('correct')).not.toBe(normalizeKey('correctOptionIds'));
  });
});

describe('recursive detection', () => {
  it('blocks a top-level banned key', () => {
    const found = findPolicyViolation({ correct: true }, 'ACTIVE_ASSESSMENT');
    expect(found?.key).toBe('correct');
    expect(found?.path).toBe('correct');
  });

  it('blocks a NESTED object', () => {
    const found = findPolicyViolation({ nested: { correct: true } }, 'ACTIVE_ASSESSMENT');
    expect(found?.path).toBe('nested.correct');
  });

  it('blocks an object INSIDE AN ARRAY', () => {
    const found = findPolicyViolation({ items: [{ explanation: 'private' }] }, 'ACTIVE_ASSESSMENT');
    expect(found?.path).toBe('items[0].explanation');
  });

  it('blocks a DEEPLY nested array-in-array', () => {
    const found = findPolicyViolation({ data: [[{ answerKey: [1] }]] }, 'ACTIVE_ASSESSMENT');
    expect(found?.key).toBe('answerKey');
    expect(found?.path).toBe('data[0][0].answerKey');
  });

  it('walks several levels deep', () => {
    const body = { a: { b: { c: { d: [{ e: { isCorrect: false } }] } } } };
    expect(findPolicyViolation(body, 'ACTIVE_ASSESSMENT')?.key).toBe('isCorrect');
  });

  it('ALLOWS a clean body', () => {
    const body = {
      questions: [
        { questionId: 'rxjs:q:0', options: [{ optionId: 101, text: 'a' }] }
      ]
    };
    expect(findPolicyViolation(body, 'ACTIVE_ASSESSMENT')).toBeNull();
  });

  it('inspects NAMES, not values — safe text containing banned words passes', () => {
    const body = {
      safe: { questionText: 'Which answer is correct?' },
      summary: 'Read the explanation to see the correct answer key.',
      note: 'expectedAnswers is discussed in this sentence.'
    };
    expect(findPolicyViolation(body, 'ACTIVE_ASSESSMENT')).toBeNull();
  });

  it('survives cycles instead of hanging', () => {
    const body: Record<string, unknown> = { name: 'ok' };
    body['self'] = body;
    expect(() => findPolicyViolation(body, 'ACTIVE_ASSESSMENT')).not.toThrow();
  });

  it('handles primitives, null and empty containers', () => {
    for (const body of [null, undefined, 1, 'text', true, [], {}]) {
      expect(findPolicyViolation(body, 'ACTIVE_ASSESSMENT')).toBeNull();
    }
  });
});

describe('PUBLIC_METADATA policy', () => {
  it('bans answer-key fields', () => {
    for (const key of ['correct', 'isCorrect', 'correctOptionIds', 'answerKey', 'expectedAnswers']) {
      expect(isKeyBanned(key, 'PUBLIC_METADATA')).toBe(true);
    }
  });

  it('bans explanation, questions and options so metadata cannot grow into a dump', () => {
    for (const key of ['explanation', 'questions', 'options']) {
      expect(isKeyBanned(key, 'PUBLIC_METADATA')).toBe(true);
    }
  });

  it('allows genuine metadata fields', () => {
    for (const key of ['quizId', 'milestone', 'summary', 'image', 'difficulty', 'questionCount']) {
      expect(isKeyBanned(key, 'PUBLIC_METADATA')).toBe(false);
    }
  });
});

describe('ACTIVE_ASSESSMENT policy', () => {
  it('bans every form of correctness and the explanation', () => {
    for (const key of [
      'correct', 'isCorrect', 'is_correct', 'correctOptionIds', 'correct_option_ids',
      'answerKey', 'answer_key', 'expectedAnswers', 'expected_answers', 'explanation'
    ]) {
      expect(isKeyBanned(key, 'ACTIVE_ASSESSMENT')).toBe(true);
    }
  });

  it('bans private source indexes', () => {
    expect(isKeyBanned('sourceQuestionIndex', 'ACTIVE_ASSESSMENT')).toBe(true);
    expect(isKeyBanned('sourceOptionIndex', 'ACTIVE_ASSESSMENT')).toBe(true);
  });

  it('ALLOWS the fields an active question needs', () => {
    for (const key of ['questionId', 'sourceQuizId', 'questionText', 'type', 'options', 'optionId', 'text']) {
      expect(isKeyBanned(key, 'ACTIVE_ASSESSMENT')).toBe(false);
    }
  });
});

describe('SUBMITTED_REVIEW policy', () => {
  it('ALLOWS the two fields review genuinely needs', () => {
    expect(isKeyBanned('correctOptionIds', 'SUBMITTED_REVIEW')).toBe(false);
    expect(isKeyBanned('explanation', 'SUBMITTED_REVIEW')).toBe(false);
  });

  it('STILL bans raw per-option correctness FLAGS', () => {
    for (const key of ['isCorrect', 'is_correct']) {
      expect(isKeyBanned(key, 'SUBMITTED_REVIEW')).toBe(true);
    }
  });

  it('permits bare `correct` — the AGGREGATE count on a submitted result', () => {
    // Not a per-option flag: this is how many questions the user got right,
    // matching Angular's InterviewResult.correct. Still banned on active and
    // public responses.
    expect(isKeyBanned('correct', 'SUBMITTED_REVIEW')).toBe(false);
    expect(isKeyBanned('correct', 'ACTIVE_ASSESSMENT')).toBe(true);
    expect(isKeyBanned('correct', 'PUBLIC_METADATA')).toBe(true);
  });

  it('STILL bans backend internals', () => {
    for (const key of [
      'sourceQuestionIndex', 'sourceOptionIndex',
      'tokenHash', 'token_hash', 'dataPath', 'databasePath'
    ]) {
      expect(isKeyBanned(key, 'SUBMITTED_REVIEW')).toBe(true);
    }
  });

  it('is an allow-list, not "anything goes after submission"', () => {
    const body = { review: [{ correctOptionIds: [101], explanation: 'ok', is_correct: true }] };
    expect(findPolicyViolation(body, 'SUBMITTED_REVIEW')?.key).toBe('is_correct');
  });

  it('permits a well-formed review body', () => {
    const body = {
      review: [
        {
          questionId: 'rxjs:q:0',
          questionText: 'Which answer is correct?',
          selectedOptionIds: [101],
          correctOptionIds: [101],
          explanation: 'Because…'
        }
      ]
    };
    expect(findPolicyViolation(body, 'SUBMITTED_REVIEW')).toBeNull();
  });
});

describe('policy separation', () => {
  it('the same body is blocked when active but allowed after submission', () => {
    const body = { correctOptionIds: [101], explanation: 'why' };
    expect(findPolicyViolation(body, 'ACTIVE_ASSESSMENT')).not.toBeNull();
    expect(findPolicyViolation(body, 'SUBMITTED_REVIEW')).toBeNull();
  });
});

/**
 * `facts` is PUBLIC trivia, served on the metadata contract only.
 *
 * A fact is a sentence about the topic, never a statement about which option is
 * correct — so it is metadata rather than answer key. But it must still not
 * ride along with pre-answer question content, which is what the QUIZ_QUESTIONS
 * ban enforces. These pin both halves, because the field moved from "dropped
 * everywhere" to "served in exactly one place".
 */
describe('facts — served on metadata, banned from question delivery', () => {
  it('is PERMITTED on the public metadata contract', () => {
    expect(isKeyBanned('facts', 'PUBLIC_METADATA')).toBe(false);
    const metadata = {
      quizzes: [
        { quizId: 'rxjs', milestone: 'RxJS', facts: ['RxJS predates Angular.'], questionCount: 10 }
      ]
    };
    expect(findPolicyViolation(metadata, 'PUBLIC_METADATA')).toBeNull();
  });

  it('is BANNED from the question-delivery contract', () => {
    expect(isKeyBanned('facts', 'QUIZ_QUESTIONS')).toBe(true);
  });

  it('is caught even when NESTED inside a questions payload', () => {
    const leak = {
      quizId: 'rxjs',
      questions: [{ questionText: 'Q?', facts: ['leaked'], options: [{ text: 'a' }] }]
    };
    const found = findPolicyViolation(leak, 'QUIZ_QUESTIONS');
    expect(found?.key).toBe('facts');
    expect(found?.path).toBe('questions[0].facts');
  });

  it('metadata carrying facts still cannot carry answer-key fields', () => {
    const bad = { quizzes: [{ quizId: 'rxjs', facts: ['ok'], correct: true }] };
    expect(findPolicyViolation(bad, 'PUBLIC_METADATA')?.key).toBe('correct');
  });
});
