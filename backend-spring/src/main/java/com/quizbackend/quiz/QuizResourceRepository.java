package com.quizbackend.quiz;

import com.quizbackend.quiz.dto.QuizResourceDto;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;

/**
 * Read-only access to the {@code quiz_resources} table — the Results-page
 * "Brush up your knowledge" links. Port of the Node reference's {@code
 * loadQuizResourcesFromDatabase} ({@code backend/src/quiz/quiz.db-source.ts}),
 * scoped per-quiz rather than loaded in bulk at startup: unlike the
 * question bank (held fully in memory because Interview session creation
 * needs random access across every topic), resources are read only by this
 * one low-traffic route, so a per-request query is simpler and equally
 * correct.
 *
 * <p>An unknown quiz and a quiz with no resource rows both answer an empty
 * list here — the caller (the controller/service) distinguishes them via
 * the quiz-metadata lookup, exactly like the Node reference's own {@code
 * getResourcesForQuiz}, which needs no not-found signal of its own.
 */
@Repository
public class QuizResourceRepository {

    private static final String SELECT_RESOURCES = """
            SELECT r.title, r.url, r.host
              FROM quiz_resources r
              JOIN quizzes z ON z.id = r.quiz_pk
             WHERE z.quiz_id = ? AND z.status = 'active'
             ORDER BY r.display_order
            """;

    private final JdbcTemplate jdbcTemplate;

    public QuizResourceRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<QuizResourceDto> findByQuizId(String quizId) {
        return jdbcTemplate.query(SELECT_RESOURCES, (rs, rowNum) -> new QuizResourceDto(
                rs.getString("title"), rs.getString("url"), rs.getString("host")), quizId);
    }
}
