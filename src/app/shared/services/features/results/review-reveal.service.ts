import { Service, inject } from '@angular/core';
import { EMPTY, Observable, defer, from, throwError, timer } from 'rxjs';
import { catchError, map, mergeMap, retry } from 'rxjs/operators';

import { QuizQuestion, ScoreAnalysisItem } from '@shared/models';
import { norm } from '@shared/utils/text-norm';
import {
  ReviewRevealRateLimitedError,
  TopicQuizAttemptService
} from '@shared/services/features/verdict/topic-quiz-attempt.service';

/** At most this many `/check` calls in flight at once. */
export const REVIEW_REVEAL_CONCURRENCY = 2;

/** A throttled (429) reveal is retried this many times, then given up. */
export const REVIEW_REVEAL_MAX_RETRIES = 3;

/** Margin past a deadline so a timer firing a hair early cannot ask too soon. */
const DEADLINE_MARGIN_MS = 50;

/** One question's reveal, fetched after the quiz ended. */
export interface ReviewReveal {
  readonly questionText: string;
  readonly correctOptionTexts: readonly string[];
  readonly explanation: string;
}

const hasReveal = (item: ScoreAnalysisItem): boolean =>
  (item.explanation ?? '').trim().length > 0 || (item.correctOptionTexts?.length ?? 0) > 0;

/**
 * Fetches the correct answers and explanation still missing from the Quiz
 * Review.
 *
 * It only ever asks about a question that ALREADY holds a signed receipt, and
 * only after that receipt's own deadline — the same server-authorized moment at
 * which an in-quiz timeout would have revealed it. It issues no receipt, writes
 * no verdict, and so cannot reach the terminal-verdict stream, scoring, timers
 * or navigation. What it returns is a plain value for the caller to display.
 */
@Service()
export class ReviewRevealService {
  private readonly attempts = inject(TopicQuizAttemptService);

  /** Questions still lacking a reveal that hold a receipt, earliest deadline first. */
  pending(
    quizId: string,
    analysis: readonly ScoreAnalysisItem[]
  ): { questionText: string; deadlineMs: number }[] {
    const seen = new Set<string>();
    const out: { questionText: string; deadlineMs: number }[] = [];
    for (const item of analysis) {
      const text = item.questionText ?? '';
      const key = norm(text);
      if (!text || seen.has(key) || hasReveal(item)) continue;
      seen.add(key);
      const deadlineMs = this.attempts.issuedDeadline(quizId, text);
      if (deadlineMs !== null) out.push({ questionText: text, deadlineMs });
    }
    // Earliest first: with a concurrency cap, a later deadline must never hold
    // a slot while an already-due question waits behind it.
    return out.sort((a, b) => a.deadlineMs - b.deadlineMs);
  }

  /** Emits one reveal per question as it becomes available; never errors. */
  reveals(quizId: string, analysis: readonly ScoreAnalysisItem[]): Observable<ReviewReveal> {
    return from(this.pending(quizId, analysis)).pipe(
      mergeMap(
        (p) =>
          defer(() => {
            const wait = p.deadlineMs - Date.now();
            return timer(wait > 0 ? wait + DEADLINE_MARGIN_MS : 0);
          }).pipe(mergeMap(() => this.fetchOne(quizId, p.questionText))),
        REVIEW_REVEAL_CONCURRENCY
      )
    );
  }

  /** One question, tied to its own request; any failure just yields nothing. */
  private fetchOne(quizId: string, questionText: string): Observable<ReviewReveal> {
    return defer(() => this.attempts.revealIssued(quizId, questionText)).pipe(
      retry({
        count: REVIEW_REVEAL_MAX_RETRIES,
        delay: (err: unknown) =>
          err instanceof ReviewRevealRateLimitedError
            ? timer(err.retryAfterMs)
            : throwError(() => err)
      }),
      map((r) => ({
        questionText,
        correctOptionTexts: [...r.correctOptionTexts],
        explanation: r.explanation
      })),
      catchError(() => EMPTY)
    );
  }
}

/**
 * Overlay fetched reveals onto the analysis, for display only.
 *
 * An item that already carries a reveal is never overwritten, `wasCorrect` is
 * never touched, and a reveal is accepted only when it matches the question it
 * was requested for: same question text, and every correct option text must be
 * one of that question's displayed options. Anything that does not line up is
 * ignored rather than shown.
 */
export function mergeReviewReveals(
  analysis: ScoreAnalysisItem[],
  reveals: ReadonlyMap<string, ReviewReveal>,
  questions: readonly QuizQuestion[]
): ScoreAnalysisItem[] {
  if (reveals.size === 0) return analysis;

  return analysis.map((item) => {
    if (hasReveal(item)) return item;
    const key = norm(item.questionText ?? '');
    const reveal = reveals.get(key);
    if (!reveal) return item;

    const atIndex = questions[item.questionIndex];
    const question =
      atIndex && norm(atIndex.questionText ?? '') === key
        ? atIndex
        : questions.find((q) => norm(q.questionText ?? '') === key);
    if (!question || reveal.correctOptionTexts.length === 0) return item;

    const options = question.options ?? [];
    const matched = reveal.correctOptionTexts.map((t) =>
      options.find((o) => norm(o.text ?? '') === norm(t))
    );
    if (matched.some((o) => !o)) return item;

    return {
      ...item,
      correctOptionTexts: [...reveal.correctOptionTexts],
      correctOptionIds: matched
        .map((o) => (o?.optionId != null ? String(o.optionId) : ''))
        .filter((id) => id.length > 0),
      explanation: reveal.explanation
    };
  });
}
