import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { InventoryItem, Order, OrdersPage, ServerEvent } from '@quickhub/shared';
import { createApp } from './app';
import { attachRealtime } from './realtime';
import { Store } from './store';

let server: Server;
let base: string;
let store: Store;
let realtime: ReturnType<typeof attachRealtime>;
const tokens: Record<string, string> = {};

async function api<T = any>(path: string, opts: { as?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.as ? { Authorization: `Bearer ${tokens[opts.as]}` } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  store = new Store({ orderCount: 400 });
  server = createServer(createApp(store));
  realtime = attachRealtime(server, store);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  for (const role of ['manager', 'picker', 'viewer']) {
    const res = await api('/api/auth/login', { method: 'POST', body: { email: `${role}@quickhub.dev`, password: 'demo1234' } });
    tokens[role] = res.body.token;
  }
});

afterAll(() => {
  realtime.close();
  server.close();
});

const firstWithStatus = async (status: string) =>
  (await api<OrdersPage>(`/api/orders?status=${status}&limit=50`, { as: 'manager' })).body.items;

describe('auth', () => {
  it('rejects a wrong password and a missing token', async () => {
    const bad = await api('/api/auth/login', { method: 'POST', body: { email: 'manager@quickhub.dev', password: 'nope' } });
    expect(bad.status).toBe(401);
    expect((await api('/api/orders')).status).toBe(401);
  });

  it('rejects a tampered token', async () => {
    const res = await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${tokens.manager}x` } });
    expect(res.status).toBe(401);
  });
});

describe('role-based access', () => {
  it('viewer cannot change status, assign, create or adjust stock', async () => {
    const [order] = await firstWithStatus('picking');
    expect((await api(`/api/orders/${order!.id}/status`, { as: 'viewer', method: 'PATCH', body: { status: 'packed', version: order!.version } })).status).toBe(403);
    expect((await api(`/api/orders/${order!.id}/assign`, { as: 'viewer', method: 'PATCH', body: { riderId: 'r-1', version: order!.version } })).status).toBe(403);
    expect((await api('/api/orders', { as: 'viewer', method: 'POST', body: {} })).status).toBe(403);
    expect((await api('/api/inventory/SKU-0001', { as: 'viewer', method: 'PATCH', body: { delta: 1, version: 1 } })).status).toBe(403);
  });

  it('picker only sees their own orders, and gets 404 for others', async () => {
    const mine = await api<OrdersPage>('/api/orders?limit=500', { as: 'picker' });
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((o) => o.pickerId === 'p-1')).toBe(true);

    const all = await api<OrdersPage>('/api/orders?limit=500', { as: 'manager' });
    const other = all.body.items.find((o) => o.pickerId !== 'p-1')!;
    expect((await api(`/api/orders/${other.id}`, { as: 'picker' })).status).toBe(404);
  });

  it('picker can pack their own order but cannot cancel it', async () => {
    const mine = (await api<OrdersPage>('/api/orders?status=picking', { as: 'picker' })).body.items[0]!;
    const cancel = await api(`/api/orders/${mine.id}/status`, { as: 'picker', method: 'PATCH', body: { status: 'cancelled', version: mine.version } });
    expect(cancel.status).toBe(403);
    const pack = await api<Order>(`/api/orders/${mine.id}/status`, { as: 'picker', method: 'PATCH', body: { status: 'packed', version: mine.version } });
    expect(pack.status).toBe(200);
    expect(pack.body.status).toBe('packed');
  });
});

describe('orders', () => {
  it('paginates with a cursor without repeating or skipping rows', async () => {
    const p1 = await api<OrdersPage>('/api/orders?limit=50', { as: 'manager' });
    const p2 = await api<OrdersPage>(`/api/orders?limit=50&cursor=${p1.body.nextCursor}`, { as: 'manager' });
    const ids = [...p1.body.items, ...p2.body.items].map((o) => o.id);
    expect(new Set(ids).size).toBe(100);
    expect(p1.body.total).toBe(400);
  });

  it('rejects a stale version with 409 and returns the latest copy', async () => {
    const order = (await firstWithStatus('picking')).find((o) => o.pickerId !== 'p-1')!;
    const ok = await api<Order>(`/api/orders/${order.id}/status`, { as: 'manager', method: 'PATCH', body: { status: 'packed', version: order.version } });
    expect(ok.body.version).toBe(order.version + 1);
    const stale = await api(`/api/orders/${order.id}/status`, { as: 'manager', method: 'PATCH', body: { status: 'cancelled', version: order.version } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.current.status).toBe('packed');
  });

  it('rejects illegal moves with 422', async () => {
    const order = (await firstWithStatus('new')).find((o) => !o.pickerId)!;
    const skip = await api(`/api/orders/${order.id}/status`, { as: 'manager', method: 'PATCH', body: { status: 'delivered', version: order.version } });
    expect(skip.status).toBe(422);
    const noPicker = await api(`/api/orders/${order.id}/status`, { as: 'manager', method: 'PATCH', body: { status: 'picking', version: order.version } });
    expect(noPicker.status).toBe(422);
    expect(noPicker.body.error.message).toBe('Assign a picker first');
  });

  it('creates an order once even if the request is sent twice', async () => {
    const inv = (await api<InventoryItem[]>('/api/inventory', { as: 'manager' })).body.find((i) => i.stock > 10)!;
    const body = { customerName: 'Test User', phone: '9876543210', address: '12, 4th Cross, Indiranagar', items: [{ sku: inv.sku, qty: 2 }] };
    const headers = { 'Idempotency-Key': 'abc-123' };
    const first = await api<Order>('/api/orders', { as: 'manager', method: 'POST', body, headers });
    const second = await api<Order>('/api/orders', { as: 'manager', method: 'POST', body, headers });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    const after = (await api<InventoryItem[]>('/api/inventory', { as: 'manager' })).body.find((i) => i.sku === inv.sku)!;
    expect(after.stock).toBe(inv.stock - 2);
  });

  it('refuses an order when stock is short, and returns stock on cancel', async () => {
    const inv = (await api<InventoryItem[]>('/api/inventory', { as: 'manager' })).body.find((i) => i.stock >= 3 && i.stock < 20)!;
    const customer = { customerName: 'Test User', phone: '9876543210', address: '12, 4th Cross, Indiranagar' };
    const tooMany = await api('/api/orders', { as: 'manager', method: 'POST', body: { ...customer, items: [{ sku: inv.sku, qty: 20 }] } });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.shortages[0]).toMatchObject({ sku: inv.sku, available: inv.stock });

    const created = await api<Order>('/api/orders', { as: 'manager', method: 'POST', body: { ...customer, items: [{ sku: inv.sku, qty: 3 }] } });
    await api(`/api/orders/${created.body.id}/status`, { as: 'manager', method: 'PATCH', body: { status: 'cancelled', version: 1 } });
    const after = (await api<InventoryItem[]>('/api/inventory', { as: 'manager' })).body.find((i) => i.sku === inv.sku)!;
    expect(after.stock).toBe(inv.stock);
  });

  it('returns field errors for a bad body', async () => {
    const res = await api('/api/orders', { as: 'manager', method: 'POST', body: { customerName: 'A', phone: '123', address: 'x', items: [] } });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.fields)).toEqual(expect.arrayContaining(['customerName', 'phone', 'address', 'items']));
  });
});

describe('websocket', () => {
  const connect = (token: string) =>
    new Promise<{ ws: WebSocket; events: ServerEvent[] }>((resolve) => {
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
      const events: ServerEvent[] = [];
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        const event = JSON.parse(String(raw)) as ServerEvent;
        events.push(event);
        if (event.type === 'hello') resolve({ ws, events });
      });
    });
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

  it('closes with 4401 for a bad token', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'garbage' })));
    const code = await new Promise<number>((r) => ws.on('close', r));
    expect(code).toBe(4401);
  });

  it('pushes updates with increasing seq; pickers only hear about their own orders', async () => {
    const manager = await connect(tokens.manager!);
    const picker = await connect(tokens.picker!);
    const order = (await firstWithStatus('new')).find((o) => !o.pickerId)!;

    // Assign to someone else: manager hears it, picker p-1 does not.
    const a = await api<Order>(`/api/orders/${order.id}/assign`, { as: 'manager', method: 'PATCH', body: { pickerId: 'p-2', version: order.version } });
    await wait();
    expect(manager.events.at(-1)).toMatchObject({ type: 'order.updated', seq: 2 });
    expect(picker.events).toHaveLength(1);

    // Reassign to p-1: the picker sees it arrive as a new order.
    const b = await api<Order>(`/api/orders/${order.id}/assign`, { as: 'manager', method: 'PATCH', body: { pickerId: 'p-1', version: a.body.version } });
    await wait();
    expect(picker.events.at(-1)).toMatchObject({ type: 'order.created', seq: 2 });

    // Take it away again: the picker is told to drop it.
    await api(`/api/orders/${order.id}/assign`, { as: 'manager', method: 'PATCH', body: { pickerId: 'p-3', version: b.body.version } });
    await wait();
    expect(picker.events.at(-1)).toMatchObject({ type: 'order.removed', orderId: order.id, seq: 3 });

    manager.ws.close();
    picker.ws.close();
  });
});
