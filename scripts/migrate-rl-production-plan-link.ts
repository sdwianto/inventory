#!/usr/bin/env npx tsx
/**
 * One-off: tag inventory_releases yang overlap produk/tanggal dengan PBL/rencana produksi.
 *
 * Usage:
 *   npx tsx scripts/migrate-rl-production-plan-link.ts --pbl PBL2608000001 [--dry-run]
 *   npx tsx scripts/migrate-rl-production-plan-link.ts --plan-id <uuid> [--dry-run]
 *
 * Env: MONGO_URL / MONGODB_URI, DB_NAME (default inventory_customer)
 */

import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'inventory_customer';

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pblIdx = args.indexOf('--pbl');
  const planIdx = args.indexOf('--plan-id');
  const pblNo = pblIdx >= 0 ? String(args[pblIdx + 1] || '').trim() : '';
  const planIdArg = planIdx >= 0 ? String(args[planIdx + 1] || '').trim() : '';
  if (!pblNo && !planIdArg) {
    console.error('Wajib --pbl NO_DOKUMEN atau --plan-id UUID');
    process.exit(1);
  }
  return { dryRun, pblNo, planIdArg };
}

async function main() {
  const { dryRun, pblNo, planIdArg } = parseArgs();
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  let issue = pblNo
    ? await db.collection('material_issues').findOne({ noDokumen: pblNo })
    : null;
  if (!issue && planIdArg) {
    issue = await db.collection('material_issues').findOne({ productionPlanId: planIdArg });
  }
  if (!issue && pblNo) {
    console.error(`PBL ${pblNo} tidak ditemukan`);
    await client.close();
    process.exit(1);
  }
  if (!issue) {
    console.error('Issue/rencana tidak ditemukan');
    await client.close();
    process.exit(1);
  }

  const tenantId = String(issue.tenantId || 'default');
  const productionPlanId = String(issue.productionPlanId || planIdArg || '');
  const productionPlanNo = String(issue.productionPlanNo || '');
  if (!productionPlanId) {
    console.error('Issue tidak punya productionPlanId');
    await client.close();
    process.exit(1);
  }

  const plan = await db.collection('production_plans').findOne({ id: productionPlanId });
  const planTanggal = plan?.tanggal ? String(plan.tanggal).slice(0, 10) : null;
  const kitchenId = plan?.kitchenId ? String(plan.kitchenId) : null;

  const productIds = new Set(
    (issue.lines || []).map((l: { productId?: string }) => String(l.productId || '').trim()).filter(Boolean),
  );

  const releaseFilter: Record<string, unknown> = {
    tenantId,
    status: 'POSTED',
    $or: [
      { productionPlanId: { $exists: false } },
      { productionPlanId: null },
      { productionPlanId: '' },
    ],
  };
  if (planTanggal) {
    const start = new Date(`${planTanggal}T00:00:00.000Z`);
    const end = new Date(`${planTanggal}T23:59:59.999Z`);
    releaseFilter.tanggal = { $gte: start, $lte: end };
  }

  const candidates = await db.collection('inventory_releases')
    .find(releaseFilter)
    .project({ id: 1, noRelease: 1, tanggal: 1, items: 1, keperluan: 1 })
    .toArray();

  const toTag: Array<{ id: string; noRelease: string; overlap: number }> = [];
  for (const rl of candidates) {
    const items = (rl.items || []) as Array<{ stokId?: string; qtyBase?: number; qty?: number }>;
    let overlap = 0;
    for (const it of items) {
      const pid = String(it.stokId || '').trim();
      if (productIds.has(pid)) {
        overlap += Number(it.qtyBase ?? it.qty) || 0;
      }
    }
    if (overlap > 0) {
      toTag.push({ id: String(rl.id), noRelease: String(rl.noRelease || ''), overlap });
    }
  }

  console.log(`Plan: ${productionPlanNo || productionPlanId} · kitchen=${kitchenId || '—'} · tanggal=${planTanggal || '—'}`);
  console.log(`PBL: ${issue.noDokumen} · ${productIds.size} produk resep`);
  console.log(`Kandidat RL overlap: ${toTag.length}${dryRun ? ' (dry-run)' : ''}`);
  for (const row of toTag) {
    console.log(`  - ${row.noRelease} overlap qty≈${row.overlap}`);
  }

  if (!dryRun && toTag.length) {
    const ids = toTag.map((r) => r.id);
    const res = await db.collection('inventory_releases').updateMany(
      { id: { $in: ids } },
      {
        $set: {
          productionPlanId,
          productionPlanNo: productionPlanNo || undefined,
          migratedPlanLinkAt: new Date(),
          migratedPlanLinkFrom: 'migrate-rl-production-plan-link',
        },
      },
    );
    console.log(`Updated ${res.modifiedCount} release(s)`);
    console.log('Langkah berikut: buka PBL → Sinkron dari stok & release operasional → Keluarkan Stok');
  }

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
