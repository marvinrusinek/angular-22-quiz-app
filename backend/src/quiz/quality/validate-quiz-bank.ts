/**
 * The Question Quality Validator: snapshot in, report out.
 *
 *   PostgreSQL ──(one read-only snapshot)──┬─► raw rows ────────► raw-rules    ─┐
 *                                          │                                    ├─► findings ─► report
 *                                          └─► the application's loader         │
 *                                                └► validateAndNormalize         │
 *                                                     └► PrivateQuiz/Question ─► domain-rules ┘
 *
 * `validateQuizBank` is PURE — it takes a snapshot and returns a report, so almost
 * everything is testable with no database. `runQuizBankValidation` is the thin
 * wrapper that reads the snapshot inside the read-only transaction and then
 * validates it AFTER the transaction has ended.
 *
 * Nothing here writes, repairs, normalizes or "fixes" data: it reports.
 */

import { readBankSnapshot, type BankSnapshot } from './bank-snapshot';
import { validateQuizBankDomain } from './domain-rules';
import { BANK_LOCATOR, buildReport, makeFinding, type QualityReport } from './findings';
import { withReadOnlySnapshot, type SnapshotSource } from './read-only-snapshot';
import { validateRawBank } from './raw-rules';

export function validateQuizBank(snapshot: BankSnapshot): QualityReport {
  const { raw } = snapshot;
  const counts = {
    quizzes: raw.quizzes.length,
    questions: raw.questions.length,
    options: raw.options.length
  };

  // No active quizzes: the application would refuse to start. One clear finding, not a
  // cascade — the domain layer would only repeat it as "collection is empty".
  if (raw.quizzes.length === 0) {
    return buildReport(counts, [
      makeFinding('EMPTY_BANK', BANK_LOCATOR, 'no active quizzes were found; the application would refuse to start'),
      ...validateRawBank(raw, [])
    ]);
  }

  const domain = validateQuizBankDomain(snapshot.source);
  return buildReport(counts, [...domain.findings, ...validateRawBank(raw, domain.quizzes)]);
}

/** Reads one read-only snapshot, then validates it. The only function that touches the database. */
export async function runQuizBankValidation(source: SnapshotSource): Promise<QualityReport> {
  const snapshot = await withReadOnlySnapshot(source, readBankSnapshot);
  return validateQuizBank(snapshot);
}
