import {
  BANK_LOCATOR,
  EXIT_FAILED,
  EXIT_OK,
  RULES,
  buildReport,
  compareFindings,
  exitCodeFor,
  formatLocator,
  locate,
  makeFinding,
  parseProblemLocation,
  renderReport,
  sortFindings,
  type Finding,
  type RuleCode
} from '../src/quiz/quality/findings';
import { QuizDataError, validateAndNormalize } from '../src/quiz/quiz.validation';

/**
 * The validator's result contract: what a finding may hold, how findings sort,
 * what the report prints, and what the exit code means. Pure — no database.
 */

const COUNTS = { quizzes: 20, questions: 185, options: 710 };

const errorFinding = (quizId = 'rxjs', q = 1): Finding =>
  makeFinding('AMBIGUOUS_QUESTION_MATCH', locate(quizId, q), 'two questions are indistinguishable');
const warningFinding = (quizId = 'rxjs', q = 1): Finding =>
  makeFinding('TYPE_DRIFT', locate(quizId, q), 'stored type differs from derived type');
const infoFinding = (): Finding =>
  makeFinding('RETIRED_QUIZZES_SKIPPED', BANK_LOCATOR, '1 retired quiz was not validated');

describe('the rule registry', () => {
  it('declares every rule at exactly one severity', () => {
    for (const [code, rule] of Object.entries(RULES)) {
      expect(['ERROR', 'WARNING', 'INFO']).toContain(rule.severity);
      expect(rule.summary.length).toBeGreaterThan(10);
      expect(code).toMatch(/^[A-Z][A-Z_]+$/);
    }
  });

  it('makeFinding takes the severity FROM THE REGISTRY, so a rule cannot report itself at another level', () => {
    for (const code of Object.keys(RULES) as RuleCode[]) {
      expect(makeFinding(code, BANK_LOCATOR, 'x').severity).toBe(RULES[code].severity);
    }
  });

  it('the structural and ambiguity rules are ERRORs; drift and facts are WARNINGs; the retired-quiz note is INFO', () => {
    expect(RULES.STRUCTURE.severity).toBe('ERROR');
    expect(RULES.AMBIGUOUS_QUESTION_MATCH.severity).toBe('ERROR');
    expect(RULES.AMBIGUOUS_OPTION_MATCH.severity).toBe('ERROR');
    expect(RULES.TYPE_DRIFT.severity).toBe('WARNING');
    expect(RULES.FACTS_INVALID_JSON.severity).toBe('WARNING');
    expect(RULES.RETIRED_QUIZZES_SKIPPED.severity).toBe('INFO');
  });
});

describe('a finding cannot carry answer-key data', () => {
  it('has exactly severity, code, locator and message', () => {
    expect(Object.keys(errorFinding()).sort()).toEqual(['code', 'locator', 'message', 'severity']);
  });

  it('its locator has exactly a quiz id, two positions and a field NAME — no text or correctness slot', () => {
    expect(Object.keys(locate('rxjs', 2, 1, 'codeSnippet')).sort())
      .toEqual(['field', 'optionIndex', 'questionIndex', 'quizId']);
  });
});

describe('locators', () => {
  it.each([
    [BANK_LOCATOR, '(bank)'],
    [locate('rxjs'), 'rxjs'],
    [locate('rxjs', 3), 'rxjs[q3]'],
    [locate('rxjs', 3, 1), 'rxjs[q3].options[1]'],
    [locate('rxjs', 3, null, 'codeSnippet'), 'rxjs[q3].codeSnippet']
  ])('formats %j as %s', (locator, expected) => {
    expect(formatLocator(locator)).toBe(expected);
  });

  it.each([
    ['<root>', BANK_LOCATOR],
    ['rxjs', locate('rxjs')],
    ['quizzes[3]', locate('quizzes[3]')],
    ['rxjs[q0]', locate('rxjs', 0)],
    ['rxjs[q12].options[3]', locate('rxjs', 12, 3)],
    ['rxjs[q4].codeSnippet', locate('rxjs', 4, null, 'codeSnippet')]
  ])('reads validateAndNormalize location "%s" back into a locator', (at, expected) => {
    expect(parseProblemLocation(at)).toEqual(expected);
  });

  it('round-trips the locations validateAndNormalize REALLY produces', () => {
    const bad = {
      quizzes: [{
        quizId: 'demo',
        milestone: 'Demo',
        questions: [
          { questionText: 'Q?', explanation: 'e', options: [{ text: 'a' }] },
          { questionText: 'Q2?', explanation: 'e', options: [{ text: 'a', correct: true }, { text: '' }, { text: 'c' }] }
        ]
      }]
    };
    let problems: readonly { at: string }[] = [];
    try {
      validateAndNormalize(bad);
    } catch (err: unknown) {
      problems = (err as QuizDataError).problems;
    }

    expect(problems.length).toBeGreaterThan(0);
    for (const { at } of problems) {
      expect(formatLocator(parseProblemLocation(at))).toBe(at);
    }
  });
});

describe('deterministic ordering', () => {
  const mixed: Finding[] = [
    infoFinding(),
    warningFinding('rxjs', 2),
    errorFinding('router', 5),
    warningFinding('forms', 0),
    errorFinding('rxjs', 1),
    makeFinding('FACTS_INVALID_JSON', locate('forms'), 'facts_json is not valid JSON'),
    makeFinding('AMBIGUOUS_OPTION_MATCH', locate('rxjs', 1, 3), 'two options are indistinguishable'),
    makeFinding('AMBIGUOUS_OPTION_MATCH', locate('rxjs', 1, 2), 'two options are indistinguishable')
  ];

  it('sorts errors, then warnings, then info', () => {
    expect(sortFindings(mixed).map((f) => f.severity)).toEqual(
      ['ERROR', 'ERROR', 'ERROR', 'ERROR', 'WARNING', 'WARNING', 'WARNING', 'INFO']
    );
  });

  it('within a severity, sorts by quiz, then question, then option, then code', () => {
    const errors = sortFindings(mixed).filter((f) => f.severity === 'ERROR').map((f) => formatLocator(f.locator));

    expect(errors).toEqual(['router[q5]', 'rxjs[q1]', 'rxjs[q1].options[2]', 'rxjs[q1].options[3]']);
  });

  it('the same findings in ANY input order produce the identical sorted list and report', () => {
    const forward = renderReport(buildReport(COUNTS, mixed));
    const reversed = renderReport(buildReport(COUNTS, [...mixed].reverse()));
    const shuffled = renderReport(buildReport(COUNTS, [mixed[3]!, mixed[0]!, mixed[6]!, mixed[1]!, mixed[7]!, mixed[2]!, mixed[5]!, mixed[4]!]));

    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it('removes exact duplicates but keeps findings that differ in any field', () => {
    const list = sortFindings([warningFinding('rxjs', 1), warningFinding('rxjs', 1), warningFinding('rxjs', 2)]);

    expect(list).toHaveLength(2);
  });

  it('is a total order: a finding compares equal only to an identical one', () => {
    expect(compareFindings(errorFinding(), errorFinding())).toBe(0);
    expect(compareFindings(errorFinding('a'), errorFinding('b'))).toBeLessThan(0);
    expect(compareFindings(errorFinding('b'), errorFinding('a'))).toBeGreaterThan(0);
  });
});

describe('the report and its exit code', () => {
  it('counts each severity', () => {
    const report = buildReport(COUNTS, [errorFinding(), warningFinding(), warningFinding('x'), infoFinding()]);

    expect([report.errorCount, report.warningCount, report.infoCount]).toEqual([1, 2, 1]);
  });

  it('exits 0 with no findings at all', () => {
    expect(exitCodeFor(buildReport(COUNTS, []))).toBe(EXIT_OK);
  });

  it('exits 0 with WARNINGS only — warnings never fail validation', () => {
    expect(exitCodeFor(buildReport(COUNTS, [warningFinding(), warningFinding('other')]))).toBe(EXIT_OK);
  });

  it('exits 0 with INFO only', () => {
    expect(exitCodeFor(buildReport(COUNTS, [infoFinding()]))).toBe(EXIT_OK);
  });

  it('exits non-zero with a single ERROR, even among many warnings', () => {
    expect(exitCodeFor(buildReport(COUNTS, [warningFinding(), errorFinding(), warningFinding('x')]))).toBe(EXIT_FAILED);
    expect(EXIT_FAILED).not.toBe(EXIT_OK);
  });
});

describe('the rendered report', () => {
  it('prints the counts and the summary block', () => {
    const text = renderReport(buildReport(COUNTS, []));

    expect(text).toContain('Quiz Bank Quality Report');
    expect(text).toMatch(/Quizzes:\s+20/);
    expect(text).toMatch(/Questions:\s+185/);
    expect(text).toMatch(/Options:\s+710/);
    expect(text).toMatch(/Errors:\s+0/);
    expect(text).toMatch(/Warnings:\s+0/);
    expect(text).toMatch(/Info:\s+0/);
  });

  it('ends with a verdict that matches the exit code', () => {
    expect(renderReport(buildReport(COUNTS, []))).toMatch(/Validation passed\.$/);
    expect(renderReport(buildReport(COUNTS, [warningFinding()]))).toMatch(/Validation completed with warnings\.$/);
    expect(renderReport(buildReport(COUNTS, [errorFinding()]))).toMatch(/Validation failed: 1 error\(s\)\.$/);
  });

  it('prints each finding as severity, code, locator and message', () => {
    const text = renderReport(buildReport(COUNTS, [warningFinding('rxjs', 4)]));

    expect(text).toContain('WARNING TYPE_DRIFT [rxjs[q4]]');
    expect(text).toContain('stored type differs from derived type');
  });

  it('is built only from counts, codes, locators and rule-written messages', () => {
    const text = renderReport(buildReport(COUNTS, [errorFinding(), warningFinding(), infoFinding()]));

    // No correctness vocabulary can appear, because no rule message or locator field can hold it.
    expect(text).not.toMatch(/is_correct|isCorrect|correctOption|answer key/i);
  });
});
