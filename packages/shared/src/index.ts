import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Users and roles                                                     */
/* ------------------------------------------------------------------ */

export const ROLES = ['manager', 'picker', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface StaffMember {
  id: string;
  name: string;
  kind: 'picker' | 'rider';
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

export const ORDER_STATUSES = [
  'new',
  'picking',
  'packed',
  'out_for_delivery',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  new: 'New',
  picking: 'Picking',
  packed: 'Packed',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  price: number;
}

export interface Order {
  id: string;
  customerName: string;
  phone: string;
  address: string;
  items: OrderItem[];
  total: number;
  status: OrderStatus;
  pickerId: string | null;
  riderId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Delivery promise time. Past this while not delivered = late. */
  promisedBy: number;
  /** Goes up by 1 on every change. Used to detect conflicting edits. */
  version: number;
}

/** Which status can move to which. This is the single source of truth. */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ['picking', 'cancelled'],
  picking: ['packed', 'cancelled'],
  packed: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

export const isFinal = (s: OrderStatus) => TRANSITIONS[s].length === 0;

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

/** Checks the state machine plus the staffing rules. Used by server AND UI. */
export function checkTransition(
  order: Pick<Order, 'status' | 'pickerId' | 'riderId'>,
  next: OrderStatus,
): TransitionCheck {
  if (!TRANSITIONS[order.status].includes(next)) {
    return {
      ok: false,
      reason: `Cannot move from ${STATUS_LABEL[order.status]} to ${STATUS_LABEL[next]}`,
    };
  }
  if (next === 'picking' && !order.pickerId) {
    return { ok: false, reason: 'Assign a picker first' };
  }
  if (next === 'out_for_delivery' && !order.riderId) {
    return { ok: false, reason: 'Assign a rider first' };
  }
  return { ok: true };
}

export const isLate = (o: Pick<Order, 'status' | 'promisedBy'>, now = Date.now()) =>
  !isFinal(o.status) && now > o.promisedBy;

export interface OrderFilter {
  status?: OrderStatus;
  q?: string;
  /** Only open orders past their promise time. */
  late?: boolean;
}

/** Does this order belong in a list with this filter? Same rule on server and client. */
export function matchesOrderFilter(order: Order, filter: OrderFilter, now = Date.now()): boolean {
  if (filter.status && order.status !== filter.status) return false;
  if (filter.late && !isLate(order, now)) return false;
  const q = filter.q?.trim().toLowerCase();
  if (!q) return true;
  return (
    order.id.toLowerCase().includes(q) ||
    order.customerName.toLowerCase().includes(q) ||
    order.phone.includes(q)
  );
}

/** List order: newest first, id as tie-breaker. Negative = a comes first. */
export const compareOrders = (a: Pick<Order, 'createdAt' | 'id'>, b: Pick<Order, 'createdAt' | 'id'>) =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

export interface InventoryItem {
  sku: string;
  name: string;
  category: string;
  stock: number;
  reorderLevel: number;
  price: number;
  version: number;
}

export const isLowStock = (i: Pick<InventoryItem, 'stock' | 'reorderLevel'>) =>
  i.stock <= i.reorderLevel;

/* ------------------------------------------------------------------ */
/* Permissions (role-based access control)                             */
/* ------------------------------------------------------------------ */

export type Permission =
  | 'orders:read'
  | 'orders:read_all'
  | 'orders:create'
  | 'orders:assign'
  | 'orders:update_status'
  | 'inventory:read'
  | 'inventory:adjust';

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  manager: [
    'orders:read',
    'orders:read_all',
    'orders:create',
    'orders:assign',
    'orders:update_status',
    'inventory:read',
    'inventory:adjust',
  ],
  picker: ['orders:read', 'orders:update_status', 'inventory:read'],
  viewer: ['orders:read', 'orders:read_all', 'inventory:read'],
};

export const can = (role: Role, permission: Permission) =>
  ROLE_PERMISSIONS[role].includes(permission);

/** Pickers may only do the two steps that happen at the shelf. */
const PICKER_STATUSES: readonly OrderStatus[] = ['picking', 'packed'];

/** Can this user see this order at all? */
export function canSeeOrder(user: User, order: Pick<Order, 'pickerId'>) {
  if (can(user.role, 'orders:read_all')) return true;
  return can(user.role, 'orders:read') && order.pickerId === user.id;
}

/** The role half of the check: is this user allowed to attempt this move at all? */
export function roleAllowsStatus(user: User, order: Pick<Order, 'pickerId'>, next: OrderStatus): TransitionCheck {
  if (!can(user.role, 'orders:update_status')) {
    return { ok: false, reason: 'Your role cannot change order status' };
  }
  if (user.role === 'picker') {
    if (order.pickerId !== user.id) return { ok: false, reason: 'Not your order' };
    if (!PICKER_STATUSES.includes(next)) {
      return { ok: false, reason: 'Pickers can only start picking or mark packed' };
    }
  }
  return { ok: true };
}

/** Can this user move this order to `next`? Role check first, then the state machine. */
export function canChangeStatus(
  user: User,
  order: Pick<Order, 'status' | 'pickerId' | 'riderId'>,
  next: OrderStatus,
): TransitionCheck {
  const role = roleAllowsStatus(user, order, next);
  return role.ok ? checkTransition(order, next) : role;
}

/* ------------------------------------------------------------------ */
/* Request schemas (validated on the server, reused by the web form)   */
/* ------------------------------------------------------------------ */

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const customerSchema = z.object({
  customerName: z.string().trim().min(2, 'Enter the customer name').max(60),
  phone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number'),
  address: z.string().trim().min(10, 'Enter the full address').max(200),
});

export const orderLineSchema = z.object({
  sku: z.string().min(1),
  qty: z.number().int().min(1, 'Minimum 1').max(20, 'Maximum 20 per item'),
});

export const createOrderSchema = customerSchema.extend({
  items: z
    .array(orderLineSchema)
    .min(1, 'Add at least one item')
    .max(30, 'Maximum 30 different items'),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const updateStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  version: z.number().int(),
});

export const assignSchema = z
  .object({
    pickerId: z.string().nullable().optional(),
    riderId: z.string().nullable().optional(),
    version: z.number().int(),
  })
  .refine((v) => v.pickerId !== undefined || v.riderId !== undefined, {
    message: 'Nothing to assign',
  });

export const adjustStockSchema = z.object({
  delta: z
    .number()
    .int()
    .refine((n) => n !== 0, 'Enter a non-zero amount'),
  version: z.number().int(),
});

/* ------------------------------------------------------------------ */
/* API shapes                                                          */
/* ------------------------------------------------------------------ */

export interface LoginResponse {
  token: string;
  user: User;
}

export interface OrdersPage {
  items: Order[];
  nextCursor: string | null;
  total: number;
}

export type OrderStats = Record<OrderStatus, number> & { late: number };

/** Every error from the API has this shape. */
export interface ApiErrorBody {
  error: {
    code:
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'validation'
      | 'conflict'
      | 'invalid_transition'
      | 'insufficient_stock'
      | 'internal';
    message: string;
    /** validation: field name -> message */
    fields?: Record<string, string>;
    /** insufficient_stock: which SKUs are short */
    shortages?: { sku: string; name: string; available: number }[];
    /** conflict: the latest copy, so the client can refresh without a second request */
    current?: unknown;
  };
}

/* ------------------------------------------------------------------ */
/* WebSocket messages (server -> client)                               */
/* ------------------------------------------------------------------ */

export type ServerEvent =
  | { type: 'hello'; seq: number }
  /** Heartbeat so the client can tell a dead connection from a quiet one. */
  | { type: 'ping' }
  | { type: 'order.created'; seq: number; order: Order }
  | { type: 'order.updated'; seq: number; order: Order }
  /** Sent to a picker when an order is taken away from them. */
  | { type: 'order.removed'; seq: number; orderId: string }
  | { type: 'inventory.updated'; seq: number; items: InventoryItem[] };

/** Close code the server uses when the token is missing/expired. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
