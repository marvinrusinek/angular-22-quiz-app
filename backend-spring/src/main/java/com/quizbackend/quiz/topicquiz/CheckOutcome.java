package com.quizbackend.quiz.topicquiz;

/**
 * Port of the Node reference's {@code CheckOutcome} union type
 * ({@code backend/src/quiz/answer-check.ts}). Exactly one of three shapes,
 * each with its OWN exact field set — sealed so {@link AnswerCheck} cannot
 * accidentally return a shape that mixes fields from two variants.
 */
public sealed interface CheckOutcome
        permits ResolvedCheckOutcome, IncompleteCheckOutcome, ExpiredCheckOutcome {
}
