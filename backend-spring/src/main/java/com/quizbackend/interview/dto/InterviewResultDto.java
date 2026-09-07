package com.quizbackend.interview.dto;

import java.util.List;

/**
 * Port of the Node reference's {@code InterviewResultDto} ({@code
 * session.dto.ts}). Returned by BOTH {@code POST .../submit} and
 * {@code GET .../result} — Node has no separate "review" endpoint; review
 * content ({@code review[]}) is simply a field of this one result response,
 * confirmed against the live route file
 * ({@code backend/src/routes/interview-sessions.route.ts}), which defines
 * only {@code submit} and {@code result} for the post-assessment lifecycle.
 *
 * <p>Reuses {@link ActiveInterviewConfigDto} for {@code config} — Node's own
 * {@code toInterviewResultDto} builds an identically-shaped object literal
 * (mode/presetId/difficulty/topicIds/questionCount) rather than a distinct
 * type.
 */
public record InterviewResultDto(
        String sessionId,
        String status,
        String submittedAt,
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
        ActiveInterviewConfigDto config,
        InterviewPerformanceDto performance,
        List<InterviewReviewQuestionDto> review
) {
}
