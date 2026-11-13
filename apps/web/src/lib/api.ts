import type { ApiErrorBody } from '@quickhub/shared';
import { useSession } from '../stores/session';

const BASE = import.meta.env.VITE_API_URL ?? '';

/** Every failed request becomes one of these, so UI code has one shape to handle. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody['error'],
  ) {
    super(body.message);
  }
  get code() {
    return this.body.code;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  /** Lets TanStack Query cancel requests that are no longer needed. */
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = useSession.getState().token;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: opts.method ?? 'GET',
      signal: opts.signal,
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // fetch only rejects when the network itself failed.
    throw new ApiError(0, { code: 'internal', message: 'Cannot reach the server. Check your connection.' });
  }

  if (res.ok) return (await res.json()) as T;

  let body: ApiErrorBody['error'];
  try {
    body = ((await res.json()) as ApiErrorBody).error;
  } catch {
    body = { code: 'internal', message: `Request failed (${res.status})` };
  }

  // An expired/invalid token on any call ends the session. The router then
  // sends the user to the login page. Login itself is excluded.
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    useSession.getState().clear();
  }
  throw new ApiError(res.status, body);
}

export function wsUrl(): string {
  if (BASE) return BASE.replace(/^http/, 'ws') + '/ws';
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : 'Something went wrong';
