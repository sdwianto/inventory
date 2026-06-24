// Resolve authenticated user from HttpOnly session cookie atau API key.

import {
  authFromPayload,
  readSessionCookieFromRequest,
  verifySessionToken,
} from '@/lib/api/session';
import { resolveApiKeyAuth } from '@/lib/api/api-key';

/**
 * @param {Request} request
 * @param {import('mongodb').Db} [db]
 * @returns {Promise<import('@/lib/api/session').AuthContext | null>}
 */
export async function resolveRequestContext(request, db) {
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

/** @typedef {{ userId: string, email: string, name: string, role: string, tenantId: string, tenantName: string, isMaster: boolean }} AuthContext */
