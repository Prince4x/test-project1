/**
 * Online controller — the WebSocket half of the app.
 *
 * Presents the same interface as the practice controller (state snapshots +
 * events + dispatch) so the table view does not care which mode it is driving.
 * Handles reconnection with backoff and automatic re-seating.
 */

import { ACTION } from '/engine/table.js';

const PING_EVERY = 20000;

export class OnlineController {
  constructor({
    profile,
    onState, onEvent, onError, onChat, onTables, onJoined, onLeft, onStatus, onWelcome
  } = {}) {
    this.profile = profile;
    this.onState = onState || (() => {});
    this.onEvent = onEvent || (() => {});
    this.onError = onError || (() => {});
    this.onChat = onChat || (() => {});
    this.onTables = onTables || (() => {});
    this.onJoined = onJoined || (() => {});
    this.onLeft = onLeft || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onWelcome = onWelcome || (() => {});
    this.socket = null;
    this.connected = false;
    this.reconnectDelay = 800;
    this.intentionalClose = false;
    this.pendingTable = null;
    this.pendingBuyIn = null;
    this.pingTimer = null;
    this.hello = null;
  }

  get isOnline() { return true; }

  get url() {
    const { protocol, host } = (typeof window !== 'undefined' ? window : {}).location || { protocol: 'http:', host: 'localhost' };
    return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/ws?profile=${encodeURIComponent(this.profile.id)}`;
  }

  connect() {
    this.intentionalClose = false;
    this.onStatus({ state: this.connected ? 'connected' : 'connecting' });
    const Socket = typeof window !== 'undefined' ? window.WebSocket : null;
    if (!Socket) {
      this.onError('WebSockets are not available in this environment');
      return;
    }
    try {
      this.socket = new Socket(this.url);
    } catch (error) {
      this.onError(`Cannot reach the game server: ${error.message}`);
      this.scheduleReconnect();
      return;
    }

    this.socket.addEventListener('open', () => {
      this.connected = true;
      this.reconnectDelay = 800;
      this.onStatus({ state: 'connected' });
      this.send({ type: 'hello', profile: this.profile });
      if (this.pendingTable) {
        this.send({ type: 'table:join', tableId: this.pendingTable, buyIn: this.pendingBuyIn, profile: this.profile });
      }
    });

    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handle(message);
    });

    this.socket.addEventListener('close', () => {
      this.connected = false;
      this.onStatus({ state: 'disconnected' });
      if (!this.intentionalClose) this.scheduleReconnect();
    });

    this.socket.addEventListener('error', () => {
      this.onStatus({ state: 'error' });
    });

    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_EVERY);
  }

  scheduleReconnect() {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, 12000);
    this.onStatus({ state: 'reconnecting', retryIn: Math.round(delay / 1000) });
    setTimeout(() => {
      if (!this.intentionalClose) this.connect();
    }, delay);
  }

  send(message) {
    const Socket = typeof window !== 'undefined' ? window.WebSocket : null;
    if (Socket && this.socket?.readyState === Socket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  handle(message) {
    switch (message.type) {
      case 'welcome':
      case 'hello':
        this.hello = message;
        this.onWelcome(message);
        if (message.tables) this.onTables(message.tables);
        break;
      case 'tables':
        this.onTables(message.tables);
        break;
      case 'state':
        this.onState(message.snapshot, message.events || [], message.table);
        if (message.events?.length) this.onEvent(message.events, message.snapshot);
        break;
      case 'joined':
        this.pendingTable = message.tableId;
        this.onJoined(message);
        break;
      case 'left':
        this.pendingTable = null;
        this.onLeft();
        break;
      case 'chat':
        this.onChat(message);
        break;
      case 'error':
        this.onError(message.message);
        break;
      default:
        break;
    }
  }

  requestTables() {
    this.send({ type: 'tables' });
  }

  joinTable(tableId, buyIn) {
    this.pendingTable = tableId;
    this.pendingBuyIn = buyIn;
    this.send({ type: 'table:join', tableId, buyIn, profile: this.profile });
  }

  createTable({ name, config, bots = 3, buyIn }) {
    this.send({ type: 'table:create', name, config, bots, buyIn, profile: this.profile });
  }

  leaveTable() {
    this.send({ type: 'table:leave' });
    this.pendingTable = null;
  }

  fillWithBots(count = 1) {
    this.send({ type: 'table:fill', count });
  }

  dispatch(action, payload = {}) {
    const message = { type: 'action', action };
    if (action === ACTION.RAISE) message.stake = payload.stake;
    return this.send(message);
  }

  respondSideShow(accept) {
    return this.send({ type: 'sideshow', accept });
  }

  rebuy(amount) {
    return this.send({ type: 'rebuy', amount });
  }

  chat(text) {
    return this.send({ type: 'chat', text });
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    try {
      this.socket?.close();
    } catch { /* already closed */ }
    this.connected = false;
  }
}

export default OnlineController;
