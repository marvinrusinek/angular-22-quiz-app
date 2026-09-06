import { deriveQuestionType, QuizDataError, validateAndNormalize } from '../src/quiz/quiz.validation';

/** Minimal valid building blocks; each test perturbs one thing. */
function option(text: string, correct?: boolean): Record<string, unknown> {
  return correct === undefined ? { text } : { text, correct };
}

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    questionText: 'What is a signal?',
    explanation: 'Because signals are reactive.',
    options: [option('A reactive primitive', true), option('A pipe'), option('A directive')],
    ...overrides
  };
}

function quiz(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    quizId: 'signals',
    milestone: 'Signals',
    summary: 'About signals',
    image: 'signals.svg',
    difficulty: 'beginner',
    questions: [question()],
    ...overrides
  };
}

function bank(quizzes: unknown[]): Record<string, unknown> {
  return { quizzes, resources: [] };
}

function problemsFrom(input: unknown): string[] {
  try {
    validateAndNormalize(input);
    return [];
  } catch (err) {
    if (err instanceof QuizDataError) return err.problems.map((p) => `${p.at}: ${p.message}`);
    throw err;
  }
}

describe('root shape', () => {
  it('accepts { quizzes: [...] }', () => {
    expect(validateAndNormalize(bank([quiz()])).quizzes).toHaveLength(1);
  });

  it('accepts a bare array', () => {
    expect(validateAndNormalize([quiz()]).quizzes).toHaveLength(1);
  });

  it.each([null, 42, 'text', true])('rejects a non-object root: %p', (input) => {
    expect(problemsFrom(input).join()).toMatch(/root/);
  });

  it('rejects a missing quizzes array', () => {
    expect(problemsFrom({ resources: [] }).join()).toMatch(/expected an array/i);
  });

  it('rejects an empty quiz collection', () => {
    expect(problemsFrom(bank([])).join()).toMatch(/empty/i);
  });
});

describe('quiz-level validation', () => {
  it('rejects a missing quizId', () => {
    expect(problemsFrom(bank([quiz({ quizId: '' })])).join()).toMatch(/blank quizId/i);
  });

  it('rejects DUPLICATE quiz ids', () => {
    expect(problemsFrom(bank([quiz(), quiz()])).join()).toMatch(/duplicate quizId/i);
  });

  it('rejects a blank milestone', () => {
    expect(problemsFrom(bank([quiz({ milestone: '  ' })])).join()).toMatch(/milestone/i);
  });

  it('rejects missing or empty questions', () => {
    expect(problemsFrom(bank([quiz({ questions: [] })])).join()).toMatch(/empty questions/i);
    expect(problemsFrom(bank([quiz({ questions: undefined })])).join()).toMatch(/questions/i);
  });

  it('accepts a numeric quizId by coercing to string', () => {
    const result = validateAndNormalize(bank([quiz({ quizId: 7 })]));
    expect(result.quizzes[0]!.quizId).toBe('7');
  });
});

describe('question-level validation', () => {
  it('rejects blank question text', () => {
    expect(problemsFrom(bank([quiz({ questions: [question({ questionText: ' ' })] })])).join())
      .toMatch(/blank questionText/i);
  });

  it('rejects a blank explanation — the app always renders one', () => {
    expect(problemsFrom(bank([quiz({ questions: [question({ explanation: '' })] })])).join())
      .toMatch(/explanation/i);
  });

  it('rejects an empty options array', () => {
    expect(problemsFrom(bank([quiz({ questions: [question({ options: [] })] })])).join())
      .toMatch(/empty options/i);
  });

  it('rejects a question with fewer than two options', () => {
    expect(
      problemsFrom(bank([quiz({ questions: [question({ options: [option('only', true)] })] })])).join()
    ).toMatch(/at least two options/i);
  });

  it('rejects a question with NO correct option', () => {
    const q = question({ options: [option('a'), option('b')] });
    expect(problemsFrom(bank([quiz({ questions: [q] })])).join()).toMatch(/no correct option/i);
  });

  it('rejects a question where EVERY option is correct', () => {
    const q = question({ options: [option('a', true), option('b', true), option('c', true)] });
    expect(problemsFrom(bank([quiz({ questions: [q] })])).join()).toMatch(/every option/i);
  });

  it('rejects blank option text', () => {
    const q = question({ options: [option('a', true), option('   ')] });
    expect(problemsFrom(bank([quiz({ questions: [q] })])).join()).toMatch(/blank option text/i);
  });

  it('rejects DUPLICATE normalized question text within a quiz', () => {
    const q = quiz({
      questions: [question(), question({ questionText: '  WHAT   IS A SIGNAL? ' })]
    });
    // Same text after normalization → ambiguous for the remaining text-based lookups.
    const joined = problemsFrom(bank([q])).join();
    expect(joined).toMatch(/duplicate normalized questionText/i);
  });

  it('allows the same question text in DIFFERENT quizzes', () => {
    const a = quiz({ quizId: 'a' });
    const b = quiz({ quizId: 'b' });
    expect(() => validateAndNormalize(bank([a, b]))).not.toThrow();
  });
});

describe('the "correct" flag convention', () => {
  it('treats an ABSENT correct key as incorrect — the real source convention', () => {
    const result = validateAndNormalize(bank([quiz()]));
    const options = result.quizzes[0]!.questions[0]!.options;
    expect(options.map((o) => o.isCorrect)).toEqual([true, false, false]);
  });

  it('accepts an explicit correct: false', () => {
    const q = question({ options: [option('a', true), option('b', false)] });
    expect(() => validateAndNormalize(bank([quiz({ questions: [q] })]))).not.toThrow();
  });

  it.each([['true'], [1], [0], ['yes'], [null], [{}]])(
    'REJECTS a non-boolean correct value (%p) rather than coercing it',
    (value) => {
      const q = question({ options: [option('a', true), { text: 'b', correct: value }] });
      expect(problemsFrom(bank([quiz({ questions: [q] })])).join())
        .toMatch(/must be true, false, or omitted/i);
    }
  );
});

describe('code snippet validation', () => {
  const SNIPPET = { language: 'typescript', code: 'const x = signal(0);', filename: 'x.ts' };

  it('is entirely optional — absent is valid', () => {
    expect(problemsFrom(bank([quiz()]))).toEqual([]);
    expect(validateAndNormalize(bank([quiz()])).quizzes[0]!.questions[0]!.codeSnippet).toBeUndefined();
  });

  it('is carried through when present and well-formed', () => {
    const q = validateAndNormalize(bank([quiz({ questions: [question({ codeSnippet: SNIPPET })] })]))
      .quizzes[0]!.questions[0]!;
    expect(q.codeSnippet).toEqual(SNIPPET);
  });

  it('filename is optional on the snippet itself', () => {
    const q = validateAndNormalize(bank([quiz({
      questions: [question({ codeSnippet: { language: 'json', code: '{}' } })]
    })])).quizzes[0]!.questions[0]!;
    expect(q.codeSnippet).toEqual({ language: 'json', code: '{}' });
  });

  it('rejects an unsupported language', () => {
    expect(problemsFrom(bank([quiz({
      questions: [question({ codeSnippet: { language: 'python', code: 'x = 1' } })]
    })]))).toEqual([expect.stringMatching(/language must be one of/i)]);
  });

  it('rejects empty code', () => {
    expect(problemsFrom(bank([quiz({
      questions: [question({ codeSnippet: { language: 'typescript', code: '' } })]
    })]))).toEqual([expect.stringMatching(/code must be a non-empty string/i)]);
  });

  it('rejects code over the length limit', () => {
    expect(problemsFrom(bank([quiz({
      questions: [question({ codeSnippet: { language: 'typescript', code: 'x'.repeat(2001) } })]
    })]))).toEqual([expect.stringMatching(/exceeds 2000 characters/i)]);
  });

  it('rejects code over the line-count limit', () => {
    expect(problemsFrom(bank([quiz({
      questions: [question({ codeSnippet: { language: 'typescript', code: Array(41).fill('x').join('\n') } })]
    })]))).toEqual([expect.stringMatching(/exceeds 40 lines/i)]);
  });

  it('rejects a blank filename when present', () => {
    expect(problemsFrom(bank([quiz({
      questions: [question({ codeSnippet: { language: 'typescript', code: 'x', filename: '   ' } })]
    })]))).toEqual([expect.stringMatching(/filename must be a non-empty string/i)]);
  });

  it('rejects a filename containing a path separator', () => {
    expect(problemsFrom(bank([quiz({
      questions: [question({ codeSnippet: { language: 'typescript', code: 'x', filename: '../evil.ts' } })]
    })]))).toEqual([expect.stringMatching(/must not contain path separators/i)]);
  });

  it('rejects a malformed codeSnippet object', () => {
    expect(problemsFrom(bank([quiz({
      questions: [question({ codeSnippet: 'not an object' })]
    })]))).toEqual([expect.stringMatching(/codeSnippet must be an object/i)]);
  });

  it('a malformed snippet does not silently repair — it fails the whole import', () => {
    expect(() => validateAndNormalize(bank([quiz({
      questions: [question({ codeSnippet: { language: 'python', code: 'x' } })]
    })]))).toThrow(QuizDataError);
  });
});

describe('question-type derivation', () => {
  it('multiple when more than one option is correct', () => {
    expect(deriveQuestionType(['a', 'b', 'c'], 2)).toBe('multiple');
  });

  it('trueFalse for exactly two True/False options with one correct', () => {
    expect(deriveQuestionType(['True', 'False'], 1)).toBe('trueFalse');
    expect(deriveQuestionType(['false', 'TRUE'], 1)).toBe('trueFalse');
    expect(deriveQuestionType([' True ', 'False'], 1)).toBe('trueFalse');
  });

  it('single for two NON-true/false options', () => {
    expect(deriveQuestionType(['Yes', 'No'], 1)).toBe('single');
  });

  it('single for the ordinary multi-option case', () => {
    expect(deriveQuestionType(['a', 'b', 'c', 'd'], 1)).toBe('single');
  });

  it('multiple WINS over true/false shape — correctness decides first', () => {
    expect(deriveQuestionType(['True', 'False'], 2)).toBe('multiple');
  });
});

describe('diagnostics safety', () => {
  it('locates problems WITHOUT quoting option text, explanations or correctness', () => {
    const q = question({
      options: [option('THE-SECRET-ANSWER', true), option('')],
      explanation: 'SECRET-EXPLANATION'
    });
    const joined = problemsFrom(bank([quiz({ questions: [q] })])).join(' ');

    expect(joined).toMatch(/signals\[q0\]\.options\[1\]/);
    expect(joined).not.toContain('THE-SECRET-ANSWER');
    expect(joined).not.toContain('SECRET-EXPLANATION');
    expect(joined).not.toMatch(/isCorrect|answerKey/);
  });

  it('reports EVERY problem, not just the first', () => {
    const q = quiz({
      questions: [question({ questionText: '' }), question({ explanation: '' })]
    });
    expect(problemsFrom(bank([q])).length).toBeGreaterThan(1);
  });

  it('does not silently repair — it throws', () => {
    expect(() => validateAndNormalize(bank([quiz({ questions: [question({ options: [] })] })])))
      .toThrow(QuizDataError);
  });
});
