/**
 * End-to-end smoke test: boot the real HTTP server, connect a real WebSocket
 * client, sit down at a table and play hands through the public API.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4500 + Math.floor(Math.random() * 300); // random: avoids stray squatters

function clientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  header[0] = 0x81;
  return Buffer.concat([header, mask, masked]);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname } = new URL(url);
    const socket = net.connect(Number(port), hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buffer = Buffer.alloc(0);
    let handshake = false;
    const client = { socket, messages: [], send: (text) => socket.write(clientFrame(text)) };
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
      for (;;) {
        if (buffer.length < 2) break;
        const length = buffer[1] & 0x7f;
        let offset = 2;
        let size = length;
        if (length === 126) {
          if (buffer.length < 4) break;
          offset = 4;
          size = buffer.readUInt16BE(2);
        } else if (length === 127) {
          if (buffer.length < 10) break;
          offset = 10;
          size = Number(buffer.readBigUInt64BE(2));
        }
        if (buffer.length < offset + size) break;
        const opcode = buffer[0] & 0x0f;
        const payload = buffer.subarray(offset, offset + size);
        buffer = buffer.subarray(offset + size);
        if (opcode === 0x1) {
          try { client.messages.push(JSON.parse(payload.toString('utf8'))); } catch { /* ignore */ }
        }
      }
    });
    socket.on('error', reject);
  });
}

const last = (client, type) => [...client.messages].reverse().find((message) => message.type === type);
const waitFor = (client, predicate, timeout = 4000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(() => {
    const found = client.messages.find(predicate);
    if (found) {
      clearInterval(timer);
      resolve(found);
    } else if (Date.now() - started > timeout) {
      clearInterval(timer);
      reject(new Error('timeout waiting for message'));
    }
  }, 20);
});

test('a player can sit at a live table and play a real hand end to end', { timeout: 150000 }, async (t) => {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TEEN_PATTI_FAST: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  t.after(() => {
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 1500);
    force.unref?.();
    server.unref();
  });

  // Wait for the server to accept connections.
  const base = `http://127.0.0.1:${PORT}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true, `server did not start: ${logs}`);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Teen Patti/);

  // The shared engine must be reachable by the browser.
  const engine = await fetch(`${base}/engine/table.js`);
  assert.equal(engine.status, 200);
  assert.match(engine.headers.get('content-type'), /javascript/);

  // A quick table keeps the test fast: small boot, two bots, two rounds.
  const created = await (await fetch(`${base}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'E2E table',
      bots: 2,
      config: { boot: 5, startChips: 500, minBuyIn: 100, maxBuyIn: 1000, maxRounds: 2, turnSeconds: 6, disconnectedTurnSeconds: 2 }
    })
  })).json();

  const client = await connect(`ws://127.0.0.1:${PORT}/ws?profile=e2e-player`);
  await waitFor(client, (message) => message.type === 'welcome');
  client.send(JSON.stringify({ type: 'hello', profile: { id: 'e2e-player', name: 'E2E Tester', avatar: '🤖' } }));
  const hello = await waitFor(client, (message) => message.type === 'hello');
  assert.ok(hello.tables.length >= 1, 'the lobby is seeded with tables');

  client.send(JSON.stringify({ type: 'table:join', tableId: created.table.id, buyIn: 500 }));
  const joined = await waitFor(client, (message) => message.type === 'joined');
  assert.equal(joined.table.maxPlayers, 6);
  assert.ok(joined.table.players >= 3, 'bots are seated');

  // Play along with the bots: act whenever it is our turn, and see cards first.
  let sawHands = 0;
  let actedAt = 0;
  const started = Date.now();
  while (Date.now() - started < 120000 && sawHands < 1) {
    const state = last(client, 'state');
    if (state?.snapshot?.phase === 'betting') {
      const you = state.snapshot.you;
      // Acting is rate-limited: the server pushes a snapshot per action.
      if (Date.now() - actedAt > 400) {
        if (you?.inHand && !you.packed && you.options?.see) {
          actedAt = Date.now();
          client.send(JSON.stringify({ type: 'action', action: 'see' }));
        } else if (you?.canAct) {
          actedAt = Date.now();
          client.send(JSON.stringify({ type: 'action', action: you.options.call ? 'chaal' : 'allin' }));
        }
      }
      if (you?.seen && you.cards?.length === 3) {
        assert.ok(you.hand, 'seen cards come with hand info');
        assert.equal(you.hand.text.length > 0, true);
      }
    }
    if (state?.snapshot?.history?.length > sawHands) sawHands = state.snapshot.history.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.ok(sawHands >= 1, `expected at least one completed hand, got ${sawHands}\n${logs}`);

  // Chat round-trip.
  client.send(JSON.stringify({ type: 'chat', text: 'Hello from the test suite' }));
  const chat = await waitFor(client, (message) => message.type === 'chat' && message.text === 'Hello from the test suite');
  assert.equal(chat.from, 'E2E Tester');

  // Leave cleanly.
  client.send(JSON.stringify({ type: 'table:leave' }));
  await waitFor(client, (message) => message.type === 'left');
  client.socket.destroy();
});
