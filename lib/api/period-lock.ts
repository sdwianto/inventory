// Enforce accounting period lock from tenant_settings.periodLockedUntil.

import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { err } from '@/lib/api/db';
import { tenantIdForWrite } from '@/lib/api/tenant-master';
import type { AuthContext } from '@/types/auth';

/**
 * Block postings on or before the locked period end date.
 */
export async function assertPeriodNotLocked(
  db: Db,
  auth: AuthContext | null,
  body: Record<string, unknown> = {},
  tanggal: string | Date | null = null,
): Promise<NextResponse | null> {
  const tenantId = tenantIdForWrite(auth, body);
  const settings = await db.collection('tenant_settings').findOne({ tenantId });
  if (!settings?.periodLockedUntil) return null;

  const lockUntil = new Date(String(settings.periodLockedUntil));
  const txDate = tanggal
    ? new Date(tanggal)
    : body?.tanggal
      ? new Date(String(body.tanggal))
      : new Date();

  if (Number.isNaN(txDate.getTime())) return null;
  if (txDate.getTime() <= lockUntil.getTime()) {
    const label = lockUntil.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    return err(
      `Periode akuntansi terkunci sampai ${label}. Tidak dapat memposting pada tanggal tersebut.`,
      423,
    );
  }
  return null;
}

/** Call at the start of POST handlers that create operational/accounting entries. */
export async function guardPosting(
  db: Db,
  auth: AuthContext | null,
  body: Record<string, unknown> = {},
  tanggal: string | Date | null = null,
): Promise<NextResponse | null> {
  return assertPeriodNotLocked(db, auth, body, tanggal);
}
