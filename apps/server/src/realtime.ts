import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { can, WS_CLOSE_UNAUTHORIZED, type ServerEvent, type User } from '@quickhub/shared';
import { verifyToken } from './auth';
import type { Store, StoreEvent } from './store';

interface Client {
  ws: WebSocket;
  user: User;
  exp: number;
  /** Each connection counts its own events, so a gap always means a missed message. */
  seq: number;
}

/** Events without `seq`; it is stamped per client when sent. */
type Outgoing = ServerEvent extends infer E ? (E extends { seq: number } ? Omit<E, 'seq'> : never) : never;

const HEARTBEAT_MS = 15_000;
const AUTH_TIMEOUT_MS = 5_000;

export function attachRealtime(server: Server, store: Store) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const clients = new Set<Client>();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws: WebSocket) {
    let client: Client | null = null;

    // The token is sent as the first message, not in the URL, because URLs
    // end up in server logs and browser history.
    const authTimer = setTimeout(() => ws.close(WS_CLOSE_UNAUTHORIZED, 'auth timeout'), AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      if (client) return; // after auth, clients have nothing else to say
      let token: unknown;
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; token?: unknown };
        token = msg.type === 'auth' ? msg.token : null;
      } catch {
        token = null;
      }
      const session = typeof token === 'string' ? verifyToken(token) : null;
      clearTimeout(authTimer);
      if (!session) {
        ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      client = { ws, user: session.user, exp: session.exp, seq: 0 };
      clients.add(client);
      send(client, { type: 'hello' });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (client) clients.delete(client);
    });
    ws.on('error', () => ws.terminate());
  }

  function send(client: Client, event: Outgoing) {
    if (client.ws.readyState !== client.ws.OPEN) return;
    client.ws.send(JSON.stringify({ ...event, seq: ++client.seq }));
  }

  /** Decide what (if anything) this user should hear about this change. */
  function forUser(user: User, event: StoreEvent): Outgoing | null {
    if (event.type === 'inventory.updated') {
      return can(user.role, 'inventory:read') ? { type: 'inventory.updated', items: event.items } : null;
    }
    if (can(user.role, 'orders:read_all')) {
      return { type: event.type, order: event.order };
    }
    // Scoped users (pickers) only hear about their own orders.
    const mine = event.order.pickerId === user.id;
    if (event.type === 'order.created') return mine ? { type: 'order.created', order: event.order } : null;
    const wasMine = event.prev.pickerId === user.id;
    if (mine) return { type: wasMine ? 'order.updated' : 'order.created', order: event.order };
    if (wasMine) return { type: 'order.removed', orderId: event.order.id };
    return null;
  }

  const onStoreEvent = (event: StoreEvent) => {
    for (const client of clients) {
      const out = forUser(client.user, event);
      if (out) send(client, out);
    }
  };
  store.events.on('event', onStoreEvent);

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      if (now > client.exp) {
        client.ws.close(WS_CLOSE_UNAUTHORIZED, 'token expired');
      } else if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(JSON.stringify({ type: 'ping' } satisfies ServerEvent));
      }
    }
  }, HEARTBEAT_MS);

  return {
    clientCount: () => clients.size,
    close() {
      clearInterval(heartbeat);
      store.events.off('event', onStoreEvent);
      for (const client of clients) client.ws.terminate();
      wss.close();
    },
  };
}
