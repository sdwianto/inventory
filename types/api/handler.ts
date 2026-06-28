import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import type { AuthContext } from '@/types/auth';

export interface HandlerContext {
  request: Request;
  db: Db;
  route: string;
  method: string;
  url: URL;
  path: string[];
  body: unknown;
  auth: AuthContext | null;
}

export type ApiHandler = (ctx: HandlerContext) => Promise<NextResponse | null | undefined>;

/** Normalize handler `body` for scope helpers and typed field access. */
export function parseHandlerBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

export interface OperationalScopeResult {
  denied: NextResponse | null;
  scopeAuth: AuthContext | null;
  tenantId: string | null;
}
