/**
 * Raw-row rules: things about the PostgreSQL rows that the normal loader either
 * drops or silently repairs, so `PrivateQuestion` can never show them.
 *
 *   stored question_type      the loader never SELECTs it; the application
 *                             re-derives the type from option correctness
 *   quizzes.facts_json        `parseFacts` turns bad JSON into `[]` without a word
 *   quizzes.display_order     no UNIQUE constraint, ties are ordered arbitrarily
 *   code_filename with no code   the loader only builds a snippet when `code` is set
 *   display_order gaps        identity is the RANK in display order, never the value
 *
 * These row types hold NO question text, option text, explanation or
 * correctness. That is deliberate: a rule cannot leak what it is never given. The
 * database adapter selects exactly these columns and nothing else.
 *
 * Rows arrive already ORDERED (quiz display_order, then question display_order,
 * then option display_order — the same ORDER BY the loader uses). A row's RANK
 * within its group is what the application uses as its identity (`questionId` is
 * `<quizId>:q:<rank>`), so the rules compute rank from position, and the locators
 * they emit match the ones `validateAndNormalize` uses.
 *
 * PURE: no database, no I/O.
 */

import type { PrivateQuiz } from '../quiz.types';
import { BANK_LOCATOR, locate, makeFinding, type Finding } from './findings';

export interface RawQuizRow {
  readonly quizId: string;
  readonly displayOrder: number;
  /** The column as stored. Never parsed or repaired here. */
  readonly factsJson: string | null;
}

export interface RawQuestionRow {
  readonly quizId: string;
  readonly displayOrder: number;
  /** questions.question_type as stored — which the application ignores. */
  readonly storedType: string;
  /** `code IS NOT NULL`. The code itself is never carried. */
  readonly hasCode: boolean;
  readonly codeFilename: string | null;
}

export interface RawOptionRow {
  readonly quizId: string;
  /** The owning question's RANK within its quiz. */
  readonly questionIndex: number;
  readonly displayOrder: number;
}

export interface RawBankSnapshot {
  readonly quizzes: readonly RawQuizRow[];
  readonly questions: readonly RawQuestionRow[];
  readonly options: readonly RawOptionRow[];
  /** Quizzes with status = 'retired': not served, so not validated. */
  readonly retiredQuizCount: number;
}

/**
 * The raw rows and the validated model disagree about which questions exist.
 * Both come from ONE read-only snapshot, so this can only be a defect in the
 * validator or its queries — it is thrown, never reported as a data finding.
 */
export class SnapshotMismatchError extends Error {
  public override readonly name = 'SnapshotMismatchError';
}

// ── facts_json ─────────────────────────────────────────────────────────────

export function validateFacts(quizId: string, factsJson: string | null): Finding[] {
  // The column is NOT NULL DEFAULT '[]'; a null can only come from a caller, and the
  // application treats it as "no facts", so it is not a finding.
  if (factsJson === null) return [];

  const at = locate(quizId, null, null, 'facts_json');

  let parsed: unknown;
  try {
    parsed = JSON.parse(factsJson);
  } catch {
    return [makeFinding('FACTS_INVALID_JSON', at, 'facts_json is not valid JSON; the application silently uses no facts')];
  }

  if (!Array.isArray(parsed)) {
    return [makeFinding('FACTS_NOT_ARRAY', at, 'facts_json is valid JSON but not an array; the application silently uses no facts')];
  }

  const bad: number[] = [];
  for (const [index, entry] of (parsed as unknown[]).entries()) {
    if (typeof entry !== 'string' || entry.trim().length === 0) bad.push(index);
  }

  if (bad.length === 0) return [];
  return [
    makeFinding(
      'FACTS_BAD_ENTRY',
      at,
      `facts_json has ${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} that ${bad.length === 1 ? 'is' : 'are'} ` +
        `not a non-blank string (at position${bad.length === 1 ? '' : 's'} ${bad.join(', ')}); the application drops them`
    )
  ];
}

// ── quizzes.display_order ──────────────────────────────────────────────────

export function validateQuizOrder(quizzes: readonly RawQuizRow[]): Finding[] {
  const byOrder = new Map<number, string[]>();
  for (const quiz of quizzes) {
    const sharing = byOrder.get(quiz.displayOrder);
    if (sharing) sharing.push(quiz.quizId);
    else byOrder.set(quiz.displayOrder, [quiz.quizId]);
  }

  const findings: Finding[] = [];
  for (const [order, ids] of byOrder) {
    if (ids.length < 2) continue;
    for (const quizId of ids) {
      findings.push(
        makeFinding(
          'QUIZ_DISPLAY_ORDER_DUPLICATE',
          locate(quizId, null, null, 'display_order'),
          `display_order ${order} is shared with ${ids.length - 1} other active quiz(zes); their relative order is not defined`
        )
      );
    }
  }
  return findings;
}

// ── per-quiz question rows ─────────────────────────────────────────────────

function groupByQuiz<T extends { readonly quizId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.quizId);
    if (list) list.push(row);
    else out.set(row.quizId, [row]);
  }
  return out;
}

/** Rows of one quiz, each paired with the PrivateQuestion of the same RANK. */
function align(quiz: PrivateQuiz, rows: readonly RawQuestionRow[]): void {
  if (rows.length !== quiz.questions.length) {
    throw new SnapshotMismatchError(
      `quiz "${quiz.quizId}": the raw snapshot has ${rows.length} question row(s) but the validated model has ${quiz.questions.length}`
    );
  }
}

export function validateQuizQuestionRows(quiz: PrivateQuiz, rows: readonly RawQuestionRow[]): Finding[] {
  align(quiz, rows);
  const findings: Finding[] = [];

  let firstGap: number | null = null;
  for (const [rank, row] of rows.entries()) {
    const derived = quiz.questions[rank]!.type;

    // Stored type vs derived type: WARNING, because both runtimes deliberately ignore the column.
    if (row.storedType !== derived) {
      findings.push(
        makeFinding(
          'TYPE_DRIFT',
          locate(quiz.quizId, rank, null, 'question_type'),
          `stored question_type "${row.storedType}" differs from the derived type "${derived}"; the application uses the derived type`
        )
      );
    }

    // A filename is only meaningful with a snippet; the loader builds one only from `code`.
    if (row.codeFilename !== null && !row.hasCode) {
      findings.push(
        makeFinding(
          'SNIPPET_ORPHAN_FILENAME',
          locate(quiz.quizId, rank, null, 'code_filename'),
          'code_filename is set but code is NULL; the filename is ignored'
        )
      );
    }

    if (firstGap === null && row.displayOrder !== rank) firstGap = rank;
  }

  if (firstGap !== null) {
    findings.push(
      makeFinding(
        'QUESTION_DISPLAY_ORDER_GAP',
        locate(quiz.quizId, firstGap, null, 'display_order'),
        'question display_order values are not 0..n-1 (first difference at this question); ' +
          'harmless today because identity uses rank, but the stored order has been edited'
      )
    );
  }

  return findings;
}

// ── options ────────────────────────────────────────────────────────────────

export function validateOptionOrder(quizId: string, options: readonly RawOptionRow[]): Finding[] {
  // Options arrive ordered by (question rank, display_order); rank is position within the question.
  const byQuestion = new Map<number, RawOptionRow[]>();
  for (const option of options) {
    const list = byQuestion.get(option.questionIndex);
    if (list) list.push(option);
    else byQuestion.set(option.questionIndex, [option]);
  }

  const findings: Finding[] = [];
  for (const [questionIndex, rows] of byQuestion) {
    const firstGap = rows.findIndex((row, rank) => row.displayOrder !== rank);
    if (firstGap >= 0) {
      findings.push(
        makeFinding(
          'OPTION_DISPLAY_ORDER_GAP',
          locate(quizId, questionIndex, firstGap, 'display_order'),
          'option display_order values are not 0..n-1 (first difference at this option); ' +
            'harmless today because identity uses rank, but the stored order has been edited'
        )
      );
    }
  }
  return findings;
}

// ── the whole raw layer ────────────────────────────────────────────────────

/**
 * @param quizzes the quizzes that passed structural validation. Raw rows of any
 *   other quiz are skipped for the rules that need the derived type — those quizzes
 *   already carry STRUCTURE errors.
 */
export function validateRawBank(raw: RawBankSnapshot, quizzes: readonly PrivateQuiz[]): Finding[] {
  const findings: Finding[] = [];

  for (const quiz of raw.quizzes) findings.push(...validateFacts(quiz.quizId, quiz.factsJson));
  findings.push(...validateQuizOrder(raw.quizzes));

  const questionsByQuiz = groupByQuiz(raw.questions);
  const optionsByQuiz = groupByQuiz(raw.options);

  for (const quiz of quizzes) {
    findings.push(...validateQuizQuestionRows(quiz, questionsByQuiz.get(quiz.quizId) ?? []));
    findings.push(...validateOptionOrder(quiz.quizId, optionsByQuiz.get(quiz.quizId) ?? []));
  }

  if (raw.retiredQuizCount > 0) {
    findings.push(
      makeFinding(
        'RETIRED_QUIZZES_SKIPPED',
        BANK_LOCATOR,
        `${raw.retiredQuizCount} retired quiz(zes) are not served by the application and were not validated`
      )
    );
  }

  return findings;
}
