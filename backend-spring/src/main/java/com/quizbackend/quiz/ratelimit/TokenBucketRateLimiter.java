package com.quizbackend.quiz.ratelimit;

import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * A small per-key token bucket — port of the Node reference's {@code
 * backend/src/shared/rate-limit.ts}.
 *
 * <p>WHY THE CHECK ENDPOINT NEEDS THIS AT ALL: {@code /check} releases
 * correctness and an explanation for one question per call. That is the
 * intended behavior, but without a limit it is also a complete answer-key
 * oracle — roughly 185 requests would drain the bank. Rate limiting does
 * not make that impossible; it makes it slow, visible and attributable.
 *
 * <p>SCOPE: in-memory and per-process, exactly like Node's — a shared
 * store would be needed before scaling to multiple replicas, and Node
 * does not have one either. Thread-safe via {@link ConcurrentHashMap} with
 * atomic per-key updates ({@code compute}), since Spring MVC handles
 * concurrent requests on separate threads (Node's is single-threaded, so
 * its equivalent map needs no such protection — this is the one place the
 * port must add something Node's runtime model made unnecessary, without
 * changing the OBSERVABLE token-bucket semantics).
 */
public final class TokenBucketRateLimiter {

    /** Bound memory: a stream of distinct keys must not grow the map without limit. */
    private static final int MAX_BUCKETS = 10_000;

    private record Bucket(double tokens, long lastRefillMs) {
    }

    public record Verdict(boolean allowed, long retryAfterSeconds) {
        static final Verdict ALLOWED = new Verdict(true, 0);
    }

    private final int capacity;
    private final double refillPerSecond;
    private final LongSupplier now;
    private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();

    public TokenBucketRateLimiter(int capacity, double refillPerSecond, LongSupplier now) {
        this.capacity = capacity;
        this.refillPerSecond = refillPerSecond;
        this.now = now;
    }

    /**
     * Consume one token for {@code key} if available. Port of Node's
     * middleware body: refill-then-consume, computed atomically per key so
     * concurrent requests for the same key cannot both observe stale tokens.
     */
    public Verdict tryConsume(String key) {
        long currentMs = now.getAsLong();
        Verdict[] result = new Verdict[1];

        // Checked and cleared BEFORE the atomic per-key update below — a
        // ConcurrentHashMap must never be mutated (including cleared) from
        // inside its own compute()/computeIfAbsent() lambda for the SAME
        // map. This is a best-effort memory bound, not a security boundary,
        // so the non-atomic size check racing a concurrent insert is
        // harmless — matching Node's own single-threaded, non-atomic
        // "if (buckets.size >= MAX_BUCKETS) buckets.clear()" check.
        if (!buckets.containsKey(key) && buckets.size() >= MAX_BUCKETS) {
            buckets.clear();
        }

        buckets.compute(key, (k, existing) -> {
            Bucket bucket = existing != null ? existing : new Bucket(capacity, currentMs);

            double elapsedSeconds = Math.max(0, (currentMs - bucket.lastRefillMs()) / 1000.0);
            double refilled = Math.min(capacity, bucket.tokens() + elapsedSeconds * refillPerSecond);

            if (refilled < 1) {
                double secondsUntilToken = (1 - refilled) / refillPerSecond;
                long retryAfter = Math.max(1, (long) Math.ceil(secondsUntilToken));
                result[0] = new Verdict(false, retryAfter);
                return new Bucket(refilled, currentMs);
            }

            result[0] = Verdict.ALLOWED;
            return new Bucket(refilled - 1, currentMs);
        });

        return result[0];
    }

    /** Test/diagnostic hook. Clears all buckets. */
    public void reset() {
        buckets.clear();
    }
}
