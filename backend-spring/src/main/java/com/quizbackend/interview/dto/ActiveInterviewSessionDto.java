package com.quizbackend.interview.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/** {@code sessionToken} is present ONLY in the creation response — never on resume. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ActiveInterviewSessionDto(
        String sessionId,
        String sessionToken,
        String status,
        String createdAt,
        String expiresAt,
        int durationSeconds,
        int remainingSeconds,
        ActiveInterviewConfigDto config,
        List<ActiveInterviewQuestionDto> questions,
        List<ActiveInterviewAnswerDto> answers
) {
}
