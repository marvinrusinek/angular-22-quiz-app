package com.quizbackend.interview;

import java.util.List;

/** Port of the Node reference's {@code { performance: { byTopic } } } nesting. */
public record FrozenPerformance(List<FrozenTopicBucket> byTopic) {
}
