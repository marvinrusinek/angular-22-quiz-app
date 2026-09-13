'use strict';

const net = require('node:net');

/**
 * Bind to port 0 (OS-assigned free port), read it back, release it
 * immediately. Standard "probe then reuse" pattern — not airtight under
 * adversarial concurrency, but combined with each app process's own retry-free
 * startup this is what the ecosystem uses in practice, and each GitHub-hosted
 * CI run gets its own isolated VM anyway (see run.js's top comment).
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

module.exports = { findFreePort };
