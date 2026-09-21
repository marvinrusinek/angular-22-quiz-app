/**
 * Domain validation: the logical quiz bank, as the application sees it.
 *
 * ONE DEFINITION OF A VALID QUESTION
 *
 * Structural validity is not decided here. `validateAndNormalize` is the rule the
 * server enforces at startup and the importer enforces before writing, and this
 * module CALLS it — every structural problem it reports becomes an ERROR finding,
 * unchanged. Nothing it checks is re-implemented (zero or all-correct options,
 * fewer than two options, duplicate normalized question text, True/False shape,
 * snippet language/size/filename, …), so the validator can never disagree with
 * the application about what is invalid.
 *
 * What this module adds are rules the application does NOT enforce, and which
 * need the validated `PrivateQuestion` model to express:
 *
 *   AMBIGUOUS_QUESTION_MATCH / AMBIGUOUS_OPTION_MATCH  (ERROR)
 *   MULTIPLE_ALL_OF_THE_ABOVE                          (WARNING)
 *
 * THE NFC COLLISION (why the two AMBIGUOUS_* rules exist)
 *
 * Three different normalizations decide whether two texts are "the same":
 *
 *   PostgreSQL question_key / option_key   lower(collapse-whitespace(btrim(x)))
 *   validateAndNormalize (normalizeText)   trim, lower-case, collapse whitespace
 *   answer-check canonicalize              NFC, trim, collapse whitespace, lower-case
 *
 * Only the runtime one applies Unicode NFC. So `café` typed with a precomposed é
 * and `café` typed as e + combining accent are DIFFERENT to the database and to
 * startup validation — both rows insert and the server starts — but IDENTICAL to
 * `/check`, which then cannot tell them apart:
 *
 *   options    a Map keyed by canonical text keeps the LAST option, so choosing the
 *              correct one can be scored against the wrong one;
 *   questions  `find` keeps the FIRST question, so the second can never be
 *              addressed and its answers are scored against the first.
 *
 * Both are objectively wrong answers to a user, so both are ERRORs. This module
 * REPORTS the collision; it does not change any normalization.
 *
 * Every message describes the problem in general terms and never quotes content.
 */

import { isAllOfTheAbove } from '../../interview/all-of-the-above';
import { canonicalize } from '../answer-check';
import type { PrivateQuestion, PrivateQuiz, QuizBankSource } from '../quiz.types';
import { QuizDataError, validateAndNormalize, type ValidationProblem } from '../quiz.validation';
import {
  BANK_LOCATOR,
  locate,
  makeFinding,
  parseProblemLocation,
  type Finding
} from './findings';

/**
 * Groups indices by a key and returns, for every index that repeats an earlier
 * one, `[laterIndex, firstIndex]`. Order is by later index, so it is deterministic.
 */
function repeats(keys: readonly string[]): readonly (readonly [number, number])[] {
  const first = new Map<string, number>();
  const out: [number, number][] = [];
  for (const [index, key] of keys.entries()) {
    const seenAt = first.get(key);
    if (seenAt === undefined) first.set(key, index);
    else out.push([index, seenAt]);
  }
  return out;
}

/** Rules that need one question and nothing else. */
export function validateQuestion(quizId: string, question: PrivateQuestion): Finding[] {
  const findings: Finding[] = [];
  const at = question.sourceQuestionIndex;

  for (const [later, earlier] of repeats(question.options.map((option) => canonicalize(option.text)))) {
    findings.push(
      makeFinding(
        'AMBIGUOUS_OPTION_MATCH',
        locate(quizId, at, later),
        `option ${later} is indistinguishable from option ${earlier} under runtime answer matching ` +
          '(NFC, case and whitespace normalization); a submitted answer resolves to only one of them'
      )
    );
  }

  // Detection reuses the repository's own helper, so this can never disagree with
  // the Interview builder or the Angular client about what "All of the above" is.
  const allOfTheAbove = question.options.filter((option) => isAllOfTheAbove(option.text)).length;
  if (allOfTheAbove > 1) {
    findings.push(
      makeFinding(
        'MULTIPLE_ALL_OF_THE_ABOVE',
        locate(quizId, at),
        `${allOfTheAbove} options are "All of the above" options; only one can be pinned last`
      )
    );
  }

  return findings;
}

/** Rules across the questions of one quiz, plus every question's own rules. */
export function validateQuiz(quiz: PrivateQuiz): Finding[] {
  const findings: Finding[] = [];

  for (const [later, earlier] of repeats(quiz.questions.map((question) => canonicalize(question.questionText)))) {
    findings.push(
      makeFinding(
        'AMBIGUOUS_QUESTION_MATCH',
        locate(quiz.quizId, later),
        `question ${later} is indistinguishable from question ${earlier} under runtime answer matching ` +
          '(NFC, case and whitespace normalization); its answers would be scored against question ' +
          `${earlier}`
      )
    );
  }

  for (const question of quiz.questions) {
    findings.push(...validateQuestion(quiz.quizId, question));
  }

  return findings;
}

type Normalization =
  | { readonly ok: true; readonly quizzes: readonly PrivateQuiz[] }
  | { readonly ok: false; readonly problems: readonly ValidationProblem[] };

function normalize(raw: unknown): Normalization {
  try {
    return { ok: true, quizzes: validateAndNormalize(raw).quizzes };
  } catch (err: unknown) {
    if (err instanceof QuizDataError) return { ok: false, problems: err.problems };
    throw err;   // an unexpected failure is the validator's own — never disguised as a finding
  }
}

export interface DomainResult {
  /** The quizzes that passed structural validation — the input to the raw-row rules. */
  readonly quizzes: readonly PrivateQuiz[];
  readonly findings: readonly Finding[];
}

/**
 * Structural validation (the application's own), then the added domain rules.
 *
 * The WHOLE bank is validated in one call first: that is exactly what the server
 * does at startup, so "no STRUCTURE errors" means the server would start.
 *
 * If that call rejects, the added rules could not run on anything. So each quiz
 * is then validated ON ITS OWN, purely to recover the quizzes that are sound and
 * keep checking them — a broken quiz does not hide findings in a healthy one. The
 * structural errors themselves come only from the whole-bank call, never twice.
 */
export function validateQuizBankDomain(source: QuizBankSource): DomainResult {
  const whole = normalize(source);

  if (whole.ok) {
    return { quizzes: whole.quizzes, findings: whole.quizzes.flatMap(validateQuiz) };
  }

  const findings: Finding[] = whole.problems.map((problem) =>
    makeFinding('STRUCTURE', parseProblemLocation(problem.at), problem.message)
  );

  const rawQuizzes = Array.isArray(source.quizzes) ? (source.quizzes as readonly unknown[]) : [];
  const healthy: PrivateQuiz[] = [];
  let skipped = 0;

  for (const rawQuiz of rawQuizzes) {
    const alone = normalize({ quizzes: [rawQuiz] });
    if (alone.ok) healthy.push(...alone.quizzes);
    else skipped++;
  }

  if (skipped > 0) {
    findings.push(
      makeFinding(
        'DOMAIN_RULES_PARTIAL',
        BANK_LOCATOR,
        `${skipped} quiz(zes) with structural errors were skipped by the added quality rules`
      )
    );
  }

  findings.push(...healthy.flatMap(validateQuiz));
  return { quizzes: healthy, findings };
}
