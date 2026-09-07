package com.quizbackend.quiz.dto;

import java.util.List;

/**
 * The whole body of {@code GET /api/quizzes} &mdash; parity with the Node
 * reference's {@code QuizzesListBody} ({@code backend/src/routes/quizzes.route.ts}):
 * {@code { quizzes: QuizMetadataDto[] }}.
 */
public record QuizzesListBody(List<QuizMetadataDto> quizzes) {
}
