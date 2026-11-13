import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import {
  adjustStockSchema,
  assignSchema,
  can,
  createOrderSchema,
  loginSchema,
  ORDER_STATUSES,
  updateStatusSchema,
  type LoginResponse,
} from '@quickhub/shared';
import { DEMO_PASSWORD, issueToken, requireAuth, requirePermission, USERS } from './auth';
import { ApiError, parse } from './errors';
import type { Store } from './store';

const listQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().max(60).optional(),
  late: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const inventoryQuerySchema = z.object({
  q: z.string().max(60).optional(),
  lowOnly: z.enum(['true', 'false']).optional(),
});

export function createApp(store: Store, opts: { latencyMs?: number } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // An empty CORS_ORIGIN (e.g. a blank dashboard field) means "not set", not "allow nobody".
  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  app.use(cors({ origin: corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : true }));
  app.use(express.json({ limit: '100kb' }));

  // Fake network delay so loading states and optimistic updates are visible locally.
  if (opts.latencyMs) {
    app.use('/api', (_req, _res, next) => setTimeout(next, opts.latencyMs));
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  /* ------------------------------ auth ------------------------------ */

  app.post('/api/auth/login', (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const user = USERS.find((u) => u.email === email);
    // Same message for "no such user" and "wrong password" so emails can't be probed.
    if (!user || password !== DEMO_PASSWORD) {
      throw new ApiError(401, 'unauthorized', 'Wrong email or password');
    }
    const body: LoginResponse = { token: issueToken(user), user };
    res.json(body);
  });

  app.use('/api', requireAuth);

  app.get('/api/me', (req, res) => res.json(req.user));

  /* ----------------------------- orders ----------------------------- */

  /** Pickers are scoped to their own orders on the server, not just in the UI. */
  const scopeOf = (req: express.Request) =>
    can(req.user!.role, 'orders:read_all') ? undefined : req.user!.id;

  app.get('/api/orders', requirePermission('orders:read'), (req, res) => {
    const query = parse(listQuerySchema, req.query);
    res.json(store.listOrders({ ...query, late: query.late === 'true', pickerId: scopeOf(req) }));
  });

  app.get('/api/stats', requirePermission('orders:read'), (req, res) => {
    res.json(store.stats(scopeOf(req)));
  });

  app.get('/api/orders/:id', requirePermission('orders:read'), (req, res) => {
    res.json(store.getOrder(req.params.id!, req.user));
  });

  app.post('/api/orders', requirePermission('orders:create'), (req, res) => {
    const input = parse(createOrderSchema, req.body);
    const rawKey = req.header('Idempotency-Key');
    const key = rawKey ? `${req.user!.id}:${rawKey.slice(0, 80)}` : undefined;
    const { order, replayed } = store.createOrder(input, key);
    res.status(replayed ? 200 : 201).json(order);
  });

  app.patch('/api/orders/:id/status', requirePermission('orders:update_status'), (req, res) => {
    const { status, version } = parse(updateStatusSchema, req.body);
    res.json(store.setStatus(req.params.id!, status, version, req.user!));
  });

  app.patch('/api/orders/:id/assign', requirePermission('orders:assign'), (req, res) => {
    const { version, ...change } = parse(assignSchema, req.body);
    res.json(store.assign(req.params.id!, change, version));
  });

  /* ---------------------------- inventory --------------------------- */

  app.get('/api/inventory', requirePermission('inventory:read'), (req, res) => {
    const query = parse(inventoryQuerySchema, req.query);
    res.json(store.listInventory({ q: query.q, lowOnly: query.lowOnly === 'true' }));
  });

  app.patch('/api/inventory/:sku', requirePermission('inventory:adjust'), (req, res) => {
    const { delta, version } = parse(adjustStockSchema, req.body);
    res.json(store.adjustStock(req.params.sku!, delta, version));
  });

  app.get('/api/staff', (_req, res) => res.json(store.staff));

  /* ----------------------------- errors ----------------------------- */

  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'not_found', 'No such endpoint')));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json(err.toBody());
      return;
    }
    // express.json() throws this for malformed JSON bodies.
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json(new ApiError(400, 'validation', 'Body is not valid JSON').toBody());
      return;
    }
    console.error(err);
    // Never leak stack traces or internals to the client.
    res.status(500).json(new ApiError(500, 'internal', 'Something went wrong').toBody());
  };
  app.use(onError);

  return app;
}
