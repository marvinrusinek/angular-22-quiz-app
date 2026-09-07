package com.quizbackend.interview;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Structural proof for {@link FrozenResultValidation} — port of the Node
 * reference's {@code assertResultInvariants}. Each test breaks exactly ONE
 * invariant so a passing suite proves every individual check actually fires,
 * not just that SOME check exists.
 */
class FrozenResultValidationTest {

    private static FrozenReviewQuestion reviewQuestion(int id) {
        return new FrozenReviewQuestion("q" + id, "topic", "text", "single",
                List.of(new FrozenReviewOption(1, "a")), List.of(1), List.of(1), "because", false, null);
    }

    private static FrozenInterviewResult validResult() {
        return new FrozenInterviewResult(
                "is_abc", "submitted", 1_000L, false,
                2, 2, 0, 2, 0, 100,
                1200, 600, 600,
                new FrozenResultConfig("custom", null, "junior", List.of("signals"), 2),
                new FrozenPerformance(List.of(new FrozenTopicBucket("signals", "Signals", 2, 0, 0, 2, 100))),
                List.of(reviewQuestion(0), reviewQuestion(1)));
    }

    @Test
    void aWellFormedResultPassesEveryInvariant() {
        assertThatCode(() -> FrozenResultValidation.assertInvariants(validResult())).doesNotThrowAnyException();
    }

    @Test
    void statusMustBeSubmitted() {
        FrozenInterviewResult result = withStatus(validResult(), "active");
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("status");
    }

    @Test
    void totalMustNotBeNegative() {
        FrozenInterviewResult result = new FrozenInterviewResult(
                "is_abc", "submitted", 1_000L, false,
                -1, 0, 0, 0, 0, 0,
                1200, 0, 1200,
                new FrozenResultConfig("custom", null, "junior", List.of(), 0),
                new FrozenPerformance(List.of()), List.of());
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("total");
    }

    @Test
    void correctPlusIncorrectPlusUnansweredMustEqualTotal() {
        FrozenInterviewResult base = validResult();
        FrozenInterviewResult result = new FrozenInterviewResult(
                base.sessionId(), base.status(), base.submittedAt(), base.submittedByExpiry(),
                base.total(), base.answered(), base.unanswered(), /* correct */ 3, base.incorrect(), base.percentage(),
                base.durationSeconds(), base.timeUsedSeconds(), base.timeRemainingSeconds(),
                base.config(), base.performance(), base.review());
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("correct + incorrect + unanswered");
    }

    @Test
    void answeredMustEqualCorrectPlusIncorrect() {
        FrozenInterviewResult base = validResult();
        FrozenInterviewResult result = new FrozenInterviewResult(
                base.sessionId(), base.status(), base.submittedAt(), base.submittedByExpiry(),
                base.total(), /* answered */ 3, base.unanswered(), base.correct(), base.incorrect(), base.percentage(),
                base.durationSeconds(), base.timeUsedSeconds(), base.timeRemainingSeconds(),
                base.config(), base.performance(), base.review());
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("answered must equal correct + incorrect");
    }

    /**
     * "answered + unanswered == total" is mathematically ENTAILED by the two
     * checks before it ({@code correct+incorrect+unanswered==total} and
     * {@code answered==correct+incorrect}): substituting the second into the
     * first yields exactly this third one. There is therefore no input that
     * satisfies both prior invariants while violating this one — breaking
     * {@code total} alone breaks the FIRST check, which fires first. This
     * test proves that fail-fast behavior rather than a false isolation.
     */
    @Test
    void aTotalInconsistentWithTheOtherFieldsIsCaughtByTheEarlierCorrectIncorrectUnansweredCheck() {
        FrozenInterviewResult base = validResult();
        FrozenInterviewResult result = new FrozenInterviewResult(
                base.sessionId(), base.status(), base.submittedAt(), base.submittedByExpiry(),
                /* total */ 5, base.answered(), base.unanswered(), base.correct(), base.incorrect(), base.percentage(),
                base.durationSeconds(), base.timeUsedSeconds(), base.timeRemainingSeconds(),
                base.config(), base.performance(), base.review());
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("correct + incorrect + unanswered");
    }

    @Test
    void percentageMustBeWithinZeroToOneHundred() {
        FrozenInterviewResult base = validResult();
        FrozenInterviewResult result = new FrozenInterviewResult(
                base.sessionId(), base.status(), base.submittedAt(), base.submittedByExpiry(),
                base.total(), base.answered(), base.unanswered(), base.correct(), base.incorrect(), /* percentage */ 101,
                base.durationSeconds(), base.timeUsedSeconds(), base.timeRemainingSeconds(),
                base.config(), base.performance(), base.review());
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("percentage");
    }

    @Test
    void timeUsedSecondsMustNotExceedDurationSeconds() {
        FrozenInterviewResult base = validResult();
        FrozenInterviewResult result = new FrozenInterviewResult(
                base.sessionId(), base.status(), base.submittedAt(), base.submittedByExpiry(),
                base.total(), base.answered(), base.unanswered(), base.correct(), base.incorrect(), base.percentage(),
                base.durationSeconds(), /* timeUsedSeconds */ base.durationSeconds() + 1, base.timeRemainingSeconds(),
                base.config(), base.performance(), base.review());
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("timeUsedSeconds");
    }

    @Test
    void timeUsedSecondsMustNotBeNegative() {
        FrozenInterviewResult base = validResult();
        FrozenInterviewResult result = new FrozenInterviewResult(
                base.sessionId(), base.status(), base.submittedAt(), base.submittedByExpiry(),
                base.total(), base.answered(), base.unanswered(), base.correct(), base.incorrect(), base.percentage(),
                base.durationSeconds(), /* timeUsedSeconds */ -1, base.timeRemainingSeconds(),
                base.config(), base.performance(), base.review());
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("timeUsedSeconds");
    }

    @Test
    void reviewLengthMustEqualTotal() {
        FrozenInterviewResult base = validResult();
        FrozenInterviewResult result = new FrozenInterviewResult(
                base.sessionId(), base.status(), base.submittedAt(), base.submittedByExpiry(),
                base.total(), base.answered(), base.unanswered(), base.correct(), base.incorrect(), base.percentage(),
                base.durationSeconds(), base.timeUsedSeconds(), base.timeRemainingSeconds(),
                base.config(), base.performance(), List.of(reviewQuestion(0))); // only 1, total is 2
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("review length");
    }

    @Test
    void eachTopicBucketsPartsMustSumToItsOwnTotal() {
        FrozenInterviewResult base = validResult();
        FrozenInterviewResult result = new FrozenInterviewResult(
                base.sessionId(), base.status(), base.submittedAt(), base.submittedByExpiry(),
                base.total(), base.answered(), base.unanswered(), base.correct(), base.incorrect(), base.percentage(),
                base.durationSeconds(), base.timeUsedSeconds(), base.timeRemainingSeconds(),
                base.config(),
                new FrozenPerformance(List.of(new FrozenTopicBucket("signals", "Signals", 1, 0, 0, /* total */ 2, 100))),
                base.review());
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("totals do not add up");
    }

    @Test
    void theSumOfAllBucketTotalsMustCoverEveryQuestion() {
        FrozenInterviewResult base = validResult();
        FrozenInterviewResult result = new FrozenInterviewResult(
                base.sessionId(), base.status(), base.submittedAt(), base.submittedByExpiry(),
                base.total(), base.answered(), base.unanswered(), base.correct(), base.incorrect(), base.percentage(),
                base.durationSeconds(), base.timeUsedSeconds(), base.timeRemainingSeconds(),
                base.config(),
                // one bucket, internally consistent (1 correct of 1), but total=2 overall.
                new FrozenPerformance(List.of(new FrozenTopicBucket("signals", "Signals", 1, 0, 0, 1, 100))),
                base.review());
        assertThatThrownBy(() -> FrozenResultValidation.assertInvariants(result))
                .isInstanceOf(FrozenResultException.class)
                .hasMessageContaining("must cover every question");
    }

    private static FrozenInterviewResult withStatus(FrozenInterviewResult base, String status) {
        return new FrozenInterviewResult(
                base.sessionId(), status, base.submittedAt(), base.submittedByExpiry(),
                base.total(), base.answered(), base.unanswered(), base.correct(), base.incorrect(), base.percentage(),
                base.durationSeconds(), base.timeUsedSeconds(), base.timeRemainingSeconds(),
                base.config(), base.performance(), base.review());
    }
}
