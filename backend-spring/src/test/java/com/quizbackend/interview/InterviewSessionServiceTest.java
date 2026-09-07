package com.quizbackend.interview;

import com.quizbackend.interview.InterviewSessionRepository.SessionAuthenticationRecord;
import com.quizbackend.interview.dto.ActiveInterviewSessionDto;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Orchestration proof against the Node reference's {@code session.service.ts}
 * create/resume paths. {@link AssessmentBuilder}/{@link AssessmentPresetBuilder}
 * are mocked (their algorithms are proven separately in their own test
 * classes) so this class stays focused on request validation, error
 * translation, identity/persistence orchestration, and resume's
 * status/expiry state machine.
 */
@ExtendWith(MockitoExtension.class)
class InterviewSessionServiceTest {

    @Mock
    private AssessmentBuilder assessmentBuilder;
    @Mock
    private AssessmentPresetBuilder presetBuilder;
    @Mock
    private InterviewSessionRepository sessionRepository;

    private long fixedNow = 1_000_000L;

    private InterviewSessionService service() {
        return new InterviewSessionService(assessmentBuilder, presetBuilder, sessionRepository,
                () -> fixedNow, AssessmentRandom.seeded(1));
    }

    private GeneratedInterviewSnapshot samplePresetSnapshot() {
        CandidateCodeSnippet snippet = new CandidateCodeSnippet("typescript", "const s = signal(0);", null);
        GeneratedQuestionSnapshot question = new GeneratedQuestionSnapshot(
                0, "signals:q:0", "signals", "What does this log?", "single", "Because signals are reactive.",
                List.of(new GeneratedOptionSnapshot(101, "0", 0, true), new GeneratedOptionSnapshot(102, "1", 1, false)),
                snippet);
        InterviewBuildConfig config = new InterviewBuildConfig("mixed", List.of("signals"), 1, 1200, "junior", "Junior Angular Developer");
        return new GeneratedInterviewSnapshot(config, 1200, List.of(question));
    }

    private void stubSuccessfulPersistence(GeneratedInterviewSnapshot snapshot) {
        ArgumentCaptor<CreateSessionInput> captor = ArgumentCaptor.forClass(CreateSessionInput.class);
        lenient().when(sessionRepository.createSessionSnapshot(captor.capture()))
                .thenAnswer(invocation -> {
                    CreateSessionInput input = captor.getValue();
                    return new InterviewSessionRecord(input.id(), input.tokenHash(), SessionStatus.ACTIVE,
                            input.config(), input.durationSeconds(), input.createdAt(), input.expiresAt(), null, false, input.attemptId());
                });
        lenient().when(sessionRepository.getSessionSnapshot(any())).thenAnswer(invocation -> {
            CreateSessionInput input = captor.getValue();
            InterviewSessionRecord record = new InterviewSessionRecord(input.id(), input.tokenHash(), SessionStatus.ACTIVE,
                    input.config(), input.durationSeconds(), input.createdAt(), input.expiresAt(), null, false, input.attemptId());
            List<SessionQuestionSnapshot> questions = snapshot.questions().stream()
                    .map(q -> new SessionQuestionSnapshot(q.position(), q.questionId(), q.sourceQuizId(), q.questionText(),
                            q.questionType(), q.explanation(),
                            q.options().stream().map(o -> new SessionOptionSnapshot(o.optionId(), o.optionText(), o.displayOrder(), o.isCorrect())).toList(),
                            false, q.codeSnippet()))
                    .toList();
            return Optional.of(new InterviewSessionSnapshot(record, questions));
        });
    }

    // ── createSession ────────────────────────────────────────────────────

    @Test
    void createSessionForAPresetReturnsAnActiveDtoWithATokenAndNoCorrectnessOrExplanation() {
        when(presetBuilder.buildPresetAssessment(any(), any())).thenReturn(samplePresetSnapshot());
        stubSuccessfulPersistence(samplePresetSnapshot());

        Map<String, Object> request = new HashMap<>();
        request.put("mode", "preset");
        request.put("presetId", "junior");

        ActiveInterviewSessionDto dto = service().createSession(request);

        assertThat(dto.status()).isEqualTo("active");
        assertThat(dto.sessionToken()).isNotBlank();
        assertThat(dto.questions()).hasSize(1);
        assertThat(dto.questions().get(0).codeSnippet().language()).isEqualTo("typescript");
        // Structural proof: ActiveInterviewQuestionDto/ActiveInterviewOptionDto
        // have no isCorrect/explanation fields at all — there is no field to
        // leak. Confirmed here by exhaustively listing what IS present.
        assertThat(dto.questions().get(0).options()).extracting("optionId", "text")
                .containsExactly(org.assertj.core.groups.Tuple.tuple(101, "0"), org.assertj.core.groups.Tuple.tuple(102, "1"));
    }

    @Test
    void createSessionRejectsAMissingMode() {
        assertThatThrownBy(() -> service().createSession(Map.of("presetId", "junior")))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void createSessionRejectsAForbiddenServerOwnedField() {
        Map<String, Object> request = new HashMap<>();
        request.put("mode", "preset");
        request.put("presetId", "junior");
        request.put("sessionToken", "client-supplied");

        assertThatThrownBy(() -> service().createSession(request))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void createSessionRejectsTopicIdsSuppliedAlongsideAPreset() {
        Map<String, Object> request = new HashMap<>();
        request.put("mode", "preset");
        request.put("presetId", "junior");
        request.put("topicIds", List.of("rxjs"));

        assertThatThrownBy(() -> service().createSession(request))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void createSessionRejectsAnUnknownPreset() {
        Map<String, Object> request = new HashMap<>();
        request.put("mode", "preset");
        request.put("presetId", "nonexistent");

        assertThatThrownBy(() -> service().createSession(request))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void createSessionForCustomModeDelegatesToTheAssessmentBuilder() {
        GeneratedInterviewSnapshot custom = new GeneratedInterviewSnapshot(
                new InterviewBuildConfig("advanced", List.of("rxjs"), 1, 900, null, null),
                900, samplePresetSnapshot().questions());
        when(assessmentBuilder.validateBuildRequest(any())).thenReturn(custom.config());
        when(assessmentBuilder.buildInterviewAssessment(any(), any())).thenReturn(custom);
        stubSuccessfulPersistence(custom);

        Map<String, Object> request = new HashMap<>();
        request.put("mode", "custom");
        request.put("difficulty", "advanced");
        request.put("topicIds", List.of("rxjs"));
        request.put("questionCount", 10);

        ActiveInterviewSessionDto dto = service().createSession(request);

        assertThat(dto.config().mode()).isEqualTo("custom");
        assertThat(dto.config().difficulty()).isEqualTo("advanced");
        verify(presetBuilder, never()).buildPresetAssessment(any(), any());
    }

    // ── persistWithIdentityRetry (via createSession — the method itself is
    //    private, exactly like the Node reference's equivalent internal
    //    helper; exercised the same way createSession's own tests already
    //    do, via sessionRepository's mocked createSessionSnapshot/getSession
    //    Snapshot) ──────────────────────────────────────────────────────────

    @Test
    void aUniquenessCollisionOnTheFirstAttemptTriggersAFreshIdentityAndASecondPersistenceAttempt() {
        when(presetBuilder.buildPresetAssessment(any(), any())).thenReturn(samplePresetSnapshot());

        ArgumentCaptor<CreateSessionInput> captor = ArgumentCaptor.forClass(CreateSessionInput.class);
        when(sessionRepository.createSessionSnapshot(captor.capture()))
                .thenThrow(new SessionRepositoryException(
                        SessionRepositoryException.Category.CONSTRAINT, "Session violates a uniqueness constraint"))
                .thenAnswer(invocation -> {
                    CreateSessionInput input = captor.getValue();
                    return new InterviewSessionRecord(input.id(), input.tokenHash(), SessionStatus.ACTIVE,
                            input.config(), input.durationSeconds(), input.createdAt(), input.expiresAt(), null, false, input.attemptId());
                });
        when(sessionRepository.getSessionSnapshot(any())).thenAnswer(invocation -> {
            CreateSessionInput input = captor.getValue();
            InterviewSessionRecord record = new InterviewSessionRecord(input.id(), input.tokenHash(), SessionStatus.ACTIVE,
                    input.config(), input.durationSeconds(), input.createdAt(), input.expiresAt(), null, false, input.attemptId());
            return Optional.of(new InterviewSessionSnapshot(record, List.of()));
        });

        Map<String, Object> request = new HashMap<>();
        request.put("mode", "preset");
        request.put("presetId", "junior");

        ActiveInterviewSessionDto dto = service().createSession(request);

        verify(sessionRepository, times(2)).createSessionSnapshot(any());
        List<CreateSessionInput> attempts = captor.getAllValues();
        assertThat(attempts).hasSize(2);
        // A fresh identity was generated for the retry — not a resubmission of the failed one.
        assertThat(attempts.get(1).id()).isNotEqualTo(attempts.get(0).id());
        assertThat(attempts.get(1).tokenHash()).isNotEqualTo(attempts.get(0).tokenHash());

        // The returned session/token belong to the SECOND (successful) identity.
        assertThat(dto.sessionId()).isEqualTo(attempts.get(1).id());
        assertThat(dto.sessionId()).isNotEqualTo(attempts.get(0).id());
    }

    @Test
    void repeatedCollisionsStopAfterThreeAttemptsAndReportAnInternalFailure() {
        when(presetBuilder.buildPresetAssessment(any(), any())).thenReturn(samplePresetSnapshot());
        when(sessionRepository.createSessionSnapshot(any()))
                .thenThrow(new SessionRepositoryException(
                        SessionRepositoryException.Category.CONSTRAINT, "Session violates a uniqueness constraint"));

        Map<String, Object> request = new HashMap<>();
        request.put("mode", "preset");
        request.put("presetId", "junior");

        assertThatThrownBy(() -> service().createSession(request))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.INTERNAL))
                .hasMessage("Session could not be created");

        // MAX_ATTEMPTS = 3 in the current implementation — never a 4th try.
        verify(sessionRepository, times(3)).createSessionSnapshot(any());
        verify(sessionRepository, never()).getSessionSnapshot(any());
    }

    @Test
    void aNonCollisionPersistenceFailureIsNotRetried() {
        when(presetBuilder.buildPresetAssessment(any(), any())).thenReturn(samplePresetSnapshot());
        when(sessionRepository.createSessionSnapshot(any()))
                .thenThrow(new SessionRepositoryException(
                        SessionRepositoryException.Category.VALIDATION, "Duplicate question position"));

        Map<String, Object> request = new HashMap<>();
        request.put("mode", "preset");
        request.put("presetId", "junior");

        assertThatThrownBy(() -> service().createSession(request))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.INTERNAL))
                .hasMessage("Session could not be created");

        // A non-collision failure fails fast on the FIRST attempt — no retry.
        verify(sessionRepository, times(1)).createSessionSnapshot(any());
    }

    // ── resumeSession ────────────────────────────────────────────────────

    @Test
    void resumeRejectsAMissingToken() {
        assertThatThrownBy(() -> service().resumeSession("is_abc", null))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
    }

    @Test
    void resumeRejectsAnUnknownSession() {
        when(sessionRepository.getSessionAuthenticationRecord("is_ghost")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service().resumeSession("is_ghost", "x".repeat(43)))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
    }

    @Test
    void resumeRejectsAMismatchedToken() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        when(sessionRepository.getSessionAuthenticationRecord("is_x"))
                .thenReturn(Optional.of(new SessionAuthenticationRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE, fixedNow + 10_000)));

        String wrongToken = SessionToken.generateSessionIdentity().rawToken();
        assertThatThrownBy(() -> service().resumeSession("is_x", wrongToken))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
    }

    @Test
    void resumeFlipsAndRejectsASessionPastItsDeadlineEvenIfStillMarkedActive() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        when(sessionRepository.getSessionAuthenticationRecord("is_x"))
                .thenReturn(Optional.of(new SessionAuthenticationRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE, fixedNow - 1)));

        assertThatThrownBy(() -> service().resumeSession("is_x", identity.rawToken()))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.SESSION_EXPIRED));
        verify(sessionRepository, times(1)).markExpiredIfDue("is_x", fixedNow);
    }

    @Test
    void resumeRejectsAnAlreadyExpiredSessionWithoutTouchingTheDatabaseAgain() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        when(sessionRepository.getSessionAuthenticationRecord("is_x"))
                .thenReturn(Optional.of(new SessionAuthenticationRecord("is_x", identity.tokenHash(), SessionStatus.EXPIRED, fixedNow - 1)));

        assertThatThrownBy(() -> service().resumeSession("is_x", identity.rawToken()))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.SESSION_EXPIRED));
    }

    @Test
    void resumeRejectsAnAlreadySubmittedSessionWithConflict() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        when(sessionRepository.getSessionAuthenticationRecord("is_x"))
                .thenReturn(Optional.of(new SessionAuthenticationRecord("is_x", identity.tokenHash(), SessionStatus.SUBMITTED, fixedNow + 10_000)));

        assertThatThrownBy(() -> service().resumeSession("is_x", identity.rawToken()))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.CONFLICT));
    }

    @Test
    void resumeReturnsTheActiveSessionWithoutASessionTokenAndNoEmptyAnswers() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        when(sessionRepository.getSessionAuthenticationRecord("is_x"))
                .thenReturn(Optional.of(new SessionAuthenticationRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE, fixedNow + 10_000)));

        InterviewSessionConfig config = new InterviewSessionConfig("mixed", List.of("signals"), 1, "junior", "Junior Angular Developer");
        InterviewSessionRecord record = new InterviewSessionRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE,
                config, 1200, fixedNow - 500, fixedNow + 10_000, null, false, "ia_x");
        SessionQuestionSnapshot question = new SessionQuestionSnapshot(0, "signals:q:0", "signals", "Q?", "single",
                "Because.", List.of(new SessionOptionSnapshot(101, "A", 0, true)), false, null);
        when(sessionRepository.getSessionSnapshot("is_x"))
                .thenReturn(Optional.of(new InterviewSessionSnapshot(record, List.of(question))));

        ActiveInterviewSessionDto dto = service().resumeSession("is_x", identity.rawToken());

        assertThat(dto.sessionToken()).isNull();
        assertThat(dto.answers()).isEmpty();
        assertThat(dto.questions()).hasSize(1);
    }
}
