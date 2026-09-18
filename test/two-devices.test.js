/**
 * The scenario this whole project exists for: two friends, two devices, one
 * table. Boots a real server, connects two independent WebSocket clients with
 * separate identities, seats them at the same table and plays a hand together.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await freePort();   // a port nothing else is using (see free-port.mjs)

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

/** A minimal WebSocket client standing in for one player's browser. */
function connect(profileId) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET /ws?profile=${encodeURIComponent(profileId)} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buffer = Buffer.alloc(0);
    let handshake = false;
    const client = { id: profileId, socket, messages: [], send: (message) => socket.write(clientFrame(JSON.stringify(message))) };
    client.last = (type) => [...client.messages].reverse().find((message) => message.type === type);
    client.state = () => client.last('state')?.snapshot;
    client.me = () => client.state()?.seats?.find((seat) => seat?.id === profileId);
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

const waitFor = (predicate, timeout = 40000, label = 'condition') => new Promise((resolve, reject) => {
  const started = Date.now();
  const timer = setInterval(() => {
    if (predicate()) {
      clearInterval(timer);
      resolve(true);
    } else if (Date.now() - started > timeout) {
      clearInterval(timer);
      reject(new Error(`timed out waiting for ${label}`));
    }
  }, 120);
});

test('two players on separate devices can sit at one table and play together', { timeout: 150000 }, async (t) => {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '0.0.0.0', TEEN_PATTI_FAST: '1' },
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

  const base = `http://127.0.0.1:${PORT}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch { /* still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  // The banner tells the host exactly what to send a friend.
  assert.match(logs, /Same Wi-Fi|This PC/, 'startup banner lists shareable addresses');

  // /api/network is what the lobby uses to build the invite link.
  const network = await (await fetch(`${base}/api/network`)).json();
  assert.equal(typeof network.port, 'number');
  assert.equal(network.local, `http://localhost:${network.port}`);
  assert.ok(Array.isArray(network.addresses), 'addresses is always an array (empty on a single-homed host)');
  for (const address of network.addresses) {
    assert.match(address.url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/, 'shareable URLs are plain http on the LAN');
    assert.equal(address.ip === '127.0.0.1', false, 'loopback is never offered as a shareable address');
  }

  // ── two devices ─────────────────────────────────────────────────────────
  const host = await connect('host-device-abc1');
  const friend = await connect('friend-phone-xyz9');
  await waitFor(() => host.last('welcome') && friend.last('welcome'), 10000, 'both clients to connect');

  host.send({ type: 'hello', profile: { id: 'host-device-abc1', name: 'Host', avatar: '🎯' } });
  friend.send({ type: 'hello', profile: { id: 'friend-phone-xyz9', name: 'Friend', avatar: '📱' } });

  // Create a table, then have the friend "open the invite link" for it.
  const created = await (await fetch(`${base}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Two friends',
      bots: 0,
      config: { boot: 5, startChips: 300, minBuyIn: 100, maxBuyIn: 500, maxRounds: 2, turnSeconds: 6, disconnectedTurnSeconds: 2 }
    })
  })).json();

  host.send({ type: 'table:join', tableId: created.table.id, buyIn: 300 });
  friend.send({ type: 'table:join', tableId: created.table.id, buyIn: 300 });
  await waitFor(() => host.state()?.you && friend.state()?.you, 15000, 'both players to be seated');

  // Each device sees the other by name, at the same table.
  const hostSees = host.state().seats.filter(Boolean).map((seat) => seat.name);
  const friendSees = friend.state().seats.filter(Boolean).map((seat) => seat.name);
  assert.deepEqual(hostSees.sort(), ['Friend', 'Host'], `host sees both players (${hostSees})`);
  assert.deepEqual(friendSees.sort(), ['Friend', 'Host'], `friend sees both players (${friendSees})`);
  assert.notEqual(host.state().you.seat, friend.state().you.seat, 'they hold different seats');

  // A hand needs two players: it starts by itself, and both get dealt in.
  await waitFor(() => host.state()?.phase === 'betting' && friend.state()?.phase === 'betting', 20000, 'a hand to be dealt');
  assert.equal(host.state().you.cardCount, 3, 'host has three cards');
  assert.equal(friend.state().you.cardCount, 3, 'friend has three cards');
  assert.equal(host.state().you.cards.length, 0, 'host cards stay hidden until seen');
  assert.equal(friend.state().you.cards.length, 0, 'friend cards stay hidden until seen');

  // ── play the hand from both devices ─────────────────────────────────────
  const actions = { host: 0, friend: 0 };
  const players = { host, friend };
  await waitFor(() => {
    for (const [key, client] of Object.entries(players)) {
      const state = client.state();
      const you = state?.you;
      if (state?.phase !== 'betting' || !you) continue;
      const tableId = state.tableId;
      assert.ok(tableId);
      if (you.inHand && !you.packed && you.options?.see) {
        client.send({ type: 'action', action: 'see' });
        actions[key] += 1;
      } else if (you.canAct) {
        client.send({ type: 'action', action: you.options.call ? 'chaal' : 'allin' });
        actions[key] += 1;
      }
    }
    return (host.state()?.history?.length || 0) >= 1;
  }, 60000, 'the friends to finish a hand together');

  assert.ok(actions.host > 0 && actions.friend > 0, `both devices acted (${JSON.stringify(actions)})`);
  assert.ok(host.state().history.length >= 1, 'the hand is in the history');

  // ── chat crosses devices ────────────────────────────────────────────────
  friend.send({ type: 'chat', text: 'chalo, next hand!' });
  await waitFor(() => host.last('chat')?.text === 'chalo, next hand!', 10000, 'chat to reach the other device');
  assert.equal(host.last('chat').from, 'Friend');
  assert.equal(host.last('chat').avatar, '📱');

  // ── the friend walks away, the host keeps playing ───────────────────────
  friend.send({ type: 'table:leave' });
  await waitFor(() => host.state()?.seats.every((seat) => seat?.name !== 'Friend'), 10000, 'the friend to leave the table');
  assert.ok(host.state().seats.some((seat) => seat?.name === 'Host'), 'the host is still seated');

  host.socket.destroy();
  friend.socket.destroy();
});
