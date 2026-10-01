/**
 * Stops and removes this suite's own isolated Postgres container after the
 * run. Never touches anything else — no other container, no developer
 * database, no other process. Playwright stops the webServer entries
 * (Node backend, and Angular only if this run started it) on its own; this
 * hook only owns the one resource Playwright itself doesn't manage.
 */
const { execSync } = require('node:child_process');
const { DB_CONTAINER_NAME } = require('./cert-e2e-backends');

module.exports = async function globalTeardown() {
  try {
    execSync(`docker rm -f ${DB_CONTAINER_NAME}`, { stdio: 'pipe' });
    console.log(`[cert-e2e-db] removed ${DB_CONTAINER_NAME}`);
  } catch {
    // Already gone, or Docker unavailable — nothing to clean up either way.
  }
};
