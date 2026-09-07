package com.quizbackend.health;

/**
 * The public liveness-probe body. Mirrors the Node reference backend's
 * {@code HealthBody} ({@code backend/src/routes/health.route.ts}) exactly:
 * {@code {"status":"ok","uptimeSeconds":<int>}}. Deliberately says nothing
 * about configuration, versions, paths, database state, or origins &mdash; a
 * health endpoint is usually the most exposed route on a service, so it
 * reveals only that the process is up.
 */
public record HealthResponse(String status, long uptimeSeconds) {

    public static HealthResponse ok(long uptimeSeconds) {
        return new HealthResponse("ok", uptimeSeconds);
    }
}
