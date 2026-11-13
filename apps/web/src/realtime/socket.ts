import { WS_CLOSE_UNAUTHORIZED, type ServerEvent } from '@quickhub/shared';
import type { ConnectionStatus } from '../stores/ui';
import { backoffDelay } from './backoff';

type DataEvent = Exclude<ServerEvent, { type: 'hello' } | { type: 'ping' }>;

export interface RealtimeHandlers {
  getToken: () => string | null;
  /** Called with a batch of events, at most once every `flushMs`. */
  onEvents: (events: DataEvent[]) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** We may have missed events (reconnect or gap in seq): refetch everything. */
  onResync: () => void;
  /** The server rejected our token. */
  onUnauthorized: () => void;
}

const FLUSH_MS = 250;
const SILENCE_LIMIT_MS = 35_000; // server pings every 15s

/**
 * A WebSocket that looks after itself: authenticates, batches incoming events,
 * detects missed messages, notices dead connections and reconnects with backoff.
 * It knows nothing about React or the cache; it only calls the handlers.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private everConnected = false;
  private lastSeq = 0;
  private lastMessageAt = 0;
  private buffer: DataEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(
    private url: string,
    private handlers: RealtimeHandlers,
  ) {}

  start() {
    this.stopped = false;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    document.addEventListener('visibilitychange', this.onVisible);
    this.watchdog = setInterval(this.checkSilence, 5_000);
    this.connect();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.buffer = [];
    this.detach();
  }

  private connect() {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.detach();
    if (!navigator.onLine) {
      this.handlers.onStatus('offline');
      return; // the 'online' event will bring us back
    }
    this.handlers.onStatus(this.everConnected ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.lastMessageAt = Date.now();
      ws.send(JSON.stringify({ type: 'auth', token: this.handlers.getToken() }));
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = (e) => {
      if (this.ws !== ws) return; // an old socket we already replaced
      this.ws = null;
      if (this.stopped) return;
      if (e.code === WS_CLOSE_UNAUTHORIZED) {
        this.handlers.onUnauthorized(); // do NOT reconnect: it would loop forever
        return;
      }
      this.scheduleReconnect();
    };
    // 'error' is always followed by 'close', which does the real handling.
    ws.onerror = () => {};
  }

  private detach() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    ws.close();
  }

  private scheduleReconnect() {
    this.handlers.onStatus(navigator.onLine ? 'reconnecting' : 'offline');
    const delay = backoffDelay(this.attempt++);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onMessage(raw: unknown) {
    this.lastMessageAt = Date.now();
    let event: ServerEvent;
    try {
      event = JSON.parse(String(raw)) as ServerEvent;
    } catch {
      return; // ignore anything that isn't JSON
    }
    if (event.type === 'ping') return;

    if (event.type === 'hello') {
      this.attempt = 0;
      this.lastSeq = event.seq;
      this.handlers.onStatus('open');
      // After a REconnect we don't know what we missed while away.
      if (this.everConnected) this.handlers.onResync();
      this.everConnected = true;
      return;
    }

    // seq should go up by exactly 1. A jump means a message was lost.
    if (event.seq !== this.lastSeq + 1) this.handlers.onResync();
    this.lastSeq = event.seq;

    // Collect events and hand them over together, so 200 updates in a burst
    // cause one render instead of 200.
    this.buffer.push(event);
    this.flushTimer ??= setTimeout(this.flush, FLUSH_MS);
  }

  private flush = () => {
    this.flushTimer = null;
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length > 0) this.handlers.onEvents(batch);
  };

  /** A connection can die without a 'close' event (e.g. laptop sleep, wifi switch). */
  private checkSilence = () => {
    if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt > SILENCE_LIMIT_MS) {
      this.attempt = 0;
      this.connect();
    }
  };

  private onOnline = () => {
    // The old socket may look open but be dead after a network change, so start fresh.
    this.attempt = 0;
    this.connect();
  };

  private onOffline = () => this.handlers.onStatus('offline');

  private onVisible = () => {
    // Don't make a returning user wait out a long backoff timer.
    if (document.visibilityState === 'visible' && !this.ws && !this.stopped) {
      this.attempt = 0;
      this.connect();
    }
  };
}
