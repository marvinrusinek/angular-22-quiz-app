import { AnswerCheckError, canonicalize, checkAnswer } from '../src/quiz/answer-check';
import {
  validateQuestion,
  validateQuiz,
  validateQuizBankDomain
} from '../src/quiz/quality/domain-rules';
import {
  buildReport,
  formatLocator,
  renderReport,
  type Finding
} from '../src/quiz/quality/findings';
import type { QuizBankSource } from '../src/quiz/quiz.types';
import { QuizDataError, validateAndNormalize } from '../src/quiz/quiz.validation';

/**
 * Pure domain-layer tests: no database. Sources use the loader's output shape
 * (`{ text, correct: true }` only on correct options, key omitted otherwise).
 */

type OptionSource = { text: string; correct?: true };
const opt = (text: string, correct = false): OptionSource => (correct ? { text, correct: true } : { text });

const question = (questionText: string, options: OptionSource[], extra: Record<string, unknown> = {}) => ({
  questionText,
  explanation: 'Because.',
  options,
  ...extra
});

const quiz = (quizId: string, questions: unknown[]) => ({
  quizId,
  milestone: `Title ${quizId}`,
  summary: '',
  image: '',
  difficulty: 'beginner',
  facts: [],
  questions
});

const bank = (...quizzes: unknown[]): QuizBankSource => ({ quizzes });

const single = () => question('Which one is right?', [opt('alpha', true), opt('beta'), opt('gamma')]);
const multiple = () => question('Pick both good ones.', [opt('one', true), opt('two', true), opt('three'), opt('four')]);
const trueFalse = () => question('Is the sky blue?', [opt('True', true), opt('False')]);

const NFC = 'café';
const NFD = 'café';

const codes = (findings: readonly Finding[]): string[] => findings.map((f) => f.code);
const at = (findings: readonly Finding[]): string[] => findings.map((f) => formatLocator(f.locator));

describe('a valid bank', () => {
  it('produces no findings for single, multiple and trueFalse questions together', () => {
    const result = validateQuizBankDomain(bank(quiz('demo', [single(), multiple(), trueFalse()])));

    expect(result.findings).toEqual([]);
    expect(result.quizzes).toHaveLength(1);
    expect(result.quizzes[0]!.questions.map((q) => q.type)).toEqual(['single', 'multiple', 'trueFalse']);
  });

  it.each([
    ['single', single()],
    ['multiple', multiple()],
    ['trueFalse', trueFalse()]
  ])('a valid %s question has no findings on its own', (_type, source) => {
    const [only] = validateAndNormalize(bank(quiz('demo', [source]))).quizzes;

    expect(validateQuestion('demo', only!.questions[0]!)).toEqual([]);
    expect(validateQuiz(only!)).toEqual([]);
  });

  it('a question with a well-formed snippet is still clean', () => {
    const withSnippet = question('What does this log?', [opt('1', true), opt('2')], {
      codeSnippet: { language: 'typescript', code: 'console.log(1);', filename: 'a.ts' }
    });

    expect(validateQuizBankDomain(bank(quiz('demo', [withSnippet]))).findings).toEqual([]);
  });
});

describe('structural validation is the application\'s own — reused, never re-implemented', () => {
  const cases: [string, unknown, string][] = [
    ['no correct option', quiz('demo', [question('Q?', [opt('a'), opt('b')])]), 'demo[q0]'],
    ['every option correct', quiz('demo', [question('Q?', [opt('a', true), opt('b', true)])]), 'demo[q0]'],
    ['fewer than two options', quiz('demo', [question('Q?', [opt('a', true)])]), 'demo[q0]'],
    ['blank question text', quiz('demo', [question('   ', [opt('a', true), opt('b')])]), 'demo[q0]'],
    ['blank explanation', quiz('demo', [{ questionText: 'Q?', explanation: '  ', options: [opt('a', true), opt('b')] }]), 'demo[q0]'],
    ['blank option text', quiz('demo', [question('Q?', [opt('a', true), opt('  ')])]), 'demo[q0].options[1]'],
    ['duplicate normalized question text', quiz('demo', [single(), question('  WHICH one is   RIGHT? ', [opt('x', true), opt('y')])]), 'demo[q1]'],
    ['a quiz with no questions', quiz('demo', []), 'demo'],
    ['an unsupported snippet language', quiz('demo', [question('Q?', [opt('a', true), opt('b')], { codeSnippet: { language: 'cobol', code: 'x' } })]), 'demo[q0].codeSnippet'],
    ['an oversized snippet', quiz('demo', [question('Q?', [opt('a', true), opt('b')], { codeSnippet: { language: 'json', code: 'x'.repeat(2001) } })]), 'demo[q0].codeSnippet'],
    ['a snippet filename with a path separator', quiz('demo', [question('Q?', [opt('a', true), opt('b')], { codeSnippet: { language: 'json', code: '{}', filename: '../x.json' } })]), 'demo[q0].codeSnippet']
  ];

  it.each(cases)('%s → a STRUCTURE error at the same place validateAndNormalize reports', (_label, badQuiz, locator) => {
    const result = validateQuizBankDomain(bank(badQuiz));

    const structure = result.findings.filter((f) => f.code === 'STRUCTURE');
    expect(structure.length).toBeGreaterThan(0);
    expect(structure.every((f) => f.severity === 'ERROR')).toBe(true);
    expect(at(structure)).toContain(locator);
  });

  it.each(cases)('%s → the messages are EXACTLY the application\'s own, unmodified', (_label, badQuiz) => {
    let original: readonly string[] = [];
    try {
      validateAndNormalize(bank(badQuiz));
    } catch (err: unknown) {
      original = (err as QuizDataError).problems.map((p) => p.message);
    }

    const ours = validateQuizBankDomain(bank(badQuiz)).findings.filter((f) => f.code === 'STRUCTURE').map((f) => f.message);
    expect(ours).toEqual(original);
    expect(ours.length).toBeGreaterThan(0);
  });

  it('reports EVERY structural problem, as the application does', () => {
    const many = quiz('demo', [
      question('Q1?', [opt('a'), opt('b')]),
      question('Q2?', [opt('a', true), opt('b', true)]),
      question('Q3?', [opt('a', true)])
    ]);

    expect(validateQuizBankDomain(bank(many)).findings.filter((f) => f.code === 'STRUCTURE')).toHaveLength(3);
  });

  it('a structurally broken quiz does not hide a finding in a healthy one', () => {
    const broken = quiz('broken', [question('Q?', [opt('a'), opt('b')])]);
    const healthy = quiz('healthy', [question(NFC, [opt('x', true), opt('y')]), question(NFD, [opt('p', true), opt('q')])]);

    const result = validateQuizBankDomain(bank(broken, healthy));

    expect(codes(result.findings)).toEqual(expect.arrayContaining(['STRUCTURE', 'AMBIGUOUS_QUESTION_MATCH', 'DOMAIN_RULES_PARTIAL']));
    expect(at(result.findings.filter((f) => f.code === 'AMBIGUOUS_QUESTION_MATCH'))).toEqual(['healthy[q1]']);
    expect(result.quizzes.map((q) => q.quizId)).toEqual(['healthy']);
  });

  it('reports the partial run once, as INFO, with a count and no content', () => {
    const result = validateQuizBankDomain(bank(quiz('a', []), quiz('b', []), quiz('ok', [single()])));
    const partial = result.findings.filter((f) => f.code === 'DOMAIN_RULES_PARTIAL');

    expect(partial).toHaveLength(1);
    expect(partial[0]!.severity).toBe('INFO');
    expect(partial[0]!.message).toContain('2 quiz(zes)');
  });

  it('a bank of no quizzes at all is a STRUCTURE error at the bank level', () => {
    const result = validateQuizBankDomain({ quizzes: [] });

    expect(at(result.findings)).toEqual(['(bank)']);
    expect(result.findings[0]!.code).toBe('STRUCTURE');
  });
});

describe('the NFC collision the audit identified', () => {
  const nfcOptions = quiz('demo', [question('Which spelling is right?', [opt(NFC, true), opt(NFD), opt('other')])]);
  const nfcQuestions = quiz('demo', [
    question(`${NFC}?`, [opt('a', true), opt('b')]),
    question(`${NFD}?`, [opt('c', true), opt('d')])
  ]);

  it('the two spellings are different to the database key and to startup validation, but identical to runtime matching', () => {
    // What quizzes' generated key computes, and what validateAndNormalize's duplicate check computes.
    const databaseStyleKey = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

    expect(NFC).not.toBe(NFD);
    expect(databaseStyleKey(NFC)).not.toBe(databaseStyleKey(NFD));
    expect(canonicalize(NFC)).toBe(canonicalize(NFD));
  });

  it('the application\'s own startup validation ACCEPTS both banks — that is the gap', () => {
    expect(() => validateAndNormalize(bank(nfcOptions))).not.toThrow();
    expect(() => validateAndNormalize(bank(nfcQuestions))).not.toThrow();
  });

  it('OPTIONS: reports AMBIGUOUS_OPTION_MATCH as an ERROR at the later option', () => {
    const result = validateQuizBankDomain(bank(nfcOptions));

    expect(codes(result.findings)).toEqual(['AMBIGUOUS_OPTION_MATCH']);
    expect(result.findings[0]!.severity).toBe('ERROR');
    expect(formatLocator(result.findings[0]!.locator)).toBe('demo[q0].options[1]');
    expect(result.findings[0]!.message).toContain('option 1 is indistinguishable from option 0');
  });

  it('OPTIONS: the collision is a REAL runtime defect — choosing the CORRECT option is scored wrong', () => {
    const [parsed] = validateAndNormalize(bank(nfcOptions)).quizzes;

    const outcome = checkAnswer({
      quiz: parsed!,
      questionText: 'Which spelling is right?',
      selectedOptionTexts: [NFC],   // the option that IS correct
      expired: false
    });

    expect(outcome).toMatchObject({ status: 'resolved', correct: false });
  });

  it('QUESTIONS: reports AMBIGUOUS_QUESTION_MATCH as an ERROR at the later question', () => {
    const result = validateQuizBankDomain(bank(nfcQuestions));

    expect(codes(result.findings)).toEqual(['AMBIGUOUS_QUESTION_MATCH']);
    expect(result.findings[0]!.severity).toBe('ERROR');
    expect(formatLocator(result.findings[0]!.locator)).toBe('demo[q1]');
  });

  it('QUESTIONS: the collision is a REAL runtime defect — the second question can never be answered', () => {
    const [parsed] = validateAndNormalize(bank(nfcQuestions)).quizzes;

    // Addressing the second question resolves to the first, whose options do not contain "c".
    expect(() =>
      checkAnswer({ quiz: parsed!, questionText: `${NFD}?`, selectedOptionTexts: ['c'], expired: false })
    ).toThrow(AnswerCheckError);
  });

  it('a plain DUPLICATE option (identical text) is caught by the same rule', () => {
    const duplicated = quiz('demo', [question('Q?', [opt('same', true), opt('same'), opt('other')])]);

    expect(codes(validateQuizBankDomain(bank(duplicated)).findings)).toEqual(['AMBIGUOUS_OPTION_MATCH']);
  });

  it('case and whitespace differences alone are also caught for options (canonicalize collapses them)', () => {
    const cased = quiz('demo', [question('Q?', [opt('Alpha', true), opt('  ALPHA '), opt('beta')])]);

    expect(codes(validateQuizBankDomain(bank(cased)).findings)).toEqual(['AMBIGUOUS_OPTION_MATCH']);
  });

  it('genuinely different texts are NOT flagged', () => {
    const distinct = quiz('demo', [question('Q?', [opt('cafe', true), opt(NFC), opt('café au lait')])]);

    expect(validateQuizBankDomain(bank(distinct)).findings).toEqual([]);
  });

  it('the same text in DIFFERENT questions or quizzes is fine — matching is scoped', () => {
    const scoped = bank(
      quiz('one', [question('Q1?', [opt('same', true), opt('x')]), question('Q2?', [opt('same', true), opt('y')])]),
      quiz('two', [question('Q1?', [opt('same', true), opt('z')])])
    );

    expect(validateQuizBankDomain(scoped).findings).toEqual([]);
  });
});

describe('"All of the above"', () => {
  it('one such option is fine, whatever its position or casing', () => {
    const one = quiz('demo', [
      question('First?', [opt('All of the above.', true), opt('a'), opt('b')]),
      question('Second?', [opt('a', true), opt('b'), opt('ALL OF THE ABOVE')])
    ]);

    expect(validateQuizBankDomain(bank(one)).findings).toEqual([]);
  });

  it('more than one is a WARNING, using the repository\'s own matcher (HTML, case, trailing punctuation)', () => {
    const two = quiz('demo', [question('Q?', [opt('a', true), opt('All of the above.'), opt('<b>all of the ABOVE</b>')])]);

    const result = validateQuizBankDomain(bank(two));

    expect(codes(result.findings)).toEqual(['MULTIPLE_ALL_OF_THE_ABOVE']);
    expect(result.findings[0]!.severity).toBe('WARNING');
    expect(formatLocator(result.findings[0]!.locator)).toBe('demo[q0]');
    expect(result.findings[0]!.message).toContain('2 options');
  });

  it('its position is deliberately NOT reported — the Interview builder and the client both pin it last', () => {
    const first = quiz('demo', [question('Q?', [opt('All of the above'), opt('a', true), opt('b')])]);

    expect(validateQuizBankDomain(bank(first)).findings).toEqual([]);
  });
});

describe('deterministic findings', () => {
  const messy = bank(
    quiz('zeta', [question(NFC, [opt('a', true), opt('b')]), question(NFD, [opt('c', true), opt('d')])]),
    quiz('alpha', [question('Q?', [opt('x', true), opt('X'), opt('All of the above'), opt('all of the above')])]),
    quiz('mid', [question('Broken?', [opt('a'), opt('b')])])
  );

  it('the same bank always yields the same findings in the same order', () => {
    const a = renderReport(buildReport({ quizzes: 3, questions: 4, options: 12 }, validateQuizBankDomain(messy).findings));
    const b = renderReport(buildReport({ quizzes: 3, questions: 4, options: 12 }, validateQuizBankDomain(messy).findings));

    expect(a).toBe(b);
  });

  it('does not depend on the order the quizzes arrive in', () => {
    const reversed = bank(...[...(messy.quizzes as unknown[])].reverse());
    const render = (source: QuizBankSource): string =>
      renderReport(buildReport({ quizzes: 3, questions: 4, options: 12 }, validateQuizBankDomain(source).findings));

    expect(render(reversed)).toBe(render(messy));
  });
});

describe('no answer-key leakage', () => {
  // Markers that must never appear: they are the content of options, explanations and questions.
  const OPTION_MARK = 'ZZ_OPTION_MARKER_71';
  const CORRECT_MARK = 'ZZ_CORRECT_ANSWER_MARKER_42';
  const EXPLANATION_MARK = 'ZZ_EXPLANATION_MARKER_13';
  const QUESTION_MARK = 'ZZ_QUESTION_MARKER_99';

  const hostile = bank(
    // structural: no correct option, blank option, duplicate question
    quiz('struct', [
      { questionText: `${QUESTION_MARK} one`, explanation: EXPLANATION_MARK, options: [opt(`${OPTION_MARK}-a`), opt('  ')] },
      { questionText: `${QUESTION_MARK} one`, explanation: EXPLANATION_MARK, options: [opt(CORRECT_MARK, true), opt(`${OPTION_MARK}-b`)] }
    ]),
    // added rules: ambiguity and repeated "all of the above"
    quiz('ambig', [
      { questionText: `${QUESTION_MARK} two`, explanation: EXPLANATION_MARK,
        options: [opt(`${CORRECT_MARK}é`, true), opt(`${CORRECT_MARK}é`), opt('All of the above'), opt('all of the above.')] }
    ])
  );

  it('no finding, locator, message or rendered report contains any question, option, explanation or answer text', () => {
    const result = validateQuizBankDomain(hostile);
    const report = renderReport(buildReport({ quizzes: 2, questions: 3, options: 8 }, result.findings));
    const everything = JSON.stringify(result.findings) + report;

    expect(result.findings.length).toBeGreaterThan(3);
    for (const marker of [OPTION_MARK, CORRECT_MARK, EXPLANATION_MARK, QUESTION_MARK]) {
      expect(everything).not.toContain(marker);
    }
  });

  it('no correctness data appears: no flag values, no correct-option indexes, no answer-key field names', () => {
    const result = validateQuizBankDomain(hostile);
    const everything = JSON.stringify(result.findings) + renderReport(buildReport({ quizzes: 2, questions: 3, options: 8 }, result.findings));

    expect(everything).not.toMatch(/is_correct|isCorrect|correctOptionIds|correctOptionTexts|"correct":/i);
  });

  it('every finding is exactly {severity, code, locator, message} with a locator of identifiers and positions only', () => {
    for (const finding of validateQuizBankDomain(hostile).findings) {
      expect(Object.keys(finding).sort()).toEqual(['code', 'locator', 'message', 'severity']);
      expect(Object.keys(finding.locator).sort()).toEqual(['field', 'optionIndex', 'questionIndex', 'quizId']);
    }
  });
});
