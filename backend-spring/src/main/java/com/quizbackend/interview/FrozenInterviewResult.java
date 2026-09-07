package com.quizbackend.interview;

import java.util.List;

/**
 * The FROZEN interview result — port of the Node reference's {@code
 * FrozenInterviewResult}. This exact shape is serialized into {@code
 * interview_sessions.result_json} at finalization and returned verbatim
 * thereafter; it is never recomputed, and every later read parses and
 * revalidates it (see {@link FrozenResultValidation}) rather than trusting
 * storage.
 *
 * <p>Safe to serialize under {@code SUBMITTED_REVIEW}: {@code
 * correctOptionIds} and {@code explanation} are authorized post-submission,
 * while per-option {@code isCorrect} is deliberately absent — correctness is
 * expressed as an id list only, exactly like the Node reference.
 */
public record FrozenInterviewResult(
        String sessionId,
        String status,
        /** Epoch ms in storage; the DTO mapper converts to ISO. */
        long submittedAt,
        boolean submittedByExpiry,
        int total,
        int answered,
        int unanswered,
        int correct,
        int incorrect,
        int percentage,
        int durationSeconds,
        int timeUsedSeconds,
        int timeRemainingSeconds,
        FrozenResultConfig config,
        FrozenPerformance performance,
        List<FrozenReviewQuestion> review
) {
}
