package com.quizbackend.interview;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Pure algorithm proof for {@link InterviewScoring} — the Node reference's
 * {@code result.scoring.ts}, unit-tested directly with no repository/DB
 * involvement since the function is a pure transform of a frozen snapshot.
 */
class InterviewScoringTest {

    private static SessionOptionSnapshot opt(int id, String text, int order, boolean correct) {
        return new SessionOptionSnapshot(id, text, order, correct);
    }

    private static SessionQuestionSnapshot question(int position, String questionId, String topic, String type,
            boolean flagged, List<SessionOptionSnapshot> options) {
        return new SessionQuestionSnapshot(position, questionId, topic, questionId + " text?", type,
                questionId + " explanation", options, flagged, null);
    }

    // ── exact-set-equality correctness — InterviewScoring.isSelectionCorrect ──

    @Test
    void emptySelectionIsNeverCorrectEvenIfTheCorrectSetIsAlsoEmpty() {
        assertThat(InterviewScoring.isSelectionCorrect(List.of(), List.of())).isFalse();
    }

    @Test
    void exactMatchIsCorrectRegardlessOfSelectionOrder() {
        assertThat(InterviewScoring.isSelectionCorrect(List.of(101, 102), List.of(102, 101))).isTrue();
    }

    @Test
    void missingOneOfTwoCorrectOptionsIsIncorrect() {
        assertThat(InterviewScoring.isSelectionCorrect(List.of(101, 102), List.of(101))).isFalse();
    }

    @Test
    void oneExtraIncorrectOptionMakesAnOtherwiseCompleteSelectionIncorrect() {
        assertThat(InterviewScoring.isSelectionCorrect(List.of(101, 102), List.of(101, 102, 103))).isFalse();
    }

    @Test
    void aSingleAnswerQuestionIsJustAOneElementCorrectSetNoSpecialCasing() {
        assertThat(InterviewScoring.isSelectionCorrect(List.of(101), List.of(101))).isTrue();
        assertThat(InterviewScoring.isSelectionCorrect(List.of(101), List.of(102))).isFalse();
    }

    @Test
    void duplicateSelectedIdsCollapseUnderSetSemantics() {
        // The repository layer already de-duplicates before this point, but the
        // scoring function itself must not be fooled by a duplicate either.
        assertThat(InterviewScoring.isSelectionCorrect(List.of(101), List.of(101, 101))).isTrue();
    }

    // ── scoreInterview: totals / answered / incorrect = answered - correct ──

    @Test
    void unansweredQuestionsCountTowardTotalButNeitherCorrectNorIncorrect() {
        List<SessionQuestionSnapshot> questions = List.of(
                question(0, "q0", "topicA", "single", false, List.of(opt(101, "a", 0, true), opt(102, "b", 1, false))),
                question(1, "q1", "topicA", "single", false, List.of(opt(201, "a", 0, true), opt(202, "b", 1, false))));

        InterviewScoring.ScoredInterview scored = InterviewScoring.scoreInterview(
                questions, Map.of(0, List.of(101)), id -> id);

        assertThat(scored.total()).isEqualTo(2);
        assertThat(scored.answered()).isEqualTo(1);
        assertThat(scored.unanswered()).isEqualTo(1);
        assertThat(scored.correct()).isEqualTo(1);
        // incorrect = answered - correct, NOT total - correct: the unanswered
        // question must not be double-counted as "incorrect".
        assertThat(scored.incorrect()).isEqualTo(0);
    }

    @Test
    void anAnsweredButWrongQuestionCountsAsIncorrectNotUnanswered() {
        List<SessionQuestionSnapshot> questions = List.of(
                question(0, "q0", "topicA", "single", false, List.of(opt(101, "a", 0, true), opt(102, "b", 1, false))));

        InterviewScoring.ScoredInterview scored = InterviewScoring.scoreInterview(
                questions, Map.of(0, List.of(102)), id -> id);

        assertThat(scored.answered()).isEqualTo(1);
        assertThat(scored.unanswered()).isEqualTo(0);
        assertThat(scored.correct()).isEqualTo(0);
        assertThat(scored.incorrect()).isEqualTo(1);
    }

    @Test
    void markedForReviewNeverAffectsScoringOnlyRidesAlongInTheReviewEntry() {
        List<SessionQuestionSnapshot> questions = List.of(
                question(0, "q0", "topicA", "single", true, List.of(opt(101, "a", 0, true), opt(102, "b", 1, false))));

        InterviewScoring.ScoredInterview scored = InterviewScoring.scoreInterview(
                questions, Map.of(0, List.of(101)), id -> id);

        assertThat(scored.correct()).isEqualTo(1);
        assertThat(scored.review().get(0).flagged()).isTrue();
    }

    @Test
    void questionOrderInTheReviewFollowsPositionRegardlessOfInputOrder() {
        List<SessionQuestionSnapshot> outOfOrder = List.of(
                question(2, "q2", "topicA", "single", false, List.of(opt(301, "a", 0, true))),
                question(0, "q0", "topicA", "single", false, List.of(opt(101, "a", 0, true))),
                question(1, "q1", "topicA", "single", false, List.of(opt(201, "a", 0, true))));

        InterviewScoring.ScoredInterview scored = InterviewScoring.scoreInterview(outOfOrder, Map.of(), id -> id);

        assertThat(scored.review()).extracting("questionId").containsExactly("q0", "q1", "q2");
    }

    @Test
    void optionsWithinAQuestionAreOrderedByDisplayOrderNotInsertionOrder() {
        List<SessionQuestionSnapshot> questions = List.of(
                question(0, "q0", "topicA", "multiple", false, List.of(
                        opt(103, "c", 2, false), opt(101, "a", 0, true), opt(102, "b", 1, true))));

        InterviewScoring.ScoredInterview scored = InterviewScoring.scoreInterview(questions, Map.of(), id -> id);

        assertThat(scored.review().get(0).options()).extracting("optionId").containsExactly(101, 102, 103);
        // correctOptionIds is also derived post-sort, in displayOrder.
        assertThat(scored.review().get(0).correctOptionIds()).containsExactly(101, 102);
    }

    // ── per-topic bucket aggregation ─────────────────────────────────────

    @Test
    void bucketsGroupBySourceQuizIdIndependentlyOfQuestionOrder() {
        List<SessionQuestionSnapshot> questions = List.of(
                question(0, "q0", "signals", "single", false, List.of(opt(101, "a", 0, true))),
                question(1, "q1", "rxjs", "single", false, List.of(opt(201, "a", 0, true))),
                question(2, "q2", "signals", "single", false, List.of(opt(301, "a", 0, true))));

        InterviewScoring.ScoredInterview scored = InterviewScoring.scoreInterview(
                questions, Map.of(0, List.of(101), 1, List.of(201), 2, List.of(999)), id -> "Title:" + id);

        assertThat(scored.byTopic()).hasSize(2);
        var signals = scored.byTopic().stream().filter(b -> b.topicId().equals("signals")).findFirst().orElseThrow();
        var rxjs = scored.byTopic().stream().filter(b -> b.topicId().equals("rxjs")).findFirst().orElseThrow();

        assertThat(signals.total()).isEqualTo(2);
        assertThat(signals.correct()).isEqualTo(1);
        assertThat(signals.incorrect()).isEqualTo(1);
        assertThat(signals.title()).isEqualTo("Title:signals");

        assertThat(rxjs.total()).isEqualTo(1);
        assertThat(rxjs.correct()).isEqualTo(1);
    }

    @Test
    void topicTitleResolverIsCalledPerBucketNotPerQuestion() {
        List<SessionQuestionSnapshot> questions = List.of(
                question(0, "q0", "signals", "single", false, List.of(opt(101, "a", 0, true))),
                question(1, "q1", "signals", "single", false, List.of(opt(201, "a", 0, true))));

        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        InterviewScoring.scoreInterview(questions, Map.of(), topicId -> {
            calls.incrementAndGet();
            return topicId;
        });

        assertThat(calls.get()).isEqualTo(1);
    }

    // ── percentage = round(correct / total * 100), over TOTAL not answered ──

    @Test
    void percentageIsComputedOverTotalNotAnsweredCount() {
        List<SessionQuestionSnapshot> questions = List.of(
                question(0, "q0", "t", "single", false, List.of(opt(101, "a", 0, true))),
                question(1, "q1", "t", "single", false, List.of(opt(201, "a", 0, true))),
                question(2, "q2", "t", "single", false, List.of(opt(301, "a", 0, true))),
                question(3, "q3", "t", "single", false, List.of(opt(401, "a", 0, true))));

        // Only 2 of 4 answered; both answered ones are correct. If percentage
        // were computed over "answered" this would read 100, not 50.
        InterviewScoring.ScoredInterview scored = InterviewScoring.scoreInterview(
                questions, Map.of(0, List.of(101), 1, List.of(201)), id -> id);

        assertThat(scored.percentage()).isEqualTo(50);
    }

    @Test
    void zeroQuestionsProducesZeroPercentageWithoutDividingByZero() {
        InterviewScoring.ScoredInterview scored = InterviewScoring.scoreInterview(List.of(), Map.of(), id -> id);
        assertThat(scored.percentage()).isEqualTo(0);
        assertThat(scored.total()).isEqualTo(0);
    }

    /**
     * Java's {@code Math.round(double)} vs JavaScript's {@code Math.round}
     * for the ONLY domain that ever occurs here: {@code correct/total*100}
     * with {@code 0 <= correct <= total} and {@code total > 0}, i.e. always
     * non-negative. Per the JDK 21 {@code Math.round(double)} spec: "the
     * result is the integer closest to the argument; if two integers are
     * equally close, then the result is the larger" — that is, exact halves
     * round UP (toward +Infinity). JavaScript's {@code Math.round} is
     * specified identically for non-negative inputs (equivalent to
     * {@code floor(x + 0.5)}, which also rounds an exact half up). Both
     * languages perform the SAME IEEE-754 double division and multiplication
     * in the same order ({@code (correct / total) * 100}), so the double
     * handed to the rounding step is bit-identical between the two runtimes;
     * the two languages' rounding rules then agree because both round
     * non-negative halves up. This is proven below both on exact-half
     * fractions (the only case where a rounding-direction MISMATCH could
     * ever matter) and on repeating-decimal fractions (thirds/sixths/
     * sevenths) that stress the non-half case.
     */
    @ParameterizedTest(name = "{0}/{1} correct -> {2}%")
    @CsvSource({
            // exact halves — the only inputs where "round half up" vs "round
            // half to even" vs "round half down" could ever disagree.
            "1,8,13",   // 12.5   -> 13
            "3,8,38",   // 37.5   -> 38
            "5,8,63",   // 62.5   -> 63 (round-half-EVEN would give 62 — must NOT happen)
            "7,8,88",   // 87.5   -> 88
            "1,2,50",   // 50.0   -> 50 (not a half-rounding case, sanity check)
            // repeating decimals — ordinary (non-half) rounding.
            "1,3,33",   // 33.333...  -> 33
            "2,3,67",   // 66.666...  -> 67
            "1,6,17",   // 16.666...  -> 17
            "5,6,83",   // 83.333...  -> 83
            "1,7,14",   // 14.2857... -> 14
            "2,7,29",   // 28.5714... -> 29
            "3,7,43",   // 42.8571... -> 43
            // boundaries
            "0,5,0",
            "5,5,100",
    })
    void percentageRoundingMatchesJavaScriptMathRoundForEveryNonNegativeCaseThatCanOccur(
            int correct, int total, int expectedPercentage) {
        List<SessionQuestionSnapshot> questions = new java.util.ArrayList<>();
        Map<Integer, List<Integer>> answers = new java.util.LinkedHashMap<>();
        for (int i = 0; i < total; i++) {
            questions.add(question(i, "q" + i, "t", "single", false,
                    List.of(opt(1000 + i, "a", 0, true), opt(2000 + i, "b", 1, false))));
            // The first `correct` questions are answered correctly; the rest
            // (up to `total`) are answered WRONG, so answered == total and
            // percentage is exercised purely through the correct/total ratio
            // rather than being conflated with the "unanswered" path.
            answers.put(i, List.of(i < correct ? 1000 + i : 2000 + i));
        }

        InterviewScoring.ScoredInterview scored = InterviewScoring.scoreInterview(questions, answers, id -> id);

        assertThat(scored.percentage()).isEqualTo(expectedPercentage);
        // Cross-check against the raw formula directly, independent of the
        // question-building above, to isolate the rounding step itself.
        int direct = (int) Math.round((correct / (double) total) * 100);
        assertThat(direct).isEqualTo(expectedPercentage);
    }

    // ── computeTimeUsedSeconds ────────────────────────────────────────────

    @Test
    void timeUsedIsFullDurationWhenSubmittedExactlyAtOrAfterTheDeadline() {
        InterviewScoring.TimeUsed timing = InterviewScoring.computeTimeUsedSeconds(2_000L, 1_000L, 1200);
        assertThat(timing.timeRemainingSeconds()).isEqualTo(0);
        assertThat(timing.timeUsedSeconds()).isEqualTo(1200);
    }

    @Test
    void timeUsedReflectsElapsedTimeWhenSubmittedEarly() {
        // duration 1200s, submitted with 200s remaining -> 1000s used.
        long expiresAt = 1_700_000_200_000L;
        long now = expiresAt - 200_000L;
        InterviewScoring.TimeUsed timing = InterviewScoring.computeTimeUsedSeconds(now, expiresAt, 1200);
        assertThat(timing.timeRemainingSeconds()).isEqualTo(200);
        assertThat(timing.timeUsedSeconds()).isEqualTo(1000);
    }

    @Test
    void nowAfterExpiresAtIsClampedToExpiresAtRatherThanReportingOvertime() {
        long expiresAt = 1_700_000_000_000L;
        long now = expiresAt + 60_000L; // one minute past the deadline
        InterviewScoring.TimeUsed timing = InterviewScoring.computeTimeUsedSeconds(now, expiresAt, 1200);
        assertThat(timing.timeRemainingSeconds()).isEqualTo(0);
        assertThat(timing.timeUsedSeconds()).isEqualTo(1200);
    }
}
