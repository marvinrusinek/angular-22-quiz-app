/**
 * The ONE definition of where this suite's controlled resources live —
 * mirrors e2e/support/e2e-backends.js's role for the main harness.
 *
 * Deliberately DIFFERENT ports from the main e2e harness (3000/8080) and
 * from a developer's own `ng serve`/`npm run dev` (4200/3000), so this suite
 * can run ALONGSIDE either without colliding. The Angular dev server is the
 * one exception — it reads :3000 as its Node API base in dev mode
 * (api-base-url.token.ts), so this suite's Node backend must also bind to
 * :3000. It never reuses the main harness's Spring backend (certificates
 * are Node-only) and never reuses a developer's own Node backend (that
 * would send claim-form traffic at their real database).
 */
const NODE_PORT = 3000;
const ANGULAR_PORT = 4200;
const DEBUG_PORT = 3098;
const DB_PORT = 55434;
const DB_CONTAINER_NAME = 'cert-e2e-postgres';
const DB_NAME = 'cert_e2e';
// 127.0.0.1 for Postgres (the container genuinely only publishes IPv4), but
// `localhost` for everything served by Node/Vite on this machine — `ng
// serve`'s dev server (Vite) binds ONLY to the IPv6 loopback (::1), not
// 127.0.0.1, confirmed directly (a health check against 127.0.0.1 hung to
// its full timeout even though the server was genuinely up and `curl
// localhost:4200` worked). `localhost` resolves correctly either way.
const DB_URL = `postgres://postgres:cert_e2e_local_only@127.0.0.1:${DB_PORT}/${DB_NAME}`;

module.exports = {
  NODE_PORT,
  ANGULAR_PORT,
  DEBUG_PORT,
  DB_PORT,
  DB_CONTAINER_NAME,
  DB_NAME,
  DB_URL,
  NODE_HEALTH_URL: `http://localhost:${NODE_PORT}/api/health`,
  ANGULAR_URL: `http://localhost:${ANGULAR_PORT}`,
  DEBUG_SENT_LOG_URL: `http://localhost:${DEBUG_PORT}/__test_debug__/sent-log`,
  DEBUG_MINT_EXPIRED_URL: `http://localhost:${DEBUG_PORT}/__test_debug__/mint-expired-token`
};
