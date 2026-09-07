package com.quizbackend.interview;

import java.util.List;

/** Port of the Node reference's {@code FrozenResultConfig}. */
public record FrozenResultConfig(
        String mode, String presetId, String difficulty, List<String> topicIds, int questionCount
) {
}
