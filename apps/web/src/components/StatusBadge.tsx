import { STATUS_LABEL, type OrderStatus } from '@quickhub/shared';

/** Colour plus a text label, so status never depends on colour alone. */
export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={`badge status-${status}`}>
      <span className="dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}
