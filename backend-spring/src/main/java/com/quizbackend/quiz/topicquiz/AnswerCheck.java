package com.quizbackend.quiz.topicquiz;

import com.quizbackend.interview.CandidateOption;
import com.quizbackend.interview.CandidateQuestion;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Per-question answer checking for Topic Quizzes — port of the Node
 * reference's {@code backend/src/quiz/answer-check.ts}. This is the ONLY
 * place correctness leaves the server, and it leaves for one question at a
 * time, in response to an answer the user actually gave.
 *
 * <p>DELIBERATELY DIFFERENT from Interview Mode's {@code InterviewScoring}:
 * a multiple-answer question resolves when {@code correctSet ⊆
 * selectedSet} (SUPERSET), NOT exact equality — selecting every correct
 * option completes the question even if a stray incorrect option is also
 * selected, and it still scores correct. This mirrors the shipped Angular
 * behavior audited in Node's own source comments; Interview Mode's
 * exact-set rule is a separate feature and is NOT reused here.
 *
 * <p>Text-based identity throughout: a question is addressed by its exact
 * (canonicalized) text within a quiz, an option by its exact text within
 * that question — never an id or index, matching the public Topic Quiz
 * contract (no identifiers on the wire).
 */
public final class AnswerCheck {

    private AnswerCheck() {
    }

    /**
     * Canonical text normalization — case-insensitive, whitespace-collapsed,
     * over NFC. Port of Node's {@code canonicalize}, which matches the
     * database's own generated {@code question_key}/{@code option_key}
     * columns.
     */
    public static String canonicalize(String text) {
        String nfc = Normalizer.normalize(text, Normalizer.Form.NFC);
        return nfc.trim().replaceAll("\\s+", " ").toLowerCase(java.util.Locale.ROOT);
    }

    private static AnswerCheckException reject() {
        throw new AnswerCheckException();
    }

    /**
     * Resolve a question by its exact text, scoped to the questions of ONE
     * quiz (the caller passes only that quiz's ordered question list) — a
     * question from another quiz must not resolve.
     */
    public static CandidateQuestion findQuestion(List<CandidateQuestion> quizQuestions, Object questionTextRaw) {
        if (!(questionTextRaw instanceof String questionText) || questionText.trim().isEmpty()) {
            throw reject();
        }
        String key = canonicalize(questionText);
        return quizQuestions.stream()
                .filter(q -> canonicalize(q.questionText()).equals(key))
                .findFirst()
                .orElseThrow(AnswerCheck::reject);
    }

    /**
     * Resolve selected option texts within ONE question. Rejects duplicates,
     * unknown text, and more selections than the question has options —
     * every rejection is the SAME {@link AnswerCheckException}, so a probe
     * cannot use the response to enumerate which options exist.
     */
    public static List<CandidateOption> resolveSelectedOptions(CandidateQuestion question, Object selectedOptionTextsRaw) {
        if (!(selectedOptionTextsRaw instanceof List<?> rawList)) {
            throw reject();
        }
        if (rawList.size() > question.options().size()) {
            throw reject();
        }

        Map<String, CandidateOption> byKey = new LinkedHashMap<>();
        for (CandidateOption option : question.options()) {
            byKey.put(canonicalize(option.text()), option);
        }

        java.util.Set<String> seen = new java.util.HashSet<>();
        List<CandidateOption> resolved = new ArrayList<>();
        for (Object rawText : rawList) {
            if (!(rawText instanceof String text) || text.trim().isEmpty()) {
                throw reject();
            }
            String key = canonicalize(text);
            if (!seen.add(key)) {
                throw reject(); // duplicate selection
            }
            CandidateOption option = byKey.get(key);
            if (option == null) {
                throw reject(); // unknown, or from another question
            }
            resolved.add(option);
        }
        return resolved;
    }

    /** True for every type that permits exactly one selected option — port of {@code isSingleSelect}. */
    private static boolean isSingleSelect(String type) {
        return !"multiple".equals(type);
    }

    private static void assertSelectionCountAllowed(CandidateQuestion question, int selectedCount) {
        if (isSingleSelect(question.type()) && selectedCount > 1) {
            throw reject();
        }
    }

    private static List<CandidateOption> correctOptionsOf(CandidateQuestion question) {
        return question.options().stream().filter(CandidateOption::isCorrect).toList();
    }

    /** The authorized reveal for one question: EXACT stored strings, source order. */
    private static CheckReveal revealOf(CandidateQuestion question) {
        List<String> correctOptionTexts = correctOptionsOf(question).stream().map(CandidateOption::text).toList();
        return new CheckReveal(correctOptionTexts, question.explanation());
    }

    private record CheckReveal(List<String> correctOptionTexts, String explanation) {
    }

    /**
     * @param expired Server-derived from the signed question receipt. NEVER a client claim.
     */
    public static CheckOutcome checkAnswer(
            CandidateQuestion question, Object selectedOptionTextsRaw, boolean expired) {
        List<CandidateOption> selected = resolveSelectedOptions(question, selectedOptionTextsRaw);
        assertSelectionCountAllowed(question, selected.size());

        // EXPIRY WINS, evaluated before any selection logic: once the
        // server-authoritative deadline has passed the reveal is authorized
        // regardless of what was selected, including nothing at all.
        if (expired) {
            CheckReveal reveal = revealOf(question);
            return new ExpiredCheckOutcome("expired", reveal.correctOptionTexts(), reveal.explanation());
        }

        List<CandidateOption> correctOptions = correctOptionsOf(question);
        java.util.Set<String> selectedKeys = selected.stream()
                .map(o -> canonicalize(o.text())).collect(java.util.stream.Collectors.toSet());

        // ── single / trueFalse ───────────────────────────────────────────
        // Any valid non-empty submission is terminal: reveals on the first click, right or wrong.
        if (isSingleSelect(question.type())) {
            if (selected.isEmpty()) {
                return new IncompleteCheckOutcome("incomplete", List.of(), correctOptions.size());
            }
            boolean correct = selected.stream().allMatch(CandidateOption::isCorrect);
            CheckReveal reveal = revealOf(question);
            return new ResolvedCheckOutcome("resolved", correct, reveal.correctOptionTexts(), reveal.explanation());
        }

        // ── multiple: correctSet ⊆ selectedSet ───────────────────────────
        List<CandidateOption> missing = correctOptions.stream()
                .filter(o -> !selectedKeys.contains(canonicalize(o.text())))
                .toList();

        if (missing.isEmpty() && !selected.isEmpty()) {
            // Extra incorrect selections do NOT prevent resolution and the
            // question still scores correct.
            CheckReveal reveal = revealOf(question);
            return new ResolvedCheckOutcome("resolved", true, reveal.correctOptionTexts(), reveal.explanation());
        }

        List<SelectedVerdict> selectedVerdicts = selected.stream()
                .map(o -> new SelectedVerdict(o.text(), o.isCorrect()))
                .toList();
        return new IncompleteCheckOutcome("incomplete", selectedVerdicts, missing.size());
    }
}
