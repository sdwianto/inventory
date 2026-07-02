/** Flag migrasi/bootstrap persisten — hindari scan penuh tiap cold start serverless. */

import type { Db } from 'mongodb';

export async function hasSystemFlag(db: Db, key: string): Promise<boolean> {
  const row = await db.collection('system_meta').findOne({ key });
  return !!row?.value;
}

export async function setSystemFlag(db: Db, key: string): Promise<void> {
  await db.collection('system_meta').updateOne(
    { key },
    { $set: { key, value: true, updatedAt: new Date() } },
    { upsert: true },
  );
}
