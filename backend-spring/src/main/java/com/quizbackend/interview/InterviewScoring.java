package com.quizbackend.interview;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.UnaryOperator;

/**
 * Interview scoring — line-for-line port of the Node reference's {@code
 * result.scoring.ts}, itself a backend port of Angular's {@code
 * computeInterviewResult}.
 *
 * <p>PURE: takes the FROZEN session snapshot plus the persisted answers and
 * returns a complete result. It never reads the live quiz bank for
 * correctness, so a historical result can never drift when the canonical
 * bank changes after a session was created.
 *
 * <p>PORTED EXACTLY:
 * <ul>
 *   <li>correctness is EXACT SET EQUALITY ({@link #isSelectionCorrect}); an
 *       empty selection is incorrect, a missing correct option is incorrect,
 *       one extra incorrect option is incorrect — no partial credit, no
 *       per-type branching (a single-answer question is simply a
 *       one-element correct set).</li>
 *   <li>{@code incorrect = answered - correct}, NOT {@code total - correct}.</li>
 *   <li>{@code percentage = round(correct / total * 100)}, over TOTAL, not
 *       answered.</li>
 *   <li>per-topic buckets are grouped by the question's {@code sourceQuizId},
 *       with the SAME percentage formula per bucket.</li>
 * </ul>
 *
 * <p>DELIBERATE DIFFERENCE carried over from Node: the topic TITLE is
 * resolved via the caller-supplied {@code topicTitleFor}, which reads the
 * CURRENT (mutable) quiz bank at finalization time — not something frozen at
 * session creation. Once written into {@code result_json} it never changes
 * again, but at the moment of finalization it reflects whatever the live
 * bank currently calls that topic. This is Node's own explicit choice (a
 * later-renamed topic must not retroactively relabel an already-completed
 * attempt), not a Spring invention.
 */
public final class InterviewScoring {

    private InterviewScoring() {
    }

    public record ScoredInterview(
            int total, int answered, int unanswered, int correct, int incorrect, int percentage,
            List<FrozenTopicBucket> byTopic, List<FrozenReviewQuestion> review
    ) {
    }

    /**
     * EXACT SET EQUALITY. Applies uniformly to single/trueFalse/multiple —
     * there is no per-type branch, because a single-answer question simply
     * has a one-element correct set.
     */
    public static boolean isSelectionCorrect(List<Integer> correctOptionIds, List<Integer> selectedOptionIds) {
        Set<Integer> selected = new HashSet<>(selectedOptionIds);
        if (selected.isEmpty()) {
            return false; // unanswered is never correct
        }
        return selected.equals(new HashSet<>(correctOptionIds));
    }

    public static ScoredInterview scoreInterview(
            List<SessionQuestionSnapshot> questions,
            Map<Integer, List<Integer>> answersByPosition,
            UnaryOperator<String> topicTitleFor) {

        List<SessionQuestionSnapshot> ordered = new ArrayList<>(questions);
        ordered.sort(Comparator.comparingInt(SessionQuestionSnapshot::position));

        int correct = 0;
        int answered = 0;

        Map<String, int[]> buckets = new LinkedHashMap<>(); // [correct, incorrect, unanswered, total]
        List<FrozenReviewQuestion> review = new ArrayList<>(ordered.size());

        for (SessionQuestionSnapshot question : ordered) {
            List<SessionOptionSnapshot> options = new ArrayList<>(question.options());
            options.sort(Comparator.comparingInt(SessionOptionSnapshot::displayOrder));

            List<Integer> correctOptionIds = options.stream()
                    .filter(SessionOptionSnapshot::isCorrect)
                    .map(SessionOptionSnapshot::optionId)
                    .toList();
            List<Integer> selectedOptionIds = new ArrayList<>(
                    answersByPosition.getOrDefault(question.position(), List.of()));

            boolean isAnswered = !selectedOptionIds.isEmpty();
            boolean isCorrect = isSelectionCorrect(correctOptionIds, selectedOptionIds);

            if (isAnswered) {
                answered++;
            }
            if (isCorrect) {
                correct++;
            }

            int[] bucket = buckets.computeIfAbsent(question.sourceQuizId(), id -> new int[4]);
            bucket[3]++; // total
            if (!isAnswered) {
                bucket[2]++; // unanswered
            } else if (isCorrect) {
                bucket[0]++; // correct
            } else {
                bucket[1]++; // incorrect
            }

            List<FrozenReviewOption> reviewOptions = options.stream()
                    .map(option -> new FrozenReviewOption(option.optionId(), option.text()))
                    .toList();

            review.add(new FrozenReviewQuestion(
                    question.questionId(), question.sourceQuizId(), question.questionText(), question.type(),
                    reviewOptions, selectedOptionIds, correctOptionIds, question.explanation(),
                    question.flagged(), question.codeSnippet()));
        }

        int total = ordered.size();

        List<FrozenTopicBucket> byTopic = new ArrayList<>(buckets.size());
        for (Map.Entry<String, int[]> entry : buckets.entrySet()) {
            int[] b = entry.getValue();
            int bucketTotal = b[3];
            int bucketPercentage = bucketTotal > 0 ? (int) Math.round((b[0] / (double) bucketTotal) * 100) : 0;
            byTopic.add(new FrozenTopicBucket(
                    entry.getKey(), topicTitleFor.apply(entry.getKey()), b[0], b[1], b[2], bucketTotal, bucketPercentage));
        }

        int percentage = total > 0 ? (int) Math.round((correct / (double) total) * 100) : 0;

        return new ScoredInterview(total, answered, total - answered, correct, answered - correct, percentage,
                byTopic, review);
    }

    /**
     * Time used, matching the Angular timer exactly:
     * {@code remaining = max(0, ceil((expiresAt - now) / 1000))},
     * {@code timeUsed = max(0, durationSeconds - remaining)}.
     *
     * <p>{@code now} is clamped to {@code expiresAt} first, so a submission
     * after the deadline reports the FULL duration rather than more than the
     * assessment allowed.
     */
    public record TimeUsed(int timeUsedSeconds, int timeRemainingSeconds) {
    }

    public static TimeUsed computeTimeUsedSeconds(long now, long expiresAt, int durationSeconds) {
        long effectiveNow = Math.min(now, expiresAt);
        long timeRemainingSeconds = Math.max(0L, (long) Math.ceil((expiresAt - effectiveNow) / 1000.0));
        long timeUsedSeconds = Math.max(0L, Math.min(durationSeconds, durationSeconds - timeRemainingSeconds));
        return new TimeUsed((int) timeUsedSeconds, (int) timeRemainingSeconds);
    }
}
