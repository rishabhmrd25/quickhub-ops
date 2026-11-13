import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { isFinal, type Order, type OrderFilter } from '@quickhub/shared';
import { useOrders, useStaff } from '../api/queries';
import { errorMessage } from '../lib/api';
import { clock, count, duration, money } from '../lib/format';
import { useNow } from '../lib/hooks';
import { StatusBadge } from './StatusBadge';

const ROW_HEIGHT = 44;
/** Start loading the next page when the user is this many rows from the end. */
const LOAD_AHEAD = 40;

export function OrdersTable({ filter }: { filter: OrderFilter }) {
  const orders = useOrders(filter);
  const staff = useStaff();
  const now = useNow();
  const navigate = useNavigate();
  const location = useLocation();
  const { orderId: openId } = useParams();

  const rows = useMemo(() => orders.data?.pages.flatMap((p) => p.items) ?? [], [orders.data]);
  const total = orders.data?.pages[0]?.total ?? 0;
  const staffName = useMemo(() => new Map(staff.data?.map((s) => [s.id, s.name])), [staff.data]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const virtualRows = virtualizer.getVirtualItems();

  /* ---- infinite scroll: fetch the next page shortly before the end ---- */
  const lastVisible = virtualRows[virtualRows.length - 1]?.index ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = orders;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastVisible >= rows.length - LOAD_AHEAD) void fetchNextPage();
  }, [lastVisible, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  /* ---- scroll anchoring ----
   * Live updates insert and remove rows. If that happens ABOVE what the user is
   * looking at, everything would jump. So we remember the first visible row and,
   * after each data change, shift the scroll position to keep that row in place. */
  const anchor = useRef<{ id: string; index: number } | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [newAbove, setNewAbove] = useState(0);

  const rememberAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const index = Math.floor(el.scrollTop / ROW_HEIGHT);
    const row = rowsRef.current[index];
    anchor.current = row ? { id: row.id, index } : null;
    if (el.scrollTop < ROW_HEIGHT) setNewAbove(0);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = anchor.current;
    if (el && prev && el.scrollTop >= ROW_HEIGHT) {
      // Look near the old position first; rows rarely move far in one batch.
      let index = -1;
      for (let i = Math.max(0, prev.index - 50); i < Math.min(rows.length, prev.index + 500); i++) {
        if (rows[i]!.id === prev.id) {
          index = i;
          break;
        }
      }
      if (index !== -1 && index !== prev.index) {
        el.scrollTop += (index - prev.index) * ROW_HEIGHT;
        if (index > prev.index) setNewAbove((n) => n + index - prev.index);
      }
    }
    rememberAnchor();
  }, [rows, rememberAnchor]);

  // A different filter is a different list: start at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    anchor.current = null;
    setNewAbove(0);
  }, [filter]);

  const open = useCallback(
    (id: string) => navigate({ pathname: `/orders/${id}`, search: location.search }),
    [navigate, location.search],
  );

  /* ------------------------------ states ------------------------------ */
  if (orders.isPending) {
    return (
      <div className="table-state" role="status">
        Loading orders…
      </div>
    );
  }
  if (orders.isError && rows.length === 0) {
    return (
      <div className="table-state" role="alert">
        <p>Could not load orders: {errorMessage(orders.error)}</p>
        <button className="btn primary" onClick={() => orders.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <div className="table-meta" aria-live="polite">
        <span data-testid="order-count">
          {count(total)} {total === 1 ? 'order' : 'orders'}
        </span>
        {orders.isFetching && !orders.isFetchingNextPage && <span className="muted"> · refreshing…</span>}
      </div>

      {/* ARIA grid roles + row counts tell screen readers the real size,
          because most rows are not in the DOM at any moment. */}
      <div className="grid" role="grid" aria-label="Orders" aria-rowcount={total + 1}>
        <div className="grid-head" role="row" aria-rowindex={1}>
          <span role="columnheader">Order</span>
          <span role="columnheader">Customer</span>
          <span role="columnheader" className="num">Items</span>
          <span role="columnheader" className="num">Total</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Picker</span>
          <span role="columnheader">Rider</span>
          <span role="columnheader">Placed</span>
          <span role="columnheader">Promise</span>
        </div>

        <div className="grid-body" ref={scrollRef} onScroll={rememberAnchor} data-testid="orders-scroll">
          {rows.length === 0 ? (
            <div className="table-state">No orders match this filter.</div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualRows.map((v) => {
                const order = rows[v.index]!;
                return (
                  <OrderRow
                    key={order.id}
                    order={order}
                    index={v.index}
                    top={v.start}
                    now={now}
                    picker={order.pickerId ? (staffName.get(order.pickerId) ?? order.pickerId) : null}
                    rider={order.riderId ? (staffName.get(order.riderId) ?? order.riderId) : null}
                    selected={order.id === openId}
                    search={location.search}
                    onOpen={open}
                  />
                );
              })}
            </div>
          )}
          {isFetchingNextPage && <div className="loading-more">Loading more…</div>}
        </div>

        {newAbove > 0 && (
          <button
            className="new-pill"
            onClick={() => {
              scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
              setNewAbove(0);
            }}
          >
            ↑ {newAbove} new above
          </button>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  order: Order;
  index: number;
  top: number;
  now: number;
  picker: string | null;
  rider: string | null;
  selected: boolean;
  search: string;
  onOpen: (id: string) => void;
}

/**
 * memo: a row re-renders only when ITS props change. A live update replaces one
 * order object, so only that row re-renders, not every visible row.
 */
const OrderRow = memo(function OrderRow({ order, index, top, now, picker, rider, selected, search, onOpen }: RowProps) {
  const open = !isFinal(order.status);
  const msLeft = order.promisedBy - now;
  return (
    <div
      className={`grid-row${selected ? ' selected' : ''}`}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      style={{ transform: `translateY(${top}px)`, height: ROW_HEIGHT }}
      onClick={() => onOpen(order.id)}
      data-testid="order-row"
      data-order-id={order.id}
    >
      <span role="gridcell">
        {/* A real link, so the row is reachable by keyboard and can be opened in a new tab. */}
        <Link to={{ pathname: `/orders/${order.id}`, search }} onClick={(e) => e.stopPropagation()}>
          {order.id}
        </Link>
      </span>
      <span role="gridcell" className="ellipsis">{order.customerName}</span>
      <span role="gridcell" className="num">{order.items.reduce((n, it) => n + it.qty, 0)}</span>
      <span role="gridcell" className="num">{money(order.total)}</span>
      <span role="gridcell"><StatusBadge status={order.status} /></span>
      <span role="gridcell" className={picker ? 'ellipsis' : 'muted'}>{picker ?? 'Unassigned'}</span>
      <span role="gridcell" className={rider ? 'ellipsis' : 'muted'}>{rider ?? 'Unassigned'}</span>
      <span role="gridcell" className="muted">{clock(order.createdAt)}</span>
      <span role="gridcell">
        {!open ? (
          <span className="muted">—</span>
        ) : msLeft < 0 ? (
          <span className="late">Late {duration(-msLeft)}</span>
        ) : (
          <span>{duration(msLeft)} left</span>
        )}
      </span>
    </div>
  );
});
