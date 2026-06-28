// Centralized audit trail for stock & financial mutations.

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { txOpts } from '@/lib/api/transaction';
import { logger } from '@/lib/api/logger';
import type { AuthContext } from '@/types/auth';

export type AuditAction =
  | 'GRN_POSTED'
  | 'STOCK_ADJUSTMENT'
  | 'HUTANG_CREATED'
  | 'HUTANG_UPDATED'
  | 'STOCK_TRANSFER'
  | 'INVENTORY_RELEASE';

export interface AuditLogEntry {
  tenantId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  summary: string;
  metadata?: Record<string, unknown>;
  userId?: string;
  userName?: string;
}

export async function writeAuditLog(
  db: Db,
  entry: AuditLogEntry,
  session?: ClientSession,
): Promise<void> {
  const doc = {
    id: uuidv4(),
    ...entry,
    createdAt: new Date(),
  };
  try {
    await db.collection('audit_log').insertOne(doc, txOpts(session));
  } catch (e) {
    logger.warn('audit_log insert failed', {
      action: entry.action,
      entityId: entry.entityId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export function auditActor(auth?: AuthContext | null): Pick<AuditLogEntry, 'userId' | 'userName'> {
  return {
    userId: auth?.userId || 'system',
    userName: auth?.name || auth?.email || 'System',
  };
}
