package com.quizbackend.interview.dto;

/**
 * Parity with the Node reference's {@code PUT /interview-sessions/:sessionId/review/:questionId}
 * response body: {@code { questionId, flagged } } — never correctness.
 */
public record FlagResponseDto(String questionId, boolean flagged) {
}
