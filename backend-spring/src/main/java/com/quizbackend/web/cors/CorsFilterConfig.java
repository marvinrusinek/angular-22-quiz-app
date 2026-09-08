package com.quizbackend.web.cors;

import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.web.filter.CorsFilter;

/**
 * Registers Spring's own {@link CorsFilter} as a genuine Servlet filter
 * (NOT via {@code WebMvcConfigurer#addCorsMappings}, which only applies
 * inside {@code DispatcherServlet}'s handler dispatch, too late to match
 * Node's registration point) — positioned to mirror the Node reference's
 * {@code app.ts} middleware order exactly: {@code securityHeaders} (Spring:
 * {@link com.quizbackend.web.SecurityHeadersFilter}, {@code
 * Ordered.HIGHEST_PRECEDENCE}) then {@code cors(...)} (here) then {@code
 * createResponseGuard()} (Spring: {@code ResponsePolicyGuardFilter}, {@code
 * HIGHEST_PRECEDENCE + 10}) then {@code express.json({limit:'32kb'})}
 * (Spring: {@code RequestSizeLimitFilter}, {@code HIGHEST_PRECEDENCE + 15}).
 *
 * <p>Ordered via an EXPLICIT {@link FilterRegistrationBean#setOrder}, not a
 * plain {@code @Order} annotation on the {@code @Bean} factory method:
 * empirically verified this slice (via a real MockMvc request whose
 * oversized body should trigger {@code RequestSizeLimitFilter}'s
 * short-circuit BEFORE {@link CorsFilter} ever ran) that {@code @Order} on
 * a {@code @Bean}-produced {@link CorsFilter} is NOT honored the way it is
 * for a directly {@code @Component}-annotated filter class — the bean
 * ended up registered AFTER {@code RequestSizeLimitFilter} despite the
 * annotation, so a CORS-eligible request whose body was too large received
 * NO {@code Access-Control-Allow-Origin} header at all. Wrapping the bean
 * in a {@link FilterRegistrationBean} with an explicit {@code setOrder}
 * call is the documented, reliable way to control a framework-provided
 * filter's position in Spring Boot, and was verified to fix the ordering
 * (see {@code RequestSizeLimitIntegrationTest
 * #corsHeadersArePresentOnA413ResponseForAnAllowedOrigin}).
 *
 * <p>This ordering is what lets a CORS preflight short-circuit before ANY
 * receipt validation, bearer-token check, response-policy guard, or route
 * business logic ever runs — {@link CorsFilter} fully answers a valid
 * preflight itself and never calls {@code filterChain.doFilter} further.
 */
@Configuration
public class CorsFilterConfig {

    @Bean
    public FilterRegistrationBean<CorsFilter> corsFilter(ApiCorsConfigurationSource corsConfigurationSource) {
        FilterRegistrationBean<CorsFilter> registration =
                new FilterRegistrationBean<>(new CorsFilter(corsConfigurationSource));
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE + 5);
        return registration;
    }
}
