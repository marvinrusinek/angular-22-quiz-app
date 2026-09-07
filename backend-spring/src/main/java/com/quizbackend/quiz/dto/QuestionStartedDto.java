package com.quizbackend.quiz.dto;

/**
 * The {@code POST /quizzes/:quizId/questions/start} response body — port of
 * the Node reference's inline object literal in {@code quizzes.route.ts}.
 * Exactly these 6 fields.
 */
public record QuestionStartedDto(
        String quizId, String questionText, int durationSeconds, long startedAt, long expiresAt, String questionReceipt
) {
}
