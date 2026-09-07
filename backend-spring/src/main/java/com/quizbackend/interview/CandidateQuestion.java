package com.quizbackend.interview;

import java.util.List;

/**
 * A question read from the canonical {@code questions}/{@code options}
 * tables for one topic (quiz), with stable ids already derived. Equivalent
 * to the Node reference's {@code PrivateQuestion}. Carries the answer key
 * ({@code options[].isCorrect}) and {@code explanation} — backend-private,
 * never mapped into an active-session DTO directly (see
 * {@code InterviewSessionDtoMapper}).
 */
public record CandidateQuestion(
        String questionId,
        String sourceQuizId,
        int sourceQuestionIndex,
        String questionText,
        String type,
        String explanation,
        List<CandidateOption> options,
        CandidateCodeSnippet codeSnippet
) {
}
