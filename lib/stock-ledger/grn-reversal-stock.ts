// Fase 3.6 — sisi stok pembalik GRN: lot hasil GRN harus utuh di gudang asal, lalu keluar persis
// dari lot itu (termasuk lot karantina/ditolak QC) lewat buku stok, dan lot ditandai reversedBy.

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import { INGREDIENT_LOTS_COLLECTION, effectiveIngredientQtyRemaining, type IngredientLotDoc } from '@/lib/food-production/ingredient-lot';
import { postStockMovements, type PostedStockLine } from '@/lib/stock-ledger/post-stock-movements';
import { roundStockQty, qtyGt } from '@/lib/stock-ledger/precision';
import type { StockActor } from '@/lib/stock-ledger/kartu';

export const GRN_REVERSAL_SOURCE = 'GRN_REVERSAL';

type GrnLike = {
  id?: unknown;
  noGRN?: unknown;
  items?: unknown;
};

export type GrnReversalLotGroup = {
  productId: string;
  productKode?: string;
  productNama?: string;
  warehouseKode: string;
  lotNo: string;
  qty: number;
  satuan?: string;
  lotIds: string[];
  unitCost?: number;
};

type GroupsResult = { ok: true; groups: GrnReversalLotGroup[] } | { ok: false; error: string };

function pairKey(productId: string, warehouseKode: string) {
  return `${productId}\u0000${warehouseKode}`;
}

/** Qty base yang diterima GRN per (produk stok, gudang). */
function receivedByPair(grn: GrnLike): Map<string, { productId: string; warehouseKode: string; qty: number; label: string }> {
  const out = new Map<string, { productId: string; warehouseKode: string; qty: number; label: string }>();
  for (const raw of (Array.isArray(grn.items) ? grn.items : []) as Record<string, unknown>[]) {
    const qty = roundStockQty(Number(raw.qtyReceivedBase) || 0);
    if (!(qty > 0)) continue;
    const productId = String(raw.stockProductId || raw.localStokId || '');
    const warehouseKode = String(raw.lokasiKode || '');
    if (!productId || !warehouseKode) continue;
    const key = pairKey(productId, warehouseKode);
    const prev = out.get(key);
    out.set(key, {
      productId,
      warehouseKode,
      qty: roundStockQty((prev?.qty || 0) + qty),
      label: String(raw.localNama || raw.vendorNama || raw.localKode || raw.vendorKode || productId),
    });
  }
  return out;
}

type ReceivedPairs = Map<string, { productId: string; warehouseKode: string; qty: number; label: string }>;

/** Produk GRN yang sudah di-merge: lotnya ikut pindah ke produk kanonik (mergedInto). */
async function canonicalizePairs(db: Db, tenantId: string, pairs: ReceivedPairs, session?: ClientSession): Promise<ReceivedPairs> {
  const ids = [...new Set([...pairs.values()].map((p) => p.productId))];
  const target = new Map<string, string>(ids.map((id) => [id, id]));
  let pending = ids;
  for (let hop = 0; hop < 3 && pending.length; hop++) {
    const rows = await db.collection('products')
      .find({ tenantId, id: { $in: pending }, mergedInto: { $type: 'string', $gt: '' } }, txOpts(session))
      .project({ id: 1, mergedInto: 1 })
      .toArray();
    const next = new Map(rows.map((r) => [String(r.id), String(r.mergedInto)]));
    if (!next.size) break;
    for (const [orig, cur] of target) {
      const to = next.get(cur);
      if (to) target.set(orig, to);
    }
    pending = [...new Set(next.values())];
  }
  const out: ReceivedPairs = new Map();
  for (const p of pairs.values()) {
    const productId = target.get(p.productId) || p.productId;
    const key = pairKey(productId, p.warehouseKode);
    const prev = out.get(key);
    out.set(key, { ...p, productId, qty: roundStockQty((prev?.qty || 0) + p.qty) });
  }
  return out;
}

/**
 * Validasi lot GRN masih utuh dan kelompokkan per (produk, gudang, nomor lot) untuk dikeluarkan.
 * Read-only — dipakai saat pengajuan dan diulang di dalam transaksi persetujuan.
 */
export async function loadGrnReversalLotGroups(
  db: Db,
  tenantId: string,
  grn: GrnLike,
  session?: ClientSession,
): Promise<GroupsResult> {
  const grnId = String(grn.id || '');
  const expected = await canonicalizePairs(db, tenantId, receivedByPair(grn), session);
  if (!expected.size) return { ok: true, groups: [] };

  const lots = await db.collection<IngredientLotDoc>(INGREDIENT_LOTS_COLLECTION)
    .find({ tenantId, grnId }, txOpts(session))
    .toArray();
  if (!lots.length) {
    return { ok: false, error: 'GRN ini tidak punya lot (data lama). Koreksi lewat Penyesuaian stok.' };
  }

  const remainingByPair = new Map<string, number>();
  const groups = new Map<string, GrnReversalLotGroup>();
  for (const lot of lots) {
    const rem = roundStockQty(effectiveIngredientQtyRemaining(lot));
    const key = pairKey(lot.productId, lot.warehouseKode);
    remainingByPair.set(key, roundStockQty((remainingByPair.get(key) || 0) + rem));
    if (!(rem > 0)) continue;
    const gKey = `${key}\u0000${String(lot.lotNo || '').trim()}`;
    const g = groups.get(gKey) || {
      productId: lot.productId,
      productKode: lot.productKode,
      productNama: lot.productNama,
      warehouseKode: lot.warehouseKode,
      lotNo: String(lot.lotNo || '').trim(),
      qty: 0,
      satuan: lot.satuan,
      lotIds: [],
    };
    g.qty = roundStockQty(g.qty + rem);
    g.lotIds.push(lot.id);
    groups.set(gKey, g);
  }

  for (const [key, exp] of expected) {
    const rem = remainingByPair.get(key) || 0;
    if (qtyGt(exp.qty, rem) || qtyGt(rem, exp.qty)) {
      const lotNos = lots
        .filter((l) => pairKey(l.productId, l.warehouseKode) === key)
        .map((l) => l.lotNo)
        .join(', ');
      return {
        ok: false,
        error: `Lot ${lotNos || exp.label} dari GRN ini sudah terpakai atau dipindah (sisa ${rem} dari ${exp.qty} di ${exp.warehouseKode}). Pembalik hanya bisa bila qty lot masih utuh di gudang asal.`,
      };
    }
  }
  for (const key of remainingByPair.keys()) {
    if (!expected.has(key) && (remainingByPair.get(key) || 0) > 0) {
      return { ok: false, error: 'Lot GRN ini ada di gudang lain dari gudang penerimaan. Pembalik hanya bisa bila lot masih di gudang asal.' };
    }
  }

  const ownIds = lots.map((l) => l.id);
  for (const g of groups.values()) {
    if (!g.lotNo) return { ok: false, error: 'Lot GRN tanpa nomor lot. Koreksi lewat Penyesuaian stok.' };
    const clash = await db.collection(INGREDIENT_LOTS_COLLECTION).findOne(
      {
        tenantId,
        productId: g.productId,
        warehouseKode: g.warehouseKode,
        lotNo: g.lotNo,
        id: { $nin: ownIds },
        qtyRemaining: { $gt: 0 },
      },
      { projection: { id: 1 }, ...txOpts(session) },
    );
    if (clash) {
      return {
        ok: false,
        error: `Nomor lot ${g.lotNo} juga dipakai lot lain di gudang ${g.warehouseKode}, jadi lot GRN ini tidak bisa dipilih dengan aman. Koreksi lewat Penyesuaian stok.`,
      };
    }
  }

  const costs = await loadGrnUnitCosts(db, tenantId, grnId, session);
  return {
    ok: true,
    groups: [...groups.values()].map((g) => ({ ...g, unitCost: costs.get(g.productId) })),
  };
}

/** Harga satuan dasar per produk dari kartu masuk GRN (rata-rata tertimbang per produk). */
async function loadGrnUnitCosts(db: Db, tenantId: string, grnId: string, session?: ClientSession) {
  const rows = await db.collection('stok_kartu')
    .find({ tenantId, sourceType: 'GRN', sourceId: grnId }, txOpts(session))
    .project({ stokId: 1, masuk: 1, hargaSatuan: 1 })
    .toArray();
  const acc = new Map<string, { qty: number; value: number }>();
  for (const r of rows) {
    const qty = Number(r.masuk) || 0;
    if (!(qty > 0)) continue;
    const a = acc.get(String(r.stokId)) || { qty: 0, value: 0 };
    a.qty += qty;
    a.value += qty * (Number(r.hargaSatuan) || 0);
    acc.set(String(r.stokId), a);
  }
  const out = new Map<string, number>();
  for (const [id, a] of acc) if (a.qty > 0) out.set(id, a.value / a.qty);
  return out;
}

export type PostGrnReversalStockResult =
  | { ok: true; lines: PostedStockLine[]; lotIds: string[] }
  | { ok: false; error: string };

/** Keluarkan lot GRN persis (PREFERRED per nomor lot) dan tandai lot reversedBy. */
export async function postGrnReversalStock(
  db: Db,
  session: ClientSession | undefined,
  input: {
    tenantId: string;
    grn: GrnLike;
    reversalId: string;
    noReversal: string;
    reason: string;
    groups: GrnReversalLotGroup[];
    actor?: StockActor | null;
    postingDate: Date;
  },
): Promise<PostGrnReversalStockResult> {
  if (!input.groups.length) return { ok: true, lines: [], lotIds: [] };
  const posted = await postStockMovements(db, session, {
    tenantId: input.tenantId,
    sourceType: GRN_REVERSAL_SOURCE,
    sourceId: input.reversalId,
    noTransaksi: input.noReversal,
    keterangan: `Pembalik GRN ${String(input.grn.noGRN || input.grn.id || '')}: ${input.reason}`,
    postingDate: input.postingDate,
    actor: input.actor,
    lines: input.groups.map((g, i) => ({
      lineRef: String(i),
      productId: g.productId,
      warehouseKode: g.warehouseKode,
      deltaQtyBase: -g.qty,
      ...(g.unitCost != null ? { unitCost: g.unitCost } : {}),
      satuan: g.satuan,
      lotPolicy: { mode: 'FEFO_CONSUME', preferredLotNo: g.lotNo, qcHeld: 'PREFERRED', allowExpired: true },
      kartuExtra: { reversalOfSourceType: 'GRN', reversalOfSourceId: String(input.grn.id || '') },
    })),
  });
  if (!posted.ok) return { ok: false, error: posted.error };
  for (const line of posted.lines) {
    if (!line.lot || line.lot.shortfall > 0) {
      return { ok: false, error: 'Lot GRN berubah bersamaan — muat ulang lalu ulangi persetujuan' };
    }
  }

  const lotIds = input.groups.flatMap((g) => g.lotIds);
  await db.collection(INGREDIENT_LOTS_COLLECTION).updateMany(
    { tenantId: input.tenantId, id: { $in: lotIds } },
    {
      $set: {
        reversedBy: { reversalId: input.reversalId, noReversal: input.noReversal },
        updatedAt: input.postingDate,
      },
    },
    txOpts(session),
  );
  return { ok: true, lines: posted.lines, lotIds };
}
