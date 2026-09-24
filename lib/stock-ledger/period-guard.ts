// Kunci periode untuk posting stok, dicek dengan tanggal posting dari server di dalam sesi.

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';

export async function stockPeriodLockError(
  db: Db,
  tenantId: string,
  postingDate: Date,
  session?: ClientSession,
): Promise<string | null> {
  const settings = await db.collection('tenant_settings').findOne(
    { tenantId },
    { projection: { periodLockedUntil: 1 }, ...txOpts(session) },
  ) as { periodLockedUntil?: unknown } | null;
  if (!settings?.periodLockedUntil) return null;
  const lockUntil = new Date(String(settings.periodLockedUntil));
  if (Number.isNaN(lockUntil.getTime())) return null;
  if (postingDate.getTime() > lockUntil.getTime()) return null;
  const label = lockUntil.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  return `Periode akuntansi terkunci sampai ${label}. Tidak dapat memposting mutasi stok pada tanggal tersebut.`;
}
