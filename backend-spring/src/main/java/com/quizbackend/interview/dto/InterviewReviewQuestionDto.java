package com.quizbackend.interview.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * Post-submission review. Reachable ONLY from a submitted session's result
 * response (SUBMITTED_REVIEW policy). Correctness is expressed as an
 * explicit ID LIST ({@code correctOptionIds}), never a per-option boolean —
 * there is deliberately no question-level {@code isCorrect} either; the
 * client derives the outcome by comparing {@code selectedOptionIds} with
 * {@code correctOptionIds}, exactly like the Node reference.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record InterviewReviewQuestionDto(
        String questionId,
        String sourceQuizId,
        String questionText,
        String type,
        List<InterviewReviewOptionDto> options,
        List<Integer> selectedOptionIds,
        List<Integer> correctOptionIds,
        String explanation,
        /** The user's own Mark-for-Review note, frozen at submission. */
        boolean flagged,
        /** Absent on every question that predates this feature. */
        CodeSnippetDto codeSnippet
) {
}
