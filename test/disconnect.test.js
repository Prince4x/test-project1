/**
 * A player who goes away must free their seat immediately.
 *
 * Browser tabs are closed, pages are reloaded, phones go to sleep and Wi-Fi
 * drops. In all of those cases the peer sends a FIN and nothing else — Node
 * reports that as 'end' and leaves the socket HALF-OPEN, so 'close' never fires
 * on its own. The WebSocket layer used to listen for 'close' only, which meant a
 * vanished player kept their connection (and therefore their seat, chips and
 * turn) until a 15-20 second keep-alive sweep noticed, or for ever.
 *
 * These tests pin the behaviour: the moment the peer is gone, the connection is
 * released and the seat is given up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from '../server/ws.js';
import { freePort } from './free-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function clientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81;
  if (payload.length < 126) header[1] = 0x80 | payload.length;
  else {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/** Connect without any nice goodbye: exactly what a closing tab looks like. */
function connect(port, query = '') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET /ws${query} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buffer = Buffer.alloc(0);
    let handshake = false;
    const messages = [];
    const client = {
      socket,
      messages,
      send: (message) => socket.write(clientFrame(JSON.stringify(message))),
      last: (type) => [...messages].reverse().find((message) => message.type === type),
      state: () => client.last('state')?.snapshot,
      closed: false
    };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshake) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        if (!buffer.subarray(0, end).toString().includes('101')) return reject(new Error('handshake failed'));
        buffer = buffer.subarray(end + 4);
        handshake = true;
        resolve(client);
      }
      // server -> client frames are never masked
      while (buffer.length >= 2) {
        const small = buffer[1] & 0x7f;
        let offset = 2;
        let length = small;
        if (small === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (small === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + length) return;
        const opcode = buffer[0] & 0x0f;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x1) { try { messages.push(JSON.parse(payload.toString('utf8'))); } catch { /* ignore */ } }
        if (opcode === 0x8) client.closed = true;
      }
    });
    socket.on('error', (error) => { if (!handshake) reject(error); });
    setTimeout(() => { if (!handshake) reject(new Error('handshake timed out')); }, 3000);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a peer that vanishes is released at once, not left half-open', async () => {
  const server = http.createServer();
  const released = [];
  const ws = attachWebSocketServer(server, {
    path: '/ws',
    onConnection: (connection) => connection.on('close', (code) => released.push(code))
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const a = await connect(port);
  const b = await connect(port);
  await sleep(100);
  assert.equal(ws.connections.size, 2, 'both clients are registered');

  // The tab is closed: FIN, no close frame.
  a.socket.destroy();
  await sleep(300);
  assert.equal(ws.connections.size, 1, 'the vanished client is released immediately');
  assert.deepEqual(released, [1006], 'the application hears about the drop exactly once');

  // A graceful close (what a browser sends when it navigates away politely).
  b.socket.end();
  await sleep(300);
  assert.equal(ws.connections.size, 0, 'a graceful goodbye is released too');
  assert.equal(released.length, 2, 'and reported exactly once, not twice');

  ws.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => { server.close(() => resolve()); setTimeout(resolve, 250); });
});

test('a released connection refuses to pretend it can still send', async () => {
  const server = http.createServer();
  let connection = null;
  const ws = attachWebSocketServer(server, { path: '/ws', onConnection: (c) => { connection = c; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const client = await connect(server.address().port);
  await sleep(100);
  assert.equal(connection.send({ type: 'state' }), true, 'a live client accepts messages');

  client.socket.destroy();
  await sleep(300);
  assert.equal(connection.writable, false, 'the connection knows it is gone');
  assert.equal(connection.send({ type: 'state' }), false, 'and reports failure instead of silently dropping the message');
  assert.equal(connection.ping(), false, 'heartbeats stop too');

  ws.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => { server.close(() => resolve()); setTimeout(resolve, 250); });
});

test('a closed tab is noticed at once instead of stalling the table', async () => {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore'
  });

  const health = () => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());

  try {
    // wait for the server to come up
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try { const h = await health(); ready = h.ok === true; } catch { await sleep(100); }
    }
    assert.ok(ready, 'the server started');

    const one = await connect(port, '?profile=tab-one');
    const two = await connect(port, '?profile=tab-two');
    one.send({ type: 'hello', profile: { id: 'tab-one', name: 'One', avatar: '🦊' } });
    two.send({ type: 'hello', profile: { id: 'tab-two', name: 'Two', avatar: '🐼' } });
    await sleep(400);

    // Both sit down at the first house table.
    const tableId = two.last('welcome')?.tables?.[0]?.id;
    assert.ok(tableId, 'the server lists a table to join');
    one.send({ type: 'table:join', tableId, buyIn: 1000, profile: { id: 'tab-one', name: 'One', avatar: '🦊' } });
    two.send({ type: 'table:join', tableId, buyIn: 1000, profile: { id: 'tab-two', name: 'Two', avatar: '🐼' } });
    await sleep(600);
    assert.equal((await health()).clients, 2, 'both players are connected');
    assert.equal((await health()).humans, 2, 'and both are seated at the table');
    assert.ok(two.state()?.seats?.some((seat) => seat?.id === 'tab-one'), 'player two can see player one');

    // Player one closes their tab mid-game: no goodbye, just a dead socket.
    one.socket.destroy();
    await sleep(600);

    const after = await health();
    assert.equal(after.clients, 1, 'the closed tab released its connection straight away');
    assert.equal(after.humans, 2, 'the seat is still held for them to reconnect to (45s grace)');
    assert.equal(two.socket.destroyed, false, 'the remaining player is still connected');

    // The table knows immediately, so it never waits on a player who is gone.
    const seated = two.state()?.seats?.find((seat) => seat?.id === 'tab-one');
    assert.equal(seated?.connected, false, 'the remaining player sees them as disconnected right away');

    two.socket.destroy();
    await sleep(500);
    assert.equal((await health()).clients, 0, 'and the table is released when they leave as well');
  } finally {
    server.kill('SIGKILL');
  }
});

test('the server answers on both 127.0.0.1 and ::1, and says why when the port is taken', async () => {
  const port = await freePort();
  const start = () => spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },   // no HOST: the default bind
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const server = start();
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        ready = response.ok;
      } catch { await sleep(100); }
    }
    assert.ok(ready, 'the server came up on IPv4');

    // The reason this matters: on Windows `localhost` resolves to ::1 first, and
    // clients such as Windows PowerShell never fall back to IPv4. A server bound
    // to 0.0.0.0 only looked dead to them.
    const overIPv6 = await fetch(`http://[::1]:${port}/api/health`).then((r) => r.ok).catch(() => false);
    assert.equal(overIPv6, true, 'and answers over IPv6 as well, so "localhost" works everywhere');
    assert.match(output, /Teen Patti Arena is running/, 'the banner still prints');

    // A second server on the same port must explain itself rather than dump a
    // stack trace the user cannot act on.
    const second = start();
    let secondOutput = '';
    second.stdout.on('data', (chunk) => { secondOutput += chunk.toString(); });
    second.stderr.on('data', (chunk) => { secondOutput += chunk.toString(); });
    const code = await new Promise((resolve) => second.on('exit', resolve));
    assert.equal(code, 1, 'the second server exits with a failure code');
    assert.match(secondOutput, /could not start: EADDRINUSE/, 'and names the real reason');
    assert.match(secondOutput, /already running/, 'and tells the user what to do about it');
  } finally {
    server.kill('SIGKILL');
  }
});
