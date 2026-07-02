#!/usr/bin/env node
/** Jalankan bootstrap sekali saat deploy — hindari migrasi berat di request path. */

import { MongoClient } from 'mongodb';
import { ensureSeeded, resetBootstrapForMigration } from '../lib/api/seed';

const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'inventory_customer';

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  if (process.argv.includes('--force')) {
    await resetBootstrapForMigration(db);
  }
  await ensureSeeded(db);
  console.log('[bootstrap] selesai');
  await client.close();
}

main().catch((e) => {
  console.error('[bootstrap] gagal:', e);
  process.exit(1);
});
