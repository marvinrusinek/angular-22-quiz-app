package com.quizbackend.interview.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Read-only code snippet, question CONTENT never answer-key material — safe
 * under ACTIVE_ASSESSMENT, which already permits {@code questionText}.
 * Deliberately a separate copy from {@code com.quizbackend.quiz.dto}'s
 * equivalent — the Node reference keeps two independent copies too
 * ({@code quiz/quiz.dto.ts} vs {@code interview/session.dto.ts}), one per
 * bounded context, rather than a shared cross-module type.
 *
 * <p>{@code filename} is OMITTED (not serialized as {@code null}) when
 * absent — Node's mapper uses a conditional spread ({@code ...(filename ?
 * {filename} : {})}) rather than always including the key.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CodeSnippetDto(String language, String code, String filename) {
}
