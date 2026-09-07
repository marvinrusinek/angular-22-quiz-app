package com.quizbackend.interview;

import com.quizbackend.interview.dto.ActiveInterviewAnswerDto;
import com.quizbackend.interview.dto.ActiveInterviewConfigDto;
import com.quizbackend.interview.dto.ActiveInterviewOptionDto;
import com.quizbackend.interview.dto.ActiveInterviewQuestionDto;
import com.quizbackend.interview.dto.ActiveInterviewSessionDto;
import com.quizbackend.interview.dto.CodeSnippetDto;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Comparator;
import java.util.List;

/**
 * Port of the Node reference's active-session mappers
 * ({@code session.dto.ts}). Built as explicit literals, field by field, from
 * the frozen snapshot — {@code isCorrect}, {@code explanation},
 * {@code tokenHash} and {@code attemptId} are simply never named here, so
 * they cannot leak even if the snapshot type grows new fields.
 */
public final class InterviewSessionDtoMapper {

    /** Always {@code yyyy-MM-ddTHH:mm:ss.SSSZ} — matches JS {@code Date#toISOString()} exactly (fixed 3-digit ms). */
    private static final DateTimeFormatter ISO_MILLIS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private InterviewSessionDtoMapper() {
    }

    static String toIso(long epochMs) {
        return ISO_MILLIS.format(Instant.ofEpochMilli(epochMs));
    }

    private static CodeSnippetDto toCodeSnippetDto(CandidateCodeSnippet snippet) {
        if (snippet == null) {
            return null;
        }
        return new CodeSnippetDto(snippet.language(), snippet.code(), snippet.filename());
    }

    public static ActiveInterviewQuestionDto toActiveQuestionDto(SessionQuestionSnapshot question) {
        List<ActiveInterviewOptionDto> options = question.options().stream()
                .sorted(Comparator.comparingInt(SessionOptionSnapshot::displayOrder))
                .map(option -> new ActiveInterviewOptionDto(option.optionId(), option.text()))
                .toList();

        return new ActiveInterviewQuestionDto(
                question.questionId(),
                question.sourceQuizId(),
                question.questionText(),
                question.type(),
                options,
                question.flagged(),
                toCodeSnippetDto(question.codeSnippet()));
    }

    public record ActiveSessionParams(
            InterviewSessionRecord session,
            List<SessionQuestionSnapshot> questions,
            List<ActiveInterviewAnswerDto> answers,
            long now,
            /** Supplied only by the creation path. */
            String sessionToken
    ) {
    }

    public static ActiveInterviewSessionDto toActiveSessionDto(ActiveSessionParams params) {
        InterviewSessionRecord session = params.session();
        InterviewSessionConfig sessionConfig = session.config();

        boolean isPreset = sessionConfig.presetId() != null;
        ActiveInterviewConfigDto config = new ActiveInterviewConfigDto(
                isPreset ? "preset" : "custom",
                isPreset ? sessionConfig.presetId() : null,
                isPreset ? null : sessionConfig.difficulty(),
                List.copyOf(sessionConfig.topicIds()),
                sessionConfig.questionCount());

        List<ActiveInterviewQuestionDto> questions = params.questions().stream()
                .sorted(Comparator.comparingInt(SessionQuestionSnapshot::position))
                .map(InterviewSessionDtoMapper::toActiveQuestionDto)
                .toList();

        // Server-calculated; the client clock is never consulted. Matches
        // Node's Math.max(0, Math.ceil((expiresAt - now) / 1000)) exactly.
        long remainingSeconds = Math.max(0L, (long) Math.ceil((session.expiresAt() - params.now()) / 1000.0));

        return new ActiveInterviewSessionDto(
                session.id(),
                params.sessionToken(),
                "active",
                toIso(session.createdAt()),
                toIso(session.expiresAt()),
                session.durationSeconds(),
                (int) remainingSeconds,
                config,
                questions,
                params.answers());
    }
}
