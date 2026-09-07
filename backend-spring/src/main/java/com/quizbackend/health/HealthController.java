package com.quizbackend.health;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.lang.management.ManagementFactory;

/**
 * Liveness probe, parity with the Node reference's {@code GET /api/health}.
 *
 * <p>No {@link com.quizbackend.security.responsepolicy.ResponsePolicyContext#set}
 * call is needed here: the response ({@code status}, {@code uptimeSeconds})
 * contains no property the default {@code PUBLIC_METADATA} policy bans, so it
 * passes the response-policy guard the same way every other route does
 * &mdash; proving the guard is transparent to a genuinely safe response, not
 * merely something every route must remember to satisfy.
 */
@RestController
public class HealthController {

    @GetMapping("/api/health")
    public HealthResponse health() {
        long uptimeSeconds = ManagementFactory.getRuntimeMXBean().getUptime() / 1000;
        return HealthResponse.ok(uptimeSeconds);
    }
}
