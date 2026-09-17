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

  send(payload) {
    if (this.closed) return false;
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
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(Buffer.alloc(0), OPCODE.PING));
    } catch {
      this.close();
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
        this.emit('close', 1000);
        this.closed = true;
        this.socket.end();
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
    socket.on('error', () => cleanup());
    socket.on('close', () => cleanup());

    function cleanup() {
      if (!connections.has(connection)) return;
      connections.delete(connection);
      connection.closed = true;
      connection.emit('close', 1006);
    }

    if (onConnection) onConnection(connection, request);
  };

  httpServer.on('upgrade', handleUpgrade);

  // Keep-alive sweep: ping every 20s, drop connections that stop answering.
  const keepAlive = setInterval(() => {
    for (const connection of connections) {
      if (connection.closed) {
        connections.delete(connection);
        continue;
      }
      if (!connection.isAlive) {
        connection.close(1001, 'Idle');
        connections.delete(connection);
        connection.emit('close', 1001);
        continue;
      }
      connection.isAlive = false;
      connection.ping();
    }
  }, 20000);
  keepAlive.unref?.();

  return {
    connections,
    close() {
      clearInterval(keepAlive);
      httpServer.off('upgrade', handleUpgrade);
    }
  };
}
