import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  checkTransition,
  isFinal,
  isLate,
  roleAllowsStatus,
  STATUS_LABEL,
  TRANSITIONS,
  type Order,
  type OrderStatus,
} from '@quickhub/shared';
import { useAssign, useOrder, useStaff, useUpdateStatus } from '../api/queries';
import { ApiError, errorMessage } from '../lib/api';
import { duration, money, stamp } from '../lib/format';
import { useCan, useNow } from '../lib/hooks';
import { useSession } from '../stores/session';
import { StatusBadge } from './StatusBadge';

const ACTION_LABEL: Record<OrderStatus, string> = {
  new: 'New',
  picking: 'Start picking',
  packed: 'Mark packed',
  out_for_delivery: 'Send out for delivery',
  delivered: 'Mark delivered',
  cancelled: 'Cancel order',
};

export default function OrderDrawer() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const order = useOrder(orderId);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => navigate({ pathname: '/orders', search: location.search });
  const closeRef = useRef(close);
  closeRef.current = close;

  // Dialog behaviour: move focus in, keep Tab inside, close on Esc,
  // and put focus back where it was when the drawer closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, []);

  const notFound = order.error instanceof ApiError && order.error.status === 404;

  return (
    <div className="drawer-backdrop" onClick={close}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${orderId}`}
        tabIndex={-1}
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        data-testid="order-drawer"
      >
        <div className="drawer-head">
          <h2>{orderId}</h2>
          <button className="icon-btn" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>

        {order.data ? (
          <OrderDetails order={order.data} />
        ) : order.isPending ? (
          <p className="muted" role="status">
            Loading…
          </p>
        ) : (
          <div role="alert">
            <p>{notFound ? 'This order does not exist, or is no longer assigned to you.' : errorMessage(order.error)}</p>
            {!notFound && (
              <button className="btn" onClick={() => order.refetch()}>
                Retry
              </button>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function OrderDetails({ order }: { order: Order }) {
  const user = useSession((s) => s.user)!;
  const canAssign = useCan('orders:assign');
  const staff = useStaff();
  const updateStatus = useUpdateStatus();
  const assign = useAssign();
  const now = useNow();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const busy = updateStatus.isPending || assign.isPending;

  // If the order changes under us (live update), drop a half-confirmed cancel.
  useEffect(() => setConfirmCancel(false), [order.version]);

  const pickers = staff.data?.filter((s) => s.kind === 'picker') ?? [];
  const riders = staff.data?.filter((s) => s.kind === 'rider') ?? [];
  const nameOf = (id: string | null) => (id ? (staff.data?.find((s) => s.id === id)?.name ?? id) : 'Unassigned');

  const pickerLocked = order.status !== 'new' && order.status !== 'picking';
  const riderLocked = order.status === 'out_for_delivery' || isFinal(order.status);

  // Only moves this ROLE may attempt are shown. Moves blocked by the order's
  // state (e.g. no rider yet) are shown disabled, with the reason.
  const actions = TRANSITIONS[order.status]
    .filter((next) => roleAllowsStatus(user, order, next).ok)
    .map((next) => ({ next, check: checkTransition(order, next) }));

  return (
    <>
      <div className="drawer-status">
        <StatusBadge status={order.status} />
        {isLate(order, now) && <span className="late">Late by {duration(now - order.promisedBy)}</span>}
      </div>

      <dl className="facts">
        <dt>Customer</dt>
        <dd>{order.customerName}</dd>
        <dt>Phone</dt>
        <dd>{order.phone}</dd>
        <dt>Address</dt>
        <dd>{order.address}</dd>
        <dt>Placed</dt>
        <dd>{stamp(order.createdAt)}</dd>
        <dt>Promised by</dt>
        <dd>{stamp(order.promisedBy)}</dd>
        <dt>Last update</dt>
        <dd>{stamp(order.updatedAt)}</dd>
      </dl>

      <h3>Assignment</h3>
      {canAssign ? (
        <div className="assign">
          <label className="field">
            <span>Picker</span>
            <select
              value={order.pickerId ?? ''}
              disabled={busy || pickerLocked}
              onChange={(e) => assign.mutate({ order, change: { pickerId: e.target.value || null } })}
            >
              {order.status === 'new' && <option value="">Unassigned</option>}
              {pickers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Rider</span>
            <select
              value={order.riderId ?? ''}
              disabled={busy || riderLocked}
              onChange={(e) => assign.mutate({ order, change: { riderId: e.target.value || null } })}
            >
              <option value="">Unassigned</option>
              {riders.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <dl className="facts">
          <dt>Picker</dt>
          <dd>{nameOf(order.pickerId)}</dd>
          <dt>Rider</dt>
          <dd>{nameOf(order.riderId)}</dd>
        </dl>
      )}

      <h3>Items</h3>
      <table className="items">
        <tbody>
          {order.items.map((it) => (
            <tr key={it.sku}>
              <td>
                {it.name} <span className="muted">{it.sku}</span>
              </td>
              <td className="num">× {it.qty}</td>
              <td className="num">{money(it.qty * it.price)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={2}>Total</th>
            <th className="num">{money(order.total)}</th>
          </tr>
        </tfoot>
      </table>

      {actions.length > 0 && (
        <div className="drawer-actions">
          {actions.map(({ next, check }) => {
            if (next === 'cancelled') {
              return confirmCancel ? (
                <span key={next} className="confirm">
                  <button className="btn danger" disabled={busy} onClick={() => updateStatus.mutate({ order, status: 'cancelled' })}>
                    Yes, cancel order
                  </button>
                  <button className="btn" onClick={() => setConfirmCancel(false)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button key={next} className="btn danger-outline" disabled={busy} onClick={() => setConfirmCancel(true)}>
                  {ACTION_LABEL[next]}
                </button>
              );
            }
            return (
              <span key={next} className="action">
                <button className="btn primary" disabled={busy || !check.ok} onClick={() => updateStatus.mutate({ order, status: next })}>
                  {ACTION_LABEL[next]}
                </button>
                {!check.ok && <small className="muted">{check.reason}</small>}
              </span>
            );
          })}
        </div>
      )}
      {isFinal(order.status) && <p className="muted">This order is {STATUS_LABEL[order.status].toLowerCase()}. No further actions.</p>}
    </>
  );
}
