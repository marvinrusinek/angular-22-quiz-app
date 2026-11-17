import { Service } from '@angular/core';

import { SK_COMPLETED_REVIEW } from '@shared/constants/session-keys';
import type { FinalResult } from '@shared/models';
import { norm } from '@shared/utils/text-norm';
import { swallow } from '@shared/utils/error-logging';
import type { ReviewReveal } from './review-reveal.service';

/** Hard caps, so the record can never grow into anything resembling a bank. */
const MAX_REVEALS = 200;
const MAX_OPTIONS_PER_REVEAL = 12;
const MAX_QUESTION_CHARS = 2_000;
const MAX_OPTION_CHARS = 1_000;
const MAX_EXPLANATION_CHARS = 20_000;

interface StoredCompletedReview {
  readonly v: 1;
  readonly quizId: string;
  readonly completedAt: number;
  readonly reveals: readonly ReviewReveal[];
}

/** Drops anything that is not a well-formed, bounded reveal (it is browser storage: never trust it). */
function sanitize(raw: unknown): ReviewReveal | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const questionText = r['questionText'];
  const texts = r['correctOptionTexts'];
  const explanation = r['explanation'];
  if (typeof questionText !== 'string' || !questionText.trim() || questionText.length > MAX_QUESTION_CHARS) {
    return null;
  }
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_OPTIONS_PER_REVEAL) return null;
  if (!texts.every((t) => typeof t === 'string' && t.trim() !== '' && t.length <= MAX_OPTION_CHARS)) return null;
  if (explanation != null && (typeof explanation !== 'string' || explanation.length > MAX_EXPLANATION_CHARS)) {
    return null;
  }
  return {
    questionText,
    correctOptionTexts: [...(texts as string[])],
    explanation: typeof explanation === 'string' ? explanation : ''
  };
}

/**
 * Remembers, for ONE completed result, the correct answers and explanation the player already earned during that
 * attempt, so Quiz Review still shows them after a refresh.
 *
 * What it is NOT: it is not the answer bank (only questions the player legitimately reached a terminal reveal for,
 * in this one attempt), it never asks the server for anything, and it never issues or replays a receipt. The saved
 * result itself stays stripped (see toDurableFinalResult).
 *
 * Scope: a record belongs to exactly one result (quizId + completedAt). A different attempt or quiz reads nothing,
 * and the record is removed whenever the saved result is (restart, new attempt). It lives in sessionStorage only
 * (this tab's session), is written only from the Results page, and is size-capped and validated on every read.
 */
@Service()
export class CompletedReviewStoreService {
  /** Add the given reveals to this result's record (existing ones are kept; a later duplicate wins). */
  save(result: Pick<FinalResult, 'quizId' | 'completedAt'>, reveals: Iterable<ReviewReveal>): void {
    if (!result.quizId || typeof result.completedAt !== 'number') return;
    const merged = this.load(result);
    let added = false;
    for (const raw of reveals) {
      const clean = sanitize(raw);
      if (!clean) continue;
      merged.set(norm(clean.questionText), clean);
      added = true;
    }
    if (!added) return; // nothing new: never rewrite or delete an existing record
    const record: StoredCompletedReview = {
      v: 1,
      quizId: result.quizId,
      completedAt: result.completedAt,
      reveals: [...merged.values()].slice(0, MAX_REVEALS)
    };
    try {
      sessionStorage.setItem(SK_COMPLETED_REVIEW, JSON.stringify(record));
    } catch (err: unknown) {
      swallow('completed-review-store.service.ts', err);
    }
  }

  /** The reveals saved for exactly this result, keyed by normalized question text; empty if none/other/invalid. */
  load(result: Pick<FinalResult, 'quizId' | 'completedAt'>): Map<string, ReviewReveal> {
    const out = new Map<string, ReviewReveal>();
    try {
      const raw = sessionStorage.getItem(SK_COMPLETED_REVIEW);
      if (!raw) return out;
      const parsed = JSON.parse(raw) as Partial<StoredCompletedReview> | null;
      if (!parsed || parsed.v !== 1) return out;
      if (parsed.quizId !== result.quizId || parsed.completedAt !== result.completedAt) return out;
      if (!Array.isArray(parsed.reveals)) return out;
      for (const item of parsed.reveals.slice(0, MAX_REVEALS)) {
        const clean = sanitize(item);
        if (clean) out.set(norm(clean.questionText), clean);
      }
    } catch (err: unknown) {
      swallow('completed-review-store.service.ts', err);
      out.clear();
    }
    return out;
  }

  clear(): void {
    clearCompletedReview();
  }
}

/** Removes the record. Standalone so the places that clear the saved result can do it without injection. */
export function clearCompletedReview(): void {
  try {
    sessionStorage.removeItem(SK_COMPLETED_REVIEW);
  } catch (err: unknown) {
    swallow('completed-review-store.service.ts', err);
  }
}
