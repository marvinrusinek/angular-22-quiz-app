package com.quizbackend.interview;

/** Port of the Node reference's {@code FrozenTopicBucket} / {@code ScoredTopicBucket}. */
public record FrozenTopicBucket(
        String topicId, String title, int correct, int incorrect, int unanswered, int total, int percentage
) {
}
