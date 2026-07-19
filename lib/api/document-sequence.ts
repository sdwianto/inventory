// Nomor dokumen berurutan per tenant (SO, DO, INV, dll.).

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';

export async function nextDocNumber(
  db: Db,
  tenantId: string | null | undefined,
  docType: string,
  prefix: string,
  session?: ClientSession,
): Promise<string> {
  const tid = tenantId || 'default';
  const result = await db.collection('document_sequences').findOneAndUpdate(
    { tenantId: tid, docType },
    {
      $inc: { lastNumber: 1 },
      $setOnInsert: { prefix, createdAt: new Date() },
      $set: { updatedAt: new Date() },
    },
    { upsert: true, returnDocument: 'after', ...txOpts(session) },
  );
  const n = Number(result?.lastNumber || 1);
  const p = String(result?.prefix || prefix);
  const yy = String(new Date().getFullYear()).slice(-2);
  const mm = String(new Date().getMonth() + 1).padStart(2, '0');
  return `${p}${yy}${mm}${String(n).padStart(6, '0')}`;
}

/** Sequential code without date: e.g. RSP-0001 */
export async function nextSequentialCode(
  db: Db,
  tenantId: string | null | undefined,
  docType: string,
  prefix: string,
  pad = 4,
): Promise<string> {
  const tid = tenantId || 'default';
  const result = await db.collection('document_sequences').findOneAndUpdate(
    { tenantId: tid, docType },
    {
      $inc: { lastNumber: 1 },
      $setOnInsert: { prefix, createdAt: new Date() },
      $set: { updatedAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const n = Number(result?.lastNumber || 1);
  const p = String(result?.prefix || prefix);
  return `${p}${String(n).padStart(pad, '0')}`;
}
