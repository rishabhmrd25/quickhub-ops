import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { can, type Permission, type User } from '@quickhub/shared';
import { ApiError } from './errors';

/**
 * DEMO ONLY. Real apps store hashed passwords in a database and use a
 * well-tested auth library. These accounts exist so the three roles can be tried.
 */
export const DEMO_PASSWORD = 'demo1234';
export const USERS: User[] = [
  { id: 'u-manager', name: 'Meera (Manager)', email: 'manager@quickhub.dev', role: 'manager' },
  // The picker's user id matches a staff id, so orders can be assigned to them.
  { id: 'p-1', name: 'Ravi (Picker)', email: 'picker@quickhub.dev', role: 'picker' },
  { id: 'u-viewer', name: 'Vik (Viewer)', email: 'viewer@quickhub.dev', role: 'viewer' },
];

const SECRET = process.env.TOKEN_SECRET ?? 'dev-only-secret-change-me';
const TTL_SEC = Number(process.env.TOKEN_TTL_SEC ?? 8 * 60 * 60);

const sign = (payload: string) => createHmac('sha256', SECRET).update(payload).digest('base64url');

/** Token = base64(payload) + "." + HMAC signature. Same idea as a JWT, kept tiny. */
export function issueToken(user: User, ttlSec = TTL_SEC): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: user.id, exp: Date.now() + ttlSec * 1000 }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined | null): { user: User; exp: number } | null {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // timingSafeEqual avoids leaking how many characters matched.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      uid: string;
      exp: number;
    };
    if (typeof exp !== 'number' || Date.now() > exp) return null;
    const user = USERS.find((u) => u.id === uid);
    return user ? { user, exp } : null;
  } catch {
    return null;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const session = verifyToken(token);
  if (!session) return next(new ApiError(401, 'unauthorized', 'Please sign in again'));
  req.user = session.user;
  next();
}

/** Route guard: the UI hides things, but this is what actually enforces roles. */
export const requirePermission =
  (permission: Permission) => (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !can(req.user.role, permission)) {
      return next(new ApiError(403, 'forbidden', 'Your role cannot do this'));
    }
    next();
  };
