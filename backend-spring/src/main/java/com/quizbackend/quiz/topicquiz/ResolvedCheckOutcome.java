package com.quizbackend.quiz.topicquiz;

import java.util.List;

/**
 * A single/trueFalse question resolves on ANY non-empty answer (right or
 * wrong); a multiple-answer question resolves once every correct option is
 * selected (extra wrong picks do not block it). EXACTLY these 4 fields —
 * matches the Node reference's {@code {status:'resolved',...}} literal
 * field-for-field (verified against {@code quiz-check-endpoint.test.ts}'s
 * own {@code Object.keys(res.body).sort()} assertion).
 */
public record ResolvedCheckOutcome(
        String status, boolean correct, List<String> correctOptionTexts, String explanation
) implements CheckOutcome {
}
