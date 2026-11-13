import { useEffect, useMemo, useState } from 'react';
import { Outlet, useSearchParams } from 'react-router-dom';
import { ORDER_STATUSES, STATUS_LABEL, type OrderFilter, type OrderStatus } from '@quickhub/shared';
import { useStats } from '../api/queries';
import { OrdersTable } from '../components/OrdersTable';
import { count } from '../lib/format';
import { useDebouncedValue } from '../lib/hooks';

const isStatus = (v: string | null): v is OrderStatus => ORDER_STATUSES.includes(v as OrderStatus);

export default function OrdersPage() {
  // Filters live in the URL (?status=picking&q=asha) so a view can be
  // bookmarked, shared, and survives a refresh.
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const status = isStatus(rawStatus) ? rawStatus : undefined;
  const q = params.get('q') ?? '';
  const late = params.get('late') === 'true';

  const [search, setSearch] = useState(q);
  const debounced = useDebouncedValue(search.trim(), 300);

  // Typing updates local state instantly; the URL (and so the request) follows 300ms later.
  useEffect(() => {
    if (debounced === q) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (debounced) next.set('q', debounced);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [debounced, q, setParams]);

  const filter = useMemo<OrderFilter>(
    () => ({ ...(status ? { status } : {}), ...(q ? { q } : {}), ...(late ? { late } : {}) }),
    [status, q, late],
  );
  const stats = useStats();

  const setStatus = (next?: OrderStatus) =>
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next) p.set('status', next);
      else p.delete('status');
      return p;
    });

  const toggleLate = () =>
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (late) p.delete('late');
      else p.set('late', 'true');
      return p;
    });

  const totalAll = stats.data ? ORDER_STATUSES.reduce((sum, s) => sum + stats.data[s], 0) : undefined;

  return (
    <div className="page orders-page">
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Filter by status">
          <button className="chip" aria-pressed={!status} onClick={() => setStatus(undefined)}>
            All {totalAll !== undefined && <b>{count(totalAll)}</b>}
          </button>
          {ORDER_STATUSES.map((s) => (
            <button key={s} className={`chip status-${s}`} aria-pressed={status === s} onClick={() => setStatus(s)}>
              <span className="dot" aria-hidden="true" />
              {STATUS_LABEL[s]} {stats.data && <b>{count(stats.data[s])}</b>}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <button className="chip late-count" aria-pressed={late} title="Open orders past their promised time" onClick={toggleLate}>
            Late only {stats.data && <b>{count(stats.data.late)}</b>}
          </button>
          <input
            type="search"
            className="search"
            placeholder="Search order, customer, phone"
            aria-label="Search orders"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <OrdersTable filter={filter} />
      {/* The order drawer is a child route, so it has its own URL. */}
      <Outlet />
    </div>
  );
}
