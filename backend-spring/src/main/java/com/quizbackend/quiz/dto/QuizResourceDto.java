package com.quizbackend.quiz.dto;

/** Port of the Node reference's {@code QuizResourceDto}. The whole of the source shape and the whole of what the panel renders. */
public record QuizResourceDto(String title, String url, String host) {
}
