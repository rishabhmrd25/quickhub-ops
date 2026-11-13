import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Permission } from '@quickhub/shared';
import { useCan } from '../lib/hooks';
import { MessagePage } from '../pages/MessagePage';
import { useSession } from '../stores/session';

/** Not signed in? Go to login, and remember where the user was heading. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const token = useSession((s) => s.token);
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** Signed in but the role is not allowed here. The server enforces this too. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const allowed = useCan(permission);
  if (!allowed) return <MessagePage title="No access" body="Your role cannot open this page. Ask a manager if you need it." />;
  return <>{children}</>;
}
