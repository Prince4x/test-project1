/**
 * Teen Patti Arena — HTTP + WebSocket server.
 *
 * Serves the static client (public/), the shared game engine (src/engine/) and
 * a small JSON API, then hands /ws to the room manager. Zero dependencies.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from './ws.js';
import { RoomManager } from './rooms.js';
import { DEFAULT_CONFIG, TeenPattiTable } from '../src/engine/table.js';
import { PERSONALITIES } from '../src/engine/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

/**
 * Static roots. `/engine/*` exposes the shared engine to the browser, so
 * practice mode runs the exact same rules code as the server.
 */
const STATIC_ROOTS = [
  { prefix: '/engine/', dir: path.join(ROOT, 'src', 'engine') },
  { prefix: '/shared/', dir: path.join(ROOT, 'src') },
  { prefix: '/', dir: path.join(ROOT, 'public') }
];

function resolveStatic(pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0]);
  for (const { prefix, dir } of STATIC_ROOTS) {
    if (!clean.startsWith(prefix)) continue;
    const relative = clean.slice(prefix.length) || 'index.html';
    const target = path.resolve(dir, relative);
    if (!target.startsWith(dir)) continue;                 // no path traversal
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  }
  return null;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────── server ──

const rooms = new RoomManager();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  // The preview proxy can serve the app from any host, so keep CORS open.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, ...rooms.stats(), tables: rooms.rooms.size });
      return;
    }

    if (pathname === '/api/config') {
      sendJson(res, 200, { defaults: DEFAULT_CONFIG, personalities: PERSONALITIES });
      return;
    }

    if (pathname === '/api/tables') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const room = rooms.createRoom({
          name: body.name,
          config: body.config || {},
          bots: body.bots ?? 3,
          isPublic: body.isPublic !== false
        });
        sendJson(res, 201, { table: rooms.getTableInfo(room) });
        return;
      }
      sendJson(res, 200, { tables: rooms.listTables() });
      return;
    }

    if (pathname.startsWith('/api/tables/')) {
      const id = pathname.slice('/api/tables/'.length);
      const room = rooms.rooms.get(id);
      if (!room) {
        sendJson(res, 404, { error: 'No such table' });
        return;
      }
      sendJson(res, 200, { table: rooms.getTableInfo(room), log: room.table.log.slice(-20) });
      return;
    }

    if (pathname === '/api/leaderboard') {
      sendJson(res, 200, { leaderboard: rooms.leaderboardTop(20) });
      return;
    }

    if (pathname.startsWith('/api/replay/')) {
      // Deterministic hand replay: the same seed always deals the same cards.
      const seed = Number(url.searchParams.get('seed') || 1);
      const players = Math.min(Math.max(Number(url.searchParams.get('players') || 4), 2), 6);
      const table = new TeenPattiTable({ seed, maxPlayers: 6 });
      for (let i = 0; i < players; i += 1) table.addPlayer({ id: `p${i}`, name: `Seat ${i + 1}` });
      table.startHand();
      sendJson(res, 200, { seed, players: table.players.map((player) => ({ name: player.name, cards: player.cards })) });
      return;
    }

    // Static assets.
    const file = resolveStatic(pathname);
    if (file) {
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
        'Last-Modified': stat.mtime.toUTCString()
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(file).pipe(res);
      return;
    }

    // Single-page app fallback.
    const index = path.join(ROOT, 'public', 'index.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    fs.createReadStream(index).pipe(res);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});

const ws = attachWebSocketServer(server, {
  path: '/ws',
  onConnection: (connection) => {
    rooms.registerClient(connection);
    connection.on('message', (message) => rooms.onMessage(connection, message));
  }
});

// Seed a couple of public house tables so the lobby is never empty. They keep
// themselves alive: once idle they recycle their bots for a fresh session.
rooms.createRoom({ name: 'Friendly Table · 10 boot', config: { boot: 10, startChips: 1000, maxRounds: 3 }, bots: 3, keepAlive: true });
rooms.createRoom({ name: 'High Roller · 100 boot', config: { boot: 100, startChips: 5000, maxBuyIn: 10000, maxRounds: 4 }, bots: 2, keepAlive: true });

const loop = setInterval(() => rooms.tick(), 400);
loop.unref?.();

server.listen(PORT, HOST, () => {
  console.log(`🎴 Teen Patti Arena running on http://${HOST}:${PORT}`);
  console.log(`   engine: shared with the browser at /engine/*`);
  console.log(`   tables: ${[...rooms.rooms.values()].map((room) => `${room.table.name} (${room.table.id})`).join(', ')}`);
});

const shutdown = () => {
  clearInterval(loop);
  ws.close();
  for (const connection of ws.connections) connection.close(1001, 'Server shutting down');
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  // Upgraded sockets are detached from the HTTP server, so close() can never
  // call back while a browser is connected — never hang on shutdown.
  setTimeout(() => process.exit(0), 600);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, rooms };
