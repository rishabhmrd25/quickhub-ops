import { describe, expect, it } from 'vitest';
import type { InventoryItem, Order } from '@quickhub/shared';
import { applyInventoryUpdates, applyOrderChanges, type OrdersData } from './applyEvents';
import { backoffDelay } from './backoff';

/** Smaller `age` = newer order = nearer the top of the list. */
const order = (n: number, age: number, patch: Partial<Order> = {}): Order => ({
  id: `ORD-${n}`,
  customerName: 'Asha Rao',
  phone: '9876543210',
  address: 'x',
  items: [],
  total: 0,
  status: 'new',
  pickerId: null,
  riderId: null,
  createdAt: 10_000 - age,
  updatedAt: 0,
  promisedBy: 0,
  version: 1,
  ...patch,
});

const list = (pages: Order[][], hasMore = false): OrdersData => ({
  pageParams: pages.map(() => null),
  pages: pages.map((items, i) => ({
    items,
    total: 100,
    nextCursor: i < pages.length - 1 || hasMore ? 'cursor' : null,
  })),
});
const ids = (data: OrdersData) => data.pages.map((p) => p.items.map((o) => o.id));

describe('applyOrderChanges', () => {
  it('replaces an order when the incoming version is newer', () => {
    const data = list([[order(3, 1), order(2, 2), order(1, 3)]]);
    const next = applyOrderChanges(data, {}, [{ kind: 'upsert', order: order(2, 2, { status: 'picking', version: 2 }) }]);
    expect(next.pages[0]!.items[1]!.status).toBe('picking');
    expect(next.pages[0]!.total).toBe(100);
  });

  it('keeps untouched rows as the same objects, so memoised rows do not re-render', () => {
    const data = list([[order(3, 1), order(2, 2)]]);
    const next = applyOrderChanges(data, {}, [{ kind: 'upsert', order: order(2, 2, { version: 2 }) }]);
    expect(next.pages[0]!.items[0]).toBe(data.pages[0]!.items[0]);
  });

  it('ignores stale and duplicate events and returns the same object', () => {
    const data = list([[order(2, 1, { version: 5 })]]);
    expect(applyOrderChanges(data, {}, [{ kind: 'upsert', order: order(2, 1, { version: 4, status: 'picking' }) }])).toBe(data);
    expect(applyOrderChanges(data, {}, [{ kind: 'upsert', order: order(2, 1, { version: 5 }) }])).toBe(data);
  });

  it('applies a forced change even when the version is not newer (optimistic update)', () => {
    const data = list([[order(2, 1, { version: 5 })]]);
    const next = applyOrderChanges(data, {}, [{ kind: 'upsert', order: order(2, 1, { version: 5, status: 'picking' }), force: true }]);
    expect(next.pages[0]!.items[0]!.status).toBe('picking');
  });

  it('uses only the newest change when one order changes several times in a batch', () => {
    const data = list([[order(2, 1)]]);
    const next = applyOrderChanges(data, {}, [
      { kind: 'upsert', order: order(2, 1, { version: 3, status: 'packed' }) },
      { kind: 'upsert', order: order(2, 1, { version: 2, status: 'picking' }) }, // arrived out of order
    ]);
    expect(next.pages[0]!.items[0]!.status).toBe('packed');
  });

  it('removes an order that no longer matches the filter and lowers the total', () => {
    const data = list([[order(3, 1), order(2, 2)]]);
    const next = applyOrderChanges(data, { status: 'new' }, [{ kind: 'upsert', order: order(2, 2, { status: 'picking', version: 2 }) }]);
    expect(ids(next)).toEqual([['ORD-3']]);
    expect(next.pages[0]!.total).toBe(99);
  });

  it('puts a brand-new order at the top and raises the total', () => {
    const data = list([[order(3, 1), order(2, 2)]], true);
    const next = applyOrderChanges(data, {}, [{ kind: 'upsert', order: order(4, 0) }]);
    expect(ids(next)).toEqual([['ORD-4', 'ORD-3', 'ORD-2']]);
    expect(next.pages[0]!.total).toBe(101);
  });

  it('inserts an order that starts matching the filter at its sorted position, across pages', () => {
    const data = list([[order(9, 1), order(7, 3)], [order(5, 5), order(3, 7)]], true);
    const next = applyOrderChanges(data, { status: 'new' }, [{ kind: 'upsert', order: order(6, 4, { version: 2 }) }]);
    expect(ids(next)).toEqual([['ORD-9', 'ORD-7'], ['ORD-6', 'ORD-5', 'ORD-3']]);
  });

  it('does not insert an order that belongs beyond the loaded pages', () => {
    const data = list([[order(9, 1), order(7, 3)]], true);
    expect(applyOrderChanges(data, {}, [{ kind: 'upsert', order: order(1, 50, { version: 2 }) }])).toBe(data);
  });

  it('appends at the end when the whole list is loaded', () => {
    const data = list([[order(9, 1), order(7, 3)]], false);
    const next = applyOrderChanges(data, {}, [{ kind: 'upsert', order: order(1, 50, { version: 2 }) }]);
    expect(ids(next)).toEqual([['ORD-9', 'ORD-7', 'ORD-1']]);
  });

  it('respects the search text when deciding whether a new order belongs', () => {
    const data = list([[order(3, 1)]]);
    expect(applyOrderChanges(data, { q: 'asha' }, [{ kind: 'upsert', order: order(4, 0, { customerName: 'Rohan Das' }) }])).toBe(data);
  });

  it('handles removals and an empty list', () => {
    const data = list([[order(3, 1), order(2, 2)]]);
    expect(ids(applyOrderChanges(data, {}, [{ kind: 'remove', orderId: 'ORD-3' }]))).toEqual([['ORD-2']]);
    const empty = list([[]]);
    expect(ids(applyOrderChanges(empty, {}, [{ kind: 'upsert', order: order(1, 0) }]))).toEqual([['ORD-1']]);
    expect(applyOrderChanges(empty, {}, [{ kind: 'remove', orderId: 'ORD-9' }])).toBe(empty);
  });
});

describe('applyInventoryUpdates', () => {
  const item = (sku: string, stock: number, version: number): InventoryItem => ({ sku, name: sku, category: 'c', stock, reorderLevel: 5, price: 10, version });

  it('replaces only newer versions', () => {
    const data = [item('A', 10, 2), item('B', 10, 2)];
    const next = applyInventoryUpdates(data, [item('A', 7, 3), item('B', 99, 1)]);
    expect(next.map((i) => i.stock)).toEqual([7, 10]);
    expect(applyInventoryUpdates(data, [item('B', 99, 2)])).toBe(data);
  });
});

describe('backoffDelay', () => {
  it('doubles up to a 30s cap, with jitter between 50% and 100%', () => {
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(20, () => 1)).toBe(30_000);
  });
});
