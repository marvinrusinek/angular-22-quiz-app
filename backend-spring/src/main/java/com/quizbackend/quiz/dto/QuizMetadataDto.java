package com.quizbackend.quiz.dto;

import java.util.List;

/**
 * Line-for-line parity with the Node reference's {@code QuizMetadataDto}
 * ({@code backend/src/quiz/quiz.dto.ts}). Field set, names and nesting are
 * copied exactly &mdash; this is a migration, not a redesign.
 *
 * <p>Built explicitly, field by field, by {@code QuizService} from
 * {@link com.quizbackend.quiz.entity.QuizEntity} &mdash; never by spreading
 * or serializing the entity itself. That is what keeps {@code id},
 * {@code displayOrder}, {@code status} and {@code factsJson} (the raw,
 * unparsed column) from ever reaching the wire, independent of whatever the
 * response-policy guard also happens to allow or ban.
 */
public record QuizMetadataDto(
        String quizId,
        String milestone,
        String summary,
        String image,
        String difficulty,
        List<String> facts,
        long questionCount
) {
}
