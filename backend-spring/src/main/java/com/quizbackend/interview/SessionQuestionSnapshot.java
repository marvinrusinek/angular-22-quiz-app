package com.quizbackend.interview;

import java.util.List;

/** A frozen question snapshot, in its session-specific position. Carries the answer key/explanation. */
public record SessionQuestionSnapshot(
        int position,
        String questionId,
        String sourceQuizId,
        String questionText,
        String type,
        String explanation,
        List<SessionOptionSnapshot> options,
        /** Mark for Review — out of scope for this slice; always false here. */
        boolean flagged,
        CandidateCodeSnippet codeSnippet
) {
}
