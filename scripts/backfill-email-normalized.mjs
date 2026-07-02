#!/usr/bin/env node
/** npm run migrate:email-normalized — backfill emailNormalized di users. */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv() {
  try {
    for (const name of ['.env.local', '.env']) {
      const p = resolve(process.cwd(), name);
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m && !process.env[m[1].trim()]) {
          process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch { /* ignore */ }
}
loadEnv();

function normalizeUserEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/inventory';

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const users = await db.collection('users').find({
    $or: [{ emailNormalized: { $exists: false } }, { emailNormalized: '' }],
  }).project({ id: 1, email: 1 }).toArray();

  let updated = 0;
  for (const u of users) {
    const normalized = normalizeUserEmail(u.email);
    if (!normalized) continue;
    await db.collection('users').updateOne({ id: u.id }, { $set: { emailNormalized: normalized } });
    updated += 1;
  }
  console.log('emailNormalized backfill:', { scanned: users.length, updated });
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
