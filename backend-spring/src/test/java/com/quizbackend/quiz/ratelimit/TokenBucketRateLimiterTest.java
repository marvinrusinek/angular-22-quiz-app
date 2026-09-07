package com.quizbackend.quiz.ratelimit;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Behavioral proof for {@link TokenBucketRateLimiter} — port of the Node
 * reference's {@code shared/rate-limit.ts}, matching its own test's
 * capacity (40) / refill (1/sec) constants used for the Topic Quiz check
 * route.
 */
class TokenBucketRateLimiterTest {

    @Test
    void allowsUpToCapacityRequestsThenBlocks() {
        long[] clock = { 1_700_000_000_000L };
        TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(40, 1.0, () -> clock[0]);

        for (int i = 0; i < 40; i++) {
            assertThat(limiter.tryConsume("1.2.3.4").allowed()).as("request %d", i).isTrue();
        }
        TokenBucketRateLimiter.Verdict blocked = limiter.tryConsume("1.2.3.4");
        assertThat(blocked.allowed()).isFalse();
        assertThat(blocked.retryAfterSeconds()).isGreaterThanOrEqualTo(1);
    }

    @Test
    void refillsAsTheInjectedClockAdvances() {
        long[] clock = { 1_700_000_000_000L };
        TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(40, 1.0, () -> clock[0]);

        for (int i = 0; i < 40; i++) {
            limiter.tryConsume("k");
        }
        assertThat(limiter.tryConsume("k").allowed()).isFalse();

        clock[0] += 5_000; // five tokens back at 1/sec
        assertThat(limiter.tryConsume("k").allowed()).isTrue();
    }

    @Test
    void differentKeysHaveIndependentBuckets() {
        long[] clock = { 0L };
        TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(1, 1.0, () -> clock[0]);

        assertThat(limiter.tryConsume("a").allowed()).isTrue();
        assertThat(limiter.tryConsume("a").allowed()).isFalse();
        // A different key is unaffected by "a" draining its own bucket.
        assertThat(limiter.tryConsume("b").allowed()).isTrue();
    }

    @Test
    void neverRefillsAboveCapacity() {
        long[] clock = { 0L };
        TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(5, 1.0, () -> clock[0]);

        limiter.tryConsume("k");
        clock[0] += 1_000_000; // a huge gap — refill is capped at `capacity`, not capacity + elapsed*refill
        // The gap alone refills the bucket back to full capacity (5), regardless
        // of how depleted it was before — so exactly 5 more successful consumes
        // are available after the gap, then the 6th fails.
        for (int i = 0; i < 5; i++) {
            assertThat(limiter.tryConsume("k").allowed()).as("post-gap request %d", i).isTrue();
        }
        assertThat(limiter.tryConsume("k").allowed()).isFalse();
    }

    @Test
    void retryAfterIsAtLeastOneSecondNeverZero() {
        long[] clock = { 0L };
        // A fast refill rate could otherwise compute a sub-1-second retry.
        TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(1, 100.0, () -> clock[0]);
        limiter.tryConsume("k");
        assertThat(limiter.tryConsume("k").retryAfterSeconds()).isEqualTo(1);
    }

    @Test
    void resetClearsAllBucketsForTesting() {
        long[] clock = { 0L };
        TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(1, 1.0, () -> clock[0]);
        limiter.tryConsume("k");
        assertThat(limiter.tryConsume("k").allowed()).isFalse();

        limiter.reset();
        assertThat(limiter.tryConsume("k").allowed()).isTrue();
    }

    @Test
    void concurrentConsumersOnTheSameKeyNeverExceedCapacity() throws InterruptedException {
        long[] clock = { 0L };
        TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(40, 0.0, () -> clock[0]);
        java.util.concurrent.atomic.AtomicInteger allowedCount = new java.util.concurrent.atomic.AtomicInteger();
        int threads = 100;
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(20);
        java.util.List<java.util.concurrent.Future<?>> futures = new java.util.ArrayList<>();
        for (int i = 0; i < threads; i++) {
            futures.add(pool.submit(() -> {
                if (limiter.tryConsume("shared").allowed()) {
                    allowedCount.incrementAndGet();
                }
            }));
        }
        for (var future : futures) {
            try {
                future.get();
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        pool.shutdown();
        assertThat(allowedCount.get()).isEqualTo(40);
    }
}
