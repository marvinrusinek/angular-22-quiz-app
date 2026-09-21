import { buildReport, formatLocator, renderReport, type Finding } from '../src/quiz/quality/findings';
import {
  SnapshotMismatchError,
  validateFacts,
  validateOptionOrder,
  validateQuizOrder,
  validateQuizQuestionRows,
  validateRawBank,
  type RawBankSnapshot,
  type RawQuestionRow
} from '../src/quiz/quality/raw-rules';
import type { PrivateQuiz } from '../src/quiz/quiz.types';
import { validateAndNormalize } from '../src/quiz/quiz.validation';

/**
 * Raw-row rules as pure functions over synthetic rows. No database.
 * Rows contain no question text, option text or correctness — by type.
 */

type OptionSource = { text: string; correct?: true };
const opt = (text: string, correct = false): OptionSource => (correct ? { text, correct: true } : { text });

const singleQ = (text: string) => ({ questionText: text, explanation: 'e', options: [opt('a', true), opt('b'), opt('c')] });
const multipleQ = (text: string) => ({ questionText: text, explanation: 'e', options: [opt('a', true), opt('b', true), opt('c')] });
const trueFalseQ = (text: string) => ({ questionText: text, explanation: 'e', options: [opt('True', true), opt('False')] });

/** A validated quiz: q0 single, q1 multiple, q2 trueFalse. */
function demoQuiz(quizId = 'demo'): PrivateQuiz {
  const source = {
    quizzes: [{
      quizId, milestone: 'M', summary: '', image: '', difficulty: 'beginner', facts: [],
      questions: [singleQ('Q0?'), multipleQ('Q1?'), trueFalseQ('Q2?')]
    }]
  };
  return validateAndNormalize(source).quizzes[0]!;
}

const row = (over: Partial<RawQuestionRow> = {}): RawQuestionRow => ({
  quizId: 'demo', displayOrder: 0, storedType: 'single', hasCode: false, codeFilename: null, ...over
});

/** Three clean question rows matching demoQuiz(): stored types agree with the derived ones. */
const cleanRows = (): RawQuestionRow[] => [
  row({ displayOrder: 0, storedType: 'single' }),
  row({ displayOrder: 1, storedType: 'multiple' }),
  row({ displayOrder: 2, storedType: 'trueFalse' })
];

const at = (findings: readonly Finding[]): string[] => findings.map((f) => `${f.code} ${formatLocator(f.locator)}`);

describe('stored type drift', () => {
  it('a clean quiz has none', () => {
    expect(validateQuizQuestionRows(demoQuiz(), cleanRows())).toEqual([]);
  });

  it('reports a WARNING where the stored type differs from the DERIVED type', () => {
    const rows = cleanRows();
    rows[1] = row({ displayOrder: 1, storedType: 'single' });   // the application derives "multiple"

    const findings = validateQuizQuestionRows(demoQuiz(), rows);

    expect(at(findings)).toEqual(['TYPE_DRIFT demo[q1].question_type']);
    expect(findings[0]!.severity).toBe('WARNING');
    expect(findings[0]!.message).toBe(
      'stored question_type "single" differs from the derived type "multiple"; the application uses the derived type'
    );
  });

  it('compares against what the application DERIVES, not against what the column claims', () => {
    // The stored column says trueFalse for a question the application derives as "single".
    const rows = cleanRows();
    rows[0] = row({ displayOrder: 0, storedType: 'trueFalse' });

    expect(at(validateQuizQuestionRows(demoQuiz(), rows))).toEqual(['TYPE_DRIFT demo[q0].question_type']);
  });

  it('reports every drifting question, in question order', () => {
    const rows = [row({ displayOrder: 0, storedType: 'multiple' }), row({ displayOrder: 1, storedType: 'single' }), row({ displayOrder: 2, storedType: 'single' })];

    expect(at(validateQuizQuestionRows(demoQuiz(), rows))).toEqual([
      'TYPE_DRIFT demo[q0].question_type',
      'TYPE_DRIFT demo[q1].question_type',
      'TYPE_DRIFT demo[q2].question_type'
    ]);
  });
});

describe('facts_json', () => {
  it.each([
    ['an empty array', '[]'],
    ['non-blank strings', '["one","two"]'],
    ['strings with surrounding whitespace (the application trims them)', '["  padded  "]'],
    ['NULL (the column is NOT NULL; the application treats it as none)', null]
  ])('accepts %s', (_label, factsJson) => {
    expect(validateFacts('demo', factsJson)).toEqual([]);
  });

  it.each([
    ['truncated JSON', '["one",'],
    ['plain prose', 'not json at all'],
    ['an empty string', '']
  ])('%s → FACTS_INVALID_JSON (WARNING)', (_label, factsJson) => {
    const findings = validateFacts('demo', factsJson);

    expect(at(findings)).toEqual(['FACTS_INVALID_JSON demo.facts_json']);
    expect(findings[0]!.severity).toBe('WARNING');
  });

  it.each([
    ['an object', '{"a":1}'],
    ['a bare string', '"hello"'],
    ['a number', '3'],
    ['null', 'null']
  ])('valid JSON that is %s → FACTS_NOT_ARRAY', (_label, factsJson) => {
    expect(at(validateFacts('demo', factsJson))).toEqual(['FACTS_NOT_ARRAY demo.facts_json']);
  });

  it('reports blank and non-string entries by POSITION, without quoting them', () => {
    const findings = validateFacts('demo', '["ok", "", 7, "fine", "   ", null, {"a":1}]');

    expect(at(findings)).toEqual(['FACTS_BAD_ENTRY demo.facts_json']);
    expect(findings[0]!.message).toContain('5 entries');
    expect(findings[0]!.message).toContain('positions 1, 2, 4, 5, 6');
  });

  it('uses the singular for one bad entry', () => {
    expect(validateFacts('demo', '["ok", 3]')[0]!.message).toContain('1 entry that is not a non-blank string (at position 1)');
  });

  it('never repairs: the validator reports the drift and leaves the application to keep dropping entries', () => {
    // Same input, same finding — validating twice cannot "fix" anything.
    expect(validateFacts('demo', '["a", ""]')).toEqual(validateFacts('demo', '["a", ""]'));
  });
});

describe('quiz display_order', () => {
  const quiz = (quizId: string, displayOrder: number) => ({ quizId, displayOrder, factsJson: '[]' });

  it('distinct orders have none', () => {
    expect(validateQuizOrder([quiz('a', 0), quiz('b', 1), quiz('c', 2)])).toEqual([]);
  });

  it('reports a WARNING on EVERY quiz that shares an order', () => {
    const findings = validateQuizOrder([quiz('a', 0), quiz('b', 1), quiz('c', 1), quiz('d', 2)]);

    expect(at(findings)).toEqual(['QUIZ_DISPLAY_ORDER_DUPLICATE b.display_order', 'QUIZ_DISPLAY_ORDER_DUPLICATE c.display_order']);
    expect(findings.every((f) => f.severity === 'WARNING')).toBe(true);
    expect(findings[0]!.message).toContain('display_order 1 is shared with 1 other');
  });

  it('counts a three-way tie correctly', () => {
    const findings = validateQuizOrder([quiz('a', 5), quiz('b', 5), quiz('c', 5)]);

    expect(findings).toHaveLength(3);
    expect(findings[0]!.message).toContain('shared with 2 other');
  });
});

describe('orphan snippet filename', () => {
  it('a filename with a snippet is fine', () => {
    const rows = cleanRows();
    rows[0] = row({ displayOrder: 0, storedType: 'single', hasCode: true, codeFilename: 'a.ts' });

    expect(validateQuizQuestionRows(demoQuiz(), rows)).toEqual([]);
  });

  it('a snippet with no filename is fine', () => {
    const rows = cleanRows();
    rows[0] = row({ displayOrder: 0, storedType: 'single', hasCode: true, codeFilename: null });

    expect(validateQuizQuestionRows(demoQuiz(), rows)).toEqual([]);
  });

  it('code_filename with code NULL → SNIPPET_ORPHAN_FILENAME (WARNING)', () => {
    const rows = cleanRows();
    rows[2] = row({ displayOrder: 2, storedType: 'trueFalse', hasCode: false, codeFilename: 'orphan.ts' });

    const findings = validateQuizQuestionRows(demoQuiz(), rows);

    expect(at(findings)).toEqual(['SNIPPET_ORPHAN_FILENAME demo[q2].code_filename']);
    expect(findings[0]!.severity).toBe('WARNING');
    expect(findings[0]!.message).not.toContain('orphan.ts');   // the value is never quoted
  });
});

describe('display-order gaps — harmless today, reported as WARNING only', () => {
  it('contiguous 0..n-1 has none', () => {
    expect(validateQuizQuestionRows(demoQuiz(), cleanRows())).toEqual([]);
  });

  it('question gap → ONE warning per quiz, at the first difference', () => {
    const rows = [row({ displayOrder: 0, storedType: 'single' }), row({ displayOrder: 2, storedType: 'multiple' }), row({ displayOrder: 5, storedType: 'trueFalse' })];

    const findings = validateQuizQuestionRows(demoQuiz(), rows);

    expect(at(findings)).toEqual(['QUESTION_DISPLAY_ORDER_GAP demo[q1].display_order']);
    expect(findings[0]!.severity).toBe('WARNING');
  });

  it('a quiz whose order starts above zero is also reported', () => {
    const rows = [row({ displayOrder: 1, storedType: 'single' }), row({ displayOrder: 2, storedType: 'multiple' }), row({ displayOrder: 3, storedType: 'trueFalse' })];

    expect(at(validateQuizQuestionRows(demoQuiz(), rows))).toEqual(['QUESTION_DISPLAY_ORDER_GAP demo[q0].display_order']);
  });

  it('a gap is NOT an error and does not stop the type comparison', () => {
    const rows = [row({ displayOrder: 0, storedType: 'multiple' }), row({ displayOrder: 4, storedType: 'multiple' }), row({ displayOrder: 9, storedType: 'trueFalse' })];

    const findings = validateQuizQuestionRows(demoQuiz(), rows);

    expect(findings.map((f) => f.code).sort()).toEqual(['QUESTION_DISPLAY_ORDER_GAP', 'TYPE_DRIFT']);
    expect(findings.every((f) => f.severity === 'WARNING')).toBe(true);
  });

  it('option gap → one warning per affected question, at the first difference', () => {
    const options = [
      { quizId: 'demo', questionIndex: 0, displayOrder: 0 }, { quizId: 'demo', questionIndex: 0, displayOrder: 1 }, { quizId: 'demo', questionIndex: 0, displayOrder: 2 },
      { quizId: 'demo', questionIndex: 1, displayOrder: 0 }, { quizId: 'demo', questionIndex: 1, displayOrder: 3 }, { quizId: 'demo', questionIndex: 1, displayOrder: 4 },
      { quizId: 'demo', questionIndex: 2, displayOrder: 1 }, { quizId: 'demo', questionIndex: 2, displayOrder: 2 }
    ];

    expect(at(validateOptionOrder('demo', options))).toEqual([
      'OPTION_DISPLAY_ORDER_GAP demo[q1].options[1].display_order',
      'OPTION_DISPLAY_ORDER_GAP demo[q2].options[0].display_order'
    ]);
  });
});

describe('the whole raw layer', () => {
  const snapshot = (over: Partial<RawBankSnapshot> = {}): RawBankSnapshot => ({
    quizzes: [{ quizId: 'demo', displayOrder: 0, factsJson: '[]' }],
    questions: cleanRows(),
    options: [],
    retiredQuizCount: 0,
    ...over
  });

  it('a clean snapshot has no findings', () => {
    expect(validateRawBank(snapshot(), [demoQuiz()])).toEqual([]);
  });

  it('reports retired quizzes as one INFO note, with a count only', () => {
    const findings = validateRawBank(snapshot({ retiredQuizCount: 3 }), [demoQuiz()]);

    expect(at(findings)).toEqual(['RETIRED_QUIZZES_SKIPPED (bank)']);
    expect(findings[0]!.severity).toBe('INFO');
    expect(findings[0]!.message).toContain('3 retired quiz(zes)');
  });

  it('runs the facts and quiz-order rules even for a quiz that failed structural validation', () => {
    const findings = validateRawBank(
      snapshot({ quizzes: [{ quizId: 'broken', displayOrder: 0, factsJson: '{' }, { quizId: 'other', displayOrder: 0, factsJson: '[]' }], questions: [] }),
      []   // no structurally valid quizzes
    );

    expect(at(findings).sort()).toEqual([
      'FACTS_INVALID_JSON broken.facts_json',
      'QUIZ_DISPLAY_ORDER_DUPLICATE broken.display_order',
      'QUIZ_DISPLAY_ORDER_DUPLICATE other.display_order'
    ]);
  });

  it('throws — rather than reporting a finding — when the raw rows and the model disagree', () => {
    expect(() => validateQuizQuestionRows(demoQuiz(), cleanRows().slice(0, 2))).toThrow(SnapshotMismatchError);
  });

  it('is deterministic: identical input, identical rendered report', () => {
    const build = (): string => {
      const findings = validateRawBank(
        snapshot({
          quizzes: [{ quizId: 'demo', displayOrder: 0, factsJson: '["ok", ""]' }, { quizId: 'zed', displayOrder: 0, factsJson: 'oops' }],
          questions: [row({ displayOrder: 0, storedType: 'multiple' }), row({ displayOrder: 3, storedType: 'multiple', codeFilename: 'x.ts' }), row({ displayOrder: 4, storedType: 'trueFalse' })],
          retiredQuizCount: 1
        }),
        [demoQuiz()]
      );
      return renderReport(buildReport({ quizzes: 2, questions: 3, options: 0 }, findings));
    };

    expect(build()).toBe(build());
  });

  it('every finding is severity/code/locator/message only — nothing carries text or correctness', () => {
    const findings = validateRawBank(
      snapshot({
        quizzes: [{ quizId: 'demo', displayOrder: 0, factsJson: '["", 7]' }],
        questions: [row({ displayOrder: 0, storedType: 'multiple', codeFilename: 'secret-name.ts' }), row({ displayOrder: 1, storedType: 'multiple' }), row({ displayOrder: 2, storedType: 'trueFalse' })],
        retiredQuizCount: 2
      }),
      [demoQuiz()]
    );
    const everything = JSON.stringify(findings) + renderReport(buildReport({ quizzes: 1, questions: 3, options: 0 }, findings));

    for (const finding of findings) {
      expect(Object.keys(finding).sort()).toEqual(['code', 'locator', 'message', 'severity']);
    }
    expect(everything).not.toContain('secret-name.ts');
    expect(everything).not.toMatch(/is_correct|isCorrect|correctOption/i);
  });
});
