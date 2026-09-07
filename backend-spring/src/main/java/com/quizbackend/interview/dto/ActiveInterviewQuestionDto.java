package com.quizbackend.interview.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * Never {@code correct}/{@code isCorrect}, never {@code explanation}. Built
 * as an explicit literal from the frozen snapshot, field by field — see
 * {@code InterviewSessionDtoMapper} — so neither can leak even if the
 * snapshot type grows new fields later.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ActiveInterviewQuestionDto(
        String questionId,
        String sourceQuizId,
        String questionText,
        String type,
        List<ActiveInterviewOptionDto> options,
        /** The user's own Mark-for-Review note. Never correctness. Always false in this slice. */
        boolean flagged,
        /** Absent on every question that predates this feature. */
        CodeSnippetDto codeSnippet
) {
}
