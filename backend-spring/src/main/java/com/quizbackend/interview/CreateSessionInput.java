package com.quizbackend.interview;

import java.util.List;

/**
 * Port of the Node reference's {@code CreateSessionInput}. Reuses
 * {@link GeneratedQuestionSnapshot}/{@link GeneratedOptionSnapshot} directly
 * as the row source rather than duplicating them into separate "creation
 * input" records — Node keeps generation-output and persistence-input types
 * separate for its own layering reasons, but no information is lost by
 * reusing them here, and it avoids a redundant field-for-field remap.
 */
public record CreateSessionInput(
        String id,
        String tokenHash,
        String attemptId,
        InterviewSessionConfig config,
        int durationSeconds,
        long createdAt,
        long expiresAt,
        List<GeneratedQuestionSnapshot> questions,
        /**
         * SHA-256 hex of the client-generated request-idempotency key
         * (never the raw key — an idempotency key is credential-equivalent,
         * see migration 007's own doc comment), or null when the caller
         * sent none.
         */
        String idempotencyKeyHash,
        /** SHA-256 hex of the validated creation request; non-null iff idempotencyKeyHash is. */
        String idempotencyRequestHash
) {
}
