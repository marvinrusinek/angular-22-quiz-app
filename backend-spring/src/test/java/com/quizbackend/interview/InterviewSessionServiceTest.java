package com.quizbackend.interview;

import com.quizbackend.interview.InterviewSessionRepository.FinalizeSessionInput;
import com.quizbackend.interview.InterviewSessionRepository.FlaggedState;
import com.quizbackend.interview.InterviewSessionRepository.SaveAnswerInput;
import com.quizbackend.interview.InterviewSessionRepository.SavedAnswerState;
import com.quizbackend.interview.InterviewSessionRepository.SessionAnswerRecord;
import com.quizbackend.interview.InterviewSessionRepository.SessionAuthenticationRecord;
import com.quizbackend.interview.InterviewSessionRepository.SetFlaggedInput;
import com.quizbackend.interview.dto.ActiveInterviewSessionDto;
import com.quizbackend.interview.dto.InterviewResultDto;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.entity.QuizEntity;
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
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
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
    @Mock
    private QuizRepository quizRepository;

    private long fixedNow = 1_000_000L;

    /**
     * A REAL rate limiter, not a mock — its logic is simple/deterministic
     * enough (a token bucket) that a real instance is both easier to use
     * correctly (no NPE-prone unstubbed Verdict) and lets tests exhaust it
     * directly (see the excessive-replay test below) rather than mocking a
     * specific denial. A fresh instance per {@link #service()} call means no
     * bucket state leaks between tests.
     */
    private InterviewSessionService service() {
        return new InterviewSessionService(assessmentBuilder, presetBuilder, sessionRepository, quizRepository,
                () -> fixedNow, AssessmentRandom.seeded(1), new IdempotencyReplayRateLimiter());
    }

    /** Matches production's own {@code InterviewSessionService#hashIdempotencyKey}. */
    private static String hashKey(String rawKey) {
        return SessionToken.hashToken(rawKey);
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

    // ── createSession idempotency (Idempotency-Key) ─────────────────────

    private Map<String, Object> presetRequest() {
        Map<String, Object> request = new HashMap<>();
        request.put("mode", "preset");
        request.put("presetId", "junior");
        return request;
    }

    @Test
    void createSessionWithAnIdempotencyKeyPersistsOnlyItsHashAlongsideTheSession() {
        when(presetBuilder.buildPresetAssessment(any(), any())).thenReturn(samplePresetSnapshot());
        ArgumentCaptor<CreateSessionInput> captor = ArgumentCaptor.forClass(CreateSessionInput.class);
        lenient().when(sessionRepository.findByIdempotencyKeyHash(hashKey("client-key-1"))).thenReturn(Optional.empty());
        stubSuccessfulPersistence(samplePresetSnapshot());

        service().createSession(presetRequest(), "client-key-1");

        verify(sessionRepository).createSessionSnapshot(captor.capture());
        // The RAW key must never reach persistence — only its hash. An
        // idempotency key is credential-equivalent (migration 007's own doc
        // comment), so this is the same one-way-hash-only discipline bearer
        // tokens already get.
        assertThat(captor.getValue().idempotencyKeyHash()).isEqualTo(hashKey("client-key-1"));
        assertThat(captor.getValue().idempotencyKeyHash()).isNotEqualTo("client-key-1").hasSize(64);
        assertThat(captor.getValue().idempotencyRequestHash()).hasSize(64); // SHA-256 hex
    }

    @Test
    void createSessionWithATooLongIdempotencyKeyIsRejected() {
        String tooLong = "k".repeat(201);
        assertThatThrownBy(() -> service().createSession(presetRequest(), tooLong))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
        verify(sessionRepository, never()).createSessionSnapshot(any());
    }

    @Test
    void createSessionWithAnIdempotencyKeyContainingAControlCharacterIsRejected() {
        assertThatThrownBy(() -> service().createSession(presetRequest(), "bad\nkey"))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
        verify(sessionRepository, never()).createSessionSnapshot(any());
    }

    @Test
    void createSessionWithABlankIdempotencyKeyIsTreatedAsNoKeyAtAll() {
        when(presetBuilder.buildPresetAssessment(any(), any())).thenReturn(samplePresetSnapshot());
        ArgumentCaptor<CreateSessionInput> captor = ArgumentCaptor.forClass(CreateSessionInput.class);
        stubSuccessfulPersistence(samplePresetSnapshot());

        service().createSession(presetRequest(), "   ");

        verify(sessionRepository).createSessionSnapshot(captor.capture());
        assertThat(captor.getValue().idempotencyKeyHash()).isNull();
        assertThat(captor.getValue().idempotencyRequestHash()).isNull();
        verify(sessionRepository, never()).findByIdempotencyKeyHash(any());
    }

    @Test
    void createSessionRetryWithTheSameKeyAndSameRequestReturnsTheExistingSessionWithAnAdditionalToken() {
        String requestHash = service().hashRequest(presetRequest());
        when(sessionRepository.findByIdempotencyKeyHash(hashKey("retry-key")))
                .thenReturn(Optional.of(new InterviewSessionRepository.IdempotencyLookup("is_existing", requestHash, fixedNow - 5000)));
        when(sessionRepository.mintAdditionalToken("is_existing", fixedNow))
                .thenReturn(new SessionToken.TokenPair("fresh-raw-token", "fresh-token-hash"));

        InterviewSessionRecord existingRecord = new InterviewSessionRecord(
                "is_existing", "stale-hash", SessionStatus.ACTIVE,
                new InterviewSessionConfig("mixed", List.of("signals"), 1, "junior", "Junior Angular Developer"),
                1200, fixedNow - 5000, fixedNow + 1_200_000L, null, false, "ia_existing");
        List<SessionQuestionSnapshot> existingQuestions = List.of(new SessionQuestionSnapshot(
                0, "signals:q:0", "signals", "What does this log?", "single", "Because signals are reactive.",
                List.of(new SessionOptionSnapshot(101, "0", 0, true), new SessionOptionSnapshot(102, "1", 1, false)),
                false, null));
        when(sessionRepository.getSessionSnapshot("is_existing"))
                .thenReturn(Optional.of(new InterviewSessionSnapshot(existingRecord, existingQuestions)));

        ActiveInterviewSessionDto dto = service().createSession(presetRequest(), "retry-key");

        assertThat(dto.sessionId()).isEqualTo("is_existing");
        assertThat(dto.sessionToken()).isEqualTo("fresh-raw-token");
        // No new session was minted — this IS the idempotent-return path.
        verify(sessionRepository, never()).createSessionSnapshot(any());
        verify(presetBuilder, never()).buildPresetAssessment(any(), any());
    }

    @Test
    void createSessionRetryWithTheSameKeyButADifferentRequestFailsSafelyWithConflict() {
        // The key was first used for a DIFFERENT request — its stored hash
        // will never match this request's, by construction of the test.
        when(sessionRepository.findByIdempotencyKeyHash(hashKey("reused-key")))
                .thenReturn(Optional.of(new InterviewSessionRepository.IdempotencyLookup("is_other", "a-completely-different-hash", fixedNow - 5000)));

        assertThatThrownBy(() -> service().createSession(presetRequest(), "reused-key"))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.CONFLICT));

        verify(sessionRepository, never()).createSessionSnapshot(any());
        verify(sessionRepository, never()).mintAdditionalToken(any(), anyLong());
    }

    @Test
    void createSessionConcurrentRaceLossConvergesOnTheWinningSessionInsteadOfFailing() {
        when(presetBuilder.buildPresetAssessment(any(), any())).thenReturn(samplePresetSnapshot());
        String requestHash = service().hashRequest(presetRequest());

        // First lookup (before the insert attempt) finds nothing; the INSERT
        // then loses the database's own uniqueness race to a concurrent
        // request, and the SECOND lookup (after the race) finds the winner.
        when(sessionRepository.findByIdempotencyKeyHash(hashKey("race-key")))
                .thenReturn(Optional.empty())
                .thenReturn(Optional.of(new InterviewSessionRepository.IdempotencyLookup("is_winner", requestHash, fixedNow - 5000)));
        when(sessionRepository.createSessionSnapshot(any()))
                .thenThrow(new SessionRepositoryException(SessionRepositoryException.Category.IDEMPOTENCY_KEY_RACE, "raced"));
        when(sessionRepository.mintAdditionalToken("is_winner", fixedNow))
                .thenReturn(new SessionToken.TokenPair("winner-raw-token", "winner-token-hash"));

        InterviewSessionRecord winnerRecord = new InterviewSessionRecord(
                "is_winner", "stale-hash", SessionStatus.ACTIVE,
                new InterviewSessionConfig("mixed", List.of("signals"), 1, "junior", "Junior Angular Developer"),
                1200, fixedNow - 5000, fixedNow + 1_200_000L, null, false, "ia_winner");
        List<SessionQuestionSnapshot> winnerQuestions = List.of(new SessionQuestionSnapshot(
                0, "signals:q:0", "signals", "What does this log?", "single", "Because signals are reactive.",
                List.of(new SessionOptionSnapshot(101, "0", 0, true), new SessionOptionSnapshot(102, "1", 1, false)),
                false, null));
        when(sessionRepository.getSessionSnapshot("is_winner"))
                .thenReturn(Optional.of(new InterviewSessionSnapshot(winnerRecord, winnerQuestions)));

        ActiveInterviewSessionDto dto = service().createSession(presetRequest(), "race-key");

        assertThat(dto.sessionId()).isEqualTo("is_winner");
        assertThat(dto.sessionToken()).isEqualTo("winner-raw-token");
    }

    // ── replay lifecycle: bounded window, bounded row growth, rate limiting ──

    /**
     * A key found but past REPLAY_WINDOW_MS is TERMINAL for that key — no
     * token is minted, and the failure is BAD_REQUEST (retrying the identical
     * request cannot help; only a genuinely new attempt, with a new key,
     * could). Proves the credential-equivalent key cannot be replayed
     * indefinitely — see migration 007's own doc comment.
     */
    @Test
    void createSessionRetryWithAnExpiredKeyIsRejectedWithoutMintingAToken() {
        String requestHash = service().hashRequest(presetRequest());
        // 31 minutes old — one minute past the 30-minute REPLAY_WINDOW_MS.
        long expiredCreatedAt = fixedNow - (31 * 60_000L);
        when(sessionRepository.findByIdempotencyKeyHash(hashKey("stale-key")))
                .thenReturn(Optional.of(new InterviewSessionRepository.IdempotencyLookup("is_stale", requestHash, expiredCreatedAt)));

        assertThatThrownBy(() -> service().createSession(presetRequest(), "stale-key"))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));

        verify(sessionRepository, never()).mintAdditionalToken(any(), anyLong());
        verify(sessionRepository, never()).createSessionSnapshot(any());
    }

    /** One minute UNDER the window boundary must still succeed — the check is a strict ">", not "&gt;=". */
    @Test
    void createSessionRetryOneMinuteUnderTheReplayWindowStillSucceeds() {
        String requestHash = service().hashRequest(presetRequest());
        long justUnderWindow = fixedNow - (29 * 60_000L);
        when(sessionRepository.findByIdempotencyKeyHash(hashKey("still-fresh-key")))
                .thenReturn(Optional.of(new InterviewSessionRepository.IdempotencyLookup("is_fresh", requestHash, justUnderWindow)));
        when(sessionRepository.mintAdditionalToken("is_fresh", fixedNow))
                .thenReturn(new SessionToken.TokenPair("fresh-raw-token", "fresh-token-hash"));
        InterviewSessionRecord record = new InterviewSessionRecord(
                "is_fresh", "stale-hash", SessionStatus.ACTIVE,
                new InterviewSessionConfig("mixed", List.of("signals"), 1, "junior", "Junior Angular Developer"),
                1200, justUnderWindow, fixedNow + 1_200_000L, null, false, "ia_fresh");
        when(sessionRepository.getSessionSnapshot("is_fresh"))
                .thenReturn(Optional.of(new InterviewSessionSnapshot(record, List.of())));

        ActiveInterviewSessionDto dto = service().createSession(presetRequest(), "still-fresh-key");

        assertThat(dto.sessionId()).isEqualTo("is_fresh");
    }

    /**
     * MAX_EXTRA_TOKENS_PER_SESSION is a hard, permanent ceiling — once
     * reached, further replay is TERMINAL (BAD_REQUEST), the same as an
     * expired key: retrying cannot help, since the cap never goes back down.
     * Proves interview_session_extra_tokens cannot grow without bound even
     * from a key that is still well within its replay window.
     */
    @Test
    void createSessionRetryPastTheExtraTokenCapIsRejectedWithoutMintingAnotherToken() {
        String requestHash = service().hashRequest(presetRequest());
        when(sessionRepository.findByIdempotencyKeyHash(hashKey("hammered-key")))
                .thenReturn(Optional.of(new InterviewSessionRepository.IdempotencyLookup("is_hammered", requestHash, fixedNow - 5000)));
        when(sessionRepository.countExtraTokens("is_hammered")).thenReturn(5); // == MAX_EXTRA_TOKENS_PER_SESSION

        assertThatThrownBy(() -> service().createSession(presetRequest(), "hammered-key"))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));

        verify(sessionRepository, never()).mintAdditionalToken(any(), anyLong());
    }

    /** Below the cap, replay proceeds normally — the cap must not fire early. */
    @Test
    void createSessionRetryOneBelowTheExtraTokenCapStillSucceeds() {
        String requestHash = service().hashRequest(presetRequest());
        when(sessionRepository.findByIdempotencyKeyHash(hashKey("almost-hammered-key")))
                .thenReturn(Optional.of(new InterviewSessionRepository.IdempotencyLookup("is_almost", requestHash, fixedNow - 5000)));
        when(sessionRepository.countExtraTokens("is_almost")).thenReturn(4); // one under the cap
        when(sessionRepository.mintAdditionalToken("is_almost", fixedNow))
                .thenReturn(new SessionToken.TokenPair("raw-token", "token-hash"));
        InterviewSessionRecord record = new InterviewSessionRecord(
                "is_almost", "stale-hash", SessionStatus.ACTIVE,
                new InterviewSessionConfig("mixed", List.of("signals"), 1, "junior", "Junior Angular Developer"),
                1200, fixedNow - 5000, fixedNow + 1_200_000L, null, false, "ia_almost");
        when(sessionRepository.getSessionSnapshot("is_almost"))
                .thenReturn(Optional.of(new InterviewSessionSnapshot(record, List.of())));

        ActiveInterviewSessionDto dto = service().createSession(presetRequest(), "almost-hammered-key");

        assertThat(dto.sessionId()).isEqualTo("is_almost");
    }

    /**
     * EXCESSIVE REPEATED REPLAY, velocity-bounded: the rate limiter's
     * capacity is exhausted well before the extra-token cap could ever be —
     * a REAL {@link IdempotencyReplayRateLimiter} (not a mock) is exhausted
     * by genuinely calling {@code createSession} repeatedly with the SAME
     * key, proving the limiter (not merely the cap) is actually wired into
     * this path. Denial is TRANSIENT (429/RateLimitedException with a
     * positive retryAfterSeconds), unlike the two TERMINAL cases above.
     */
    @Test
    void repeatedReplayOfTheSameKeyIsEventuallyRateLimited() {
        String requestHash = service().hashRequest(presetRequest());
        when(sessionRepository.findByIdempotencyKeyHash(hashKey("hot-key")))
                .thenReturn(Optional.of(new InterviewSessionRepository.IdempotencyLookup("is_hot", requestHash, fixedNow - 5000)));
        when(sessionRepository.mintAdditionalToken(eq("is_hot"), anyLong()))
                .thenReturn(new SessionToken.TokenPair("raw-token", "token-hash"));
        InterviewSessionRecord record = new InterviewSessionRecord(
                "is_hot", "stale-hash", SessionStatus.ACTIVE,
                new InterviewSessionConfig("mixed", List.of("signals"), 1, "junior", "Junior Angular Developer"),
                1200, fixedNow - 5000, fixedNow + 1_200_000L, null, false, "ia_hot");
        when(sessionRepository.getSessionSnapshot("is_hot"))
                .thenReturn(Optional.of(new InterviewSessionSnapshot(record, List.of())));

        // ONE service/limiter instance reused across every call in this test
        // — service() would otherwise hand back a fresh, un-exhausted
        // limiter each time.
        InterviewSessionService sharedService = new InterviewSessionService(
                assessmentBuilder, presetBuilder, sessionRepository, quizRepository,
                () -> fixedNow, AssessmentRandom.seeded(1), new IdempotencyReplayRateLimiter());

        int allowed = 0;
        Exception denial = null;
        for (int i = 0; i < 8; i++) { // capacity is 5 — 8 attempts must exhaust it
            try {
                sharedService.createSession(presetRequest(), "hot-key");
                allowed++;
            } catch (com.quizbackend.quiz.ratelimit.RateLimitedException e) {
                denial = e;
                break;
            }
        }

        assertThat(allowed).isEqualTo(5);
        assertThat(denial).isInstanceOf(com.quizbackend.quiz.ratelimit.RateLimitedException.class);
        assertThat(((com.quizbackend.quiz.ratelimit.RateLimitedException) denial).getRetryAfterSeconds()).isPositive();
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

    /**
     * A token minted by {@link InterviewSessionRepository#mintAdditionalToken}
     * for a concurrent-race/idempotent-retry response is a DIFFERENT bearer
     * token from the session's primary one, so authenticate() must accept it
     * too — not only the primary token_hash — for every other endpoint
     * (resume, answer, submit, etc.) to actually be usable by whichever
     * caller received it.
     */
    @Test
    void resumeAcceptsATokenThatWasMintedAsAnAdditionalCredentialForTheSameSession() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        when(sessionRepository.getSessionAuthenticationRecord("is_x"))
                .thenReturn(Optional.of(new SessionAuthenticationRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE, fixedNow + 10_000)));

        String extraRawToken = SessionToken.generateSessionIdentity().rawToken();
        when(sessionRepository.hasExtraToken("is_x", SessionToken.hashToken(extraRawToken))).thenReturn(true);

        InterviewSessionConfig config = new InterviewSessionConfig("mixed", List.of("signals"), 1, "junior", "Junior Angular Developer");
        InterviewSessionRecord record = new InterviewSessionRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE,
                config, 1200, fixedNow - 500, fixedNow + 10_000, null, false, "ia_x");
        when(sessionRepository.getSessionSnapshot("is_x"))
                .thenReturn(Optional.of(new InterviewSessionSnapshot(record, List.of())));

        // Does not throw — the presented token is neither the primary token
        // nor gibberish, it is a genuinely separate valid credential.
        service().resumeSession("is_x", extraRawToken);
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
    void resumeReturnsTheActiveSessionWithoutASessionTokenAndNoAnswersWhenNonePersisted() {
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
        // getAnswers left unstubbed -> Mockito's default empty List, exactly
        // matching a session with zero persisted rows.

        ActiveInterviewSessionDto dto = service().resumeSession("is_x", identity.rawToken());

        assertThat(dto.sessionToken()).isNull();
        assertThat(dto.answers()).isEmpty();
        assertThat(dto.questions()).hasSize(1);
    }

    @Test
    void resumePopulatesConfirmedAnswersFromPersistedStateOrderedByPosition() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        when(sessionRepository.getSessionAuthenticationRecord("is_x"))
                .thenReturn(Optional.of(new SessionAuthenticationRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE, fixedNow + 10_000)));

        InterviewSessionConfig config = new InterviewSessionConfig("mixed", List.of("signals"), 2, "junior", "Junior Angular Developer");
        InterviewSessionRecord record = new InterviewSessionRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE,
                config, 1200, fixedNow - 500, fixedNow + 10_000, null, false, "ia_x");
        SessionQuestionSnapshot q0 = new SessionQuestionSnapshot(0, "signals:q:0", "signals", "Q0?", "single",
                "Because.", List.of(new SessionOptionSnapshot(101, "A", 0, true)), false, null);
        SessionQuestionSnapshot q1 = new SessionQuestionSnapshot(1, "signals:q:1", "signals", "Q1?", "multiple",
                "Because.", List.of(new SessionOptionSnapshot(201, "A", 0, true), new SessionOptionSnapshot(202, "B", 1, true)), true, null);
        when(sessionRepository.getSessionSnapshot("is_x"))
                .thenReturn(Optional.of(new InterviewSessionSnapshot(record, List.of(q0, q1))));
        // Stored out of position order deliberately, to prove the service
        // re-sorts rather than trusting getAnswers' own row order.
        when(sessionRepository.getAnswers("is_x")).thenReturn(List.of(
                new SessionAnswerRecord(1, List.of(201, 202), fixedNow),
                new SessionAnswerRecord(0, List.of(101), fixedNow)));

        ActiveInterviewSessionDto dto = service().resumeSession("is_x", identity.rawToken());

        assertThat(dto.answers()).extracting("questionId", "selectedOptionIds")
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("signals:q:0", List.of(101)),
                        org.assertj.core.groups.Tuple.tuple("signals:q:1", List.of(201, 202)));
        // Flag state is on the QUESTION dto, independent of the answers list.
        assertThat(dto.questions().get(1).flagged()).isTrue();
        assertThat(dto.questions().get(0).flagged()).isFalse();
    }

    @Test
    void resumeOmitsAnEmptyPersistedAnswerRowDefensively() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        when(sessionRepository.getSessionAuthenticationRecord("is_x"))
                .thenReturn(Optional.of(new SessionAuthenticationRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE, fixedNow + 10_000)));
        InterviewSessionConfig config = new InterviewSessionConfig("mixed", List.of("signals"), 1, "junior", "Junior Angular Developer");
        InterviewSessionRecord record = new InterviewSessionRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE,
                config, 1200, fixedNow - 500, fixedNow + 10_000, null, false, "ia_x");
        SessionQuestionSnapshot q0 = new SessionQuestionSnapshot(0, "signals:q:0", "signals", "Q0?", "single",
                "Because.", List.of(new SessionOptionSnapshot(101, "A", 0, true)), false, null);
        when(sessionRepository.getSessionSnapshot("is_x"))
                .thenReturn(Optional.of(new InterviewSessionSnapshot(record, List.of(q0))));
        // Defensive case: an empty selection row should never exist in
        // practice (cleared answers are deleted, not stored empty), but the
        // mapping must not surface it as an answer if it somehow did.
        when(sessionRepository.getAnswers("is_x")).thenReturn(List.of(new SessionAnswerRecord(0, List.of(), fixedNow)));

        ActiveInterviewSessionDto dto = service().resumeSession("is_x", identity.rawToken());

        assertThat(dto.answers()).isEmpty();
    }

    // ── saveAnswer ───────────────────────────────────────────────────────

    @Test
    void saveAnswerRejectsAMissingToken() {
        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", null, Map.of("selectedOptionIds", List.of(101))))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
    }

    @Test
    void saveAnswerRejectsAWrongToken() {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        when(sessionRepository.getSessionAuthenticationRecord("is_x"))
                .thenReturn(Optional.of(new SessionAuthenticationRecord("is_x", identity.tokenHash(), SessionStatus.ACTIVE, fixedNow + 10_000)));
        String wrongToken = SessionToken.generateSessionIdentity().rawToken();

        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", wrongToken, Map.of("selectedOptionIds", List.of(101))))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
        // Body/question validation must never run before authentication.
        verify(sessionRepository, never()).saveAnswer(any());
    }

    private String authenticatedSession(String sessionId, SessionStatus status, long expiresAt) {
        SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
        when(sessionRepository.getSessionAuthenticationRecord(sessionId))
                .thenReturn(Optional.of(new SessionAuthenticationRecord(sessionId, identity.tokenHash(), status, expiresAt)));
        return identity.rawToken();
    }

    @Test
    void saveAnswerTranslatesAnUnknownQuestionToBadRequest() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.saveAnswer(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.QUESTION_NOT_IN_SESSION, "Question does not belong to this session"));

        assertThatThrownBy(() -> service().saveAnswer("is_x", "ghost:q:0", token, Map.of("selectedOptionIds", List.of(101))))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void saveAnswerTranslatesAnOptionFromAnotherQuestionToBadRequest() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.saveAnswer(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.OPTION_NOT_IN_QUESTION, "Selected option does not belong to this question"));

        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", token, Map.of("selectedOptionIds", List.of(999))))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void saveAnswerTranslatesTooManySelectionsForASingleQuestionToBadRequest() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.saveAnswer(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.INVALID_SELECTION_COUNT, "This question accepts exactly one selection"));

        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", token, Map.of("selectedOptionIds", List.of(101, 102))))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST))
                .hasMessage("This question accepts exactly one selection");
    }

    @Test
    void saveAnswerTranslatesAnExpiredSessionToSessionExpired() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.saveAnswer(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.SESSION_EXPIRED, "Session expired"));

        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", token, Map.of("selectedOptionIds", List.of(101))))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.SESSION_EXPIRED));
    }

    @Test
    void saveAnswerTranslatesASubmittedSessionToConflict() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.saveAnswer(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.SESSION_NOT_ACTIVE, "Session already submitted"));

        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", token, Map.of("selectedOptionIds", List.of(101))))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.CONFLICT));
    }

    @Test
    void saveAnswerReturnsTheConfirmedCountsFromTheRepositoryOnSuccess() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        ArgumentCaptor<SaveAnswerInput> captor = ArgumentCaptor.forClass(SaveAnswerInput.class);
        when(sessionRepository.saveAnswer(captor.capture()))
                .thenReturn(new SavedAnswerState("signals:q:0", List.of(101), 1, 2));

        SavedAnswerState result = service().saveAnswer("is_x", "signals:q:0", token, Map.of("selectedOptionIds", List.of(101)));

        assertThat(result.answeredCount()).isEqualTo(1);
        assertThat(result.questionCount()).isEqualTo(2);
        // now is captured ONCE, inside this call — the injected fixed clock.
        assertThat(captor.getValue().now()).isEqualTo(fixedNow);
        assertThat(captor.getValue().sessionId()).isEqualTo("is_x");
        assertThat(captor.getValue().questionId()).isEqualTo("signals:q:0");
    }

    @Test
    void saveAnswerAllowsAnEmptySelectionToClearTheAnswer() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        ArgumentCaptor<SaveAnswerInput> captor = ArgumentCaptor.forClass(SaveAnswerInput.class);
        when(sessionRepository.saveAnswer(captor.capture()))
                .thenReturn(new SavedAnswerState("signals:q:0", List.of(), 0, 2));

        SavedAnswerState result = service().saveAnswer("is_x", "signals:q:0", token, Map.of("selectedOptionIds", List.of()));

        assertThat(result.selectedOptionIds()).isEmpty();
        assertThat(captor.getValue().selectedOptionIds()).isEmpty();
    }

    @Test
    void saveAnswerRejectsANonArraySelectedOptionIds() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", token, Map.of("selectedOptionIds", "101")))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void saveAnswerRejectsDuplicateSelectedOptionIds() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", token, Map.of("selectedOptionIds", List.of(101, 101))))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void saveAnswerRejectsANonIntegerSelection() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", token, Map.of("selectedOptionIds", List.of(101.5))))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void saveAnswerRejectsTooManySelectedOptionIds() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        List<Integer> tooMany = new java.util.ArrayList<>();
        for (int i = 0; i < 33; i++) {
            tooMany.add(i);
        }
        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", token, Map.of("selectedOptionIds", tooMany)))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void saveAnswerRejectsAnUnexpectedBodyField() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        Map<String, Object> body = new HashMap<>();
        body.put("selectedOptionIds", List.of(101));
        body.put("isCorrect", true);

        assertThatThrownBy(() -> service().saveAnswer("is_x", "signals:q:0", token, body))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    // ── setFlagged ───────────────────────────────────────────────────────

    @Test
    void setFlaggedRejectsAMissingToken() {
        assertThatThrownBy(() -> service().setFlagged("is_x", "signals:q:0", null, Map.of("flagged", true)))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
    }

    @Test
    void setFlaggedRejectsAWrongToken() {
        when(sessionRepository.getSessionAuthenticationRecord("is_x"))
                .thenReturn(Optional.of(new SessionAuthenticationRecord(
                        "is_x", SessionToken.generateSessionIdentity().tokenHash(), SessionStatus.ACTIVE, fixedNow + 10_000)));
        String wrongToken = SessionToken.generateSessionIdentity().rawToken();

        assertThatThrownBy(() -> service().setFlagged("is_x", "signals:q:0", wrongToken, Map.of("flagged", true)))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
        verify(sessionRepository, never()).setFlagged(any());
    }

    @Test
    void setFlaggedTranslatesAnUnknownQuestionToBadRequest() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.setFlagged(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.QUESTION_NOT_IN_SESSION, "Question does not belong to this session"));

        assertThatThrownBy(() -> service().setFlagged("is_x", "ghost:q:0", token, Map.of("flagged", true)))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void setFlaggedTranslatesAnExpiredSessionToSessionExpired() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.setFlagged(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.SESSION_EXPIRED, "Session expired"));

        assertThatThrownBy(() -> service().setFlagged("is_x", "signals:q:0", token, Map.of("flagged", true)))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.SESSION_EXPIRED));
    }

    @Test
    void setFlaggedTranslatesASubmittedSessionToConflict() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.setFlagged(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.SESSION_NOT_ACTIVE, "Session already submitted"));

        assertThatThrownBy(() -> service().setFlagged("is_x", "signals:q:0", token, Map.of("flagged", true)))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.CONFLICT));
    }

    @Test
    void setFlaggedTrueThenFalseBothRoundTripThroughTheRepositoryUnchanged() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        ArgumentCaptor<SetFlaggedInput> captor = ArgumentCaptor.forClass(SetFlaggedInput.class);
        when(sessionRepository.setFlagged(captor.capture())).thenAnswer(invocation ->
                new FlaggedState(captor.getValue().questionId(), captor.getValue().flagged()));

        FlaggedState setTrue = service().setFlagged("is_x", "signals:q:0", token, Map.of("flagged", true));
        assertThat(setTrue.flagged()).isTrue();

        FlaggedState setFalse = service().setFlagged("is_x", "signals:q:0", token, Map.of("flagged", false));
        assertThat(setFalse.flagged()).isFalse();

        assertThat(captor.getAllValues()).extracting(SetFlaggedInput::flagged).containsExactly(true, false);
    }

    @Test
    void setFlaggedRejectsANonBooleanValue() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        assertThatThrownBy(() -> service().setFlagged("is_x", "signals:q:0", token, Map.of("flagged", "yes")))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    @Test
    void setFlaggedRejectsAnUnexpectedBodyField() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        Map<String, Object> body = new HashMap<>();
        body.put("flagged", true);
        body.put("selectedOptionIds", List.of(101));

        assertThatThrownBy(() -> service().setFlagged("is_x", "signals:q:0", token, body))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST));
    }

    // ── submitSession / getResult (Slice 5) ──────────────────────────────

    private static FrozenInterviewResult sampleFrozenResult(String sessionId) {
        FrozenReviewQuestion question = new FrozenReviewQuestion(
                "signals:q:0", "signals", "What does this log?", "single",
                List.of(new FrozenReviewOption(101, "0"), new FrozenReviewOption(102, "1")),
                List.of(101), List.of(101), "Because signals are reactive.", false, null);
        return new FrozenInterviewResult(
                sessionId, "submitted", 1_700_000_000_000L, false,
                1, 1, 0, 1, 0, 100,
                1200, 600, 600,
                new FrozenResultConfig("preset", "junior", null, List.of("signals"), 1),
                new FrozenPerformance(List.of(new FrozenTopicBucket("signals", "Signals", 1, 0, 0, 1, 100))),
                List.of(question));
    }

    @Test
    void submitSessionRejectsAMissingToken() {
        assertThatThrownBy(() -> service().submitSession("is_x", null, Map.of()))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
        verify(sessionRepository, never()).finalizeSession(any());
    }

    @Test
    void submitSessionRejectsAWrongToken() {
        authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        String wrongToken = SessionToken.generateSessionIdentity().rawToken();

        assertThatThrownBy(() -> service().submitSession("is_x", wrongToken, Map.of()))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
        verify(sessionRepository, never()).finalizeSession(any());
    }

    @Test
    void submitSessionRejectsANonEmptyBodyNamingTheOffendingField() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        Map<String, Object> body = new HashMap<>();
        body.put("score", 100);

        assertThatThrownBy(() -> service().submitSession("is_x", token, body))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.BAD_REQUEST))
                .hasMessageContaining("\"score\"");
        verify(sessionRepository, never()).finalizeSession(any());
    }

    @Test
    void submitSessionAcceptsAnEmptyBodyAndDelegatesToFinalize() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        ArgumentCaptor<FinalizeSessionInput> captor = ArgumentCaptor.forClass(FinalizeSessionInput.class);
        when(sessionRepository.finalizeSession(captor.capture())).thenReturn(sampleFrozenResult("is_x"));

        InterviewResultDto dto = service().submitSession("is_x", token, Map.of());

        assertThat(dto.sessionId()).isEqualTo("is_x");
        assertThat(dto.status()).isEqualTo("submitted");
        assertThat(dto.total()).isEqualTo(1);
        assertThat(dto.review()).hasSize(1);
        assertThat(captor.getValue().sessionId()).isEqualTo("is_x");
        assertThat(captor.getValue().now()).isEqualTo(fixedNow);
    }

    @Test
    void submitSessionAcceptsANullBodyTheSameAsEmpty() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.finalizeSession(any())).thenReturn(sampleFrozenResult("is_x"));

        InterviewResultDto dto = service().submitSession("is_x", token, null);

        assertThat(dto.sessionId()).isEqualTo("is_x");
    }

    @Test
    void submitSessionTranslatesAnAlreadySubmittedRaceToConflict() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.finalizeSession(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.SESSION_NOT_ACTIVE, "Session already submitted"));

        assertThatThrownBy(() -> service().submitSession("is_x", token, Map.of()))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.CONFLICT));
    }

    @Test
    void submitSessionTranslatesCorruptStoredDataToTheGenericInternalMessage() {
        // Node quirk, preserved verbatim: CORRUPT_DATA/VALIDATION/etc. all
        // fall through to the SAME generic "Answer could not be saved"
        // message, even on submit — not a more specific "result" wording.
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(sessionRepository.finalizeSession(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.CORRUPT_DATA, "Session is_x has an invalid stored result"));

        assertThatThrownBy(() -> service().submitSession("is_x", token, Map.of()))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.INTERNAL))
                .hasMessage("Answer could not be saved");
    }

    @Test
    void submitSessionResolvesTopicTitlesFromTheLiveQuizBankAtFinalizationTime() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        QuizEntity liveQuiz = new QuizEntity(1L, "signals", "Angular Signals (Renamed)", "s", "i", "junior", "[]", 0, "active");
        when(quizRepository.findByQuizIdAndStatus("signals", "active")).thenReturn(Optional.of(liveQuiz));

        ArgumentCaptor<FinalizeSessionInput> captor = ArgumentCaptor.forClass(FinalizeSessionInput.class);
        when(sessionRepository.finalizeSession(captor.capture())).thenReturn(sampleFrozenResult("is_x"));

        service().submitSession("is_x", token, Map.of());

        // The service must hand the repository a resolver that reads the
        // LIVE bank — proven by invoking it directly here, exactly as
        // finalizeSession itself would during scoring.
        assertThat(captor.getValue().topicTitleFor().resolve("signals")).isEqualTo("Angular Signals (Renamed)");
    }

    @Test
    void submitSessionFallsBackToTheTopicIdWhenTheLiveQuizIsGoneOrRetired() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);
        when(quizRepository.findByQuizIdAndStatus("signals", "active")).thenReturn(Optional.empty());

        ArgumentCaptor<FinalizeSessionInput> captor = ArgumentCaptor.forClass(FinalizeSessionInput.class);
        when(sessionRepository.finalizeSession(captor.capture())).thenReturn(sampleFrozenResult("is_x"));

        service().submitSession("is_x", token, Map.of());

        assertThat(captor.getValue().topicTitleFor().resolve("signals")).isEqualTo("signals");
    }

    // ── getResult ────────────────────────────────────────────────────────

    @Test
    void getResultRejectsAMissingToken() {
        assertThatThrownBy(() -> service().getResult("is_x", null))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
    }

    @Test
    void getResultRejectsAnUnknownSession() {
        String token = SessionToken.generateSessionIdentity().rawToken();
        when(sessionRepository.getSessionAuthenticationRecord("is_ghost")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service().getResult("is_ghost", token))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
    }

    @Test
    void getResultOfASubmittedSessionReturnsTheStoredResultWithoutReFinalizing() {
        String token = authenticatedSession("is_x", SessionStatus.SUBMITTED, fixedNow + 10_000);
        when(sessionRepository.getSubmittedResult("is_x")).thenReturn(Optional.of(sampleFrozenResult("is_x")));

        InterviewResultDto dto = service().getResult("is_x", token);

        assertThat(dto.status()).isEqualTo("submitted");
        verify(sessionRepository, never()).finalizeSession(any());
    }

    @Test
    void getResultOfASubmittedSessionWithNoStoredResultIsAnInternalError() {
        String token = authenticatedSession("is_x", SessionStatus.SUBMITTED, fixedNow + 10_000);
        when(sessionRepository.getSubmittedResult("is_x")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service().getResult("is_x", token))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.INTERNAL))
                .hasMessage("Result could not be read");
    }

    @Test
    void getResultOfAStillRunningActiveSessionIsRejectedWithConflictAndNeverFinalizes() {
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow + 10_000);

        assertThatThrownBy(() -> service().getResult("is_x", token))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.CONFLICT))
                .hasMessage("This assessment has not been submitted");
        verify(sessionRepository, never()).finalizeSession(any());
    }

    @Test
    void getResultOfAnActiveSessionPastItsDeadlineAutoFinalizesEvenWithoutAPriorSubmit() {
        // expiresAt == fixedNow: the deadline has JUST passed. Node's own
        // boundary is `expiresAt <= now`, so this must auto-finalize, not 409.
        String token = authenticatedSession("is_x", SessionStatus.ACTIVE, fixedNow);
        ArgumentCaptor<FinalizeSessionInput> captor = ArgumentCaptor.forClass(FinalizeSessionInput.class);
        when(sessionRepository.finalizeSession(captor.capture())).thenReturn(sampleFrozenResult("is_x"));

        InterviewResultDto dto = service().getResult("is_x", token);

        assertThat(dto.status()).isEqualTo("submitted");
        assertThat(captor.getValue().now()).isEqualTo(fixedNow);
    }

    @Test
    void getResultOfAnExpiredSessionAutoFinalizesRegardlessOfTheStoredDeadline() {
        // status already EXPIRED (Slice 4's markExpiredIfDue already flipped
        // it) with a deadline that is, incidentally, still in the future on
        // the clock alone — the STATUS check must be sufficient on its own.
        String token = authenticatedSession("is_x", SessionStatus.EXPIRED, fixedNow + 10_000);
        when(sessionRepository.finalizeSession(any())).thenReturn(sampleFrozenResult("is_x"));

        InterviewResultDto dto = service().getResult("is_x", token);

        assertThat(dto.status()).isEqualTo("submitted");
    }

    @Test
    void getResultTranslatesAFinalizeFailureTheSameWayAsSubmit() {
        String token = authenticatedSession("is_x", SessionStatus.EXPIRED, fixedNow + 10_000);
        when(sessionRepository.finalizeSession(any())).thenThrow(new SessionRepositoryException(
                SessionRepositoryException.Category.SESSION_NOT_FOUND, "Session not found"));

        assertThatThrownBy(() -> service().getResult("is_x", token))
                .isInstanceOf(SessionServiceException.class)
                .satisfies(ex -> assertThat(((SessionServiceException) ex).getCode())
                        .isEqualTo(SessionServiceException.Code.UNAUTHORIZED));
    }
}
