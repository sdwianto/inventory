#!/usr/bin/env node
/**
 * Backfill approvalStatus pada hutang vendor lama.
 * Usage: node scripts/migrate-hutang-approval.mjs [tenantId]
 */
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.MONGODB_DB || 'inventory_customer';
const tenantId = process.argv[2] || null;

async function backfill(db, tid) {
  const filter = {
    referenceType: 'VENDOR_INVOICE',
    approvalStatus: { $exists: false },
    status: { $in: ['OUTSTANDING', 'PARTIAL', 'LUNAS'] },
  };
  if (tid) filter.tenantId = tid;

  const rows = await db.collection('hutang').find(filter).toArray();
  let updated = 0;
  for (const h of rows) {
    const now = h.createdAt || new Date();
    await db.collection('hutang').updateOne(
      { id: h.id },
      {
        $set: {
          approvalStatus: h.status === 'LUNAS' ? 'PAID_EXTERNAL' : 'APPROVED',
          approvedAt: h.approvedAt || now,
          approvedBy: h.approvedBy || { userId: '', userName: 'Migrasi sistem', role: 'SYSTEM' },
          updatedAt: new Date(),
        },
      },
    );
    updated += 1;
  }
  return { updated, scanned: rows.length };
}

const client = new MongoClient(uri);
await client.connect();
const result = await backfill(client.db(dbName), tenantId);
console.log(JSON.stringify(result, null, 2));
await client.close();
