package com.quizbackend.interview;

import java.util.List;

/**
 * Port of the Node reference's {@code FrozenReviewQuestion}. Correctness IS
 * exposed here as {@code correctOptionIds} — this type is only ever
 * serialized under the SUBMITTED_REVIEW response policy, which is the one
 * policy that legitimately permits it.
 */
public record FrozenReviewQuestion(
        String questionId,
        String sourceQuizId,
        String questionText,
        String type,
        List<FrozenReviewOption> options,
        List<Integer> selectedOptionIds,
        List<Integer> correctOptionIds,
        String explanation,
        /** The user's own Mark-for-Review note, frozen at submission. Never scored. */
        boolean flagged,
        /** Question CONTENT, frozen at submission. Absent on most questions. */
        CandidateCodeSnippet codeSnippet
) {
}
