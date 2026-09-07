package com.quizbackend.quiz;

import com.quizbackend.quiz.dto.QuizMetadataDto;
import com.quizbackend.quiz.entity.QuizEntity;
import com.quizbackend.web.error.ApiException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Read-only quiz metadata, parity with the Node reference's
 * {@code createQuizRepositoryFromDatabase} + the {@code /quizzes} route
 * handlers in {@code quizzes.route.ts}.
 *
 * <p>Controller &rarr; Service &rarr; Repository &rarr; Entity, and
 * Entity &rarr; explicit DTO mapper &rarr; API DTO &rarr; response-policy
 * guard &rarr; JSON, exactly as required: this class is the ONLY place a
 * {@link QuizEntity} is read field-by-field into a
 * {@link QuizMetadataDto}. No repository {@code save}/{@code delete}/mutating
 * query is called anywhere in this class &mdash; {@code @Transactional(readOnly
 * = true)} states that intent to Hibernate; the real guarantee is that no
 * write method is ever invoked.
 */
@Service
public class QuizService {

    private static final String ACTIVE = "active";

    private final QuizRepository quizRepository;
    private final ObjectMapper objectMapper;

    public QuizService(QuizRepository quizRepository, ObjectMapper objectMapper) {
        this.quizRepository = quizRepository;
        this.objectMapper = objectMapper;
    }

    /**
     * Parity with {@code GET /api/quizzes}: every active quiz, in
     * {@code display_order}, as metadata only.
     *
     * <p>Two queries total regardless of quiz count &mdash; one for the
     * quizzes, one aggregate query for every quiz's question count &mdash;
     * mirroring the Node reference's own "fixed number of round trips
     * regardless of bank size" design.
     */
    @Transactional(readOnly = true)
    public List<QuizMetadataDto> listQuizMetadata() {
        List<QuizEntity> quizzes = quizRepository.findByStatusOrderByDisplayOrder(ACTIVE);
        Map<Long, Long> countsByQuizPk = questionCountsFor(quizzes);

        List<QuizMetadataDto> result = new ArrayList<>(quizzes.size());
        for (QuizEntity quiz : quizzes) {
            result.add(toDto(quiz, countsByQuizPk.getOrDefault(quiz.getId(), 0L)));
        }
        return result;
    }

    /**
     * Parity with {@code GET /api/quizzes/:quizId}: metadata for one quiz, or
     * {@link ApiException#notFound(String)} for both an unknown id AND a
     * retired quiz &mdash; the Node reference cannot distinguish the two
     * either, because a retired quiz is never loaded into
     * {@code getQuizMetadata()} in the first place.
     */
    @Transactional(readOnly = true)
    public QuizMetadataDto getQuizMetadata(String quizId) {
        QuizEntity quiz = quizRepository.findByQuizIdAndStatus(quizId, ACTIVE)
                .orElseThrow(() -> ApiException.notFound("Quiz not found"));
        long questionCount = quizRepository.countQuestionsByQuizPks(List.of(quiz.getId())).stream()
                .findFirst()
                .map(QuizRepository.QuestionCountProjection::getQuestionCount)
                .orElse(0L);
        return toDto(quiz, questionCount);
    }

    private Map<Long, Long> questionCountsFor(List<QuizEntity> quizzes) {
        if (quizzes.isEmpty()) {
            return Map.of();
        }
        List<Long> quizPks = quizzes.stream().map(QuizEntity::getId).toList();
        Map<Long, Long> counts = new HashMap<>();
        for (QuizRepository.QuestionCountProjection row : quizRepository.countQuestionsByQuizPks(quizPks)) {
            counts.put(row.getQuizPk(), row.getQuestionCount());
        }
        return counts;
    }

    /**
     * Field-by-field, matching {@code toQuizMetadataDto} in the Node
     * reference exactly. Never a spread of the entity — a column added to
     * {@code QuizEntity} later must not silently reach the wire.
     */
    private QuizMetadataDto toDto(QuizEntity quiz, long questionCount) {
        return new QuizMetadataDto(
                quiz.getQuizId(),
                quiz.getMilestone(),
                quiz.getSummary(),
                quiz.getImage(),
                quiz.getDifficulty(),
                parseFacts(quiz.getFactsJson()),
                questionCount
        );
    }

    /**
     * Parity with the Node reference's {@code parseFacts()}
     * ({@code quiz.db-source.ts}): null/blank or a parse failure both yield
     * an empty list rather than failing the request &mdash; this is
     * display-only trivia, not answer-key material, so a malformed value
     * must not break metadata delivery.
     */
    private List<String> parseFacts(String factsJson) {
        if (factsJson == null || factsJson.isBlank()) {
            return List.of();
        }
        try {
            JsonNode parsed = objectMapper.readTree(factsJson);
            if (!parsed.isArray()) {
                return List.of();
            }
            List<String> facts = new ArrayList<>();
            for (JsonNode element : parsed) {
                if (element.isString()) {
                    facts.add(element.asString());
                }
            }
            return facts;
        } catch (JacksonException malformed) {
            return List.of();
        }
    }
}
