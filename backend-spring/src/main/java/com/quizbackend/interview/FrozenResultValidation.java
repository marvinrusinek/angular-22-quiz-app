package com.quizbackend.interview;

/**
 * Port of the Node reference's {@code assertResultInvariants}. Asserted
 * before writing a frozen result, and again on every read — storage is not
 * trusted merely because this process wrote it.
 */
public final class FrozenResultValidation {

    private FrozenResultValidation() {
    }

    private static void fail(String message) {
        throw new FrozenResultException(message);
    }

    public static void assertInvariants(FrozenInterviewResult result) {
        if (!"submitted".equals(result.status())) {
            fail("result status must be submitted");
        }
        if (result.total() < 0) {
            fail("invalid total");
        }
        if (result.correct() + result.incorrect() + result.unanswered() != result.total()) {
            fail("correct + incorrect + unanswered must equal total");
        }
        if (result.answered() != result.correct() + result.incorrect()) {
            fail("answered must equal correct + incorrect");
        }
        if (result.answered() + result.unanswered() != result.total()) {
            fail("answered + unanswered must equal total");
        }
        if (result.percentage() < 0 || result.percentage() > 100) {
            fail("percentage out of range");
        }
        if (result.timeUsedSeconds() < 0 || result.timeUsedSeconds() > result.durationSeconds()) {
            fail("timeUsedSeconds out of range");
        }
        if (result.review().size() != result.total()) {
            fail("review length must equal total");
        }

        int bucketTotalSum = 0;
        for (FrozenTopicBucket bucket : result.performance().byTopic()) {
            if (bucket.correct() + bucket.incorrect() + bucket.unanswered() != bucket.total()) {
                fail("topic bucket \"" + bucket.topicId() + "\" totals do not add up");
            }
            bucketTotalSum += bucket.total();
        }
        if (bucketTotalSum != result.total()) {
            fail("topic buckets must cover every question");
        }
    }
}
