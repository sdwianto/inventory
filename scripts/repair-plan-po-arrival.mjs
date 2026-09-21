#!/usr/bin/env node
/**
 * Rapikan tanggal kedatangan PO tertaut rencana produksi ke H-1 tanggal menu.
 *
 * Usage:
 *   node scripts/repair-plan-po-arrival.mjs              # dry-run
 *   node scripts/repair-plan-po-arrival.mjs --apply
 *   SALES_DB_NAME=dawam_erp node scripts/repair-plan-po-arrival.mjs --apply
 */
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

const APPLY = process.argv.includes('--apply');
const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
const invDbName = process.env.INVENTORY_DB_NAME || process.env.DB_NAME || 'inventory_customer';
const salesDbName = process.env.SALES_DB_NAME || 'dawam_erp';

if (!uri) {
  console.error('MONGO_URL / MONGODB_URI tidak ada');
  process.exit(1);
}

function cal(d) {
  if (d == null) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function shiftIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function utcNoon(iso) {
  return new Date(`${iso}T12:00:00.000Z`);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const inv = client.db(invDbName);
const sales = client.db(salesDbName);

const pos = await inv.collection('customer_purchase_orders').find({
  productionPlanId: { $exists: true, $nin: [null, ''] },
  status: { $nin: ['CANCELLED'] },
}).project({
  id: 1, noPO: 1, status: 1, tanggalKedatangan: 1, productionPlanId: 1, tenantId: 1,
}).toArray();

const planIds = [...new Set(pos.map((p) => String(p.productionPlanId || '')).filter(Boolean))];
const plans = await inv.collection('production_plans').find({ id: { $in: planIds } })
  .project({ id: 1, noDokumen: 1, tanggal: 1 }).toArray();
const planById = new Map(plans.map((p) => [String(p.id), p]));

const mismatches = [];
for (const po of pos) {
  const plan = planById.get(String(po.productionPlanId || ''));
  const planTgl = cal(plan?.tanggal);
  const expected = planTgl ? shiftIso(planTgl, -1) : '';
  const actual = cal(po.tanggalKedatangan);
  if (!expected || actual === expected) continue;
  mismatches.push({ po, plan, expected, actual });
}

console.log(`[plan-po-arrival] db=${invDbName} activePlanPOs=${pos.length} mismatch=${mismatches.length} apply=${APPLY}`);
for (const row of mismatches) {
  console.log(JSON.stringify({
    noPO: row.po.noPO,
    status: row.po.status,
    plan: row.plan?.noDokumen,
    planTanggal: cal(row.plan?.tanggal),
    actual: row.actual,
    expected: row.expected,
  }));
}

if (APPLY && mismatches.length) {
  const now = new Date();
  for (const row of mismatches) {
    const date = utcNoon(row.expected);
    await inv.collection('customer_purchase_orders').updateOne(
      { id: row.po.id },
      {
        $set: {
          tanggalKedatangan: date,
          arrivalAlignedAt: now,
          arrivalAlignedTo: row.expected,
          arrivalAlignedFrom: row.actual,
          updatedAt: now,
        },
      },
    );
    const soRes = await sales.collection('sales_orders').updateMany(
      { noPO: row.po.noPO, status: { $nin: ['CANCELLED', 'FULFILLED'] } },
      { $set: { tanggalPermintaanKirim: date, updatedAt: now } },
    );
    console.log(`updated ${row.po.noPO} → ${row.expected} (SO matched=${soRes.matchedCount} modified=${soRes.modifiedCount})`);
  }
}

await client.close();
