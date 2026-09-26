// Perbaikan lot bahan yang tertinggal di gudang lama (pindah gudang versi lama memindahkan saldo tanpa lot).
// Urutan meniru kejadian seharusnya: lot ikut pindah ke gudang home lalu terpakai FEFO, jadi kelebihan
// dihabiskan FEFO dulu di gudang asal dan sisanya (≤ kekurangan lot di home) dipindah ke home.

import type { ClientSession, Db } from 'mongodb';
import { INGREDIENT_LOTS_COLLECTION, effectiveIngredientQtyRemaining } from '@/lib/food-production/ingredient-lot';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { STOK_LOKASI } from '@/lib/stock-ledger/balance';
import { consumeIngredientLotsFefo } from '@/lib/stock-ledger/lot-consume';
import { relocateLotsFefo } from '@/lib/stock-ledger/lot-relocate';
import { STOCK_QTY_EPS, roundStockQty } from '@/lib/stock-ledger/precision';

export type LotRealignLine = {
  warehouseKode: string;
  lotQty: number;
  stokQty: number;
  excess: number;
  /** Dihabiskan FEFO di gudang ini (barangnya sudah terpakai). */
  consume: number;
  /** Dipindah ke gudang home (barangnya ada di home, lotnya belum). */
  relocate: number;
};

export type LotRealignPlan = {
  productId: string;
  kode: string;
  nama: string;
  homeGudang: string;
  lines: LotRealignLine[];
};

type LotAgg = { productId: string; warehouseKode: string; qty: number };

function sumByKey(rows: Array<{ key: string; qty: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.key, roundStockQty((m.get(r.key) || 0) + r.qty));
  return m;
}

/** Rencana per produk: gudang dengan Σ sisa lot > saldo gudang. Tanpa tulis. */
export async function planLotRealign(db: Db, tenantId: string, session?: ClientSession): Promise<LotRealignPlan[]> {
  const opts = session ? { session } : {};
  const lots = await db.collection(INGREDIENT_LOTS_COLLECTION).find(
    { tenantId, status: { $in: ['ACTIVE', 'EXPIRED'] } },
    { ...opts, projection: { _id: 0, productId: 1, warehouseKode: 1, qty: 1, qtyRemaining: 1, status: 1 } },
  ).toArray();
  const lotSum = new Map<string, LotAgg>();
  for (const l of lots) {
    const p = String(l.productId || '').trim();
    const w = String(l.warehouseKode || '').trim();
    const rem = effectiveIngredientQtyRemaining(l as never);
    if (!p || !w || !(rem > 0)) continue;
    const key = `${p}|${w}`;
    const cur = lotSum.get(key) || { productId: p, warehouseKode: w, qty: 0 };
    cur.qty = roundStockQty(cur.qty + rem);
    lotSum.set(key, cur);
  }
  if (!lotSum.size) return [];

  const productIds = [...new Set([...lotSum.values()].map((a) => a.productId))];
  const [lokasiRows, products] = await Promise.all([
    db.collection(STOK_LOKASI).find(
      { tenantId, stokId: { $in: productIds } },
      { ...opts, projection: { _id: 0, stokId: 1, lokasiKode: 1, qty: 1 } },
    ).toArray(),
    db.collection('products').find(
      { tenantId, id: { $in: productIds } },
      { ...opts, projection: { _id: 0, id: 1, kode: 1, nama: 1, gudangKode: 1 } },
    ).toArray(),
  ]);
  const stok = sumByKey(lokasiRows.map((r) => ({ key: `${r.stokId}|${r.lokasiKode}`, qty: roundStockQty(r.qty) })));
  const productById = new Map(products.map((p) => [String(p.id), p]));

  const plans: LotRealignPlan[] = [];
  for (const productId of productIds) {
    const product = productById.get(productId);
    const home = resolveProductGudangKode(product as { gudangKode?: string } | undefined);
    const whs = [...lotSum.values()].filter((a) => a.productId === productId);
    const qtyAt = (w: string) => Math.max(0, stok.get(`${productId}|${w}`) || 0);
    const lotAt = (w: string) => lotSum.get(`${productId}|${w}`)?.qty || 0;
    let homeGap = Math.max(0, roundStockQty(qtyAt(home) - lotAt(home)));
    const lines: LotRealignLine[] = [];
    for (const a of whs) {
      const w = a.warehouseKode;
      const excess = roundStockQty(a.qty - qtyAt(w));
      if (!(excess > STOCK_QTY_EPS)) continue;
      const relocate = w === home ? 0 : roundStockQty(Math.min(excess, homeGap));
      homeGap = roundStockQty(homeGap - relocate);
      lines.push({
        warehouseKode: w,
        lotQty: a.qty,
        stokQty: qtyAt(w),
        excess,
        consume: roundStockQty(excess - relocate),
        relocate,
      });
    }
    if (lines.length) {
      plans.push({
        productId,
        kode: String(product?.kode || ''),
        nama: String(product?.nama || ''),
        homeGudang: home,
        lines,
      });
    }
  }
  return plans.sort((x, y) => x.kode.localeCompare(y.kode));
}

export type LotRealignApplied = {
  consumed: number;
  consumeShortfall: number;
  relocated: number;
  relocateShortfall: number;
};

/** Jalankan satu rencana produk di sesi pemanggil (konsumsi FEFO dulu, lalu pindah sisanya ke home). */
export async function applyLotRealign(
  db: Db,
  session: ClientSession | undefined,
  tenantId: string,
  plan: LotRealignPlan,
  opts: { now: Date; noDokumen: string },
): Promise<LotRealignApplied> {
  const out: LotRealignApplied = { consumed: 0, consumeShortfall: 0, relocated: 0, relocateShortfall: 0 };
  for (const line of plan.lines) {
    if (line.consume > STOCK_QTY_EPS) {
      const r = await consumeIngredientLotsFefo(db, {
        tenantId,
        stokId: plan.productId,
        warehouseKode: line.warehouseKode,
        needQty: line.consume,
        asOf: opts.now,
        allowExpired: true,
        noDokumen: opts.noDokumen,
        qcHeld: 'LAST',
      }, session);
      out.consumed = roundStockQty(out.consumed + r.allocated);
      out.consumeShortfall = roundStockQty(out.consumeShortfall + r.shortfall);
    }
    if (line.relocate > STOCK_QTY_EPS) {
      const r = await relocateLotsFefo(db, {
        tenantId,
        stokId: plan.productId,
        fromWarehouseKode: line.warehouseKode,
        toWarehouseKode: plan.homeGudang,
        needQty: line.relocate,
        asOf: opts.now,
        allowExpired: true,
        noTransaksi: opts.noDokumen,
      }, session);
      out.relocated = roundStockQty(out.relocated + r.allocated);
      out.relocateShortfall = roundStockQty(out.relocateShortfall + r.shortfall);
    }
  }
  return out;
}
