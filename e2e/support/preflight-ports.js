/**
 * FAIL CLOSED if either controlled backend port is already taken.
 *
 * Playwright's own `reuseExistingServer: false` also refuses a busy port, but
 * it checks each server only when it is that server's turn — after the servers
 * before it have started and after the throwaway database exists. Run as the
 * first step of the FIRST backend's command, this stops the whole run up front,
 * before a database is created, so an occupied 8080 (the developer's own Spring)
 * cannot leave an `e2e_*` database behind.
 *
 * It never inspects, connects beyond a bare TCP handshake, signals or stops
 * whatever owns the port: it only reports that the port is not free.
 */
const net = require('node:net');

const { NODE_PORT, SPRING_PORT } = require('./e2e-backends');

const HOSTS = ['127.0.0.1', '::1'];

/** True when something accepts a TCP connection on this port (any loopback family). */
function isTaken(port) {
  const attempt = (host) =>
    new Promise((resolve) => {
      const socket = net
        .connect({ port, host })
        .setTimeout(700)
        .on('connect', () => { socket.destroy(); resolve(true); })
        .on('timeout', () => { socket.destroy(); resolve(false); })
        .on('error', () => resolve(false));
    });
  return Promise.all(HOSTS.map(attempt)).then((results) => results.some(Boolean));
}

async function main() {
  const owners = { [NODE_PORT]: 'Node/Topic Quiz backend', [SPRING_PORT]: 'Spring/Interview backend' };
  const busy = [];
  for (const port of [NODE_PORT, SPRING_PORT]) {
    if (await isTaken(port)) busy.push(port);
  }
  if (busy.length === 0) {
    console.log(`[e2e-preflight] ports ${NODE_PORT} and ${SPRING_PORT} are free`);
    return;
  }
  console.error('\n[e2e-preflight] ABORTING before any database or server is created — already in use:');
  for (const port of busy) console.error(`  :${port}  (E2E must own the ${owners[port]})`);
  console.error(
    '\n[e2e-preflight] E2E starts its own isolated backends on these fixed ports (the app and its CSP\n' +
    '                only allow these two), and will not reuse or send traffic to a server that is\n' +
    '                already running there — that could be your development backend and database.\n' +
    '                Stop the process that owns the port, then run again.\n'
  );
  process.exit(1);
}

main();
