'use strict';

/** Poll a URL until it responds ok, or throw with the last error/status seen. */
async function waitForHttpOk(url, { timeoutMs = 45_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out waiting for ${url} to respond ok after ${timeoutMs}ms. Last error: ${lastError?.message ?? 'none'}`
  );
}

module.exports = { waitForHttpOk };
