// Resolve authenticated user from HttpOnly session cookie atau API key.

import type { Db } from 'mongodb';
import type { AuthContext } from '@/types/auth';
import {
  authFromPayload,
  readSessionCookieFromRequest,
  verifySessionToken,
} from '@/lib/api/session';
import { resolveApiKeyAuth } from '@/lib/api/api-key';

export async function resolveRequestContext(
  request: Request,
  db?: Db,
): Promise<AuthContext | null> {
  const token = readSessionCookieFromRequest(request);
  if (token) {
    const payload = verifySessionToken(token);
    if (payload) return authFromPayload(payload);
  }
  if (db) {
    const apiAuth = await resolveApiKeyAuth(db, request);
    if (apiAuth) return apiAuth;
  }
  return null;
}
