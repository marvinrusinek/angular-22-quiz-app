package com.quizbackend.interview.dto;

/** Never {@code isCorrect} — correctness is expressed only via {@code correctOptionIds} on the question. */
public record InterviewReviewOptionDto(int optionId, String text) {
}
