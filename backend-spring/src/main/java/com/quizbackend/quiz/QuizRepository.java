package com.quizbackend.quiz;

import com.quizbackend.quiz.entity.QuizEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

/**
 * Read-only access to the {@code quizzes} table, matching the Node
 * reference's {@code loadQuizBankFromDatabase} query exactly:
 * {@code WHERE status = 'active' ORDER BY display_order}.
 *
 * <p>Deliberately has NO {@code save}/{@code delete} caller anywhere in this
 * slice &mdash; {@link JpaRepository} exposes those methods, but nothing in
 * {@code QuizService} or {@code QuizController} invokes them. This slice is
 * read-only by construction, not merely by convention.
 *
 * <p>{@link #countQuestionsByQuizPks} avoids mapping a {@code Question}
 * entity purely to answer "how many questions does this quiz have" &mdash;
 * exactly the same restraint the Node reference migration audit asked for:
 * map only what a route genuinely needs. One native aggregate query answers
 * it for every quiz in the list endpoint in a single round trip, avoiding
 * N+1 without eager-loading a relationship that would otherwise go unused.
 */
public interface QuizRepository extends JpaRepository<QuizEntity, Long> {

    List<QuizEntity> findByStatusOrderByDisplayOrder(String status);

    Optional<QuizEntity> findByQuizIdAndStatus(String quizId, String status);

    /**
     * One question-count per quiz primary key, in a single query. Native SQL
     * rather than a mapped {@code Question} entity: the {@code questions}
     * table is real and large enough to matter for N+1, but this slice needs
     * nothing about it except the count.
     */
    @Query(value = "SELECT quiz_pk AS quizPk, COUNT(*) AS questionCount "
            + "FROM questions WHERE quiz_pk IN (:quizPks) GROUP BY quiz_pk",
            nativeQuery = true)
    List<QuestionCountProjection> countQuestionsByQuizPks(@Param("quizPks") List<Long> quizPks);

    interface QuestionCountProjection {
        Long getQuizPk();
        Long getQuestionCount();
    }
}
