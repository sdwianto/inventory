import type { NextResponse } from 'next/server';
import { err } from '@/lib/api/db';
import type { AuthContext } from '@/types/auth';

/** Session users with manage roles bypass scope checks; API keys must carry the scope. */
const MANAGE_BYPASS = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

export function requireApiScope(
  auth: AuthContext | null | undefined,
  scope: string,
): NextResponse | null {
  if (!auth) return err('Unauthorized', 401);
  if (!auth.isApiKey) {
    if (MANAGE_BYPASS.has(String(auth.role || ''))) return null;
    return err('Forbidden', 403);
  }
  const scopes = auth.scopes || [];
  if (scopes.includes(scope) || scopes.includes('*')) return null;
  return err(`API key memerlukan scope ${scope}`, 403);
}
