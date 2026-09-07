package com.quizbackend.interview;

import java.util.List;

/** Port of the Node reference's {@code GeneratedInterviewSnapshot} — the whole generated assessment, pre-persistence. */
public record GeneratedInterviewSnapshot(
        InterviewBuildConfig config,
        int durationSeconds,
        List<GeneratedQuestionSnapshot> questions
) {
}
