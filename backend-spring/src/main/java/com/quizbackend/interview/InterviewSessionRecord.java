package com.quizbackend.interview;

/**
 * Port of the Node reference's {@code InterviewSessionRecord}. Timestamps are
 * epoch MILLISECONDS ({@code long}), matching the {@code BIGINT} columns —
 * never {@code Instant}, never seconds, never mixed.
 */
public record InterviewSessionRecord(
        String id,
        /** SHA-256 hex of the bearer token. Never returned to a client. */
        String tokenHash,
        SessionStatus status,
        InterviewSessionConfig config,
        int durationSeconds,
        long createdAt,
        long expiresAt,
        Long submittedAt,
        boolean submittedByExpiry,
        String attemptId
) {
}
