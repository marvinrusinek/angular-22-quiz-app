package com.quizbackend.interview;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Read-only access to one topic's (quiz's) full question/option content —
 * the piece the Slice 2 {@code QuizEntity}/{@code QuizRepository} deliberately
 * did not map, because the two quiz-metadata endpoints never needed it.
 * Interview session creation does.
 *
 * <p>Derives {@code questionId}/{@code optionId} the SAME way the Node
 * reference does ({@code backend/src/quiz/quiz.ids.ts}): from the 0-based
 * POSITION of each row in {@code ORDER BY display_order}, never from the
 * stored {@code display_order} value itself, and never from
 * {@code legacy_question_id}/{@code legacy_option_id} (provenance-only
 * columns). This is deliberately two flat queries per topic rather than a
 * single join, mirroring the Node reference's own "fixed number of round
 * trips" reasoning in {@code quiz.db-source.ts}.
 *
 * <p>Question {@code type} is RE-DERIVED from option correctness/text via
 * {@link #deriveQuestionType}, exactly like the Node reference's
 * {@code deriveQuestionType()} — deliberately NOT read from the stored
 * {@code questions.question_type} column, because that is how the live Node
 * bank (which this must match) computes it; see
 * {@code quiz.db-source.ts}/{@code quiz.validation.ts}.
 */
@Repository
public class InterviewQuestionRepository {

    private static final String SELECT_QUESTIONS = """
            SELECT q.id AS question_pk, q.question_text, q.explanation, q.display_order,
                   q.code, q.code_language, q.code_filename
              FROM questions q
              JOIN quizzes z ON z.id = q.quiz_pk
             WHERE z.quiz_id = ? AND z.status = 'active'
             ORDER BY q.display_order
            """;

    private static final String SELECT_OPTIONS = """
            SELECT o.question_pk, o.option_text, o.display_order, o.is_correct
              FROM options o
              JOIN questions q ON q.id = o.question_pk
              JOIN quizzes z ON z.id = q.quiz_pk
             WHERE z.quiz_id = ? AND z.status = 'active'
             ORDER BY q.display_order, o.display_order
            """;

    private final JdbcTemplate jdbcTemplate;

    public InterviewQuestionRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<CandidateQuestion> findByQuizId(String quizId) {
        record QuestionRow(long questionPk, String questionText, String explanation,
                            String code, String codeLanguage, String codeFilename) {
        }
        record OptionRow(long questionPk, String optionText, boolean isCorrect) {
        }

        List<QuestionRow> questionRows = jdbcTemplate.query(SELECT_QUESTIONS,
                (rs, rowNum) -> new QuestionRow(
                        rs.getLong("question_pk"),
                        rs.getString("question_text"),
                        rs.getString("explanation"),
                        rs.getString("code"),
                        rs.getString("code_language"),
                        rs.getString("code_filename")),
                quizId);

        List<OptionRow> optionRows = jdbcTemplate.query(SELECT_OPTIONS,
                (rs, rowNum) -> new OptionRow(
                        rs.getLong("question_pk"),
                        rs.getString("option_text"),
                        rs.getInt("is_correct") == 1),
                quizId);

        Map<Long, List<OptionRow>> optionsByQuestionPk = new LinkedHashMap<>();
        for (OptionRow option : optionRows) {
            optionsByQuestionPk.computeIfAbsent(option.questionPk(), key -> new ArrayList<>()).add(option);
        }

        List<CandidateQuestion> result = new ArrayList<>(questionRows.size());
        for (int questionIndex = 0; questionIndex < questionRows.size(); questionIndex++) {
            QuestionRow row = questionRows.get(questionIndex);
            List<OptionRow> rawOptions = optionsByQuestionPk.getOrDefault(row.questionPk(), List.of());

            List<CandidateOption> options = new ArrayList<>(rawOptions.size());
            List<String> optionTexts = new ArrayList<>(rawOptions.size());
            int correctCount = 0;
            for (int optionIndex = 0; optionIndex < rawOptions.size(); optionIndex++) {
                OptionRow optionRow = rawOptions.get(optionIndex);
                options.add(new CandidateOption(
                        makeOptionId(questionIndex, optionIndex),
                        optionIndex,
                        optionRow.optionText(),
                        optionRow.isCorrect()));
                optionTexts.add(optionRow.optionText());
                if (optionRow.isCorrect()) {
                    correctCount++;
                }
            }

            CandidateCodeSnippet codeSnippet = row.code() == null
                    ? null
                    : new CandidateCodeSnippet(row.codeLanguage(), row.code(), row.codeFilename());

            result.add(new CandidateQuestion(
                    makeQuestionId(quizId, questionIndex),
                    quizId,
                    questionIndex,
                    row.questionText(),
                    deriveQuestionType(optionTexts, correctCount),
                    row.explanation(),
                    options,
                    codeSnippet));
        }

        return result;
    }

    /** Port of {@code makeQuestionId}: {@code <quizId>:q:<sourceQuestionIndex>}. Opaque outside this module. */
    static String makeQuestionId(String quizId, int sourceQuestionIndex) {
        return quizId + ":q:" + sourceQuestionIndex;
    }

    /** Port of {@code makeOptionId}: {@code (questionIndex + 1) * 100 + (optionIndex + 1)}. */
    static int makeOptionId(int sourceQuestionIndex, int sourceOptionIndex) {
        return (sourceQuestionIndex + 1) * 100 + (sourceOptionIndex + 1);
    }

    /** Port of {@code deriveQuestionType} — see the class javadoc for why this is re-derived, not read from a column. */
    static String deriveQuestionType(List<String> optionTexts, int correctCount) {
        if (correctCount > 1) {
            return "multiple";
        }
        if (optionTexts.size() == 2) {
            List<String> normalized = optionTexts.stream()
                    .map(text -> text.trim().toLowerCase(java.util.Locale.ROOT))
                    .sorted()
                    .toList();
            if (normalized.get(0).equals("false") && normalized.get(1).equals("true")) {
                return "trueFalse";
            }
        }
        return "single";
    }
}
