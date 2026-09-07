package com.quizbackend.quiz.topicquiz;

import com.quizbackend.interview.CandidateOption;
import com.quizbackend.interview.CandidateQuestion;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Pure algorithm proof for {@link AnswerCheck} — port of the Node
 * reference's {@code answer-check.ts}, cross-checked case-by-case against
 * that file's own test suite ({@code backend/test/quiz-check-endpoint.test.ts}),
 * read fresh this slice. DELIBERATELY tests the SUPERSET rule for multiple-
 * answer questions, which is NOT the same as Interview Mode's exact-set
 * rule (see {@code InterviewScoringTest} for that one).
 */
class AnswerCheckTest {

    private static CandidateOption opt(int id, String text, boolean correct) {
        return new CandidateOption(id, id, text, correct);
    }

    private static CandidateQuestion question(String text, String type, List<CandidateOption> options) {
        return new CandidateQuestion("q", "rxjs", 0, text, type, "Because.", options, null);
    }

    private static final CandidateQuestion SINGLE = question("Which answer is correct?", "single", List.of(
            opt(1, "A multicast observable", true), opt(2, "A pipe", false), opt(3, "A directive", false)));

    private static final CandidateQuestion MULTIPLE = question("Select every operator", "multiple", List.of(
            opt(1, "map", true), opt(2, "filter", true), opt(3, "Observable", false), opt(4, "Subject", false)));

    private static final CandidateQuestion TRUE_FALSE = question("Is a Subject also an Observable?", "trueFalse", List.of(
            opt(1, "True", true), opt(2, "False", false)));

    // ── single / trueFalse: any non-empty answer is terminal ─────────────

    @Test
    void correctSingleResolvesWithCorrectTrue() {
        var outcome = (ResolvedCheckOutcome) AnswerCheck.checkAnswer(SINGLE, List.of("A multicast observable"), false);
        assertThat(outcome.status()).isEqualTo("resolved");
        assertThat(outcome.correct()).isTrue();
        assertThat(outcome.correctOptionTexts()).containsExactly("A multicast observable");
        assertThat(outcome.explanation()).isEqualTo("Because.");
    }

    @Test
    void incorrectSingleStillResolvesWithCorrectFalse() {
        var outcome = (ResolvedCheckOutcome) AnswerCheck.checkAnswer(SINGLE, List.of("A pipe"), false);
        assertThat(outcome.status()).isEqualTo("resolved");
        assertThat(outcome.correct()).isFalse();
        assertThat(outcome.correctOptionTexts()).containsExactly("A multicast observable");
    }

    @Test
    void trueFalseResolvesLikeAnySingleSelect() {
        var correctOutcome = (ResolvedCheckOutcome) AnswerCheck.checkAnswer(TRUE_FALSE, List.of("True"), false);
        assertThat(correctOutcome.correct()).isTrue();
        var wrongOutcome = (ResolvedCheckOutcome) AnswerCheck.checkAnswer(TRUE_FALSE, List.of("False"), false);
        assertThat(wrongOutcome.correct()).isFalse();
    }

    @Test
    void rejectsTwoSelectionsOnASingleAnswerQuestion() {
        assertThatThrownBy(() -> AnswerCheck.checkAnswer(SINGLE, List.of("A multicast observable", "A pipe"), false))
                .isInstanceOf(AnswerCheckException.class);
    }

    @Test
    void emptySelectionIsIncompleteNotAnError() {
        var outcome = (IncompleteCheckOutcome) AnswerCheck.checkAnswer(SINGLE, List.of(), false);
        assertThat(outcome.status()).isEqualTo("incomplete");
        assertThat(outcome.selectedVerdicts()).isEmpty();
        assertThat(outcome.remainingCorrectCount()).isEqualTo(1);
    }

    // ── multiple: the audited SUPERSET rule (correctSet ⊆ selectedSet) ──

    @Test
    void allCorrectOnlyResolves() {
        var outcome = (ResolvedCheckOutcome) AnswerCheck.checkAnswer(MULTIPLE, List.of("map", "filter"), false);
        assertThat(outcome.status()).isEqualTo("resolved");
        assertThat(outcome.correct()).isTrue();
        assertThat(outcome.correctOptionTexts()).containsExactly("map", "filter");
    }

    @Test
    void allCorrectPlusOneIncorrectStillResolvesAndScoresCorrect() {
        // The audited shipped behavior: a stray wrong pick does not block
        // completion and does not cost the point.
        var outcome = (ResolvedCheckOutcome) AnswerCheck.checkAnswer(MULTIPLE, List.of("map", "filter", "Observable"), false);
        assertThat(outcome.status()).isEqualTo("resolved");
        assertThat(outcome.correct()).isTrue();
    }

    @Test
    void oneCorrectOnlyIsIncompleteWithOneRemaining() {
        var outcome = (IncompleteCheckOutcome) AnswerCheck.checkAnswer(MULTIPLE, List.of("map"), false);
        assertThat(outcome.status()).isEqualTo("incomplete");
        assertThat(outcome.selectedVerdicts()).containsExactly(new SelectedVerdict("map", true));
        assertThat(outcome.remainingCorrectCount()).isEqualTo(1);
    }

    @Test
    void incorrectOnlyIsIncompleteAndThatPickIsMarkedIncorrect() {
        var outcome = (IncompleteCheckOutcome) AnswerCheck.checkAnswer(MULTIPLE, List.of("Observable"), false);
        assertThat(outcome.selectedVerdicts()).containsExactly(new SelectedVerdict("Observable", false));
        assertThat(outcome.remainingCorrectCount()).isEqualTo(2);
    }

    @Test
    void remainingCorrectCountCountsOnlyMissingCorrectOptions() {
        var outcome = (IncompleteCheckOutcome) AnswerCheck.checkAnswer(MULTIPLE, List.of("Observable", "Subject"), false);
        assertThat(outcome.remainingCorrectCount()).isEqualTo(2);
    }

    @Test
    void neverRevealsCorrectnessForUnselectedOptionsWhileIncomplete() {
        var outcome = (IncompleteCheckOutcome) AnswerCheck.checkAnswer(MULTIPLE, List.of("map"), false);
        assertThat(outcome.selectedVerdicts()).hasSize(1);
        // 'filter' is correct but must never be named while incomplete.
        assertThat(outcome.toString()).doesNotContain("filter");
    }

    // ── validation and scoping ────────────────────────────────────────────

    @Test
    void rejectsADuplicateSelectedText() {
        assertThatThrownBy(() -> AnswerCheck.checkAnswer(MULTIPLE, List.of("map", "map"), false))
                .isInstanceOf(AnswerCheckException.class);
    }

    @Test
    void rejectsAnUnknownOptionText() {
        assertThatThrownBy(() -> AnswerCheck.checkAnswer(MULTIPLE, List.of("no such option"), false))
                .isInstanceOf(AnswerCheckException.class);
    }

    @Test
    void rejectsMoreSelectionsThanTheQuestionHasOptions() {
        assertThatThrownBy(() -> AnswerCheck.checkAnswer(TRUE_FALSE, List.of("True", "False", "Maybe"), false))
                .isInstanceOf(AnswerCheckException.class);
    }

    @Test
    void findQuestionRejectsAQuestionFromAnotherQuiz() {
        assertThatThrownBy(() -> AnswerCheck.findQuestion(List.of(SINGLE, MULTIPLE), "What does computed() return?"))
                .isInstanceOf(AnswerCheckException.class);
    }

    @Test
    void findQuestionRejectsNonStringOrBlankInput() {
        assertThatThrownBy(() -> AnswerCheck.findQuestion(List.of(SINGLE), 42)).isInstanceOf(AnswerCheckException.class);
        assertThatThrownBy(() -> AnswerCheck.findQuestion(List.of(SINGLE), null)).isInstanceOf(AnswerCheckException.class);
        assertThatThrownBy(() -> AnswerCheck.findQuestion(List.of(SINGLE), "   ")).isInstanceOf(AnswerCheckException.class);
    }

    @Test
    void matchesTextCaseInsensitivelyAndWhitespaceInsensitively() {
        CandidateQuestion found = AnswerCheck.findQuestion(List.of(SINGLE), "  which   ANSWER is CORRECT?  ");
        assertThat(found).isEqualTo(SINGLE);

        var outcome = (ResolvedCheckOutcome) AnswerCheck.checkAnswer(SINGLE, List.of("  A MULTICAST   observable "), false);
        // The reveal returns the EXACT stored strings, not the client's casing.
        assertThat(outcome.correctOptionTexts()).containsExactly("A multicast observable");
    }

    @Test
    void handlesHtmlLikeOptionTextExactly() {
        CandidateQuestion htmlQuestion = question("Which selector is used for routing?", "single", List.of(
                opt(1, "<router-outlet>", true), opt(2, "this.http.get<User>('/api/users/1')", false)));
        var outcome = (ResolvedCheckOutcome) AnswerCheck.checkAnswer(htmlQuestion, List.of("<router-outlet>"), false);
        assertThat(outcome.correct()).isTrue();
        assertThat(outcome.correctOptionTexts()).containsExactly("<router-outlet>");
    }

    // ── expiry ────────────────────────────────────────────────────────────

    @Test
    void revealsAfterTheSignedDeadlineEvenWithAPartialSelection() {
        var outcome = (ExpiredCheckOutcome) AnswerCheck.checkAnswer(MULTIPLE, List.of("map"), true);
        assertThat(outcome.status()).isEqualTo("expired");
        assertThat(outcome.correctOptionTexts()).containsExactly("map", "filter");
        assertThat(outcome.explanation()).isEqualTo("Because.");
    }

    @Test
    void revealsAfterExpiryWithNoSelectionAtAll() {
        var outcome = (ExpiredCheckOutcome) AnswerCheck.checkAnswer(MULTIPLE, List.of(), true);
        assertThat(outcome.status()).isEqualTo("expired");
    }

    @Test
    void expiredOutcomeHasNoCorrectFieldUnlikeResolved() {
        // Structural proof: ExpiredCheckOutcome the TYPE has no correct()
        // accessor at all — there is no field to leak a right/wrong verdict
        // through on an expiry reveal.
        assertThat(ExpiredCheckOutcome.class.getRecordComponents()).extracting(java.lang.reflect.RecordComponent::getName)
                .containsExactly("status", "correctOptionTexts", "explanation");
    }

    @Test
    void expiryWinsRegardlessOfSelectionValidity() {
        // Even an otherwise-invalid selection count is irrelevant once expired —
        // Node's own checkAnswer evaluates `expired` before validating selection.
        // (A single-select question would normally reject >1 selections.)
        var outcome = AnswerCheck.checkAnswer(SINGLE, List.of("A pipe"), true);
        assertThat(outcome).isInstanceOf(ExpiredCheckOutcome.class);
    }

    // ── canonicalize ──────────────────────────────────────────────────────

    @Test
    void canonicalizeCollapsesWhitespaceAndCase() {
        assertThat(AnswerCheck.canonicalize("  Which   ANSWER is CORRECT?  "))
                .isEqualTo(AnswerCheck.canonicalize("which answer is correct?"));
    }

    @Test
    void canonicalizeIsNfcStableForAccentedText() {
        String precomposed = "café";               // NFC: e-acute as one codepoint
        String decomposed = "café";               // NFD: e + combining acute accent
        assertThat(AnswerCheck.canonicalize(precomposed)).isEqualTo(AnswerCheck.canonicalize(decomposed));
    }
}
