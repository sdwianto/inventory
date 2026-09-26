// Enforce accounting period lock from tenant_settings.periodLockedUntil.

import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { err } from '@/lib/api/db';
import { tenantIdForWrite } from '@/lib/api/tenant-master';
import type { AuthContext } from '@/types/auth';

function hasDateInput(value: unknown): boolean {
  if (value == null) return false;
  if (value instanceof Date) return true;
  return String(value).trim() !== '';
}

/**
 * Block postings when either the server date or the document date falls on or before the
 * locked period end. A document date that is present but unparseable is rejected.
 */
export async function assertPeriodNotLocked(
  db: Db,
  auth: AuthContext | null,
  body: Record<string, unknown> = {},
  tanggal: string | Date | null = null,
): Promise<NextResponse | null> {
  const docDateInput = hasDateInput(tanggal) ? tanggal : hasDateInput(body?.tanggal) ? body.tanggal : null;
  let docDate: Date | null = null;
  if (docDateInput != null) {
    docDate = docDateInput instanceof Date ? docDateInput : new Date(String(docDateInput));
    if (Number.isNaN(docDate.getTime())) return err('Tanggal dokumen tidak valid.', 400);
  }

  const tenantId = tenantIdForWrite(auth, body);
  const settings = await db.collection('tenant_settings').findOne({ tenantId });
  if (!settings?.periodLockedUntil) return null;

  const lockUntil = new Date(String(settings.periodLockedUntil));
  if (Number.isNaN(lockUntil.getTime())) return null;
  const serverDate = new Date();
  const lockedDate = [serverDate, docDate].find((d) => d != null && d.getTime() <= lockUntil.getTime());
  if (lockedDate) {
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
