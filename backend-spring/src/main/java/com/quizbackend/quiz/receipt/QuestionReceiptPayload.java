package com.quizbackend.quiz.receipt;

/**
 * Port of the Node reference's {@code QuestionReceiptPayload}
 * ({@code backend/src/quiz/question-receipt.ts}). Identity stays
 * TEXT-BASED — {@code questionText}, never an id or index — the same
 * public contract {@code /check} already uses.
 */
public record QuestionReceiptPayload(int v, String quizId, String questionText, long startedAt, long expiresAt) {
}
