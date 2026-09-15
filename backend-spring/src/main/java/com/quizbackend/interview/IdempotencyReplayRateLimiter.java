package com.quizbackend.interview;

import com.quizbackend.quiz.ratelimit.TokenBucketRateLimiter;
import org.springframework.stereotype.Component;

/**
 * Throttles how FAST a single Idempotency-Key can be replayed — same
 * mechanism as {@link com.quizbackend.quiz.ratelimit.CheckRateLimiter}, a
 * different application. An idempotency key is credential-equivalent (see
 * migration 007_interview_session_idempotency.sql's own doc comment): a
 * captured key can be replayed to mint a fresh, working bearer token for its
 * session, so replaying it must be slow enough to be attributable, exactly
 * like the answer-key-oracle reasoning {@code CheckRateLimiter} documents
 * for {@code /check}.
 *
 * <p>Keyed by the idempotency key's OWN hash (never the raw key — see
 * {@link InterviewSessionService#hashIdempotencyKey}), so this limiter's
 * in-memory bucket map never holds a raw key either. A brand-new key (one
 * {@link InterviewSessionRepository#findByIdempotencyKeyHash} has never seen
 * before) never touches this limiter at all — see
 * {@code InterviewSessionService#tryReturnExisting}'s own comment for why
 * only an actual REPLAY (a key already resolving to a committed session)
 * consumes a token here.
 *
 * <p>Capacity/refill are deliberately generous relative to how this
 * mechanism is actually used (a handful of retries within
 * {@code REPLAY_WINDOW_MS}), while still bounding a tight retry loop: 5
 * replays, refilling one every 30s.
 */
@Component
public class IdempotencyReplayRateLimiter {

    private static final int CAPACITY = 5;
    private static final double REFILL_PER_SECOND = 1.0 / 30.0;

    private final TokenBucketRateLimiter limiter;

    public IdempotencyReplayRateLimiter() {
        this.limiter = new TokenBucketRateLimiter(CAPACITY, REFILL_PER_SECOND, System::currentTimeMillis);
    }

    public TokenBucketRateLimiter.Verdict tryConsume(String idempotencyKeyHash) {
        return limiter.tryConsume(idempotencyKeyHash);
    }
}
