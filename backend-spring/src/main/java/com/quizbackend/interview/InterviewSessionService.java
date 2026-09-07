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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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

    private final AssessmentBuilder assessmentBuilder;
    private final AssessmentPresetBuilder presetBuilder;
    private final InterviewSessionRepository sessionRepository;
    private final QuizRepository quizRepository;
    private final LongSupplier now;
    private final RandomSource random;

    @Autowired
    public InterviewSessionService(AssessmentBuilder assessmentBuilder, AssessmentPresetBuilder presetBuilder,
            InterviewSessionRepository sessionRepository, QuizRepository quizRepository) {
        this(assessmentBuilder, presetBuilder, sessionRepository, quizRepository, System::currentTimeMillis, AssessmentRandom.CRYPTO);
    }

    /** Test/advanced constructor — injects a deterministic clock and/or shuffle source. */
    public InterviewSessionService(AssessmentBuilder assessmentBuilder, AssessmentPresetBuilder presetBuilder,
            InterviewSessionRepository sessionRepository, QuizRepository quizRepository, LongSupplier now, RandomSource random) {
        this.assessmentBuilder = assessmentBuilder;
        this.presetBuilder = presetBuilder;
        this.sessionRepository = sessionRepository;
        this.quizRepository = quizRepository;
        this.now = now;
        this.random = random;
    }

    public ActiveInterviewSessionDto createSession(Map<String, Object> request) {
        GeneratedInterviewSnapshot snapshot = resolveAssessment(validateRequest(request));
        long createdAt = now.getAsLong();
        long expiresAt = createdAt + snapshot.durationSeconds() * 1000L;

        SessionToken.SessionIdentity identity = persistWithIdentityRetry(snapshot, createdAt, expiresAt);

        InterviewSessionSnapshot stored = sessionRepository.getSessionSnapshot(identity.sessionId())
                .orElseThrow(() -> new SessionServiceException(
                        SessionServiceException.Code.INTERNAL, "Session could not be read back"));

        return InterviewSessionDtoMapper.toActiveSessionDto(new InterviewSessionDtoMapper.ActiveSessionParams(
                stored.session(), stored.questions(), List.of(), createdAt, identity.rawToken()));
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

    /** Verify the bearer token. Throws the SAME generic error for every failure. */
    private void authenticate(String sessionId, String rawToken) {
        if (rawToken == null) {
            throw SessionServiceException.unauthorized();
        }
        SessionAuthenticationRecord auth = sessionRepository.getSessionAuthenticationRecord(sessionId)
                .orElseThrow(SessionServiceException::unauthorized);
        if (!SessionToken.tokenMatches(rawToken, auth.tokenHash())) {
            throw SessionServiceException.unauthorized();
        }
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
            GeneratedInterviewSnapshot snapshot, long createdAt, long expiresAt) {
        for (int attempt = 1; attempt <= MAX_IDENTITY_ATTEMPTS; attempt++) {
            SessionToken.SessionIdentity identity = SessionToken.generateSessionIdentity();
            CreateSessionInput input = toCreateInput(snapshot, identity, createdAt, expiresAt);

            try {
                sessionRepository.createSessionSnapshot(input);
                return identity;
            } catch (SessionRepositoryException e) {
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
            SessionToken.SessionIdentity identity, long createdAt, long expiresAt) {
        InterviewBuildConfig cfg = snapshot.config();
        InterviewSessionConfig config = new InterviewSessionConfig(
                cfg.difficulty(), cfg.topicIds(), cfg.questionCount(), cfg.presetId(), cfg.presetName());

        return new CreateSessionInput(
                identity.sessionId(), identity.tokenHash(), identity.attemptId(),
                config, snapshot.durationSeconds(), createdAt, expiresAt, snapshot.questions());
    }
}
