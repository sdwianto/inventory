#!/usr/bin/env node
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';

function loadEnv() {
  try {
    const p = resolve(process.cwd(), '.env.local');
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* ignore */ }
}
loadEnv();

const noPO = process.argv[2] || 'CPO2607000007';
const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.DB_NAME || 'inventory_customer');
const po = await db.collection('customer_purchase_orders').findOne({ noPO });
console.log(JSON.stringify({
  noPO: po?.noPO,
  status: po?.status,
  vendorNoSO: po?.vendorNoSO,
  vendorSoId: po?.vendorSoId,
  vendorTenantId: po?.vendorTenantId,
  vendorSubmissions: po?.vendorSubmissions,
  vendorSyncError: po?.vendorSyncError,
  items: (po?.items || []).map((it) => ({ kode: it.kode, vendorTenantId: it.vendorTenantId })),
}, null, 2));
await client.close();
