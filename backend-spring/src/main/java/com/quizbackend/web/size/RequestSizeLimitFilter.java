package com.quizbackend.web.size;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * JSON request-body size limit — port of the Node reference's {@code
 * express.json({ limit: '32kb' })} ({@code backend/src/app.ts}), which
 * resolves (verified this slice by actually running Node's own {@code
 * bytes} library: {@code bytes.parse('32kb') === 32768}) to exactly 32768
 * bytes, applied ONLY to requests whose Content-Type is {@code
 * application/json} (Express's {@code type-is}-based exact match, ignoring
 * parameters like {@code charset} — the same default {@code express.json()}
 * itself uses).
 *
 * <p>Ordered to run AFTER {@code ResponsePolicyGuardFilter} ({@code
 * HIGHEST_PRECEDENCE + 10}), mirroring Node's own registration order
 * ({@code securityHeaders}, {@code cors}, {@code createResponseGuard()},
 * THEN {@code express.json()}): the response-policy guard's {@code
 * ContentCachingResponseWrapper} therefore still wraps and scans this
 * filter's 413 body (harmlessly — it is a fixed, safe literal), exactly as
 * Node's own {@code res.json} patch would see the error handler's 413
 * write, since response-guard registers before the body-size middleware
 * there too.
 *
 * <p>Enforces the limit against the ACTUAL BYTES READ from the stream, not
 * merely the declared {@code Content-Length} — protecting against an
 * absent, chunked, or misleading header exactly like Node's underlying
 * {@code raw-body}/{@code bytes} machinery does. A {@code Content-Length}
 * that already exceeds the limit is rejected immediately without reading
 * any body at all; otherwise the stream is read incrementally and aborted
 * the instant more than {@value #LIMIT_BYTES} bytes have been seen, so an
 * oversized body is never fully buffered into memory.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 15)
public class RequestSizeLimitFilter extends OncePerRequestFilter {

    /** 32768 bytes — {@code bytes.parse('32kb')}, confirmed by running Node's own library. */
    static final int LIMIT_BYTES = 32 * 1024;

    private static final String APPLICATION_JSON = "application/json";

    private static final byte[] TOO_LARGE_BODY =
            "{\"error\":{\"code\":\"PAYLOAD_TOO_LARGE\",\"message\":\"Request body too large\"}}"
                    .getBytes(StandardCharsets.UTF_8);

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {

        if (!isJsonContentType(request.getContentType())) {
            filterChain.doFilter(request, response);
            return;
        }

        long declaredLength = request.getContentLengthLong();
        if (declaredLength > LIMIT_BYTES) {
            writeTooLarge(response);
            return;
        }

        byte[] body;
        try {
            body = readBounded(request.getInputStream(), LIMIT_BYTES);
        } catch (BodyTooLargeException tooLarge) {
            writeTooLarge(response);
            return;
        }

        filterChain.doFilter(new CachedBodyHttpServletRequest(request, body), response);
    }

    /** Exact match, ignoring parameters (e.g. {@code ; charset=utf-8}) — the same default {@code express.json()} itself uses. */
    private static boolean isJsonContentType(String contentType) {
        if (contentType == null) {
            return false;
        }
        int semicolon = contentType.indexOf(';');
        String mediaType = (semicolon >= 0 ? contentType.substring(0, semicolon) : contentType).trim();
        return mediaType.equalsIgnoreCase(APPLICATION_JSON);
    }

    /**
     * Reads the ENTIRE stream only if it stays within {@code limit} bytes;
     * throws as soon as more than {@code limit} bytes have actually been
     * read, regardless of what {@code Content-Length} claimed.
     */
    private static byte[] readBounded(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(Math.min(limit + 1, 8192));
        byte[] chunk = new byte[8192];
        int total = 0;
        int read;
        while ((read = in.read(chunk)) != -1) {
            total += read;
            if (total > limit) {
                throw new BodyTooLargeException();
            }
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    private static void writeTooLarge(HttpServletResponse response) throws IOException {
        response.setStatus(413);
        response.setContentType("application/json;charset=UTF-8");
        response.getOutputStream().write(TOO_LARGE_BODY);
    }

    private static final class BodyTooLargeException extends RuntimeException {
    }
}
