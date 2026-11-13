import { useEffect, useState } from 'react';
import { can, type Permission } from '@quickhub/shared';
import { useSession } from '../stores/session';

/** Returns `value` only after it has stopped changing for `delay` ms. */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Current time that refreshes every `intervalMs`, for "5m ago" style labels. */
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** UI-side permission check. The server checks again; this only decides what to show. */
export function useCan(permission: Permission): boolean {
  const role = useSession((s) => s.user?.role);
  return role ? can(role, permission) : false;
}
