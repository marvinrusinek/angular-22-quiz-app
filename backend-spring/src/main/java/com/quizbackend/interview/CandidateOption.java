package com.quizbackend.interview;

/**
 * An option read from the canonical {@code options} table, with its stable
 * {@code optionId} already derived (see {@link InterviewQuestionRepository}).
 * Equivalent to the Node reference's {@code PrivateOption}. ANSWER KEY
 * material ({@code isCorrect}) — never mapped into an active-session DTO.
 */
public record CandidateOption(int optionId, int sourceOptionIndex, String text, boolean isCorrect) {
}
