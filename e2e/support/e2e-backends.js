/**
 * The ONE definition of where Playwright's controlled backends live.
 *
 * The Angular app routes to two permanent backends and, in a dev build served
 * from localhost, to FIXED local ports (src/app/shared/tokens/api-base-url.token.ts):
 *
 *   Topic Quiz + Interview-builder metadata → Node/Express  http://localhost:3000/api
 *   Interview session lifecycle             → Spring Boot   http://localhost:8080/api
 *
 * Those ports are also the only loopback ports the page's Content-Security-Policy
 * (`connect-src` in src/index.html) allows, so the harness cannot move them: it
 * has to CONTROL 3000 and 8080, and abort if either is already taken.
 *
 * Everything that needs a port or a health URL — playwright.config.ts, the Spring
 * launcher, the port preflight, the specs that talk to a backend directly — reads
 * them from HERE. `spring-datasource.spec.ts` compares these values with the
 * app's own constants, so the harness can no longer drift away from the app's
 * routing without a test failing. (It did once: the split was introduced with no
 * change here, and every Interview spec quietly talked to the wrong backend.)
 */

const NODE_PORT = 3000;
const SPRING_PORT = 8080;

/** What the Angular dev server is reachable as — the browser Origin both backends must allow. */
const ANGULAR_ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];

module.exports = {
  NODE_PORT,
  SPRING_PORT,
  NODE_API_BASE_URL: `http://localhost:${NODE_PORT}/api`,
  SPRING_API_BASE_URL: `http://localhost:${SPRING_PORT}/api`,
  NODE_HEALTH_URL: `http://localhost:${NODE_PORT}/api/health`,
  SPRING_HEALTH_URL: `http://localhost:${SPRING_PORT}/api/health`,
  ANGULAR_ORIGINS
};
