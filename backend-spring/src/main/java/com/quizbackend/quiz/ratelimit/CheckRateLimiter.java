package com.quizbackend.quiz.ratelimit;

import org.springframework.stereotype.Component;

/**
 * The single, application-wide rate limiter for {@code POST
 * /quizzes/:quizId/check} — port of the Node reference's {@code
 * createRateLimiter({capacity: 40, refillPerSecond: 1, ...})} wiring in
 * {@code app.ts}. A Spring-managed singleton, exactly like Node's ONE
 * limiter instance shared across every request for the life of the
 * process — a per-request limiter would reset on every call and limit
 * nothing.
 *
 * <p>Question delivery ({@code /questions}) is deliberately NOT limited by
 * this or any other limiter — it exposes only text the client is
 * authorized to render, matching Node's own comment in {@code app.ts}.
 */
@Component
public class CheckRateLimiter {

    private static final int CAPACITY = 40;
    private static final double REFILL_PER_SECOND = 1.0;

    private final TokenBucketRateLimiter limiter;

    public CheckRateLimiter() {
        this.limiter = new TokenBucketRateLimiter(CAPACITY, REFILL_PER_SECOND, System::currentTimeMillis);
    }

    public TokenBucketRateLimiter.Verdict tryConsume(String key) {
        return limiter.tryConsume(key);
    }
}
