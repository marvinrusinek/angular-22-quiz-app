package com.quizbackend.interview;

import com.quizbackend.interview.dto.ActiveInterviewConfigDto;
import com.quizbackend.interview.dto.CodeSnippetDto;
import com.quizbackend.interview.dto.InterviewPerformanceBucketDto;
import com.quizbackend.interview.dto.InterviewPerformanceDto;
import com.quizbackend.interview.dto.InterviewResultDto;
import com.quizbackend.interview.dto.InterviewReviewOptionDto;
import com.quizbackend.interview.dto.InterviewReviewQuestionDto;

import java.util.List;

/**
 * Port of the Node reference's {@code toInterviewResultDto}
 * ({@code session.dto.ts}). Maps the FROZEN result onto the wire shape as
 * explicit literals, field by field, exactly like every other mapper in this
 * migration — {@code tokenHash} and per-option {@code isCorrect} are simply
 * never named here, so neither can leak even if the frozen type grows new
 * fields later.
 */
public final class InterviewResultDtoMapper {

    private InterviewResultDtoMapper() {
    }

    private static CodeSnippetDto toCodeSnippetDto(CandidateCodeSnippet snippet) {
        if (snippet == null) {
            return null;
        }
        return new CodeSnippetDto(snippet.language(), snippet.code(), snippet.filename());
    }

    public static InterviewResultDto toInterviewResultDto(FrozenInterviewResult result) {
        FrozenResultConfig cfg = result.config();
        boolean isPreset = cfg.presetId() != null;
        ActiveInterviewConfigDto config = new ActiveInterviewConfigDto(
                isPreset ? "preset" : "custom",
                isPreset ? cfg.presetId() : null,
                isPreset ? null : cfg.difficulty(),
                List.copyOf(cfg.topicIds()),
                cfg.questionCount());

        List<InterviewPerformanceBucketDto> byTopic = result.performance().byTopic().stream()
                .map(bucket -> new InterviewPerformanceBucketDto(
                        bucket.topicId(), bucket.title(), bucket.correct(), bucket.incorrect(),
                        bucket.unanswered(), bucket.total(), bucket.percentage()))
                .toList();

        List<InterviewReviewQuestionDto> review = result.review().stream()
                .map(question -> new InterviewReviewQuestionDto(
                        question.questionId(),
                        question.sourceQuizId(),
                        question.questionText(),
                        question.type(),
                        question.options().stream()
                                .map(option -> new InterviewReviewOptionDto(option.optionId(), option.text()))
                                .toList(),
                        List.copyOf(question.selectedOptionIds()),
                        List.copyOf(question.correctOptionIds()),
                        question.explanation(),
                        question.flagged(),
                        toCodeSnippetDto(question.codeSnippet())))
                .toList();

        return new InterviewResultDto(
                result.sessionId(),
                "submitted",
                InterviewSessionDtoMapper.toIso(result.submittedAt()),
                result.submittedByExpiry(),
                result.total(),
                result.answered(),
                result.unanswered(),
                result.correct(),
                result.incorrect(),
                result.percentage(),
                result.durationSeconds(),
                result.timeUsedSeconds(),
                result.timeRemainingSeconds(),
                config,
                new InterviewPerformanceDto(byTopic),
                review);
    }
}
