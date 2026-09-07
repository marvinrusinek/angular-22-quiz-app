package com.quizbackend.interview;

import java.util.List;

/**
 * Port of the Node reference's {@code InterviewBuildConfig}. {@code difficulty}
 * is {@code "mixed"} for a preset assessment (the real band mix lives in the
 * preset definition); a custom assessment carries the caller's own single
 * difficulty value.
 */
public record InterviewBuildConfig(
        String difficulty,
        List<String> topicIds,
        int questionCount,
        int durationSeconds,
        String presetId,
        String presetName
) {
}
