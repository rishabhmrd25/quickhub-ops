import type { InfiniteData } from '@tanstack/react-query';
import {
  compareOrders,
  matchesOrderFilter,
  type InventoryItem,
  type Order,
  type OrderFilter,
  type OrdersPage,
} from '@quickhub/shared';

export type OrderChange =
  | { kind: 'upsert'; order: Order; /** apply even if the version is not newer (optimistic updates, rollbacks) */ force?: boolean }
  | { kind: 'remove'; orderId: string };

export type OrdersData = InfiniteData<OrdersPage, string | null>;

/**
 * Apply a batch of live changes to one cached orders list.
 *
 * Pure function: same input, same output, no side effects. That makes it easy
 * to unit test, and it is where most real-time edge cases are decided:
 *  - stale events (older version than what we have) are ignored
 *  - an order that no longer matches the list's filter is removed
 *  - an order that now matches is inserted at its sorted position,
 *    but only if that position is inside the part of the list already loaded
 *
 * Returns the SAME object when nothing changed, so React skips re-rendering.
 */
export function applyOrderChanges(data: OrdersData, filter: OrderFilter, changes: OrderChange[]): OrdersData {
  if (changes.length === 0) return data;

  // If one order changed several times in this batch, only the last change matters.
  const latest = new Map<string, OrderChange>();
  for (const change of changes) {
    const id = change.kind === 'upsert' ? change.order.id : change.orderId;
    const seen = latest.get(id);
    if (change.kind === 'upsert' && seen?.kind === 'upsert' && !change.force && seen.order.version > change.order.version) continue;
    latest.set(id, change);
  }

  let changed = false;
  let totalDelta = 0;
  const handled = new Set<string>();

  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const items: Order[] = [];
    for (const item of page.items) {
      const change = latest.get(item.id);
      if (!change) {
        items.push(item);
        continue;
      }
      handled.add(item.id);
      if (change.kind === 'remove') {
        pageChanged = true;
        totalDelta--;
      } else if (!change.force && change.order.version <= item.version) {
        items.push(item); // stale or duplicate event
      } else if (matchesOrderFilter(change.order, filter)) {
        items.push(change.order);
        pageChanged = true;
      } else {
        pageChanged = true; // moved out of this filter
        totalDelta--;
      }
    }
    if (!pageChanged) return page;
    changed = true;
    return { ...page, items };
  });

  // Orders we don't have yet that now belong in this list.
  for (const [id, change] of latest) {
    if (handled.has(id) || change.kind !== 'upsert' || !matchesOrderFilter(change.order, filter)) continue;
    for (let p = 0; p < pages.length; p++) {
      const page = pages[p]!;
      const last = page.items[page.items.length - 1];
      const isLastPage = p === pages.length - 1;
      const fitsHere = last ? compareOrders(change.order, last) < 0 : true;
      // Past the end of what is loaded and more pages exist: it will arrive when the user scrolls there.
      if (!fitsHere && !(isLastPage && page.nextCursor === null)) continue;
      const at = page.items.findIndex((item) => compareOrders(change.order, item) < 0);
      const items = [...page.items];
      items.splice(at === -1 ? items.length : at, 0, change.order);
      pages[p] = { ...page, items };
      changed = true;
      totalDelta++;
      break;
    }
  }

  if (!changed) return data;
  return { ...data, pages: pages.map((page) => (totalDelta ? { ...page, total: Math.max(0, page.total + totalDelta) } : page)) };
}

/** Replace inventory rows that have a newer version. Same-object return if nothing changed. */
export function applyInventoryUpdates(list: InventoryItem[], updates: InventoryItem[]): InventoryItem[] {
  const bySku = new Map(updates.map((u) => [u.sku, u]));
  let changed = false;
  const next = list.map((item) => {
    const update = bySku.get(item.sku);
    if (!update || update.version <= item.version) return item;
    changed = true;
    return update;
  });
  return changed ? next : list;
}
