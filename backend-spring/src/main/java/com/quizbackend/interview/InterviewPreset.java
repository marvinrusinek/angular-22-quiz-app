package com.quizbackend.interview;

import java.util.List;

/** Port of the Node reference's {@code InterviewPreset}. */
public record InterviewPreset(
        String id,
        String name,
        int questionCount,
        int durationMinutes,
        DifficultyDistribution difficultyDistribution,
        List<String> topicIds
) {
}
