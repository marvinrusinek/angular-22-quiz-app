package com.quizbackend.quiz.ratelimit;

/**
 * Thrown when {@link TokenBucketRateLimiter#tryConsume} denies a request.
 * Port of the Node reference's raw {@code respondTooManyRequests} — deliberately
 * NOT routed through {@code ApiException}'s code/status vocabulary, since
 * {@code RATE_LIMITED} carries a dynamic {@code Retry-After} header no other
 * error in this application needs.
 */
public class RateLimitedException extends RuntimeException {

    private final long retryAfterSeconds;

    public RateLimitedException(long retryAfterSeconds) {
        super("Too many requests");
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public long getRetryAfterSeconds() {
        return retryAfterSeconds;
    }
}
