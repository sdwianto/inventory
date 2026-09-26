/**
 * stock-recon: gudang (stok_lokasi) vs kartu vs master vs lot vs bin, float dust, keluar tanpa harga.
 */

import type { Db } from 'mongodb';
import { auditTenantStockDrift } from '@/lib/api/stock-ledger';
import { detectStokBinVsLokasi } from '@/lib/api/stok-bin-reconcile';
import { INGREDIENT_LOTS_COLLECTION, effectiveIngredientQtyRemaining } from '@/lib/food-production/ingredient-lot';
import { isMemoCostItem } from '@/lib/stock-ledger/cost';
import { roundStockQty, STOCK_QTY_DP, STOCK_QTY_EPS } from '@/lib/stock-ledger/precision';
import { resolveCostingCutoverAt } from '@/lib/recon/context';
import type { ReconDetectResult, ReconFinding, ReconKind } from '@/lib/recon/types';

const DRIFT_KIND: Record<string, ReconKind> = {
  home_vs_ledger: 'STOCK_HOME_VS_LEDGER',
  master_vs_lokasi: 'STOCK_MASTER_VS_LOKASI',
  phantom_wh: 'STOCK_PHANTOM_WAREHOUSE',
  ledger_negative: 'STOCK_LEDGER_NEGATIVE',
};

const DUST_SAMPLE = 200;
export const FLOAT_DUST_WINDOW_DAYS = 7;

/** Nilai numerik yang tidak sama dengan pembulatan 4 desimal buku stok. */
function notRoundedExpr(field: string) {
  return {
    $and: [
      { $isNumber: `$${field}` },
      { $ne: [`$${field}`, { $round: [`$${field}`, STOCK_QTY_DP] }] },
    ],
  };
}

function isDust(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && roundStockQty(n) !== n;
}

async function detectLotVsLokasi(db: Db, tenantId: string): Promise<ReconFinding[]> {
  const lots = await db.collection(INGREDIENT_LOTS_COLLECTION)
    .find({ tenantId, status: { $in: ['ACTIVE', 'EXPIRED'] } })
    .project({ productId: 1, warehouseKode: 1, qty: 1, qtyRemaining: 1, status: 1 })
    .toArray();
  const sums = new Map<string, { productId: string; lokasiKode: string; sum: number }>();
  for (const lot of lots) {
    const productId = String(lot.productId || '').trim();
    const lokasiKode = String(lot.warehouseKode || '').trim();
    if (!productId || !lokasiKode) continue;
    const rem = effectiveIngredientQtyRemaining(lot as Parameters<typeof effectiveIngredientQtyRemaining>[0]);
    if (!(rem > 0)) continue;
    const key = `${productId}|${lokasiKode}`;
    const cur = sums.get(key) || { productId, lokasiKode, sum: 0 };
    cur.sum = roundStockQty(cur.sum + rem);
    sums.set(key, cur);
  }
  if (!sums.size) return [];
  const productIds = [...new Set([...sums.values()].map((s) => s.productId))];
  const lokasi = await db.collection('stok_lokasi')
    .find({ tenantId, stokId: { $in: productIds } })
    .project({ stokId: 1, lokasiKode: 1, qty: 1 })
    .toArray();
  const qtyByKey = new Map(lokasi.map((r) => [`${r.stokId}|${r.lokasiKode}`, roundStockQty(r.qty)]));
  const out: ReconFinding[] = [];
  for (const [key, s] of sums) {
    const stock = qtyByKey.get(key) || 0;
    if (s.sum <= stock + STOCK_QTY_EPS) continue;
    out.push({
      kind: 'STOCK_LOT_GT_LOKASI',
      refType: 'PRODUCT',
      refId: s.productId,
      productId: s.productId,
      lokasiKode: s.lokasiKode,
      expected: stock,
      actual: s.sum,
      delta: roundStockQty(s.sum - stock),
      detail: `Σ sisa lot ${s.sum} > stok gudang ${stock} di ${s.lokasiKode}`,
    });
  }
  return out;
}

async function detectFloatDust(
  db: Db,
  tenantId: string,
  since: Date,
): Promise<{ findings: ReconFinding[]; count: number }> {
  const lokasiFilter = { tenantId, $expr: notRoundedExpr('qty') };
  const productFilter = { tenantId, $expr: notRoundedExpr('stok') };
  const kartuFilter = {
    tenantId,
    tanggal: { $gte: since },
    $expr: { $or: [notRoundedExpr('masuk'), notRoundedExpr('keluar')] },
  };
  const [lokasiRows, productRows, kartuRows, lokasiCount, productCount, kartuCount] = await Promise.all([
    db.collection('stok_lokasi').find(lokasiFilter).project({ stokId: 1, lokasiKode: 1, qty: 1 }).limit(DUST_SAMPLE).toArray(),
    db.collection('products').find(productFilter).project({ id: 1, kode: 1, nama: 1, stok: 1 }).limit(DUST_SAMPLE).toArray(),
    db.collection('stok_kartu').find(kartuFilter)
      .project({ id: 1, stokId: 1, lokasiKode: 1, noTransaksi: 1, masuk: 1, keluar: 1 })
      .limit(DUST_SAMPLE).toArray(),
    db.collection('stok_lokasi').countDocuments(lokasiFilter),
    db.collection('products').countDocuments(productFilter),
    db.collection('stok_kartu').countDocuments(kartuFilter),
  ]);
  const findings: ReconFinding[] = [];
  for (const r of lokasiRows) {
    if (!isDust(r.qty)) continue;
    findings.push({
      kind: 'STOCK_FLOAT_DUST',
      refType: 'PRODUCT',
      refId: String(r.stokId || ''),
      productId: String(r.stokId || ''),
      lokasiKode: String(r.lokasiKode || ''),
      actual: Number(r.qty),
      expected: roundStockQty(r.qty),
      detail: `stok_lokasi ${r.lokasiKode} qty ${r.qty} belum dibulatkan ${STOCK_QTY_DP} desimal`,
    });
  }
  for (const p of productRows) {
    if (!isDust(p.stok)) continue;
    findings.push({
      kind: 'STOCK_FLOAT_DUST',
      refType: 'PRODUCT',
      refId: String(p.id || ''),
      productId: String(p.id || ''),
      kode: p.kode ? String(p.kode) : undefined,
      nama: p.nama ? String(p.nama) : undefined,
      actual: Number(p.stok),
      expected: roundStockQty(p.stok),
      detail: `stok master ${p.stok} belum dibulatkan ${STOCK_QTY_DP} desimal`,
    });
  }
  for (const k of kartuRows) {
    const field = isDust(k.masuk) ? 'masuk' : isDust(k.keluar) ? 'keluar' : null;
    if (!field) continue;
    findings.push({
      kind: 'STOCK_FLOAT_DUST',
      refType: 'PRODUCT',
      refId: String(k.stokId || ''),
      refNo: k.noTransaksi ? String(k.noTransaksi) : undefined,
      productId: String(k.stokId || ''),
      lokasiKode: k.lokasiKode ? String(k.lokasiKode) : undefined,
      actual: Number(k[field]),
      expected: roundStockQty(k[field]),
      detail: `kartu ${k.noTransaksi || k.id} ${field} ${k[field]} belum dibulatkan ${STOCK_QTY_DP} desimal`,
    });
  }
  return { findings, count: lokasiCount + productCount + kartuCount };
}

/** Kartu keluar tanpa harga sesudah cutover costingV2: nilai pemakaian tidak terjurnal. */
async function detectZeroCostOut(db: Db, tenantId: string, cutoverAt: Date): Promise<ReconFinding[]> {
  const rows = await db.collection('stok_kartu').aggregate<{
    _id: string;
    n: number;
    qty: number;
    docs: string[];
  }>([
    {
      $match: {
        tenantId,
        keluar: { $gt: 0 },
        tanggal: { $gte: cutoverAt },
        costSource: { $ne: 'NON_INVENTORY' },
        $or: [{ hargaSatuan: { $lte: 0 } }, { hargaSatuan: null }, { hargaSatuan: { $exists: false } }],
      },
    },
    {
      $group: {
        _id: '$stokId',
        n: { $sum: 1 },
        qty: { $sum: '$keluar' },
        docs: { $addToSet: '$noTransaksi' },
      },
    },
    { $sort: { n: -1 } },
    { $limit: 500 },
  ]).toArray();
  if (!rows.length) return [];
  const products = await db.collection('products')
    .find({ tenantId, id: { $in: rows.map((r) => String(r._id)) } })
    .project({ id: 1, kode: 1, nama: 1, itemRole: 1 })
    .toArray();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const out: ReconFinding[] = [];
  for (const r of rows) {
    const p = byId.get(String(r._id));
    if (p && isMemoCostItem({ itemRole: p.itemRole as string | undefined })) continue;
    const docs = (r.docs || []).filter(Boolean).slice(0, 5);
    out.push({
      kind: 'STOCK_ZERO_COST_OUT',
      refType: 'PRODUCT',
      refId: String(r._id),
      productId: String(r._id),
      kode: p?.kode ? String(p.kode) : undefined,
      nama: p?.nama ? String(p.nama) : undefined,
      actual: roundStockQty(r.qty),
      detail: `${r.n} baris keluar tanpa harga sejak cutover (${docs.join(', ') || '—'})`,
    });
  }
  return out;
}

export async function detectStockRecon(
  db: Db,
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<ReconDetectResult> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - FLOAT_DUST_WINDOW_DAYS * 86_400_000);
  const [drift, lot, bin, dust, cutoverAt] = await Promise.all([
    auditTenantStockDrift(db, tenantId),
    detectLotVsLokasi(db, tenantId),
    detectStokBinVsLokasi(db, tenantId, { limit: 200 }),
    detectFloatDust(db, tenantId, since),
    resolveCostingCutoverAt(db, tenantId),
  ]);

  const findings: ReconFinding[] = [];
  for (const d of drift.drifts) {
    for (const issue of d.issues) {
      const kind = DRIFT_KIND[issue.split(' ')[0]];
      if (!kind) continue;
      const base = { refType: 'PRODUCT' as const, refId: d.productId, productId: d.productId, kode: d.kode, nama: d.nama };
      if (kind === 'STOCK_HOME_VS_LEDGER') {
        findings.push({
          ...base, kind, lokasiKode: d.gudangKode, expected: Math.max(0, d.ledgerSaldo), actual: d.lokasiHome,
          delta: roundStockQty(d.lokasiHome - Math.max(0, d.ledgerSaldo)),
          detail: `Stok gudang ${d.gudangKode} ${d.lokasiHome} ≠ saldo kartu ${d.ledgerSaldo}`,
        });
      } else if (kind === 'STOCK_MASTER_VS_LOKASI') {
        findings.push({
          ...base, kind, expected: d.lokasiTotal, actual: d.masterStok,
          delta: roundStockQty(d.masterStok - d.lokasiTotal),
          detail: `Stok master ${d.masterStok} ≠ Σ stok gudang ${d.lokasiTotal}`,
        });
      } else if (kind === 'STOCK_PHANTOM_WAREHOUSE') {
        findings.push({
          ...base, kind, lokasiKode: d.phantomWarehouses.join(','),
          detail: `Ada stok di gudang selain ${d.gudangKode}: ${d.phantomWarehouses.join(', ')}`,
        });
      } else {
        findings.push({
          ...base, kind, actual: d.ledgerSaldo,
          detail: `Saldo kartu negatif ${d.ledgerSaldo}`,
        });
      }
    }
  }
  findings.push(...lot);
  for (const m of bin.mismatches) {
    if (m.kind !== 'BIN_SUM_GT_STOK_LOKASI') continue;
    findings.push({
      kind: 'STOCK_BIN_GT_LOKASI',
      refType: 'PRODUCT',
      refId: m.stokId,
      productId: m.stokId,
      lokasiKode: m.warehouseKode,
      expected: m.stokLokasiQty,
      actual: m.binQtySum,
      delta: m.delta,
      detail: `Σ bin ${m.binQtySum} > stok gudang ${m.stokLokasiQty} di ${m.warehouseKode}`,
    });
  }
  findings.push(...dust.findings);
  if (cutoverAt) findings.push(...(await detectZeroCostOut(db, tenantId, cutoverAt)));

  await fillProductLabels(db, tenantId, findings);
  return {
    findings,
    counts: {
      STOCK_BIN_GT_LOKASI: bin.summary.binSumGt,
      STOCK_FLOAT_DUST: dust.count,
    },
    meta: {
      productsScanned: drift.scanned,
      costingCutoverAt: cutoverAt ? cutoverAt.toISOString() : null,
      floatDustWindowDays: FLOAT_DUST_WINDOW_DAYS,
    },
  };
}

async function fillProductLabels(db: Db, tenantId: string, findings: ReconFinding[]) {
  const missing = [...new Set(findings.filter((f) => f.productId && !f.kode).map((f) => String(f.productId)))];
  if (!missing.length) return;
  const products = await db.collection('products')
    .find({ tenantId, id: { $in: missing } })
    .project({ id: 1, kode: 1, nama: 1 })
    .toArray();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  for (const f of findings) {
    if (!f.productId || f.kode) continue;
    const p = byId.get(f.productId);
    if (!p) continue;
    f.kode = p.kode ? String(p.kode) : undefined;
    f.nama = p.nama ? String(p.nama) : undefined;
  }
}
