// Resolve authenticated user from HttpOnly session cookie.

import {
  authFromPayload,
  readSessionCookieFromRequest,
  verifySessionToken,
} from '@/lib/api/session';

/**
 * @param {Request} request
 * @returns {Promise<import('@/lib/api/session').AuthContext | null>}
 */
export async function resolveRequestContext(request) {
  const token = readSessionCookieFromRequest(request);
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload) return null;
  return authFromPayload(payload);
}

/** @typedef {{ userId: string, email: string, name: string, role: string, tenantId: string, tenantName: string, isMaster: boolean }} AuthContext */
