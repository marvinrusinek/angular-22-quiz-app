package com.quizbackend.quiz.topicquiz;

import java.util.List;

/**
 * Nothing resolved yet: EXACTLY these 3 fields — no {@code correctOptionTexts}/
 * {@code explanation} key at all (not merely null), matching Node's object
 * literal, which never names those keys in this branch. {@code
 * selectedVerdicts} carries ONLY the user's own picks; an unselected
 * option's correctness is never disclosed, which is what stops partial
 * play from being used to enumerate the answer key one option at a time.
 */
public record IncompleteCheckOutcome(
        String status, List<SelectedVerdict> selectedVerdicts, int remainingCorrectCount
) implements CheckOutcome {
}
