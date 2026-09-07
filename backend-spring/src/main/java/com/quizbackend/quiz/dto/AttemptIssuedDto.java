package com.quizbackend.quiz.dto;

/**
 * The {@code POST /quizzes/:quizId/attempts} response body — port of the
 * Node reference's inline object literal in {@code quizzes.route.ts}.
 * Exactly these 5 fields (verified against the Node test's own {@code
 * Object.keys(res.body).sort()} assertion).
 */
public record AttemptIssuedDto(
        String quizId, int durationSeconds, long startedAt, long expiresAt, String attemptReceipt
) {
}
