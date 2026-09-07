package com.quizbackend.interview;

import java.util.List;

/** Mirrors the Angular AssessmentConfig; validated on every read from storage. */
public record InterviewSessionConfig(
        String difficulty,
        List<String> topicIds,
        int questionCount,
        String presetId,
        String presetName
) {
}
