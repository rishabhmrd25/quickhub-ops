import { EventEmitter } from 'node:events';
import {
  canSeeOrder,
  checkTransition,
  isFinal,
  isLate,
  matchesOrderFilter,
  ORDER_STATUSES,
  roleAllowsStatus,
  type CreateOrderInput,
  type InventoryItem,
  type Order,
  type OrderItem,
  type OrdersPage,
  type OrderStats,
  type OrderStatus,
  type StaffMember,
  type User,
} from '@quickhub/shared';
import { ApiError } from './errors';

/** What the store announces. The realtime layer turns these into WebSocket messages. */
export type StoreEvent =
  | { type: 'order.created'; order: Order }
  | { type: 'order.updated'; order: Order; prev: Order }
  | { type: 'inventory.updated'; items: InventoryItem[] };

export interface ListOrdersQuery {
  status?: OrderStatus;
  q?: string;
  cursor?: string;
  limit: number;
  /** When set, only orders assigned to this picker are returned. */
  pickerId?: string;
}

const PROMISE_MS = 12 * 60 * 1000;

/** Small seeded random generator so the fake data is the same on every start. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Asha', 'Rohan', 'Priya', 'Karthik', 'Neha', 'Arjun', 'Divya', 'Imran', 'Sneha', 'Vikram', 'Ananya', 'Rahul', 'Pooja', 'Aditya', 'Fatima', 'Suresh', 'Kavya', 'Manish', 'Lakshmi', 'Joseph'];
const LAST = ['Rao', 'Sharma', 'Iyer', 'Khan', 'Reddy', 'Nair', 'Gupta', 'Das', 'Menon', 'Singh', 'Patel', 'Joshi', 'Shetty', 'Fernandes', 'Verma'];
const AREAS = ['Indiranagar', 'Koramangala', 'HSR Layout', 'Whitefield', 'Jayanagar', 'BTM Layout', 'Marathahalli', 'JP Nagar', 'Bellandur', 'Malleshwaram'];
const CATALOG: Record<string, string[]> = {
  'Fruits & Vegetables': ['Banana', 'Tomato', 'Onion', 'Potato', 'Apple', 'Spinach', 'Carrot', 'Mango', 'Cucumber', 'Lemon'],
  'Dairy & Eggs': ['Toned Milk', 'Curd', 'Paneer', 'Butter', 'Eggs', 'Cheese Slices', 'Ghee', 'Buttermilk', 'Fresh Cream', 'Greek Yogurt'],
  Snacks: ['Potato Chips', 'Salted Peanuts', 'Digestive Biscuits', 'Namkeen Mix', 'Popcorn', 'Dark Chocolate', 'Protein Bar', 'Cookies', 'Nachos', 'Khakhra'],
  Beverages: ['Cola', 'Orange Juice', 'Green Tea', 'Instant Coffee', 'Coconut Water', 'Energy Drink', 'Lassi', 'Soda', 'Iced Tea', 'Mineral Water'],
  Staples: ['Basmati Rice', 'Wheat Atta', 'Toor Dal', 'Sunflower Oil', 'Sugar', 'Salt', 'Poha', 'Besan', 'Moong Dal', 'Rava'],
  'Personal Care': ['Shampoo', 'Soap Bar', 'Toothpaste', 'Face Wash', 'Hand Wash', 'Body Lotion', 'Deodorant', 'Hair Oil', 'Razor', 'Sunscreen'],
  Household: ['Dish Wash Liquid', 'Detergent', 'Floor Cleaner', 'Garbage Bags', 'Tissue Roll', 'Toilet Cleaner', 'Scrub Pad', 'Air Freshener', 'Matchbox', 'Aluminium Foil'],
  Bakery: ['White Bread', 'Brown Bread', 'Pav', 'Burger Buns', 'Rusk', 'Muffins', 'Croissant', 'Pizza Base', 'Garlic Bread', 'Cake Slice'],
};
const SIZES = ['Small', 'Regular', 'Large'];

export class Store {
  readonly events = new EventEmitter();
  readonly staff: StaffMember[] = [];
  private orders = new Map<string, Order>();
  /** Order ids, newest first. Kept sorted so listing is a simple walk. */
  private ids: string[] = [];
  private inventory = new Map<string, InventoryItem>();
  private nextOrderNumber = 100001;
  /** Idempotency-Key -> order id, so a repeated create returns the first order. */
  private idempotency = new Map<string, string>();
  /** Orders a person touched recently; the simulator leaves these alone. */
  private touchedAt = new Map<string, number>();
  private rand: () => number;

  constructor(opts: { orderCount?: number; seed?: number } = {}) {
    this.rand = mulberry32(opts.seed ?? 42);
    this.seed(opts.orderCount ?? 10_000);
  }

  /* ------------------------------ seed ------------------------------ */

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rand() * list.length)]!;
  }

  private seed(orderCount: number) {
    const pickerNames = ['Ravi', 'Sana', 'Deepak', 'Latha', 'Farhan', 'Geeta', 'Naveen', 'Tara'];
    const riderNames = ['Anil', 'Bala', 'Chetan', 'Dinesh', 'Eshan', 'Faiz', 'Ganesh', 'Hari', 'Irfan', 'Jatin'];
    pickerNames.forEach((name, i) => this.staff.push({ id: `p-${i + 1}`, name, kind: 'picker' }));
    riderNames.forEach((name, i) => this.staff.push({ id: `r-${i + 1}`, name, kind: 'rider' }));

    let n = 1;
    for (const [category, names] of Object.entries(CATALOG)) {
      for (const base of names) {
        for (const size of SIZES) {
          const sku = `SKU-${String(n++).padStart(4, '0')}`;
          const reorderLevel = 10 + Math.floor(this.rand() * 20);
          // About 1 in 8 items starts low so the "low stock" view has data.
          const low = this.rand() < 0.125;
          this.inventory.set(sku, {
            sku,
            name: `${base} (${size})`,
            category,
            stock: low ? Math.floor(this.rand() * reorderLevel) : 40 + Math.floor(this.rand() * 200),
            reorderLevel,
            price: 20 + Math.floor(this.rand() * 48) * 5,
            version: 1,
          });
        }
      }
    }

    const skus = [...this.inventory.keys()];
    const pickers = this.staff.filter((s) => s.kind === 'picker');
    const riders = this.staff.filter((s) => s.kind === 'rider');
    const now = Date.now();
    const ACTIVE = Math.min(120, orderCount);
    const built: Order[] = [];

    // i = 0 is the newest order. The newest ACTIVE orders are still in progress.
    for (let i = 0; i < orderCount; i++) {
      const createdAt = i < ACTIVE ? now - i * 8_000 : now - ACTIVE * 8_000 - (i - ACTIVE) * 26_000;
      let status: OrderStatus;
      if (i < 25) status = 'new';
      else if (i < 60) status = 'picking';
      else if (i < 85) status = 'packed';
      else if (i < ACTIVE) status = 'out_for_delivery';
      else status = this.rand() < 0.05 ? 'cancelled' : 'delivered';

      const items: OrderItem[] = [];
      const lineCount = 1 + Math.floor(this.rand() * 5);
      const used = new Set<string>();
      for (let k = 0; k < lineCount; k++) {
        const sku = this.pick(skus);
        if (used.has(sku)) continue;
        used.add(sku);
        const inv = this.inventory.get(sku)!;
        items.push({ sku, name: inv.name, qty: 1 + Math.floor(this.rand() * 3), price: inv.price });
      }

      // Every 6th active order goes to p-1 so the demo picker account has work.
      const picker = i < ACTIVE && i % 6 === 0 ? pickers[0]! : this.pick(pickers);
      const hasPicker = status !== 'new' || i % 3 === 0;
      const hasRider = status === 'out_for_delivery' || status === 'delivered' || (status === 'packed' && i % 2 === 0);

      built.push({
        id: '', // set below, once we know the order
        customerName: `${this.pick(FIRST)} ${this.pick(LAST)}`,
        phone: `9${String(Math.floor(this.rand() * 1e9)).padStart(9, '0')}`,
        address: `${1 + Math.floor(this.rand() * 400)}, ${1 + Math.floor(this.rand() * 12)}th Cross, ${this.pick(AREAS)}, Bengaluru`,
        items,
        total: items.reduce((sum, it) => sum + it.qty * it.price, 0),
        status,
        pickerId: hasPicker ? picker.id : null,
        riderId: hasRider ? this.pick(riders).id : null,
        createdAt,
        updatedAt: createdAt,
        promisedBy: createdAt + PROMISE_MS,
        version: 1,
      });
    }

    // Oldest order gets the smallest number, like a real system.
    for (let i = built.length - 1; i >= 0; i--) built[i]!.id = `ORD-${this.nextOrderNumber++}`;
    for (const order of built) {
      this.orders.set(order.id, order);
      this.ids.push(order.id);
    }
  }

  /* ----------------------------- orders ----------------------------- */

  listOrders(query: ListOrdersQuery): OrdersPage {
    const filter = { status: query.status, q: query.q };
    let after: { createdAt: number; id: string } | null = null;
    if (query.cursor) {
      const [ts, id] = query.cursor.split('_');
      if (!ts || !id || Number.isNaN(Number(ts))) {
        throw new ApiError(400, 'validation', 'Bad cursor');
      }
      after = { createdAt: Number(ts), id };
    }

    const items: Order[] = [];
    let total = 0;
    let hasMore = false;
    for (const id of this.ids) {
      const o = this.orders.get(id)!;
      if (query.pickerId && o.pickerId !== query.pickerId) continue;
      if (!matchesOrderFilter(o, filter)) continue;
      total++;
      // Cursor = "everything older than the last row you have". Unlike page
      // numbers, this does not shift when new orders arrive at the top.
      if (after && !(o.createdAt < after.createdAt || (o.createdAt === after.createdAt && o.id < after.id))) continue;
      if (items.length < query.limit) items.push(o);
      else hasMore = true;
    }
    const last = items[items.length - 1];
    return { items, total, nextCursor: hasMore && last ? `${last.createdAt}_${last.id}` : null };
  }

  /** Returns the order, or throws 404. Also 404 if this user may not see it. */
  getOrder(id: string, viewer?: User): Order {
    const order = this.orders.get(id);
    if (!order || (viewer && !canSeeOrder(viewer, order))) {
      throw new ApiError(404, 'not_found', 'Order not found');
    }
    return order;
  }

  stats(pickerId?: string): OrderStats {
    const stats = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as OrderStats;
    stats.late = 0;
    const now = Date.now();
    for (const o of this.orders.values()) {
      if (pickerId && o.pickerId !== pickerId) continue;
      stats[o.status]++;
      if (isLate(o, now)) stats.late++;
    }
    return stats;
  }

  private assertVersion(order: Order, version: number | null) {
    if (version !== null && version !== order.version) {
      throw new ApiError(409, 'conflict', 'This order was changed by someone else', { current: order });
    }
  }

  private save(prev: Order, patch: Partial<Order>, byPerson: boolean): Order {
    const order: Order = { ...prev, ...patch, updatedAt: Date.now(), version: prev.version + 1 };
    this.orders.set(order.id, order);
    if (byPerson) this.touchedAt.set(order.id, Date.now());
    this.events.emit('event', { type: 'order.updated', order, prev } satisfies StoreEvent);
    return order;
  }

  /** `actor = null` means the simulator; it still obeys the state machine. */
  setStatus(id: string, next: OrderStatus, version: number | null, actor: User | null): Order {
    const prev = this.getOrder(id, actor ?? undefined);
    this.assertVersion(prev, version);

    if (actor) {
      const role = roleAllowsStatus(actor, prev, next);
      if (!role.ok) throw new ApiError(403, 'forbidden', role.reason);
    }
    const move = checkTransition(prev, next);
    if (!move.ok) throw new ApiError(422, 'invalid_transition', move.reason);

    const order = this.save(prev, { status: next }, actor !== null);
    if (next === 'cancelled') this.changeStock(order.items.map((it) => ({ sku: it.sku, delta: it.qty })));
    return order;
  }

  assign(
    id: string,
    change: { pickerId?: string | null; riderId?: string | null },
    version: number | null,
    byPerson = true,
  ): Order {
    const prev = this.getOrder(id);
    this.assertVersion(prev, version);
    if (isFinal(prev.status)) {
      throw new ApiError(422, 'invalid_transition', 'This order is already closed');
    }

    const patch: Partial<Order> = {};
    if (change.pickerId !== undefined && change.pickerId !== prev.pickerId) {
      if (prev.status !== 'new' && prev.status !== 'picking') {
        throw new ApiError(422, 'invalid_transition', 'Picking is already finished');
      }
      if (change.pickerId === null && prev.status === 'picking') {
        throw new ApiError(422, 'invalid_transition', 'An order being picked needs a picker');
      }
      this.assertStaff(change.pickerId, 'picker');
      patch.pickerId = change.pickerId;
    }
    if (change.riderId !== undefined && change.riderId !== prev.riderId) {
      if (prev.status === 'out_for_delivery') {
        throw new ApiError(422, 'invalid_transition', 'The rider has already left');
      }
      this.assertStaff(change.riderId, 'rider');
      patch.riderId = change.riderId;
    }
    if (Object.keys(patch).length === 0) return prev; // nothing actually changed
    return this.save(prev, patch, byPerson);
  }

  private assertStaff(id: string | null, kind: StaffMember['kind']) {
    if (id !== null && !this.staff.some((s) => s.id === id && s.kind === kind)) {
      throw new ApiError(400, 'validation', `Unknown ${kind}`, { fields: { [`${kind}Id`]: `Unknown ${kind}` } });
    }
  }

  createOrder(input: CreateOrderInput, idempotencyKey?: string): { order: Order; replayed: boolean } {
    if (idempotencyKey) {
      const existing = this.idempotency.get(idempotencyKey);
      if (existing) return { order: this.orders.get(existing)!, replayed: true };
    }

    // The same SKU on two lines is merged into one.
    const merged = new Map<string, number>();
    for (const line of input.items) merged.set(line.sku, (merged.get(line.sku) ?? 0) + line.qty);

    const items: OrderItem[] = [];
    const shortages: { sku: string; name: string; available: number }[] = [];
    for (const [sku, qty] of merged) {
      const inv = this.inventory.get(sku);
      if (!inv) throw new ApiError(400, 'validation', 'Unknown item', { fields: { items: `Unknown item ${sku}` } });
      if (inv.stock < qty) shortages.push({ sku, name: inv.name, available: inv.stock });
      items.push({ sku, name: inv.name, qty, price: inv.price });
    }
    // Stock is checked here, at the last moment, because it may have changed
    // since the form loaded. All-or-nothing: no partial orders.
    if (shortages.length > 0) {
      throw new ApiError(422, 'insufficient_stock', 'Some items are out of stock', { shortages });
    }

    const now = Date.now();
    const order: Order = {
      id: `ORD-${this.nextOrderNumber++}`,
      customerName: input.customerName,
      phone: input.phone,
      address: input.address,
      items,
      total: items.reduce((sum, it) => sum + it.qty * it.price, 0),
      status: 'new',
      pickerId: null,
      riderId: null,
      createdAt: now,
      updatedAt: now,
      promisedBy: now + PROMISE_MS,
      version: 1,
    };
    this.orders.set(order.id, order);
    this.ids.unshift(order.id);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, order.id);
      if (this.idempotency.size > 5_000) this.idempotency.delete(this.idempotency.keys().next().value!);
    }
    this.changeStock(items.map((it) => ({ sku: it.sku, delta: -it.qty })));
    this.events.emit('event', { type: 'order.created', order } satisfies StoreEvent);
    return { order, replayed: false };
  }

  /* ---------------------------- inventory --------------------------- */

  listInventory(query: { q?: string; lowOnly?: boolean }): InventoryItem[] {
    const q = query.q?.trim().toLowerCase();
    return [...this.inventory.values()].filter((it) => {
      if (query.lowOnly && it.stock > it.reorderLevel) return false;
      if (q && !(it.name.toLowerCase().includes(q) || it.sku.toLowerCase().includes(q) || it.category.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  adjustStock(sku: string, delta: number, version: number): InventoryItem {
    const item = this.inventory.get(sku);
    if (!item) throw new ApiError(404, 'not_found', 'Item not found');
    if (item.version !== version) {
      throw new ApiError(409, 'conflict', 'Stock changed since you loaded it', { current: item });
    }
    if (item.stock + delta < 0) {
      throw new ApiError(422, 'insufficient_stock', `Only ${item.stock} in stock`, {
        shortages: [{ sku, name: item.name, available: item.stock }],
      });
    }
    return this.changeStock([{ sku, delta }])[0]!;
  }

  private changeStock(changes: { sku: string; delta: number }[]): InventoryItem[] {
    const updated: InventoryItem[] = [];
    for (const { sku, delta } of changes) {
      const item = this.inventory.get(sku);
      if (!item) continue;
      const next = { ...item, stock: Math.max(0, item.stock + delta), version: item.version + 1 };
      this.inventory.set(sku, next);
      updated.push(next);
    }
    if (updated.length > 0) {
      this.events.emit('event', { type: 'inventory.updated', items: updated } satisfies StoreEvent);
    }
    return updated;
  }

  /* -------------------- helpers for the simulator ------------------- */

  openOrders(): Order[] {
    const open: Order[] = [];
    // Open orders are always near the top (newest), so stop early.
    for (const id of this.ids.slice(0, 600)) {
      const o = this.orders.get(id)!;
      if (!isFinal(o.status)) open.push(o);
    }
    return open;
  }

  wasTouchedRecently(id: string, withinMs = 60_000) {
    const at = this.touchedAt.get(id);
    return at !== undefined && Date.now() - at < withinMs;
  }

  randomInStockSkus(count: number): string[] {
    const inStock = [...this.inventory.values()].filter((i) => i.stock > 5);
    const out = new Set<string>();
    while (out.size < Math.min(count, inStock.length)) out.add(this.pick(inStock).sku);
    return [...out];
  }

  randomCustomer() {
    return {
      customerName: `${this.pick(FIRST)} ${this.pick(LAST)}`,
      phone: `9${String(Math.floor(this.rand() * 1e9)).padStart(9, '0')}`,
      address: `${1 + Math.floor(this.rand() * 400)}, ${1 + Math.floor(this.rand() * 12)}th Cross, ${this.pick(AREAS)}, Bengaluru`,
    };
  }

  random() {
    return this.rand();
  }
}
