/**
 * Minimal RFC 6455 WebSocket server.
 *
 * Implemented from scratch so the whole project runs with zero npm
 * dependencies (sandbox-friendly): HTTP upgrade handshake, masked client
 * frames, fragmentation, ping/pong keep-alive and close handling.
 */

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
};

/** Encode a payload as a server-to-client frame (never masked). */
export function encodeFrame(payload, opcode = OPCODE.TEXT) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, data]);
}

export class WebSocketConnection {
  constructor(socket, server) {
    this.socket = socket;
    this.server = server;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.isAlive = true;
    this.data = {};             // scratch space for the application
    this.handlers = { message: [], close: [], pong: [] };
    this.closeHook = null;      // set by attachWebSocketServer to release() the connection
    socket.setNoDelay(true);
  }

  on(event, handler) {
    if (this.handlers[event]) this.handlers[event].push(handler);
    return this;
  }

  emit(event, ...args) {
    for (const handler of this.handlers[event] || []) {
      try {
        handler(...args);
      } catch (error) {
        console.error('[ws] handler error:', error.message);
      }
    }
  }

  /**
   * True while the socket can still carry bytes. A peer that disappeared leaves
   * the socket half-open (we get 'end' but never 'close'), so writes to it
   * succeed silently and go nowhere — callers must not trust them.
   */
  get writable() {
    return !this.closed && !this.socket.destroyed && !this.socket.writableEnded;
  }

  send(payload) {
    if (!this.writable) return false;
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    try {
      this.socket.write(encodeFrame(text, OPCODE.TEXT));
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  ping() {
    if (!this.writable) return false;
    try {
      this.socket.write(encodeFrame(Buffer.alloc(0), OPCODE.PING));
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.socket.write(encodeFrame(body, OPCODE.CLOSE));
      this.socket.end();
    } catch {
      /* already gone */
    }
  }

  /** Feed raw TCP bytes and drain any complete frames. */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.readFrame();
      if (!frame) break;
      this.handleFrame(frame);
    }
  }

  readFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < offset + 2) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null;
      const big = buffer.readBigUInt64BE(offset);
      if (big > 8n * 1024n * 1024n) {
        this.close(1009, 'Frame too large');
        return null;
      }
      length = Number(big);
      offset += 8;
    }

    let mask = null;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buffer.length < offset + length) return null;

    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    this.buffer = buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.PING:
        try {
          this.socket.write(encodeFrame(payload, OPCODE.PONG));
        } catch { /* ignore */ }
        return;
      case OPCODE.PONG:
        this.isAlive = true;
        this.emit('pong');
        return;
      case OPCODE.CLOSE:
        // Acknowledge the close and hand the teardown to the transport, which
        // releases the connection exactly once (see release() below). Emitting
        // the event directly here would double-report a closing connection.
        try {
          this.socket.write(encodeFrame(payload.subarray(0, 2), OPCODE.CLOSE));
        } catch { /* peer already gone */ }
        this.closed = true;
        try {
          this.socket.end();
        } catch { /* ignore */ }
        if (this.closeHook) this.closeHook(1000);
        else this.emit('close', 1000);
        return;
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        break;
      case OPCODE.CONTINUATION:
        this.fragments.push(payload);
        break;
      default:
        return;
    }
    if (!fin) return;
    const data = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === OPCODE.BINARY) return;
    let text;
    try {
      text = data.toString('utf8');
    } catch {
      return;
    }
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch { /* keep the raw string */ }
    this.emit('message', parsed, text);
  }
}

/**
 * Attach a WebSocket endpoint to an existing HTTP server.
 * @returns {{ connections: Set<WebSocketConnection>, close: () => void }}
 */
export function attachWebSocketServer(httpServer, { path = '/ws', onConnection } = {}) {
  const connections = new Set();

  /**
   * Release a connection exactly once: drop it from the registry, mark it
   * closed, destroy the socket and tell the application.
   *
   * Destroying the socket here matters. When a browser tab is closed or the
   * page is reloaded the peer sends a FIN and nothing else; Node reports that as
   * 'end' and leaves the socket half-open, so 'close' never arrives on its own
   * and the socket, its buffers and the player's seat would be held until the
   * keep-alive sweep noticed — or forever. Treating every terminal event as the
   * end of the connection is what frees a seat the moment a player goes away.
   */
  function release(connection, code = 1006) {
    if (!connections.has(connection)) return;
    connections.delete(connection);
    connection.closed = true;
    try {
      connection.socket.destroy();
    } catch {
      /* already gone */
    }
    connection.emit('close', code);
  }

  const handleUpgrade = (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (!key || (request.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    );

    const connection = new WebSocketConnection(socket, httpServer);
    connection.query = url.searchParams;
    connections.add(connection);
    if (head && head.length) connection.push(head);
    socket.on('data', (chunk) => connection.push(chunk));

    connection.closeHook = (code) => release(connection, code);

    // 'end' is the one that matters: it fires the moment the peer goes away,
    // where 'close' waits for a teardown that a vanished peer never performs.
    socket.on('end', () => release(connection, 1006));
    socket.on('error', () => release(connection, 1006));
    socket.on('close', () => release(connection, 1006));

    if (onConnection) onConnection(connection, request);
  };

  httpServer.on('upgrade', handleUpgrade);

  /**
   * Keep-alive sweep. Healthy clients answer the protocol-level ping within a
   * heartbeat; a phone that went to sleep or a cable that was pulled answers
   * nothing. One missed heartbeat is enough to declare the peer gone, because
   * the cheap cases (tab closed, page reloaded) are already handled instantly by
   * the socket's 'end' event.
   */
  const HEARTBEAT_EVERY = 15000;
  const keepAlive = setInterval(() => {
    for (const connection of [...connections]) {
      if (connection.closed) {
        release(connection, 1006);
        continue;
      }
      if (!connection.isAlive) {
        connection.close(1001, 'Idle');
        release(connection, 1001);
        continue;
      }
      connection.isAlive = false;
      connection.ping();
    }
  }, HEARTBEAT_EVERY);
  keepAlive.unref?.();

  return {
    connections,
    close() {
      clearInterval(keepAlive);
      httpServer.off('upgrade', handleUpgrade);
    }
  };
}
