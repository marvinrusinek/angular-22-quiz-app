package com.quizbackend.interview;

import java.util.List;

/** Port of the Node reference's {@code GeneratedQuestionSnapshot}. Carries the answer key. */
public record GeneratedQuestionSnapshot(
        int position,
        String questionId,
        String sourceQuizId,
        String questionText,
        String questionType,
        String explanation,
        List<GeneratedOptionSnapshot> options,
        CandidateCodeSnippet codeSnippet
) {
}
