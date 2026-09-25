// Penulis tunggal products.stok & products.stokDisplay — denormalisasi Σ stok_lokasi.
// Di luar lib/stock-ledger kedua field ini hanya dibaca (dijaga ESLint).

import type { ClientSession, Db } from 'mongodb';
import { productFilterById } from '@/lib/api/tenant-operational';
import { txOpts } from '@/lib/api/transaction';
import { formatStockDualLabel } from '@/lib/uom/display';
import { syntheticBaseUomFromProduct } from '@/lib/uom/synthetic-uom';
import { PRODUCT_UOM_COLLECTION, type ProductUom } from '@/lib/uom/types';
import { roundStockQty } from '@/lib/stock-ledger/precision';

const STOK_LOKASI = 'stok_lokasi';

type MasterProductFields = {
  satuan?: string;
  baseUomId?: string;
  barcode?: string;
};

/** Label stok tersimpan = label yang dihitung attachUomSummary saat baca. */
export function formatMasterStokDisplay(
  stok: number,
  tenantId: string,
  productId: string,
  product: MasterProductFields,
  uoms: ProductUom[],
): string {
  const list = uoms.length ? uoms : [syntheticBaseUomFromProduct(tenantId, productId, product)];
  return formatStockDualLabel(roundStockQty(stok), list);
}

/** Σ stok_lokasi produk (dibulatkan 4 dp), dibaca di sesi yang sama. */
export async function sumLokasiQty(
  db: Db,
  tenantId: string,
  stokId: string,
  session?: ClientSession,
): Promise<number> {
  const rows = await db.collection<{ qty?: number | string }>(STOK_LOKASI)
    .find({ tenantId, stokId }, txOpts(session))
    .project({ qty: 1 })
    .toArray();
  return roundStockQty(rows.reduce((s, r) => s + roundStockQty(r.qty), 0));
}

export async function computeMasterStokDisplay(
  db: Db,
  tenantId: string,
  stokId: string,
  stok: number,
  product: MasterProductFields,
  session?: ClientSession,
): Promise<string> {
  const uoms = await db.collection(PRODUCT_UOM_COLLECTION)
    .find({ tenantId, productId: stokId, aktif: { $ne: false } }, txOpts(session))
    .sort({ sortOrder: 1, satuan: 1 })
    .toArray() as unknown as ProductUom[];
  return formatMasterStokDisplay(stok, tenantId, stokId, product, uoms);
}

export type MasterStockWrite = {
  found: boolean;
  stok: number;
  stokDisplay: string;
  before?: { stok: number; stokDisplay: string };
};

const PLAN_CHUNK = 500;

function tenantProductFilter(tenantId: string, extra: Record<string, unknown>): Record<string, unknown> {
  const tid = tenantId || 'default';
  if (tid !== 'default') return { ...extra, tenantId: tid };
  return {
    ...extra,
    $or: [{ tenantId: 'default' }, { tenantId: { $exists: false } }, { tenantId: null }, { tenantId: '' }],
  };
}

export type MasterStockPlanRow = {
  productId: string;
  kode: string;
  nama: string;
  aktif: boolean;
  mergedInto: string | null;
  /** Nilai stok mentah di dokumen (untuk compare-and-set). */
  rawStok: unknown;
  before: { stok: number; stokDisplay: string };
  after: { stok: number; stokDisplay: string };
  /** Nilai tersimpan ≠ Σ lokasi persis (termasuk tipe/pembulatan); besar selisih = after.stok − before.stok. */
  stokChanged: boolean;
  displayChanged: boolean;
};

/**
 * Read-only: master tersimpan vs Σ stok_lokasi + label UOM. Tanpa `productIds` → seluruh produk
 * tenant (termasuk nonaktif & sumber vendor tergabung).
 */
export async function planProductsMasterStock(
  db: Db,
  tenantId: string,
  productIds?: string[],
  session?: ClientSession,
): Promise<MasterStockPlanRow[]> {
  const tid = tenantId || 'default';
  const filter = tenantProductFilter(tid, productIds ? { id: { $in: productIds } } : {});
  const products = await db.collection('products')
    .find(filter, txOpts(session))
    .project({ _id: 0, id: 1, kode: 1, nama: 1, aktif: 1, mergedInto: 1, satuan: 1, baseUomId: 1, barcode: 1, stok: 1, stokDisplay: 1 })
    .toArray() as Array<MasterProductFields & Record<string, unknown>>;

  const out: MasterStockPlanRow[] = [];
  for (let i = 0; i < products.length; i += PLAN_CHUNK) {
    const chunk = products.slice(i, i + PLAN_CHUNK);
    const ids = chunk.map((p) => String(p.id || '')).filter(Boolean);
    const [lokasiRows, uomRows] = await Promise.all([
      db.collection<{ stokId?: string; qty?: number | string }>(STOK_LOKASI)
        .find({ tenantId: tid, stokId: { $in: ids } }, txOpts(session))
        .project({ stokId: 1, qty: 1 })
        .toArray(),
      db.collection(PRODUCT_UOM_COLLECTION)
        .find({ tenantId: tid, productId: { $in: ids }, aktif: { $ne: false } }, txOpts(session))
        .sort({ sortOrder: 1, satuan: 1 })
        .toArray() as unknown as Promise<ProductUom[]>,
    ]);
    const sumById = new Map<string, number>();
    for (const r of lokasiRows) {
      const sid = String(r.stokId || '');
      sumById.set(sid, (sumById.get(sid) || 0) + roundStockQty(r.qty));
    }
    const uomsById = new Map<string, ProductUom[]>();
    for (const u of uomRows) {
      const list = uomsById.get(u.productId) || [];
      list.push(u);
      uomsById.set(u.productId, list);
    }
    for (const p of chunk) {
      const productId = String(p.id || '');
      if (!productId) continue;
      const stok = roundStockQty(sumById.get(productId) || 0);
      const stokDisplay = formatMasterStokDisplay(stok, tid, productId, p, uomsById.get(productId) || []);
      const beforeStok = roundStockQty(p.stok as number | string | undefined);
      const beforeDisplay = String(p.stokDisplay ?? '');
      out.push({
        productId,
        kode: String(p.kode || ''),
        nama: String(p.nama || ''),
        aktif: p.aktif !== false,
        mergedInto: p.mergedInto ? String(p.mergedInto) : null,
        rawStok: p.stok,
        before: { stok: beforeStok, stokDisplay: beforeDisplay },
        after: { stok, stokDisplay },
        stokChanged: p.stok !== stok,
        displayChanged: beforeDisplay !== stokDisplay,
      });
    }
  }
  return out;
}

/**
 * Samakan master (stok + label) produk tertentu setelah UOM berubah di luar posting.
 * Compare-and-set pada nilai stok yang dibaca: bila posting lain menulis lebih dulu, baris dilewati
 * (posting itu sudah menghitung ulang master dalam sesinya).
 */
export async function refreshProductsMasterStock(
  db: Db,
  tenantId: string,
  productIds: string[],
  session?: ClientSession,
): Promise<{ updated: number; skipped: number }> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return { updated: 0, skipped: 0 };
  const plan = await planProductsMasterStock(db, tenantId, ids, session);
  const ops = plan
    .filter((r) => r.stokChanged || r.displayChanged)
    .map((r) => ({
      updateOne: {
        filter: tenantProductFilter(tenantId, { id: r.productId, stok: r.rawStok ?? null }),
        update: { $set: { stok: r.after.stok, stokDisplay: r.after.stokDisplay, updatedAt: new Date() } },
      },
    }));
  if (!ops.length) return { updated: 0, skipped: 0 };
  const res = await db.collection('products').bulkWrite(ops, { ordered: false, ...txOpts(session) });
  return { updated: res.modifiedCount, skipped: ops.length - res.matchedCount };
}

/** Satu update atomik {stok, stokDisplay} dari Σ stok_lokasi; UOM & lokasi dibaca dalam sesi. */
export async function writeProductMasterStock(
  db: Db,
  tenantId: string,
  stokId: string,
  session?: ClientSession,
): Promise<MasterStockWrite> {
  const filter = productFilterById(tenantId, stokId);
  const product = await db.collection('products').findOne(filter, {
    ...txOpts(session),
    projection: { satuan: 1, baseUomId: 1, barcode: 1, stok: 1, stokDisplay: 1 },
  }) as (MasterProductFields & { stok?: unknown; stokDisplay?: unknown }) | null;
  const stok = await sumLokasiQty(db, tenantId, stokId, session);
  if (!product) return { found: false, stok, stokDisplay: '' };
  const stokDisplay = await computeMasterStokDisplay(db, tenantId, stokId, stok, product, session);
  await db.collection('products').updateOne(
    filter,
    { $set: { stok, stokDisplay, updatedAt: new Date() } },
    txOpts(session),
  );
  return {
    found: true,
    stok,
    stokDisplay,
    before: {
      stok: roundStockQty(product.stok as number | string | undefined),
      stokDisplay: String(product.stokDisplay ?? ''),
    },
  };
}
