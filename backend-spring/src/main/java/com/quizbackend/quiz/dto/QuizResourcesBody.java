package com.quizbackend.quiz.dto;

import java.util.List;

/** Port of the Node reference's {@code QuizResourcesBody} — the {@code GET /quizzes/:quizId/resources} response body. */
public record QuizResourcesBody(String quizId, List<QuizResourceDto> resources) {
}
