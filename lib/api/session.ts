// HttpOnly session cookie — signed JWT (HS256) via Node crypto.

import { cookies } from 'next/headers';
import type { AuthContext } from '@/types/auth';
import {
  ACTING_TENANT_COOKIE,
  SESSION_COOKIE,
  authFromPayload,
  buildSessionPayload,
  createSessionToken,
  sessionCookieOptions,
  verifySessionToken,
} from '@/lib/api/session-token';

export type { AuthContext };
export {
  SESSION_COOKIE,
  ACTING_TENANT_COOKIE,
  createSessionToken,
  verifySessionToken,
  sessionCookieOptions,
  buildSessionPayload,
  authFromPayload,
};

type RequestWithCookies = Request & {
  cookies: { get: (name: string) => { value: string } | undefined };
};

export function readSessionCookieFromRequest(request: Request): string | null {
  const cookieStore = (request as RequestWithCookies).cookies;
  return cookieStore.get(SESSION_COOKIE)?.value || null;
}

export function readActingTenantFromRequest(request: Request): string {
  const cookieStore = (request as RequestWithCookies).cookies;
  return cookieStore.get(ACTING_TENANT_COOKIE)?.value?.trim() || '';
}

export async function readSessionCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value || null;
}
