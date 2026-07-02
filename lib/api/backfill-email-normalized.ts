/** Backfill emailNormalized untuk user legacy. */

import type { Db } from 'mongodb';
import { normalizeUserEmail } from '@/lib/api/user-email';

export async function backfillEmailNormalized(db: Db) {
  const users = await db.collection('users').find({
    $or: [{ emailNormalized: { $exists: false } }, { emailNormalized: '' }],
  }).project({ id: 1, email: 1 }).toArray();

  let updated = 0;
  for (const u of users) {
    const normalized = normalizeUserEmail(String(u.email || ''));
    if (!normalized) continue;
    await db.collection('users').updateOne(
      { id: u.id },
      { $set: { emailNormalized: normalized } },
    );
    updated += 1;
  }
  return { scanned: users.length, updated };
}
