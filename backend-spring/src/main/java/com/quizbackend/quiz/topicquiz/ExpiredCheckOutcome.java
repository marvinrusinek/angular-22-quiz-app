package com.quizbackend.quiz.topicquiz;

import java.util.List;

/**
 * The server-authoritative deadline passed before the question resolved —
 * EXACTLY these 3 fields, deliberately NO {@code correct} boolean (unlike
 * {@link ResolvedCheckOutcome}): an expiry reveal is neither a win nor a
 * loss recorded here, matching the Node reference's own object literal,
 * which never names a {@code correct} key in this branch.
 */
public record ExpiredCheckOutcome(
        String status, List<String> correctOptionTexts, String explanation
) implements CheckOutcome {
}
