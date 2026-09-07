package com.quizbackend.interview;

import java.security.SecureRandom;
import java.util.List;

/**
 * Port of the Node reference's {@code assessment.random.ts}. Everything
 * random in assessment generation flows through {@link RandomSource} so
 * behavior is reproducible under test and swappable for a strong generator
 * in production — the builder never calls an unabstracted RNG directly.
 */
public final class AssessmentRandom {

    private AssessmentRandom() {
    }

    /**
     * Production source. {@link SecureRandom#nextDouble()} already returns a
     * value uniformly distributed in [0, 1), the same contract Node's
     * crypto-backed source provides (there {@code crypto.randomInt(0, 2**32) /
     * 2**32}); no extra scaling is needed on the Java side.
     */
    public static final RandomSource CRYPTO = new SecureRandom()::nextDouble;

    /**
     * Deterministic test source — EXACT port of Node's {@code seededRandomSource}
     * (mulberry32). Cross-validated against the actual Node output for seed 42
     * (see {@code AssessmentRandomTest}): both produce the identical 8-value
     * draw sequence and the identical shuffle of [0..9].
     */
    public static RandomSource seeded(int seed) {
        int[] state = {seed};
        return () -> {
            state[0] += 0x6d2b79f5;
            int t = state[0];
            t = (t ^ (t >>> 15)) * (t | 1);
            t ^= t + (t ^ (t >>> 7)) * (t | 61);
            long unsigned = (t ^ (t >>> 14)) & 0xFFFFFFFFL;
            return unsigned / 4294967296.0;
        };
    }

    /** Replays a fixed list of values, then throws. Pins exact orderings in tests. */
    public static RandomSource fixed(double... values) {
        int[] index = {0};
        return () -> {
            if (index[0] >= values.length) {
                throw new IllegalStateException("Fixed random source exhausted");
            }
            return values[index[0]++];
        };
    }

    /**
     * EXACT port of the Node reference's {@code shuffleArrayInPlace}, itself an
     * exact port of Angular's {@code ArrayUtils.shuffleArray}. Two properties
     * are deliberately reproduced: the loop runs down to {@code i === 0}
     * INCLUSIVE (one extra draw versus textbook Fisher-Yates, required for
     * seeded-source parity), and it mutates in place and returns the same list.
     * Callers must clone first if the input must survive unshuffled.
     */
    public static <T> List<T> shuffleInPlace(List<T> list, RandomSource random) {
        for (int i = list.size() - 1; i >= 0; i--) {
            int j = (int) Math.floor(random.next() * (i + 1));
            T a = list.get(i);
            T b = list.get(j);
            list.set(i, b);
            list.set(j, a);
        }
        return list;
    }
}
