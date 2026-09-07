package com.quizbackend.quiz.dto;

import java.util.List;

/** Port of the Node reference's {@code TopicQuizQuestionsDto} — the {@code GET /quizzes/:quizId/questions} response body. */
public record TopicQuizQuestionsDto(String quizId, List<TopicQuizQuestionDto> questions) {
}
