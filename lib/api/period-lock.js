// Enforce accounting period lock from tenant_settings.periodLockedUntil.

import { err } from '@/lib/api/db';
import { tenantIdForWrite } from '@/lib/api/tenant-master';

/**
 * Block postings on or before the locked period end date.
 * @returns {import('next/server').NextResponse | null}
 */
export async function assertPeriodNotLocked(db, auth, body = {}, tanggal = null) {
  const tenantId = tenantIdForWrite(auth, body);
  const settings = await db.collection('tenant_settings').findOne({ tenantId });
  if (!settings?.periodLockedUntil) return null;

  const lockUntil = new Date(settings.periodLockedUntil);
  const txDate = tanggal
    ? new Date(tanggal)
    : body?.tanggal
      ? new Date(body.tanggal)
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
export async function guardPosting(db, auth, body = {}, tanggal = null) {
  return assertPeriodNotLocked(db, auth, body, tanggal);
}
