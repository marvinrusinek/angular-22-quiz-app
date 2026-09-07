package com.quizbackend.interview;

import com.quizbackend.interview.InterviewPresets.PresetCapacity;
import com.quizbackend.interview.InterviewPresets.ResolvedInterviewPreset;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.entity.QuizEntity;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Backend port of Angular's {@code AssessmentBuilderService.buildFromPreset()},
 * matching the Node reference's {@code assessment.preset-builder.ts} line for
 * line. A genuinely DIFFERENT algorithm from the Custom path: presets balance
 * across DIFFICULTY BANDS using quotas, then round-robin within each band.
 * Shortfall strategy: fill each band from its own topics round-robin, then
 * carry any shortfall to the CLOSEST difficulty the preset allows (nonzero
 * weight), nearest-first, ties toward the LOWER difficulty. A zero-weighted
 * difficulty is never used; topics outside the preset are never used.
 */
@Component
public class AssessmentPresetBuilder {

    private final QuizRepository quizRepository;
    private final InterviewQuestionRepository questionRepository;

    public AssessmentPresetBuilder(QuizRepository quizRepository, InterviewQuestionRepository questionRepository) {
        this.quizRepository = quizRepository;
        this.questionRepository = questionRepository;
    }

    private static List<String> dedupe(List<String> ids) {
        return new ArrayList<>(new LinkedHashSet<>(ids));
    }

    /** Port of {@code presetCapacity}. Only the preset's own topics are counted. */
    public PresetCapacity presetCapacity(InterviewPreset preset) {
        DifficultyQuota byDifficulty = new DifficultyQuota(0, 0, 0);
        Map<QuizDifficulty, Integer> counts = new LinkedHashMap<>();
        for (QuizDifficulty d : QuizDifficulty.values()) {
            counts.put(d, 0);
        }

        for (String topicId : dedupe(preset.topicIds())) {
            Optional<QuizEntity> quiz = quizRepository.findByQuizIdAndStatus(topicId, "active");
            if (quiz.isEmpty() || quiz.get().getDifficulty() == null) {
                continue;
            }
            QuizDifficulty difficulty = QuizDifficulty.fromWireValue(quiz.get().getDifficulty());
            if (difficulty == null) {
                continue;
            }
            int questionCount = questionRepository.findByQuizId(topicId).size();
            counts.put(difficulty, counts.get(difficulty) + questionCount);
        }
        byDifficulty = new DifficultyQuota(counts.get(QuizDifficulty.BEGINNER),
                counts.get(QuizDifficulty.INTERMEDIATE), counts.get(QuizDifficulty.ADVANCED));

        int usable = 0;
        for (QuizDifficulty d : QuizDifficulty.values()) {
            if (preset.difficultyDistribution().get(d) > 0) {
                usable += byDifficulty.get(d);
            }
        }

        return new PresetCapacity(byDifficulty, usable, preset.questionCount());
    }

    /**
     * Port of {@code redistributionOrder}. The anchor is the difficulty that
     * carried the LARGEST original quota. Candidates are ordered by distance
     * from the anchor, ties resolved toward the lower difficulty.
     */
    public static List<QuizDifficulty> redistributionOrder(DifficultyQuota quota, List<QuizDifficulty> allowed) {
        QuizDifficulty anchor = QuizDifficulty.BEGINNER;
        int best = quota.get(QuizDifficulty.BEGINNER);
        for (QuizDifficulty d : QuizDifficulty.values()) {
            if (quota.get(d) > best) {
                best = quota.get(d);
                anchor = d;
            }
        }
        final int anchorIndex = anchor.ordinal();

        List<QuizDifficulty> result = new ArrayList<>(allowed);
        result.sort((a, b) -> {
            int da = Math.abs(a.ordinal() - anchorIndex);
            int db = Math.abs(b.ordinal() - anchorIndex);
            if (da != db) {
                return da - db;
            }
            return a.ordinal() - b.ordinal();
        });
        return result;
    }

    /**
     * Port of {@code takeBalanced}. Consumes from the front of each topic's
     * already-shuffled pool, round-robin, so one large topic cannot dominate
     * and a question can never be taken twice.
     */
    private static List<CandidateQuestion> takeBalanced(
            List<String> topicIds, Map<String, List<CandidateQuestion>> remaining, int want) {
        List<CandidateQuestion> out = new ArrayList<>();
        if (want <= 0 || topicIds.isEmpty()) {
            return out;
        }

        boolean progressed = true;
        while (out.size() < want && progressed) {
            progressed = false;
            for (String topicId : topicIds) {
                if (out.size() >= want) {
                    break;
                }
                List<CandidateQuestion> pool = remaining.get(topicId);
                if (pool != null && !pool.isEmpty()) {
                    out.add(pool.remove(0));
                    progressed = true;
                }
            }
        }
        return out;
    }

    public GeneratedInterviewSnapshot buildPresetAssessment(InterviewPreset preset, RandomSource random) {
        PresetCapacity capacity = presetCapacity(preset);
        if (capacity.usable() < preset.questionCount()) {
            throw new AssessmentBuildException(AssessmentBuildException.Code.INSUFFICIENT_QUESTIONS,
                    "preset \"" + preset.id() + "\" needs " + preset.questionCount()
                            + " questions but only " + capacity.usable() + " are available");
        }

        List<String> topicIds = dedupe(preset.topicIds());
        Map<QuizDifficulty, List<String>> topicsByDifficulty = new LinkedHashMap<>();
        Map<String, List<CandidateQuestion>> pools = new LinkedHashMap<>();

        for (String topicId : topicIds) {
            Optional<QuizEntity> quiz = quizRepository.findByQuizIdAndStatus(topicId, "active");
            if (quiz.isEmpty() || quiz.get().getDifficulty() == null) {
                continue;
            }
            QuizDifficulty difficulty = QuizDifficulty.fromWireValue(quiz.get().getDifficulty());
            if (difficulty == null) {
                continue;
            }
            pools.put(topicId, new ArrayList<>(questionRepository.findByQuizId(topicId)));
            topicsByDifficulty.computeIfAbsent(difficulty, d -> new ArrayList<>()).add(topicId);
        }

        DifficultyQuota quota = InterviewPresets.calculateDifficultyQuota(
                preset.questionCount(), preset.difficultyDistribution());
        List<QuizDifficulty> allowed = new ArrayList<>();
        for (QuizDifficulty d : QuizDifficulty.values()) {
            if (preset.difficultyDistribution().get(d) > 0) {
                allowed.add(d);
            }
        }

        // One shuffle per topic pool, in topicIds order — the draw sequence
        // matters for parity under a seeded source.
        Map<String, List<CandidateQuestion>> remaining = new LinkedHashMap<>();
        for (Map.Entry<String, List<CandidateQuestion>> entry : pools.entrySet()) {
            remaining.put(entry.getKey(), AssessmentRandom.shuffleInPlace(new ArrayList<>(entry.getValue()), random));
        }

        List<CandidateQuestion> picked = new ArrayList<>();
        int shortfall = 0;

        for (QuizDifficulty difficulty : QuizDifficulty.values()) {
            int want = quota.get(difficulty);
            if (want <= 0) {
                continue;
            }
            List<CandidateQuestion> taken = takeBalanced(
                    topicsByDifficulty.getOrDefault(difficulty, List.of()), remaining, want);
            picked.addAll(taken);
            shortfall += want - taken.size();
        }

        if (shortfall > 0) {
            for (QuizDifficulty difficulty : redistributionOrder(quota, allowed)) {
                if (shortfall == 0) {
                    break;
                }
                List<CandidateQuestion> taken = takeBalanced(
                        topicsByDifficulty.getOrDefault(difficulty, List.of()), remaining, shortfall);
                picked.addAll(taken);
                shortfall -= taken.size();
            }
        }

        List<CandidateQuestion> ordered = AssessmentRandom.shuffleInPlace(picked, random);

        List<GeneratedQuestionSnapshot> questions = new ArrayList<>(ordered.size());
        for (int position = 0; position < ordered.size(); position++) {
            CandidateQuestion question = ordered.get(position);
            questions.add(new GeneratedQuestionSnapshot(
                    position, question.questionId(), question.sourceQuizId(), question.questionText(),
                    question.type(), question.explanation(),
                    AssessmentBuilder.orderOptions(question, random), question.codeSnippet()));
        }

        ResolvedInterviewPreset resolved = InterviewPresets.resolvePreset(preset);
        InterviewBuildConfig config = new InterviewBuildConfig(
                "mixed", topicIds, resolved.questionCount(), resolved.durationSeconds(),
                resolved.presetId(), resolved.presetName());

        GeneratedInterviewSnapshot snapshot = new GeneratedInterviewSnapshot(config, resolved.durationSeconds(), questions);
        AssessmentBuilder.assertSnapshotValid(snapshot, preset.questionCount());
        return snapshot;
    }
}
