/**
 * The Question Quality Validator's result contract.
 *
 * PURE: no database, no filesystem, no process. Everything here is data plus
 * small functions over it, so the whole validator is testable without PostgreSQL.
 *
 * ── WHAT A FINDING MAY CONTAIN ─────────────────────────────────────
 *
 * The quiz bank IS the answer key. A finding therefore carries exactly four
 * things, none of which can hold answer-key data:
 *
 *   severity  ERROR | WARNING | INFO
 *   code      a stable rule id from RULES below
 *   locator   a quiz id plus POSITIONS (question index, option index) — never
 *             question text, option text, explanations or correctness
 *   message   a sentence written by a rule, describing the problem in general
 *             terms ("two options are indistinguishable"), never quoting content
 *
 * The locator convention is the one `validateAndNormalize` already uses for its
 * own problems (`<quizId>[q<index>].options[<index>]`, zero-based), so a
 * validator finding and a startup failure point at the same place in the same
 * words. Every rule constructs findings through `makeFinding`, which takes the
 * severity from RULES — a rule cannot quietly report itself at a different
 * severity than the registry declares.
 *
 * ── EXIT SEMANTICS ─────────────────────────────────────────────────
 *
 *   0  no ERROR findings (warnings and info never fail the run)
 *   1  one or more ERROR findings, OR the validator itself could not run
 *
 * The repository has no convention of distinct exit codes (the import script
 * and the server both use 1 for every failure), so this does not invent one.
 */

export type Severity = 'ERROR' | 'WARNING' | 'INFO';

/** Lower sorts first: errors, then warnings, then info. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = { ERROR: 0, WARNING: 1, INFO: 2 };

interface RuleDefinition {
  readonly severity: Severity;
  /** One line, for humans reading the registry. Never printed with content. */
  readonly summary: string;
}

const defineRules = <T extends Record<string, RuleDefinition>>(rules: T): T => rules;

/**
 * Every rule the validator can report. Adding a rule means adding it here first.
 */
export const RULES = defineRules({
  // ── ERROR ────────────────────────────────────────────────────────
  EMPTY_BANK: {
    severity: 'ERROR',
    summary: 'no active quizzes were found, so the application would refuse to start'
  },
  STRUCTURE: {
    severity: 'ERROR',
    summary: 'a structural rule enforced by validateAndNormalize (the same check the server runs at startup)'
  },
  AMBIGUOUS_QUESTION_MATCH: {
    severity: 'ERROR',
    summary: 'two questions in one quiz are indistinguishable under the runtime answer-matching normalization'
  },
  AMBIGUOUS_OPTION_MATCH: {
    severity: 'ERROR',
    summary: 'two options of one question are indistinguishable under the runtime answer-matching normalization'
  },

  // ── WARNING ──────────────────────────────────────────────────────
  TYPE_DRIFT: {
    severity: 'WARNING',
    summary: 'the stored questions.question_type differs from the type the application derives'
  },
  FACTS_INVALID_JSON: {
    severity: 'WARNING',
    summary: 'quizzes.facts_json is not valid JSON (the application silently treats it as empty)'
  },
  FACTS_NOT_ARRAY: {
    severity: 'WARNING',
    summary: 'quizzes.facts_json is valid JSON but not an array (the application silently treats it as empty)'
  },
  FACTS_BAD_ENTRY: {
    severity: 'WARNING',
    summary: 'quizzes.facts_json contains an entry that is not a non-blank string (the application drops it)'
  },
  QUIZ_DISPLAY_ORDER_DUPLICATE: {
    severity: 'WARNING',
    summary: 'two active quizzes share a display_order, so their relative order is not defined'
  },
  SNIPPET_ORPHAN_FILENAME: {
    severity: 'WARNING',
    summary: 'code_filename is set but code is NULL (the filename is silently ignored)'
  },
  QUESTION_DISPLAY_ORDER_GAP: {
    severity: 'WARNING',
    summary: 'question display_order values are not contiguous (harmless today: identity uses rank, not value)'
  },
  OPTION_DISPLAY_ORDER_GAP: {
    severity: 'WARNING',
    summary: 'option display_order values are not contiguous (harmless today: identity uses rank, not value)'
  },
  MULTIPLE_ALL_OF_THE_ABOVE: {
    severity: 'WARNING',
    summary: 'more than one option of a question is an "All of the above" option'
  },

  // ── INFO ─────────────────────────────────────────────────────────
  RETIRED_QUIZZES_SKIPPED: {
    severity: 'INFO',
    summary: 'retired quizzes are not served by the application and were not validated'
  },
  DOMAIN_RULES_PARTIAL: {
    severity: 'INFO',
    summary: 'domain quality rules were skipped for quizzes that have structural errors'
  }
});

export type RuleCode = keyof typeof RULES;

/**
 * Where a finding points. Identifiers and positions only — see the header.
 * `field` names a part of a question ("codeSnippet"); it is never a value.
 */
export interface Locator {
  readonly quizId: string | null;
  readonly questionIndex: number | null;
  readonly optionIndex: number | null;
  readonly field: string | null;
}

export const BANK_LOCATOR: Locator = Object.freeze({
  quizId: null,
  questionIndex: null,
  optionIndex: null,
  field: null
});

export function locate(
  quizId: string,
  questionIndex: number | null = null,
  optionIndex: number | null = null,
  field: string | null = null
): Locator {
  return { quizId, questionIndex, optionIndex, field };
}

/** `quizId`, `quizId[q3]`, `quizId[q3].options[1]`, `quizId[q3].codeSnippet`, or `(bank)`. */
export function formatLocator(locator: Locator): string {
  if (locator.quizId === null) return '(bank)';
  let out = locator.quizId;
  if (locator.questionIndex !== null) out += `[q${locator.questionIndex}]`;
  if (locator.optionIndex !== null) out += `.options[${locator.optionIndex}]`;
  if (locator.field !== null) out += `.${locator.field}`;
  return out;
}

/**
 * Reads the `at` string of a `validateAndNormalize` problem back into a Locator.
 *
 * Its shapes are: `<root>`, `quizzes[n]` (a quiz with no usable id), a bare quiz
 * id, `<quizId>[q<n>]`, `<quizId>[q<n>].options[<m>]` and `<quizId>[q<n>].codeSnippet`.
 * Anything unrecognised is kept as the quiz id so nothing is lost.
 */
export function parseProblemLocation(at: string): Locator {
  if (at === '<root>') return BANK_LOCATOR;

  const match = /^(.*)\[q(\d+)\](?:\.options\[(\d+)\]|\.(codeSnippet))?$/.exec(at);
  if (!match) return locate(at);

  return locate(
    match[1] ?? at,
    Number(match[2]),
    match[3] === undefined ? null : Number(match[3]),
    match[4] ?? null
  );
}

export interface Finding {
  readonly severity: Severity;
  readonly code: RuleCode;
  readonly locator: Locator;
  readonly message: string;
}

/** The only way rules create findings: severity comes from the registry. */
export function makeFinding(code: RuleCode, locator: Locator, message: string): Finding {
  return { severity: RULES[code].severity, code, locator, message };
}

/** Total, locale-independent, deterministic. */
function compareStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function compareNumbers(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    compareStrings(a.locator.quizId, b.locator.quizId) ||
    compareNumbers(a.locator.questionIndex, b.locator.questionIndex) ||
    compareNumbers(a.locator.optionIndex, b.locator.optionIndex) ||
    compareStrings(a.locator.field, b.locator.field) ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.message, b.message)
  );
}

/** Sorted, with exact duplicates removed, so output never depends on discovery order. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const sorted = [...findings].sort(compareFindings);
  return sorted.filter((finding, index) => index === 0 || compareFindings(sorted[index - 1]!, finding) !== 0);
}

/** Row counts of what was validated (active quizzes only). */
export interface BankCounts {
  readonly quizzes: number;
  readonly questions: number;
  readonly options: number;
}

export interface QualityReport {
  readonly counts: BankCounts;
  readonly findings: readonly Finding[];
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
}

export function buildReport(counts: BankCounts, findings: readonly Finding[]): QualityReport {
  const sorted = sortFindings(findings);
  const count = (severity: Severity): number => sorted.filter((f) => f.severity === severity).length;
  return {
    counts,
    findings: sorted,
    errorCount: count('ERROR'),
    warningCount: count('WARNING'),
    infoCount: count('INFO')
  };
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/** Warnings and info never fail the run; a single ERROR does. */
export function exitCodeFor(report: QualityReport): 0 | 1 {
  return report.errorCount > 0 ? EXIT_FAILED : EXIT_OK;
}

/** Wide enough for the longest label ("Questions:") plus one space. */
const pad = (label: string): string => label.padEnd(11);

/** The console report. Built only from counts, codes, locators and rule-written messages. */
export function renderReport(report: QualityReport): string {
  const lines: string[] = [
    'Quiz Bank Quality Report',
    '',
    `${pad('Quizzes:')}${report.counts.quizzes}`,
    `${pad('Questions:')}${report.counts.questions}`,
    `${pad('Options:')}${report.counts.options}`,
    '',
    `${pad('Errors:')}${report.errorCount}`,
    `${pad('Warnings:')}${report.warningCount}`,
    `${pad('Info:')}${report.infoCount}`
  ];

  for (const finding of report.findings) {
    lines.push('', `${finding.severity} ${finding.code} [${formatLocator(finding.locator)}]`, `  ${finding.message}`);
  }

  lines.push(
    '',
    report.errorCount > 0
      ? `Validation failed: ${report.errorCount} error(s).`
      : report.warningCount > 0
        ? 'Validation completed with warnings.'
        : 'Validation passed.'
  );
  return lines.join('\n');
}
