package com.quizbackend.interview;

import com.quizbackend.interview.InterviewSessionRepository.SessionAuthenticationRecord;
import com.quizbackend.interview.dto.ActiveInterviewAnswerDto;
import com.quizbackend.interview.dto.ActiveInterviewSessionDto;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.LongSupplier;

/**
 * Interview session orchestration — port of the Node reference's
 * {@code session.service.ts}, scoped to create + resume (Slice 3). Knows
 * nothing about Spring MVC beyond plain values in, plain values out, so the
 * controller stays a thin adapter, mirroring the Node router's own role.
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

    private final AssessmentBuilder assessmentBuilder;
    private final AssessmentPresetBuilder presetBuilder;
    private final InterviewSessionRepository sessionRepository;
    private final LongSupplier now;
    private final RandomSource random;

    @Autowired
    public InterviewSessionService(AssessmentBuilder assessmentBuilder, AssessmentPresetBuilder presetBuilder,
            InterviewSessionRepository sessionRepository) {
        this(assessmentBuilder, presetBuilder, sessionRepository, System::currentTimeMillis, AssessmentRandom.CRYPTO);
    }

    /** Test/advanced constructor — injects a deterministic clock and/or shuffle source. */
    public InterviewSessionService(AssessmentBuilder assessmentBuilder, AssessmentPresetBuilder presetBuilder,
            InterviewSessionRepository sessionRepository, LongSupplier now, RandomSource random) {
        this.assessmentBuilder = assessmentBuilder;
        this.presetBuilder = presetBuilder;
        this.sessionRepository = sessionRepository;
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

        // No answer persistence in this slice (Slice 3 is create/resume parity
        // only) — session_answers can never contain rows yet, so an empty
        // list is not a shortcut, it is the actually-correct current state.
        List<ActiveInterviewAnswerDto> answers = List.of();

        return InterviewSessionDtoMapper.toActiveSessionDto(new InterviewSessionDtoMapper.ActiveSessionParams(
                stored.session(), stored.questions(), answers, nowMs, null));
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
