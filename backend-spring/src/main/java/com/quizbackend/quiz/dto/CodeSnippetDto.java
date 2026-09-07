package com.quizbackend.quiz.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Read-only code snippet, question CONTENT never answer-key material — safe
 * under {@code QUIZ_QUESTIONS}, which already permits {@code questionText}.
 * Deliberately a separate copy from {@code com.quizbackend.interview.dto}'s
 * equivalent — the Node reference keeps two independent copies too
 * ({@code quiz/quiz.dto.ts} vs {@code interview/session.dto.ts} both
 * declare their own local {@code CodeSnippetDto}/{@code toCodeSnippetDto}),
 * one per bounded context, rather than a shared cross-module type.
 *
 * <p>{@code filename} is OMITTED (not serialized as {@code null}) when
 * absent, matching Node's conditional spread.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CodeSnippetDto(String language, String code, String filename) {
}
