package com.quizbackend.interview;

/** A frozen option snapshot. Independent of the quiz bank after creation. ANSWER KEY — never in an active DTO. */
public record SessionOptionSnapshot(int optionId, String text, int displayOrder, boolean isCorrect) {
}
