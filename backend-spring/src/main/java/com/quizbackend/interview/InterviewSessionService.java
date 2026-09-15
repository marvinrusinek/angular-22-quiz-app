package com.quizbackend.interview;

import com.quizbackend.interview.InterviewSessionRepository.FinalizeSessionInput;
import com.quizbackend.interview.InterviewSessionRepository.FlaggedState;
import com.quizbackend.interview.InterviewSessionRepository.SavedAnswerState;
import com.quizbackend.interview.InterviewSessionRepository.SessionAnswerRecord;
import com.quizbackend.interview.InterviewSessionRepository.SessionAuthenticationRecord;
import com.quizbackend.interview.InterviewSessionRepository.SetFlaggedInput;
import com.quizbackend.interview.dto.ActiveInterviewAnswerDto;
import com.quizbackend.interview.dto.ActiveInterviewSessionDto;
import com.quizbackend.interview.dto.InterviewResultDto;
import com.quizbackend.quiz.QuizRepository;
import com.quizbackend.quiz.ratelimit.RateLimitedException;
import com.quizbackend.quiz.ratelimit.TokenBucketRateLimiter;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.LongSupplier;

/**
 * Interview session orchestration — port of the Node reference's
 * {@code session.service.ts}: create/resume (Slice 3), answer save + Mark
 * for Review (Slice 4), submit/result (Slice 5). Knows nothing about Spring
 * MVC beyond plain values in, plain values out, so the controller stays a
 * thin adapter, mirroring the Node router's own role.
 */
@Service
public class InterviewSessionService {

    private static final List<String> FORBIDDEN_REQUEST_KEYS = List.of(
            "durationSeconds", "duration", "expiresAt", "createdAt", "sessionId", "attemptId",
            "sessionToken", "tokenHash", "questionIds", "optionIds", "questions", "options",
            "correct", "isCorrect", "correctOptionIds", "score", "result", "status");

    private static final List<String> ALLOWED_REQUEST_KEYS =
            List.of("mode", "presetId", "difficulty", "topicIds", "questionCount");

    private static final int MAX_TOPIC_IDS = 50;
    private static final int MAX_STRING_LENGTH = 100;
    private static final int MAX_IDENTITY_ATTEMPTS = 3;
    private static final int MAX_SELECTED_OPTIONS = 32;
    /** Comfortably above a UUID (36 chars); bounds header/column size, not a security control. */
    private static final int MAX_IDEMPOTENCY_KEY_LENGTH = 200;

    /**
     * How long a committed idempotency key remains REPLAYABLE (findable, and
     * capable of minting an additional token) after the session it belongs
     * to was created. An idempotency key is credential-equivalent (see
     * migration 007's own doc comment) — an indefinite replay window would
     * let a captured key mint working tokens forever. 30 minutes is
     * comfortably longer than every legitimate replay path this app has: the
     * client's own 60s in-page create timeout
     * ({@code BuildYourInterviewComponent.SESSION_CREATE_TIMEOUT_MS}) and its
     * 10-minute reload-recovery window ({@code PENDING_CREATE_TTL_MS}), so no
     * genuine retry is ever rejected — while still bounding how long a
     * captured key stays useful to anyone else.
     */
    private static final long REPLAY_WINDOW_MS = 30 * 60_000L;

    /**
     * How many ADDITIONAL tokens {@link #tryReturnExisting} may ever mint for
     * one session. Independent of, and a hard backstop under, {@code
     * idempotencyReplayRateLimiter} — the limiter bounds how FAST replay
     * happens, this bounds how MANY tokens can ever exist for one session
     * regardless of timing (see interview_session_extra_tokens' own
     * migration doc comment on why unlimited growth here is unacceptable
     * even though each individual token is only ever handed to one caller).
     */
    private static final int MAX_EXTRA_TOKENS_PER_SESSION = 5;

    private final AssessmentBuilder assessmentBuilder;
    private final AssessmentPresetBuilder presetBuilder;
    private final InterviewSessionRepository sessionRepository;
    private final QuizRepository quizRepository;
    private final LongSupplier now;
    private final RandomSource random;
    private final IdempotencyReplayRateLimiter idempotencyReplayRateLimiter;

    @Autowired
    public InterviewSessionService(AssessmentBuilder assessmentBuilder, AssessmentPresetBuilder presetBuilder,
            InterviewSessionRepository sessionRepository, QuizRepository quizRepository,
            IdempotencyReplayRateLimiter idempotencyReplayRateLimiter) {
        this(assessmentBuilder, presetBuilder, sessionRepository, quizRepository, System::currentTimeMillis,
                AssessmentRandom.CRYPTO, idempotencyReplayRateLimiter);
    }

    /** Test/advanced constructor — injects a deterministic clock and/or shuffle source. */
    public InterviewSessionService(AssessmentBuilder assessmentBuilder, AssessmentPresetBuilder presetBuilder,
            InterviewSessionRepository sessionRepository, QuizRepository quizRepository, LongSupplier now, RandomSource random,
            IdempotencyReplayRateLimiter idempotencyReplayRateLimiter) {
        this.assessmentBuilder = assessmentBuilder;
        this.presetBuilder = presetBuilder;
        this.sessionRepository = sessionRepository;
        this.quizRepository = quizRepository;
        this.now = now;
        this.random = random;
        this.idempotencyReplayRateLimiter = idempotencyReplayRateLimiter;
    }

    /** Overload preserved for any caller with no idempotency key to offer — identical to {@code createSession(request, null)}. */
    public ActiveInterviewSessionDto createSession(Map<String, Object> request) {
        return createSession(request, null);
    }

    /**
     * Create a session. {@code rawIdempotencyKey} is the client's OPTIONAL,
     * self-generated key for this logical start attempt (the {@code
     * Idempotency-Key} header) — see {@code docs/spring-production-runbook.md}
     * for the full design. A null/absent key preserves the exact pre-existing
     * behavior (always mint a new session) for backward compatibility with
     * any caller that does not send one.
     *
     * <p>When a key IS present:
     * <ol>
     *   <li>If a session already exists for this key, this is a RETRY of an
     *       already-committed attempt (the client's own request, or a
     *       response it never received) — return that session, not a new
     *       one. Its request must match the ORIGINAL request's fingerprint,
     *       or the key is being reused for something materially different
     *       and the call fails safely (CONFLICT) instead of returning an
     *       unrelated session.</li>
     *   <li>Otherwise, create normally, but persist the key + fingerprint
     *       alongside the session so a LATER retry (or a concurrent racer)
     *       can find it. A concurrent racer that loses the database's own
     *       uniqueness check falls back to step 1 rather than erroring.</li>
     * </ol>
     */
    public ActiveInterviewSessionDto createSession(Map<String, Object> request, String rawIdempotencyKey) {
        Map<String, Object> validated = validateRequest(request);
        String idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
        // Hashed IMMEDIATELY and never referenced again by this method — every
        // call below this line passes idempotencyKeyHash, never
        // idempotencyKey/rawIdempotencyKey/request's raw header value. An
        // idempotency key is credential-equivalent (see migration 007's own
        // doc comment), so it gets the SAME one-way-hash-only discipline this
        // codebase already applies to bearer tokens.
        String idempotencyKeyHash = idempotencyKey == null ? null : hashIdempotencyKey(idempotencyKey);
        String requestHash = idempotencyKeyHash == null ? null : hashRequest(validated);

        if (idempotencyKeyHash != null) {
            Optional<ActiveInterviewSessionDto> existing = tryReturnExisting(idempotencyKeyHash, requestHash);
            if (existing.isPresent()) {
                return existing.get();
            }
        }

        GeneratedInterviewSnapshot snapshot = resolveAssessment(validated);
        long createdAt = now.getAsLong();
        long expiresAt = createdAt + snapshot.durationSeconds() * 1000L;

        SessionToken.SessionIdentity identity;
        try {
            identity = persistWithIdentityRetry(snapshot, createdAt, expiresAt, idempotencyKeyHash, requestHash);
        } catch (IdempotencyKeyRaceException race) {
            // A concurrent request committed first under this exact key while
            // we were generating/inserting ours — resolve it the same way a
            // sequential retry would, by reading back the winner.
            return tryReturnExisting(idempotencyKeyHash, requestHash)
                    .orElseThrow(() -> new SessionServiceException(
                            SessionServiceException.Code.INTERNAL, "Session could not be created"));
        }

        InterviewSessionSnapshot stored = sessionRepository.getSessionSnapshot(identity.sessionId())
                .orElseThrow(() -> new SessionServiceException(
                        SessionServiceException.Code.INTERNAL, "Session could not be read back"));

        return InterviewSessionDtoMapper.toActiveSessionDto(new InterviewSessionDtoMapper.ActiveSessionParams(
                stored.session(), stored.questions(), List.of(), createdAt, identity.rawToken()));
    }

    /**
     * An idempotency key's INSERT lost the database's own uniqueness race —
     * internal control-flow signal only, never leaves this class.
     */
    private static final class IdempotencyKeyRaceException extends RuntimeException {
    }

    /**
     * Resolve an idempotency key's HASH against an already-committed session,
     * or report empty when none exists yet (the caller should create one).
     * Never called with anything but a hash — see {@code createSession}'s own
     * comment on why the raw key never reaches this far.
     *
     * <p>A request-hash MISMATCH fails closed (CONFLICT) rather than ever
     * returning a session the current request didn't ask for. A key found
     * but past its {@link #REPLAY_WINDOW_MS} or its session's {@link
     * #MAX_EXTRA_TOKENS_PER_SESSION} cap fails closed too (BAD_REQUEST) —
     * both are TERMINAL for this key: retrying the identical request cannot
     * help, only a genuinely new attempt (a new key) can. A rate-limit denial
     * is the one TRANSIENT case (429, {@code Retry-After}) — see {@code
     * idempotencyReplayRateLimiter}'s own doc comment.
     */
    private Optional<ActiveInterviewSessionDto> tryReturnExisting(String idempotencyKeyHash, String requestHash) {
        Optional<InterviewSessionRepository.IdempotencyLookup> found =
                sessionRepository.findByIdempotencyKeyHash(idempotencyKeyHash);
        if (found.isEmpty()) {
            // A brand-new key, never a replay — NOT rate-limited or counted
            // against any cap. Only an ACTUAL replay (found below) consumes
            // either.
            return Optional.empty();
        }
        InterviewSessionRepository.IdempotencyLookup lookup = found.get();
        if (!lookup.requestHash().equals(requestHash)) {
            throw new SessionServiceException(SessionServiceException.Code.CONFLICT,
                    "This idempotency key was already used for a different request");
        }

        if (now.getAsLong() - lookup.createdAt() > REPLAY_WINDOW_MS) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST,
                    "This request has expired. Please start a new attempt.");
        }

        TokenBucketRateLimiter.Verdict verdict = idempotencyReplayRateLimiter.tryConsume(idempotencyKeyHash);
        if (!verdict.allowed()) {
            throw new RateLimitedException(verdict.retryAfterSeconds());
        }

        if (sessionRepository.countExtraTokens(lookup.sessionId()) >= MAX_EXTRA_TOKENS_PER_SESSION) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST,
                    "This request has been retried too many times. Please start a new attempt.");
        }

        // An ADDITIONAL, independently-valid token — see
        // InterviewSessionRepository#mintAdditionalToken's own doc comment
        // for why this never invalidates the session's original token (or
        // any other additional token already minted for it): whichever
        // caller(s) resolving this same idempotency key are genuinely live,
        // every one of their responses must keep working.
        SessionToken.TokenPair extra = sessionRepository.mintAdditionalToken(lookup.sessionId(), now.getAsLong());

        InterviewSessionSnapshot stored = sessionRepository.getSessionSnapshot(lookup.sessionId())
                .orElseThrow(() -> new SessionServiceException(
                        SessionServiceException.Code.INTERNAL, "Session could not be read back"));

        return Optional.of(InterviewSessionDtoMapper.toActiveSessionDto(new InterviewSessionDtoMapper.ActiveSessionParams(
                stored.session(), stored.questions(), List.of(), stored.session().createdAt(), extra.rawToken())));
    }

    /**
     * SHA-256 hex of the client's raw idempotency key — the ONLY form ever
     * persisted, queried by, rate-limited by, or logged (an idempotency key
     * is credential-equivalent; see migration 007's own doc comment). Reuses
     * {@link SessionToken#hashToken}: the algorithm is identical (SHA-256 hex
     * of a UTF-8 string) even though this value is not a bearer token — a
     * second, differently-named implementation of the exact same three lines
     * would only invite the two to drift.
     */
    private static String hashIdempotencyKey(String rawIdempotencyKey) {
        return SessionToken.hashToken(rawIdempotencyKey);
    }

    /** Trim/validate the client's key; blank or absent means "no idempotency requested". */
    private String normalizeIdempotencyKey(String raw) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if (trimmed.length() > MAX_IDEMPOTENCY_KEY_LENGTH) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST,
                    "Idempotency-Key is too long");
        }
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            // Printable ASCII only — a header value can't carry control
            // characters anyway, but this keeps the STORED value equally
            // constrained regardless of how it arrived.
            if (c < 0x20 || c > 0x7E) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST,
                        "Idempotency-Key contains an invalid character");
            }
        }
        return trimmed;
    }

    /**
     * SHA-256 hex of the VALIDATED request's meaningful fields, canonically
     * ordered — a retry of the exact same logical attempt always sends the
     * exact same fields, so this matches trivially; anything else is treated
     * as a materially different request. Never includes anything server-
     * generated (no ids, no timestamps) — only what the client itself chose.
     */
    // Package-private (not private) so the test suite can compute the SAME
    // hash a real request would, to stub a matching findByIdempotencyKey
    // lookup — the alternative (duplicating this exact algorithm inside the
    // test) is worse: two independently-maintained copies could drift.
    String hashRequest(Map<String, Object> validated) {
        StringBuilder canonical = new StringBuilder();
        canonical.append("mode=").append(validated.get("mode"));
        canonical.append(";presetId=").append(validated.get("presetId"));
        canonical.append(";difficulty=").append(validated.get("difficulty"));
        Object topicIds = validated.get("topicIds");
        canonical.append(";topicIds=");
        if (topicIds instanceof List<?> list) {
            canonical.append(list);
        } else {
            canonical.append(topicIds);
        }
        canonical.append(";questionCount=").append(validated.get("questionCount"));

        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(canonical.toString().getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                hex.append(String.format("%02x", b));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 must be available", e);
        }
    }

    public ActiveInterviewSessionDto resumeSession(String sessionId, String rawToken) {
        authenticate(sessionId, rawToken);

        SessionAuthenticationRecord auth = sessionRepository.getSessionAuthenticationRecord(sessionId)
                .orElseThrow(SessionServiceException::unauthorized);

        long nowMs = now.getAsLong();

        // Never trust a stored 'active' without checking the deadline.
        if (auth.status() == SessionStatus.ACTIVE && auth.expiresAt() <= nowMs) {
            sessionRepository.markExpiredIfDue(sessionId, nowMs);
            throw new SessionServiceException(SessionServiceException.Code.SESSION_EXPIRED, "This assessment has expired");
        }
        if (auth.status() == SessionStatus.EXPIRED) {
            throw new SessionServiceException(SessionServiceException.Code.SESSION_EXPIRED, "This assessment has expired");
        }
        if (auth.status() == SessionStatus.SUBMITTED) {
            // Results/submit are out of scope for this slice; the active route never serves a finished one.
            throw new SessionServiceException(SessionServiceException.Code.CONFLICT, "This assessment has already been submitted");
        }

        InterviewSessionSnapshot stored = sessionRepository.getSessionSnapshot(sessionId)
                .orElseThrow(SessionServiceException::unauthorized);

        List<ActiveInterviewAnswerDto> answers = savedAnswers(sessionId, stored.questions());

        return InterviewSessionDtoMapper.toActiveSessionDto(new InterviewSessionDtoMapper.ActiveSessionParams(
                stored.session(), stored.questions(), answers, nowMs, null));
    }

    /**
     * Save or clear ONE question's selection. Authentication happens FIRST —
     * no question or option validation runs until the bearer token matches,
     * so the endpoint cannot be used to probe which question ids exist in a
     * session the caller does not own.
     */
    public SavedAnswerState saveAnswer(String sessionId, String questionId, String rawToken, Map<String, Object> body) {
        authenticate(sessionId, rawToken);
        List<Integer> selectedOptionIds = parseSelectedOptionIds(body);

        try {
            // now captured ONCE, inside this call, so the deadline cannot move.
            return sessionRepository.saveAnswer(new InterviewSessionRepository.SaveAnswerInput(
                    sessionId, questionId, selectedOptionIds, now.getAsLong()));
        } catch (SessionRepositoryException e) {
            throw translateRepositoryError(e);
        }
    }

    /**
     * Set or clear the Mark-for-Review flag for ONE question. Never touches
     * an answer, never affects scoring or navigation, and never reveals
     * correctness — the response is {@code {questionId, flagged}} only.
     */
    public FlaggedState setFlagged(String sessionId, String questionId, String rawToken, Map<String, Object> body) {
        authenticate(sessionId, rawToken);
        boolean flagged = parseFlagged(body);

        try {
            return sessionRepository.setFlagged(new SetFlaggedInput(sessionId, questionId, flagged, now.getAsLong()));
        } catch (SessionRepositoryException e) {
            throw translateRepositoryError(e);
        }
    }

    /**
     * Finalize the assessment. Idempotent: an already-submitted session
     * returns its frozen result untouched, so a manual submit racing an
     * expiry submit produces exactly ONE result. Works for active AND
     * already-expired sessions — the client is never required to have
     * submitted at the exact moment the countdown hit zero.
     */
    public InterviewResultDto submitSession(String sessionId, String rawToken, Map<String, Object> body) {
        authenticate(sessionId, rawToken);
        assertEmptySubmitBody(body);

        try {
            FrozenInterviewResult result = sessionRepository.finalizeSession(
                    new FinalizeSessionInput(sessionId, now.getAsLong(), this::topicTitle));
            return InterviewResultDtoMapper.toInterviewResultDto(result);
        } catch (SessionRepositoryException e) {
            throw translateRepositoryError(e);
        }
    }

    /**
     * The frozen result. DECISION (ported from Node): an expired-but-
     * unfinalized session is FINALIZED here rather than requiring a prior
     * {@code POST /submit} — a user whose tab closed at the deadline would
     * otherwise be stuck with a result they can never retrieve. The
     * transition is idempotent and produces the same frozen result the
     * submit route would.
     */
    public InterviewResultDto getResult(String sessionId, String rawToken) {
        authenticate(sessionId, rawToken);

        SessionAuthenticationRecord auth = sessionRepository.getSessionAuthenticationRecord(sessionId)
                .orElseThrow(SessionServiceException::unauthorized);

        long nowMs = now.getAsLong();

        if (auth.status() == SessionStatus.SUBMITTED) {
            FrozenInterviewResult stored = sessionRepository.getSubmittedResult(sessionId)
                    .orElseThrow(() -> new SessionServiceException(SessionServiceException.Code.INTERNAL, "Result could not be read"));
            return InterviewResultDtoMapper.toInterviewResultDto(stored);
        }

        boolean deadlinePassed = auth.status() == SessionStatus.EXPIRED || auth.expiresAt() <= nowMs;
        if (!deadlinePassed) {
            // Still running — a result does not exist yet.
            throw new SessionServiceException(SessionServiceException.Code.CONFLICT, "This assessment has not been submitted");
        }

        try {
            FrozenInterviewResult result = sessionRepository.finalizeSession(
                    new FinalizeSessionInput(sessionId, nowMs, this::topicTitle));
            return InterviewResultDtoMapper.toInterviewResultDto(result);
        } catch (SessionRepositoryException e) {
            throw translateRepositoryError(e);
        }
    }

    /**
     * Topic display title, resolved from the CURRENT (mutable) quiz bank at
     * finalization time and then frozen into the result forever — port of
     * the Node reference's own {@code topicTitleFor}. Deliberately NOT the
     * session's frozen question content: Node reads {@code
     * quizRepository.getQuizById(topicId)?.milestone}, the live bank, at the
     * moment of finalization — see {@code InterviewScoring}'s javadoc.
     */
    private String topicTitle(String topicId) {
        return quizRepository.findByQuizIdAndStatus(topicId, "active")
                .map(quiz -> quiz.getMilestone())
                .orElse(topicId);
    }

    /**
     * A submit body must be empty. Every value in a result is determined by
     * the server, so a client claim about the score, the reason, the
     * timestamps or the answers is rejected rather than ignored.
     */
    private void assertEmptySubmitBody(Map<String, Object> body) {
        if (body == null || body.isEmpty()) {
            return;
        }
        String firstKey = body.keySet().iterator().next();
        throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST,
                "Submit accepts no fields — \"" + firstKey + "\" is determined by the server");
    }

    /**
     * Persisted selections, keyed back to the OPAQUE questionId and ordered
     * by question position. A cleared answer has no row, so it simply does
     * not appear — the client's own model treats "no entry" as unanswered.
     */
    private List<ActiveInterviewAnswerDto> savedAnswers(String sessionId, List<SessionQuestionSnapshot> questions) {
        Map<Integer, String> questionIdByPosition = new LinkedHashMap<>();
        for (SessionQuestionSnapshot question : questions) {
            questionIdByPosition.put(question.position(), question.questionId());
        }

        List<SessionAnswerRecord> answers = new ArrayList<>(sessionRepository.getAnswers(sessionId));
        answers.sort((a, b) -> Integer.compare(a.position(), b.position()));

        List<ActiveInterviewAnswerDto> result = new ArrayList<>();
        for (SessionAnswerRecord answer : answers) {
            if (answer.selectedOptionIds().isEmpty()) {
                continue;
            }
            String questionId = questionIdByPosition.get(answer.position());
            if (questionId == null) {
                continue; // defensive: orphan rows cannot exist
            }
            result.add(new ActiveInterviewAnswerDto(questionId, List.copyOf(answer.selectedOptionIds())));
        }
        return result;
    }

    /** Map repository categories onto service errors, revealing nothing extra. */
    private static SessionServiceException translateRepositoryError(SessionRepositoryException e) {
        return switch (e.getCategory()) {
            // Already authenticated, so this can only be a race with deletion.
            case SESSION_NOT_FOUND -> SessionServiceException.unauthorized();
            case SESSION_EXPIRED ->
                    new SessionServiceException(SessionServiceException.Code.SESSION_EXPIRED, "This assessment has expired");
            case SESSION_NOT_ACTIVE ->
                    new SessionServiceException(SessionServiceException.Code.CONFLICT, "This assessment has already been submitted");
            case QUESTION_NOT_IN_SESSION ->
                    new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Question does not belong to this session");
            case OPTION_NOT_IN_QUESTION ->
                    new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Selected option does not belong to this question");
            case INVALID_SELECTION_COUNT -> new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, e.getMessage());
            default -> new SessionServiceException(SessionServiceException.Code.INTERNAL, "Answer could not be saved");
        };
    }

    /**
     * Strict body validation for a save. Nothing is coerced: {@code "401"}
     * is a string, not an option id, and is rejected rather than parsed.
     */
    private List<Integer> parseSelectedOptionIds(Map<String, Object> body) {
        if (body == null) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Request body must be an object");
        }
        for (String key : body.keySet()) {
            if (key.equals("__proto__") || key.equals("constructor") || key.equals("prototype")) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Request contains a forbidden key");
            }
            if (!key.equals("selectedOptionIds")) {
                // Catches correctness/score/explanation/questionId/optionText
                // claims and anything else a client might invent.
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Unexpected field \"" + key + "\"");
            }
        }

        Object raw = body.get("selectedOptionIds");
        if (!(raw instanceof List<?> rawList)) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "selectedOptionIds must be an array");
        }
        if (rawList.size() > MAX_SELECTED_OPTIONS) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Too many selected options");
        }

        Set<Integer> seen = new HashSet<>();
        List<Integer> ids = new ArrayList<>(rawList.size());
        for (Object value : rawList) {
            if (!(value instanceof Number number) || number.doubleValue() != Math.floor(number.doubleValue())) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "selectedOptionIds must contain integers");
            }
            int intValue = number.intValue();
            if (!seen.add(intValue)) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "selectedOptionIds contains duplicates");
            }
            ids.add(intValue);
        }
        return ids;
    }

    /**
     * Strict body validation for a review-flag write. Accepts ONLY
     * {@code { flagged: boolean }} — no selection, no question metadata,
     * nothing that could be mistaken for an answer.
     */
    private boolean parseFlagged(Map<String, Object> body) {
        if (body == null) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Request body must be an object");
        }
        for (String key : body.keySet()) {
            if (key.equals("__proto__") || key.equals("constructor") || key.equals("prototype")) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Request contains a forbidden key");
            }
            if (!key.equals("flagged")) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Unexpected field \"" + key + "\"");
            }
        }
        Object flagged = body.get("flagged");
        if (!(flagged instanceof Boolean bool)) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "flagged must be a boolean");
        }
        return bool;
    }

    /**
     * Verify the bearer token. Throws the SAME generic error for every
     * failure. Checks the session's PRIMARY token first (the common case —
     * every session has exactly one caller using its one and only token, so
     * this is the only query that case ever pays), falling back to any
     * ADDITIONAL token {@link InterviewSessionRepository#mintAdditionalToken}
     * issued for an idempotent-retry/concurrent-race response — see its own
     * doc comment for why more than one token can be valid for a session at
     * once.
     */
    private void authenticate(String sessionId, String rawToken) {
        if (rawToken == null) {
            throw SessionServiceException.unauthorized();
        }
        SessionAuthenticationRecord auth = sessionRepository.getSessionAuthenticationRecord(sessionId)
                .orElseThrow(SessionServiceException::unauthorized);
        if (SessionToken.tokenMatches(rawToken, auth.tokenHash())) {
            return;
        }
        if (SessionToken.isWellFormedToken(rawToken)
                && sessionRepository.hasExtraToken(sessionId, SessionToken.hashToken(rawToken))) {
            return;
        }
        throw SessionServiceException.unauthorized();
    }

    private Map<String, Object> validateRequest(Map<String, Object> request) {
        if (request == null) {
            return Map.of();
        }
        for (String key : request.keySet()) {
            if (key.equals("__proto__") || key.equals("constructor") || key.equals("prototype")) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Request contains a forbidden key");
            }
            if (FORBIDDEN_REQUEST_KEYS.contains(key)) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST,
                        "\"" + key + "\" is determined by the server and may not be supplied");
            }
            if (!ALLOWED_REQUEST_KEYS.contains(key)) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Unexpected field \"" + key + "\"");
            }
        }

        Object topicIds = request.get("topicIds");
        if (topicIds instanceof List<?> list) {
            if (list.size() > MAX_TOPIC_IDS) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Too many topics requested");
            }
            for (Object id : list) {
                if (id instanceof String s && s.length() > MAX_STRING_LENGTH) {
                    throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "Topic id is too long");
                }
            }
        }

        return request;
    }

    private GeneratedInterviewSnapshot resolveAssessment(Map<String, Object> request) {
        Object mode = request.get("mode");
        if (!"preset".equals(mode) && !"custom".equals(mode)) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "mode must be \"preset\" or \"custom\"");
        }

        try {
            return "preset".equals(mode) ? buildPreset(request) : buildCustom(request);
        } catch (AssessmentBuildException e) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, e.getMessage());
        }
    }

    private GeneratedInterviewSnapshot buildPreset(Map<String, Object> request) {
        Object presetId = request.get("presetId");
        if (!(presetId instanceof String presetIdString)) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "presetId is required for preset mode");
        }
        // A preset owns its topics, count, duration and quotas.
        for (String key : Set.of("topicIds", "difficulty", "questionCount")) {
            if (request.get(key) != null) {
                throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST,
                        "\"" + key + "\" may not be supplied with a preset — the preset defines it");
            }
        }

        InterviewPreset preset = InterviewPresets.findById(presetIdString);
        if (preset == null) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "unknown preset \"" + presetIdString + "\"");
        }

        return presetBuilder.buildPresetAssessment(preset, random);
    }

    private GeneratedInterviewSnapshot buildCustom(Map<String, Object> request) {
        if (request.get("presetId") != null) {
            throw new SessionServiceException(SessionServiceException.Code.BAD_REQUEST, "presetId may not be supplied in custom mode");
        }

        Object difficulty = request.get("difficulty");
        Object rawTopicIds = request.get("topicIds");
        Object rawCount = request.get("questionCount");

        List<String> topicIds = null;
        if (rawTopicIds instanceof List<?> list) {
            topicIds = new ArrayList<>();
            for (Object item : list) {
                topicIds.add(item instanceof String s ? s : null);
            }
        }
        Integer questionCount = rawCount instanceof Number n ? n.intValue() : null;

        AssessmentBuilder.BuildRequest buildRequest = new AssessmentBuilder.BuildRequest(
                difficulty instanceof String s ? s : null, topicIds, questionCount);

        InterviewBuildConfig config = assessmentBuilder.validateBuildRequest(buildRequest);
        return assessmentBuilder.buildInterviewAssessment(config, random);
    }

    /**
     * A session/attempt id collision is astronomically unlikely with 128
     * bits, but if one occurred the correct response is a fresh identity —
     * not retrying a validation or integrity failure, which would just fail
     * again.
     */
    private SessionToken.SessionIdentity persistWithIdentityRetry(
            GeneratedInterviewSnapshot snapshot, long createdAt, long expiresAt,
            String idempotencyKeyHash, String idempotencyRequestHash) {
        for (int attempt = 1; attempt <= MAX_IDENTITY_ATTEMPTS; attempt++) {
            SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
            CreateSessionInput input = toCreateInput(snapshot, identity, createdAt, expiresAt,
                    idempotencyKeyHash, idempotencyRequestHash);

            try {
                sessionRepository.createSessionSnapshot(input);
                return identity;
            } catch (SessionRepositoryException e) {
                if (e.getCategory() == SessionRepositoryException.Category.IDEMPOTENCY_KEY_RACE) {
                    // Not a session/attempt id collision — a concurrent racer
                    // already won under this exact key. Retrying with a new
                    // random identity would never resolve that; the caller
                    // must read back the winner instead.
                    throw new IdempotencyKeyRaceException();
                }
                boolean collided = e.getCategory() == SessionRepositoryException.Category.CONSTRAINT
                        && e.getMessage() != null && e.getMessage().toLowerCase(java.util.Locale.ROOT).contains("uniqueness");
                if (!collided || attempt == MAX_IDENTITY_ATTEMPTS) {
                    throw new SessionServiceException(SessionServiceException.Code.INTERNAL, "Session could not be created");
                }
                // else: mint a completely new identity and try again
            }
        }
        throw new SessionServiceException(SessionServiceException.Code.INTERNAL, "Session could not be created");
    }

    private CreateSessionInput toCreateInput(GeneratedInterviewSnapshot snapshot,
            SessionToken.SessionIdentity identity, long createdAt, long expiresAt,
            String idempotencyKeyHash, String idempotencyRequestHash) {
        InterviewBuildConfig cfg = snapshot.config();
        InterviewSessionConfig config = new InterviewSessionConfig(
                cfg.difficulty(), cfg.topicIds(), cfg.questionCount(), cfg.presetId(), cfg.presetName());

        return new CreateSessionInput(
                identity.sessionId(), identity.tokenHash(), identity.attemptId(),
                config, snapshot.durationSeconds(), createdAt, expiresAt, snapshot.questions(),
                idempotencyKeyHash, idempotencyRequestHash);
    }
}
