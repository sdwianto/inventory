/**
 * Verifikasi metrik akhir rencana "Kelola bahan enterprise grade" (bagian G). READ-ONLY.
 *
 *   npx tsx scripts/verify/kelola-bahan-metrics.ts                 # semua tenant
 *   npx tsx scripts/verify/kelola-bahan-metrics.ts sppg --json
 *
 * ENV: MONGO_URL, DB_NAME (default inventory_customer). Exit 1 bila ada metrik target yang belum terpenuhi.
 * Hanya memanggil find/aggregate/countDocuments dan detektor rekonsiliasi (tanpa saveReconReport).
 */
import { MongoClient, type Db } from 'mongodb';
import { buildRecipeConversionReview } from '../../lib/api/recipe-conversion-review';
import { isTenantFeatureEnabled } from '../../lib/api/feature-flags';
import { PRODUCT_KODE_UNIQUE_FILTER } from '../../lib/api/product-merge';
import { MATERIAL_ISSUES_COLLECTION } from '../../lib/food-production/material-issue';
import { unlinkedReleaseFilter } from '../../lib/food-production/rl-unlinked';
import { INVENTORY_RELEASES_COLLECTION } from '../../lib/food-production/material-issue-reconcile';
import { listReconTenantIds, resolveCostingCutoverAt } from '../../lib/recon/context';
import { detectStockRecon } from '../../lib/recon/stock-recon';
import { detectGrniRecon } from '../../lib/recon/grni-recon';
import { buildReconReport } from '../../lib/recon/reports';

type Metric = {
  key: string;
  label: string;
  value: number | null;
  target: number | null;
  ok: boolean | null;
  note?: string;
};

const DEFAULT_EXPIRY_FILTER = {
  $or: [{ expirySource: 'DEFAULT' }, { expirySource: { $exists: false } }, { expirySource: null }],
};

function metric(key: string, label: string, value: number | null, target: number | null, note?: string): Metric {
  const ok = value === null || target === null ? null : value <= target;
  return { key, label, value, target, ok, note };
}

async function firstCreatedAt(db: Db, coll: string, filter: Record<string, unknown>): Promise<Date | null> {
  const doc = await db.collection(coll).findOne(filter, { sort: { createdAt: 1 }, projection: { createdAt: 1 } });
  return doc?.createdAt ? new Date(doc.createdAt as Date) : null;
}

async function tenantMetrics(db: Db, tenantId: string): Promise<{ tenantId: string; flags: Record<string, boolean>; metrics: Metric[] }> {
  const flagNames = ['pblReferenceMode', 'rlFromPoReference', 'strictRecipeConversion', 'lotQcRequired',
    'planStockReservation', 'costingV2', 'adjustmentApproval'] as const;
  const flags: Record<string, boolean> = {};
  for (const f of flagNames) flags[f] = await isTenantFeatureEnabled(db, tenantId, f);
  const now = new Date();
  const metrics: Metric[] = [];

  // 1. Kartu keluar baru tanpa harga (sesudah cutover costingV2).
  const cutover = await resolveCostingCutoverAt(db, tenantId);
  const zeroOutFilter = {
    tenantId,
    keluar: { $gt: 0 },
    $or: [{ hargaSatuan: { $exists: false } }, { hargaSatuan: null }, { hargaSatuan: { $lte: 0 } }],
    costSource: { $ne: 'NON_INVENTORY' },
  };
  const zeroOutAll = await db.collection('stok_kartu').countDocuments(zeroOutFilter);
  const zeroOutNew = cutover
    ? await db.collection('stok_kartu').countDocuments({ ...zeroOutFilter, tanggal: { $gte: cutover } })
    : null;
  metrics.push(metric('zeroCostOutNew', 'Kartu keluar baru dengan harga 0', zeroOutNew, 0,
    cutover ? `sejak cutover ${cutover.toISOString()}; seluruh riwayat ${zeroOutAll}` : `costingV2 belum cutover; seluruh riwayat ${zeroOutAll}`));

  // 2. Lot baru berkedaluwarsa default (sesudah GRN mulai mengisi kedaluwarsa).
  const lotStart = await firstCreatedAt(db, 'ingredient_lots', { tenantId, expirySource: { $in: ['INPUT', 'MASTER_SHELF'] } });
  const lotDefaultAll = await db.collection('ingredient_lots').countDocuments({ tenantId, ...DEFAULT_EXPIRY_FILTER });
  const lotDefaultNew = lotStart
    ? await db.collection('ingredient_lots').countDocuments({ tenantId, ...DEFAULT_EXPIRY_FILTER, createdAt: { $gte: lotStart } })
    : null;
  metrics.push(metric('defaultExpiryLotsNew', 'Lot baru dengan kedaluwarsa default', lotDefaultNew, 0,
    lotStart ? `sejak lot bertanggal isian pertama ${lotStart.toISOString()}; seluruh riwayat ${lotDefaultAll}` : `belum ada lot dengan kedaluwarsa isian; seluruh riwayat ${lotDefaultAll}`));

  // 3. Baris resep dengan faktor fallback / konversi belum valid.
  const review = await buildRecipeConversionReview(db, tenantId);
  metrics.push(metric('recipeFallbackLines', 'Baris resep dengan faktor fallback', review.summary.fallbackLines, 0));
  metrics.push(metric('recipeInvalidLines', 'Baris resep konversi INVALID/STALE',
    review.summary.invalidLines + review.summary.staleLines, 0,
    `INVALID ${review.summary.invalidLines}, STALE ${review.summary.staleLines} dari ${review.summary.lines} baris`));

  // 4. Kode produk ganda aktif.
  const dup = await db.collection('products').aggregate([
    { $match: { tenantId, ...PRODUCT_KODE_UNIQUE_FILTER } },
    { $group: { _id: '$kode', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: 'n' },
  ]).toArray();
  metrics.push(metric('duplicateKode', 'Kode produk ganda aktif', Number(dup[0]?.n || 0), 0));

  // 5. Buku stok: master vs gudang, gudang vs kartu, float dust, negatif, lot/bin > gudang.
  const s = buildReconReport({ tenantId, job: 'stock', startedAt: Date.now(), result: await detectStockRecon(db, tenantId, { now }) }).summary;
  metrics.push(metric('masterVsGudang', 'Selisih master vs gudang', s.STOCK_MASTER_VS_LOKASI ?? 0, 0));
  metrics.push(metric('gudangVsKartu', 'Selisih gudang vs kartu', s.STOCK_HOME_VS_LEDGER ?? 0, 0));
  metrics.push(metric('floatDust', 'Float dust stok', s.STOCK_FLOAT_DUST ?? 0, 0));
  metrics.push(metric('ledgerNegative', 'Saldo kartu negatif', s.STOCK_LEDGER_NEGATIVE ?? 0, 0));
  metrics.push(metric('lotGtGudang', 'Lot melebihi stok gudang', s.STOCK_LOT_GT_LOKASI ?? 0, 0));
  metrics.push(metric('binGtGudang', 'Bin melebihi stok gudang', s.STOCK_BIN_GT_LOKASI ?? 0, 0));

  // 6. PBL baru yang memutasi stok (sesudah PBL acuan pertama) dan RL produksi tanpa tautan.
  const pblRefStart = await firstCreatedAt(db, MATERIAL_ISSUES_COLLECTION, { tenantId, stockMode: 'REFERENCE' });
  const pblMutatingNew = pblRefStart
    ? await db.collection(MATERIAL_ISSUES_COLLECTION).countDocuments({
      tenantId,
      createdAt: { $gte: pblRefStart },
      stockMode: { $ne: 'REFERENCE' },
      stockPostedAt: { $exists: true, $ne: null },
    })
    : null;
  metrics.push(metric('pblMutatingNew', 'PBL baru yang memutasi stok', pblMutatingNew, 0,
    pblRefStart ? `sejak PBL acuan pertama ${pblRefStart.toISOString()}` : 'belum ada PBL mode acuan'));
  const rlUnlinked = await db.collection(INVENTORY_RELEASES_COLLECTION).countDocuments({ tenantId, ...unlinkedReleaseFilter() });
  metrics.push(metric('rlUnlinked', 'RL produksi tanpa tautan rencana', rlUnlinked, 0));

  // 7. Penyesuaian POSTED tanpa penyetuju independen (sejak alur persetujuan dipakai).
  const approvalStart = await firstCreatedAt(db, 'penyesuaian_stok', { tenantId, 'approvedBy.userId': { $exists: true } });
  let adjNoApproval: number | null = null;
  if (approvalStart) {
    const docs = await db.collection('penyesuaian_stok')
      .find({ tenantId, status: 'POSTED', createdAt: { $gte: approvalStart } })
      .project({ createdBy: 1, updatedBy: 1, submittedBy: 1, editorIds: 1, approvedBy: 1, selfApprovedByMaster: 1 })
      .toArray();
    adjNoApproval = docs.filter((d) => {
      const approver = String(d.approvedBy?.userId || '').trim();
      if (!approver) return true;
      if (d.selfApprovedByMaster) return true;
      const makers = [d.createdBy, d.updatedBy, d.submittedBy].map((u) => String(u?.userId || '').trim());
      const editors = Array.isArray(d.editorIds) ? d.editorIds.map(String) : [];
      return makers.includes(approver) || editors.includes(approver);
    }).length;
  }
  metrics.push(metric('adjustmentNoApproval', 'Penyesuaian tanpa penyetuju berbeda', adjNoApproval, 0,
    approvalStart ? `sejak persetujuan pertama ${approvalStart.toISOString()}` : 'alur persetujuan belum pernah dipakai'));

  // 8. GL persediaan vs nilai stok (hanya bermakna sesudah cutover costingV2).
  if (cutover) {
    const grni = await detectGrniRecon(db, tenantId, { now });
    const g = buildReconReport({ tenantId, job: 'grni', startedAt: Date.now(), result: grni }).summary;
    const gl = grni.findings.find((f) => f.kind === 'GL_INVENTORY_VS_VALUATION');
    metrics.push(metric('glVsValuation', 'GL persediaan ≠ nilai stok', gl ? 1 : 0, 0, gl?.detail));
    metrics.push(metric('grniResidual', 'Sisa GRNI per tagihan', g.GRNI_BILL_RESIDUAL ?? 0, 0));
    metrics.push(metric('consumptionUnjournaled', 'Pemakaian tanpa jurnal', g.GL_CONSUMPTION_UNJOURNALED ?? 0, 0));
  } else {
    metrics.push(metric('glVsValuation', 'GL persediaan ≠ nilai stok', null, 0, 'costingV2 belum cutover'));
  }

  return { tenantId, flags, metrics };
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const tenantArg = argv.find((a) => !a.startsWith('--'));
  const url = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?directConnection=true';
  const dbName = process.env.DB_NAME || 'inventory_customer';
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000, readPreference: 'secondaryPreferred' });
  await client.connect();
  let failed = 0;
  try {
    const db = client.db(dbName);
    const tenants = tenantArg ? [tenantArg] : await listReconTenantIds(db);
    const results = [];
    for (const t of tenants) results.push(await tenantMetrics(db, t));
    failed = results.reduce((n, r) => n + r.metrics.filter((m) => m.ok === false).length, 0);
    if (json) {
      console.log(JSON.stringify({ dbName, generatedAt: new Date().toISOString(), failed, results }, null, 2));
    } else {
      for (const r of results) {
        const on = Object.entries(r.flags).filter(([, v]) => v).map(([k]) => k).join(', ') || '-';
        console.log(`\n== ${r.tenantId} (flag aktif: ${on})`);
        for (const m of r.metrics) {
          const mark = m.ok === null ? ' n/a' : m.ok ? '  OK' : 'GAGAL';
          console.log(`${mark.padStart(5)}  ${m.label}: ${m.value ?? '-'}${m.note ? `  (${m.note})` : ''}`);
        }
      }
      console.log(`\n${dbName}: ${failed} metrik belum terpenuhi`);
    }
  } finally {
    await client.close();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
