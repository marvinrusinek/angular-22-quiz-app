package com.quizbackend.interview.dto;

import java.util.List;

/**
 * Parity with the Node reference's {@code PUT /interview-sessions/:sessionId/answers/:questionId}
 * response body: {@code { saved, questionId, selectedOptionIds, answeredCount, questionCount } }.
 * {@code answeredCount}/{@code questionCount} are derived from persisted rows,
 * never from anything the caller sent.
 */
public record AnswerSaveResponseDto(boolean saved, String questionId, List<Integer> selectedOptionIds,
        long answeredCount, long questionCount) {
}
