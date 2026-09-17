import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { attachWebSocketServer, encodeFrame } from '../server/ws.js';

/** Frame a client-to-server message (clients must mask, servers must not). */
function clientFrame(text, opcode = 0x1) {
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
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, mask, masked]);
}

/** Tiny client that speaks just enough WebSocket to drive the server. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname } = new URL(url);
    const socket = net.connect(Number(port), hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET ${pathname} HTTP/1.1\r\n` +
        `Host: ${hostname}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    const messages = [];
    const client = {
      socket,
      messages,
      send(text) {
        socket.write(clientFrame(text));
      },
      close() {
        socket.destroy();
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const headers = buffer.subarray(0, end).toString();
        if (!headers.includes('101')) return reject(new Error(`Handshake failed: ${headers.split('\r\n')[0]}`));
        assert.match(headers, /Sec-WebSocket-Accept: [\w+/=]+/);
        buffer = buffer.subarray(end + 4);
        handshakeDone = true;
        resolve(client);
      }
      // Drain server frames (unmasked, text only).
      for (;;) {
        if (buffer.length < 2) break;
        const length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) break;
          offset = 4;
        } else if (length === 127) break; // not needed for these tests
        const size = length === 126 ? buffer.readUInt16BE(2) : length;
        if (buffer.length < offset + size) break;
        const opcode = buffer[0] & 0x0f;
        const payload = buffer.subarray(offset, offset + size);
        buffer = buffer.subarray(offset + size);
        if (opcode === 0x1) messages.push(JSON.parse(payload.toString('utf8')));
        if (opcode === 0x8) socket.end();
      }
    });
    socket.on('error', reject);
  });
}

/** Upgraded sockets are detached from the HTTP server, so close() may never
 *  call back — resolve either way. */
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 250);
  });
}

function waitFor(client, predicate, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = client.messages.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for message'));
      }
    }, 15);
  });
}

test('the WebSocket server completes a handshake and round-trips JSON', async () => {
  const server = http.createServer((req, res) => res.end('http'));
  let seen = null;
  attachWebSocketServer(server, {
    onConnection: (connection) => {
      connection.on('message', (message) => {
        seen = message;
        connection.send({ type: 'echo', got: message });
        connection.close();
      });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const client = await connect(`ws://127.0.0.1:${port}/ws`);
  client.send(JSON.stringify({ type: 'ping', value: 'नमस्ते' }));

  const echo = await waitFor(client, (message) => message.type === 'echo');
  assert.deepEqual(seen, { type: 'ping', value: 'नमस्ते' });
  assert.deepEqual(echo.got, { type: 'ping', value: 'नमस्ते' });

  client.close();
  server.closeAllConnections?.();
  await closeServer(server);
});

test('unknown upgrade paths are rejected', async () => {
  const server = http.createServer();
  attachWebSocketServer(server, { path: '/ws' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const result = await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('GET /nope HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\n\r\n');
    });
    socket.on('data', (chunk) => resolve(chunk.toString().split('\r\n')[0]));
    socket.on('error', () => resolve('error'));
  });

  assert.match(result, /404/);
  await closeServer(server);
});

test('large frames round-trip through the length-126 encoding path', async () => {
  const server = http.createServer();
  attachWebSocketServer(server, {
    onConnection: (connection) => {
      connection.on('message', (message) => connection.send({ type: 'size', length: message.text.length }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const client = await connect(`ws://127.0.0.1:${port}/ws`);
  const text = 'x'.repeat(500);
  client.send(JSON.stringify({ type: 'big', text }));

  const reply = await waitFor(client, (message) => message.type === 'size');
  assert.equal(reply.length, 500);

  // Server-to-client framing uses the same helper.
  const frame = encodeFrame('hello');
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 5);

  client.close();
  server.closeAllConnections?.();
  await closeServer(server);
});
