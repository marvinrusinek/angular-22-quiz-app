package com.quizbackend.quiz.dto;

/** Port of the Node reference's {@code TopicQuizOptionDto}. ONLY the text — no id, no correctness. */
public record TopicQuizOptionDto(String text) {
}
