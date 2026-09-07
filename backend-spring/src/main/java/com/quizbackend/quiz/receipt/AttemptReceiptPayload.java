package com.quizbackend.quiz.receipt;

/**
 * Port of the Node reference's {@code AttemptReceiptPayload}
 * ({@code backend/src/quiz/attempt-receipt.ts}). Everything the server
 * needs, and nothing it does not: no question/option identity, no
 * correctness, no explanations, no database ids.
 */
public record AttemptReceiptPayload(int v, String quizId, long startedAt, long expiresAt) {
}
