package com.quizbackend.quiz.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * JPA mapping of the EXISTING {@code quizzes} table
 * ({@code backend/src/db/migrations/002_quiz_bank.sql}). PostgreSQL is
 * canonical here &mdash; this class describes that schema, it does not define
 * one. {@code spring.jpa.hibernate.ddl-auto=validate} means Hibernate will
 * refuse to start rather than silently reconcile a mismatch by altering the
 * database.
 *
 * <p>Deliberately does NOT map {@code display_order} beyond persistence use
 * (ordering is applied via the repository query, not read by callers) and
 * does NOT map {@code question_key}/{@code option_key} equivalents &mdash;
 * this slice targets only {@code GET /api/quizzes} and
 * {@code GET /api/quizzes/{quizId}}, which return quiz METADATA only, never
 * questions or options. See {@code QuizRepository} for how the per-quiz
 * question count is obtained without mapping a {@code Question} entity.
 *
 * <p>This is a PERSISTENCE MODEL ONLY. It must never be returned from a
 * controller &mdash; see {@code QuizService} for the explicit field-by-field
 * mapping into {@link com.quizbackend.quiz.dto.QuizMetadataDto}, mirroring
 * the Node reference's {@code quiz.dto.ts} discipline of never spreading a
 * private model into a DTO.
 */
@Entity
@Table(name = "quizzes")
public class QuizEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id")
    private Long id;

    @Column(name = "quiz_id", nullable = false, unique = true)
    private String quizId;

    @Column(name = "milestone", nullable = false)
    private String milestone;

    @Column(name = "summary", nullable = false)
    private String summary;

    @Column(name = "image", nullable = false)
    private String image;

    /** Nullable — the schema permits a quiz with no declared difficulty. */
    @Column(name = "difficulty")
    private String difficulty;

    /**
     * Raw JSON-array-of-strings TEXT column, exactly as PostgreSQL stores it.
     * Parsed by {@code QuizService}, not here — an entity is a persistence
     * model, not a place for response-shaping logic.
     */
    @Column(name = "facts_json", nullable = false)
    private String factsJson;

    /** Read-only ordering key; not exposed on any DTO. */
    @Column(name = "display_order", nullable = false)
    private Integer displayOrder;

    /** {@code 'active' | 'retired'}; the repository queries only {@code 'active'}. */
    @Column(name = "status", nullable = false)
    private String status;

    protected QuizEntity() {
        // JPA requires a no-arg constructor. Package-private/protected only —
        // never used directly by application code.
    }

    /**
     * Explicit, fully-specified construction — used by tests to build a
     * known {@code QuizEntity} without a database, so {@code QuizService}'s
     * mapping logic (facts parsing, count merging) can be unit-tested without
     * a Spring context or a real connection. Never used by JPA itself, which
     * always goes through the no-arg constructor above via reflection.
     */
    public QuizEntity(Long id, String quizId, String milestone, String summary, String image,
            String difficulty, String factsJson, Integer displayOrder, String status) {
        this.id = id;
        this.quizId = quizId;
        this.milestone = milestone;
        this.summary = summary;
        this.image = image;
        this.difficulty = difficulty;
        this.factsJson = factsJson;
        this.displayOrder = displayOrder;
        this.status = status;
    }

    public Long getId() {
        return id;
    }

    public String getQuizId() {
        return quizId;
    }

    public String getMilestone() {
        return milestone;
    }

    public String getSummary() {
        return summary;
    }

    public String getImage() {
        return image;
    }

    public String getDifficulty() {
        return difficulty;
    }

    public String getFactsJson() {
        return factsJson;
    }

    public Integer getDisplayOrder() {
        return displayOrder;
    }

    public String getStatus() {
        return status;
    }
}
