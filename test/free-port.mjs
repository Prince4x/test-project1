/**
 * Ports for the tests that boot a real server.
 *
 * These suites run in parallel (one process per test file), so fixed or
 * hand-picked ranges collided with each other: a file would start a server on a
 * port another file had just taken, the server died with EADDRINUSE, and the
 * test failed for reasons that had nothing to do with the code.
 *
 * Asking the operating system for a free port instead keeps the suites out of
 * each other's way — it hands out unused ephemeral ports, not a range we guessed.
 */

import net from 'node:net';

/** Resolve with a port number nothing is currently listening on. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export default freePort;
