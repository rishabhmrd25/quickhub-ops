import { Suspense } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useMe } from '../api/queries';
import { useCan } from '../lib/hooks';
import { useRealtime } from '../realtime/useRealtime';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { ErrorBoundary } from './ErrorBoundary';
import { Toasts } from './Toasts';

const CONNECTION_LABEL = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
} as const;

export function AppShell() {
  const user = useSession((s) => s.user);
  const clear = useSession((s) => s.clear);
  const connection = useUi((s) => s.connection);
  const canCreate = useCan('orders:create');
  const location = useLocation();

  useRealtime();
  // Checks the stored token is still valid after a page reload. A 401 signs the user out.
  useMe();

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          QuickHub <span>Ops</span>
        </div>
        <nav aria-label="Main">
          {/* "Orders" should not also light up on the New order page. */}
          <NavLink to="/orders" className={({ isActive }) => (isActive && !location.pathname.startsWith('/orders/new') ? 'active' : '')}>
            Orders
          </NavLink>
          <NavLink to="/inventory">Inventory</NavLink>
          {canCreate && (
            <NavLink to="/orders/new" className="nav-cta">
              + New order
            </NavLink>
          )}
        </nav>
        <div className="topbar-right">
          <span className={`conn conn-${connection}`} role="status" data-testid="connection">
            <span className="dot" aria-hidden="true" />
            {CONNECTION_LABEL[connection]}
          </span>
          <span className="who">
            {user?.name} <span className="role-tag">{user?.role}</span>
          </span>
          <button className="btn" onClick={clear}>
            Sign out
          </button>
        </div>
      </header>

      {(connection === 'reconnecting' || connection === 'offline') && (
        <div className="banner" role="alert">
          {connection === 'offline'
            ? 'You are offline. What you see may be out of date.'
            : 'Connection lost. Reconnecting… live updates are paused.'}
        </div>
      )}

      <main id="main">
        {/* resetKey: navigating away from a crashed page clears the error screen */}
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<div className="page-loading">Loading…</div>}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <Toasts />
    </div>
  );
}
