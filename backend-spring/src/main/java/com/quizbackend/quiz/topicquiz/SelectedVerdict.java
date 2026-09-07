package com.quizbackend.quiz.topicquiz;

/** One of the user's OWN picks and whether it is correct. An unselected option's correctness is never disclosed. */
public record SelectedVerdict(String text, boolean correct) {
}
