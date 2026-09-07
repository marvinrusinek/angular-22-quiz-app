package com.quizbackend.quiz.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * Port of the Node reference's {@code TopicQuizQuestionDto}
 * ({@code backend/src/quiz/quiz.dto.ts}). The public contract carries NO
 * identifiers — a question is addressed by its exact text within a quiz.
 * {@code correctCount} discloses CARDINALITY (how many options are
 * correct), never IDENTITY (which ones) — a deliberate, narrow disclosure
 * matching Node's own documented reasoning (the "N answers are correct"
 * banner was always public before an answer).
 *
 * <p>{@code difficulty} is ALWAYS present, including as JSON {@code null}
 * &mdash; Node's mapper assigns it as a plain shorthand property, not a
 * conditional spread. Only {@code codeSnippet} is omitted (not serialized
 * as {@code null}) when absent, matching Node's own conditional spread for
 * that one field &mdash; hence the per-field annotation below rather than a
 * class-level {@code @JsonInclude(NON_NULL)}, which would incorrectly
 * suppress a genuinely-null {@code difficulty} too.
 */
public record TopicQuizQuestionDto(
        String questionText,
        String type,
        String difficulty,
        int correctCount,
        List<TopicQuizOptionDto> options,
        @JsonInclude(JsonInclude.Include.NON_NULL) CodeSnippetDto codeSnippet
) {
}
