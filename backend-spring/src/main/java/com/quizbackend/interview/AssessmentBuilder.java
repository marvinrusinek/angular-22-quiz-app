package com.quizbackend.interview;

import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.entity.QuizEntity;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Backend port of Angular's {@code AssessmentBuilderService.build()} (the
 * CUSTOM path), matching the Node reference's {@code assessment.builder.ts}
 * line for line: topic ids de-duplicated (order preserved) and REJECTED on
 * duplicate (not silently collapsed, unlike Angular); unknown topic ids
 * rejected explicitly; topic/difficulty consistency enforced; even-split
 * allocation with remainder to the first topics in caller order, capped by
 * capacity, leftover round-robinned to topics with spare capacity; per-topic
 * shuffle then take-first-N; final shuffle of the combined selection;
 * per-question option shuffle with "All of the above" pinned last AFTER
 * shuffling; duration from a fixed count-to-seconds table.
 */
@Component
public class AssessmentBuilder {

    public static final List<Integer> CUSTOM_QUESTION_COUNTS = List.of(10, 20, 30);

    private static final Map<Integer, Integer> DURATION_SECONDS_BY_COUNT = Map.of(
            10, 15 * 60,
            20, 30 * 60,
            30, 45 * 60
    );

    private final QuizRepository quizRepository;
    private final InterviewQuestionRepository questionRepository;

    public AssessmentBuilder(QuizRepository quizRepository, InterviewQuestionRepository questionRepository) {
        this.quizRepository = quizRepository;
        this.questionRepository = questionRepository;
    }

    /** Raw, untrusted input — mirrors the Node reference's {@code InterviewBuildRequest}. */
    public record BuildRequest(String difficulty, List<String> topicIds, Integer questionCount) {
    }

    private static void fail(AssessmentBuildException.Code code, String message) {
        throw new AssessmentBuildException(code, message);
    }

    private static List<String> dedupe(List<String> ids) {
        return new ArrayList<>(new LinkedHashSet<>(ids));
    }

    /**
     * Validate and normalize a raw custom-mode request. Difficulty is
     * normalized HERE and nowhere else, matching the Node reference.
     */
    public InterviewBuildConfig validateBuildRequest(BuildRequest request) {
        if (request.difficulty() == null || request.difficulty().isBlank()) {
            fail(AssessmentBuildException.Code.INVALID_CONFIG, "difficulty is required");
        }
        String difficulty = request.difficulty().trim().toLowerCase(java.util.Locale.ROOT);
        boolean mixed = difficulty.equals("mixed");
        if (!mixed && QuizDifficulty.fromWireValue(difficulty) == null) {
            fail(AssessmentBuildException.Code.INVALID_CONFIG, "unsupported difficulty \"" + difficulty + "\"");
        }

        List<String> rawTopics = request.topicIds();
        if (rawTopics == null || rawTopics.isEmpty()) {
            fail(AssessmentBuildException.Code.INVALID_CONFIG, "at least one topic must be selected");
        }
        for (String id : rawTopics) {
            if (id == null || id.trim().isEmpty()) {
                fail(AssessmentBuildException.Code.INVALID_CONFIG, "every topic id must be a non-empty string");
            }
        }

        List<String> trimmed = rawTopics.stream().map(String::trim).toList();
        List<String> topicIds = dedupe(trimmed);
        if (topicIds.size() != trimmed.size()) {
            fail(AssessmentBuildException.Code.INVALID_CONFIG, "topicIds contains duplicates");
        }

        for (String topicId : topicIds) {
            Optional<QuizEntity> quiz = quizRepository.findByQuizIdAndStatus(topicId, "active");
            if (quiz.isEmpty()) {
                fail(AssessmentBuildException.Code.UNKNOWN_TOPIC, "unknown topic \"" + topicId + "\"");
            }
            if (!mixed && !quiz.get().getDifficulty().equals(difficulty)) {
                fail(AssessmentBuildException.Code.TOPIC_DIFFICULTY_MISMATCH,
                        "topic \"" + topicId + "\" is not available at difficulty \"" + difficulty + "\"");
            }
        }

        Integer rawCount = request.questionCount();
        if (rawCount == null || !CUSTOM_QUESTION_COUNTS.contains(rawCount)) {
            fail(AssessmentBuildException.Code.INVALID_CONFIG,
                    "questionCount must be one of " + CUSTOM_QUESTION_COUNTS + " — received " + rawCount);
        }
        int questionCount = rawCount;

        int available = 0;
        Map<String, List<CandidateQuestion>> poolsForAvailability = new LinkedHashMap<>();
        for (String topicId : topicIds) {
            List<CandidateQuestion> pool = questionRepository.findByQuizId(topicId);
            poolsForAvailability.put(topicId, pool);
            available += pool.size();
        }
        if (available < questionCount) {
            fail(AssessmentBuildException.Code.INSUFFICIENT_QUESTIONS,
                    "only " + available + " questions available for " + questionCount + " requested");
        }

        return new InterviewBuildConfig(difficulty, topicIds, questionCount,
                DURATION_SECONDS_BY_COUNT.get(questionCount), null, null);
    }

    /**
     * EXACT port of {@code allocate()}: even split; remainder to the FIRST
     * topics in caller order; every target capped by capacity; leftover
     * handed out round-robin to topics with spare capacity.
     */
    public static Map<String, Integer> allocate(List<String> topicIds, Map<String, Integer> capacityById, int count) {
        Map<String, Integer> allocation = new LinkedHashMap<>();
        for (String id : topicIds) {
            allocation.put(id, 0);
        }

        int base = count / topicIds.size();
        int remainder = count % topicIds.size();

        for (int index = 0; index < topicIds.size(); index++) {
            String id = topicIds.get(index);
            int target = base + (index < remainder ? 1 : 0);
            allocation.put(id, Math.min(target, capacityById.getOrDefault(id, 0)));
        }

        int assigned = allocation.values().stream().mapToInt(Integer::intValue).sum();
        while (assigned < count) {
            List<String> spare = topicIds.stream()
                    .filter(id -> capacityById.getOrDefault(id, 0) - allocation.getOrDefault(id, 0) > 0)
                    .toList();
            if (spare.isEmpty()) {
                break; // unreachable once availability is checked
            }
            for (String id : spare) {
                if (assigned >= count) {
                    break;
                }
                allocation.put(id, allocation.get(id) + 1);
                assigned++;
            }
        }

        return allocation;
    }

    /**
     * Shuffle a question's options, then pin "All of the above" last — same
     * order of operations as Angular's {@code shuffleOptions()}. {@code
     * displayOrder} is re-stamped from the final position; {@code optionId}
     * never changes.
     */
    public static List<GeneratedOptionSnapshot> orderOptions(CandidateQuestion question, RandomSource random) {
        List<CandidateOption> shuffled = AssessmentRandom.shuffleInPlace(new ArrayList<>(question.options()), random);
        List<CandidateOption> pinned = pinAllOfTheAboveLast(shuffled);

        List<GeneratedOptionSnapshot> result = new ArrayList<>(pinned.size());
        for (int index = 0; index < pinned.size(); index++) {
            CandidateOption option = pinned.get(index);
            result.add(new GeneratedOptionSnapshot(option.optionId(), option.text(), index, option.isCorrect()));
        }
        return result;
    }

    /**
     * Port of Angular's {@code pinAllOfTheAboveLast}. Moves EVERY matching
     * option to the end, preserving the relative order of the rest.
     */
    private static List<CandidateOption> pinAllOfTheAboveLast(List<CandidateOption> items) {
        if (items.size() < 2) {
            return items;
        }
        boolean anyMatch = items.stream().anyMatch(item -> AllOfTheAbove.isAllOfTheAbove(item.text()));
        if (!anyMatch) {
            return items;
        }
        List<CandidateOption> result = new ArrayList<>(items.size());
        for (CandidateOption item : items) {
            if (!AllOfTheAbove.isAllOfTheAbove(item.text())) {
                result.add(item);
            }
        }
        for (CandidateOption item : items) {
            if (AllOfTheAbove.isAllOfTheAbove(item.text())) {
                result.add(item);
            }
        }
        return result;
    }

    public GeneratedInterviewSnapshot buildInterviewAssessment(InterviewBuildConfig config, RandomSource random) {
        List<String> topicIds = config.topicIds();

        Map<String, List<CandidateQuestion>> pools = new LinkedHashMap<>();
        for (String id : topicIds) {
            pools.put(id, new ArrayList<>(questionRepository.findByQuizId(id)));
        }

        Map<String, Integer> capacity = new LinkedHashMap<>();
        pools.forEach((id, list) -> capacity.put(id, list.size()));
        Map<String, Integer> allocation = allocate(topicIds, capacity, config.questionCount());

        List<CandidateQuestion> picked = new ArrayList<>();
        for (String topicId : topicIds) {
            int take = allocation.getOrDefault(topicId, 0);
            if (take <= 0) {
                continue;
            }
            List<CandidateQuestion> shuffled = AssessmentRandom.shuffleInPlace(
                    new ArrayList<>(pools.getOrDefault(topicId, List.of())), random);
            picked.addAll(shuffled.subList(0, Math.min(take, shuffled.size())));
        }

        List<CandidateQuestion> ordered = AssessmentRandom.shuffleInPlace(picked, random);

        List<GeneratedQuestionSnapshot> questions = new ArrayList<>(ordered.size());
        for (int position = 0; position < ordered.size(); position++) {
            CandidateQuestion question = ordered.get(position);
            questions.add(new GeneratedQuestionSnapshot(
                    position, question.questionId(), question.sourceQuizId(), question.questionText(),
                    question.type(), question.explanation(), orderOptions(question, random), question.codeSnippet()));
        }

        GeneratedInterviewSnapshot snapshot = new GeneratedInterviewSnapshot(config, config.durationSeconds(), questions);
        assertSnapshotValid(snapshot, config.questionCount());
        return snapshot;
    }

    /**
     * Last gate before persistence — re-checks the generated snapshot's
     * invariants rather than assuming them, exactly like the Node reference.
     */
    public static void assertSnapshotValid(GeneratedInterviewSnapshot snapshot, int expectedCount) {
        List<GeneratedQuestionSnapshot> questions = snapshot.questions();

        if (questions.size() != expectedCount) {
            fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT,
                    "generated " + questions.size() + " questions for a " + expectedCount + "-question assessment");
        }
        if (snapshot.durationSeconds() <= 0) {
            fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT,
                    "assessment has an invalid duration (" + snapshot.durationSeconds() + ")");
        }

        Set<String> seenQuestionIds = new LinkedHashSet<>();

        for (int index = 0; index < questions.size(); index++) {
            GeneratedQuestionSnapshot question = questions.get(index);
            String at = "question " + index;

            if (question.position() != index) {
                fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT,
                        at + " has non-contiguous position " + question.position());
            }
            if (!seenQuestionIds.add(question.questionId())) {
                fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT, at + " duplicates an earlier question");
            }
            if (question.questionId().isBlank()) {
                fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT, at + " has no id");
            }
            if (question.sourceQuizId().isBlank()) {
                fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT, at + " has no source quiz");
            }
            if (question.questionText().isBlank()) {
                fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT, at + " has blank text");
            }
            if (question.explanation().isBlank()) {
                fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT, at + " has a blank explanation");
            }

            List<GeneratedOptionSnapshot> options = question.options();
            if (options.size() < 2) {
                fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT, at + " has fewer than two options");
            }

            Set<Integer> optionIds = new LinkedHashSet<>();
            for (int optionIndex = 0; optionIndex < options.size(); optionIndex++) {
                GeneratedOptionSnapshot option = options.get(optionIndex);
                if (option.displayOrder() != optionIndex) {
                    fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT,
                            at + " has non-contiguous option display order");
                }
                if (!optionIds.add(option.optionId())) {
                    fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT, at + " has a duplicate option id");
                }
                if (option.optionText().isBlank()) {
                    fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT, at + " has a blank option");
                }
            }

            long correctCount = options.stream().filter(GeneratedOptionSnapshot::isCorrect).count();
            if (question.questionType().equals("multiple")) {
                if (correctCount < 2) {
                    fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT,
                            at + " is multiple-answer with " + correctCount + " correct options");
                }
                if (correctCount == options.size()) {
                    fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT, at + " marks every option correct");
                }
            } else if (correctCount != 1) {
                fail(AssessmentBuildException.Code.INVALID_GENERATED_SNAPSHOT,
                        at + " is single-selection with " + correctCount + " correct options");
            }
        }
    }
}
