/**
 * W2-2 / W2-3 — FG ship & return needs for DST (Food Tray lines; FG on linked HSL).
 */

import { FOOD_TRAY_ID, type DispatchLine } from '@/lib/food-production/distribution';
import { roundQty } from '@/lib/food-production/material-requirement';
import type { FefoAllocation } from '@/lib/food-production/fefo-allocate';

export type HslFgLine = {
  finishedGoodProductId?: string;
  finishedGoodNama?: string;
  finishedGoodKode?: string;
  actualPorsi?: number;
  satuan?: string;
};

export type DistFgShipNeed = {
  stokId: string;
  nama?: string;
  kode?: string;
  satuan?: string;
  /** HSL produced qty for this FG. */
  hslQty: number;
  /** Qty to ship / consume (scaled by DST ship ratio). */
  needQty: number;
};

function trayQtyFromDistLines(lines: DispatchLine[]): number {
  return roundQty(
    (lines || []).reduce((s, l) => {
      const shipped = l.qtyDikirim != null ? Number(l.qtyDikirim) : Number(l.qtyPorsi);
      return s + (Number.isFinite(shipped) && shipped > 0 ? shipped : 0);
    }, 0),
  );
}

function trayQtyFromHsl(lines: HslFgLine[]): number {
  const qtys = (lines || [])
    .map((l) => Number(l.actualPorsi) || 0)
    .filter((q) => q > 0);
  if (!qtys.length) return 0;
  // Food Tray = max line porsi (1 set), same as collapseSourceToFoodTray.
  return roundQty(Math.max(...qtys));
}

/** Aggregate HSL FG lines that own stock/batches (skip empty / FOOD_TRAY ids). */
export function hslFgStockLines(lines: HslFgLine[]): Array<{
  stokId: string;
  nama?: string;
  kode?: string;
  satuan?: string;
  qty: number;
}> {
  const byId = new Map<string, { stokId: string; nama?: string; kode?: string; satuan?: string; qty: number }>();
  for (const line of lines || []) {
    const stokId = String(line.finishedGoodProductId || '').trim();
    if (!stokId || stokId === FOOD_TRAY_ID) continue;
    const qty = Number(line.actualPorsi) || 0;
    if (!(qty > 0)) continue;
    const cur = byId.get(stokId);
    if (cur) {
      cur.qty = roundQty(cur.qty + qty);
    } else {
      byId.set(stokId, {
        stokId,
        nama: line.finishedGoodNama,
        kode: line.finishedGoodKode,
        satuan: line.satuan,
        qty: roundQty(qty),
      });
    }
  }
  return [...byId.values()];
}

/**
 * Scale each HSL FG qty by DST ship ratio (shipped tray / HSL tray).
 * Ratio clamped to [0, 1]. Full ship → needQty = hslQty.
 */
export function computeDistFgShipNeeds(input: {
  distLines: DispatchLine[];
  hslLines: HslFgLine[];
}): DistFgShipNeed[] {
  const fg = hslFgStockLines(input.hslLines);
  if (!fg.length) return [];

  const hslTray = trayQtyFromHsl(input.hslLines);
  const shipTray = trayQtyFromDistLines(input.distLines);
  if (!(hslTray > 0) || !(shipTray > 0)) return [];

  const ratio = Math.min(1, shipTray / hslTray);
  return fg.map((row) => ({
    stokId: row.stokId,
    nama: row.nama,
    kode: row.kode,
    satuan: row.satuan,
    hslQty: row.qty,
    needQty: roundQty(row.qty * ratio),
  })).filter((r) => r.needQty > 0);
}

function trayReturnQtyFromDistLines(lines: DispatchLine[]): number {
  return roundQty(
    (lines || []).reduce((s, l) => {
      const ret = Number(l.qtyDikembalikan) || 0;
      return s + (ret > 0 ? ret : 0);
    }, 0),
  );
}

/**
 * W2-3 — FG restock needs from returned tray qty (vs HSL tray).
 * Caps each FG at shipped needQty when `shippedByStok` provided.
 */
export function computeDistFgReturnNeeds(input: {
  distLines: DispatchLine[];
  hslLines: HslFgLine[];
  /** Optional cap from W2-2 fefoConsume.needQty per stokId. */
  shippedByStok?: Record<string, number>;
}): DistFgShipNeed[] {
  const fg = hslFgStockLines(input.hslLines);
  if (!fg.length) return [];

  const hslTray = trayQtyFromHsl(input.hslLines);
  const returnTray = trayReturnQtyFromDistLines(input.distLines);
  if (!(hslTray > 0) || !(returnTray > 0)) return [];

  const ratio = Math.min(1, returnTray / hslTray);
  return fg.map((row) => {
    let needQty = roundQty(row.qty * ratio);
    const cap = input.shippedByStok?.[row.stokId];
    if (cap != null && Number.isFinite(cap)) {
      needQty = Math.min(needQty, Math.max(0, Number(cap)));
    }
    return {
      stokId: row.stokId,
      nama: row.nama,
      kode: row.kode,
      satuan: row.satuan,
      hslQty: row.qty,
      needQty,
    };
  }).filter((r) => r.needQty > 0);
}

/**
 * Restore plan: reverse FEFO (LIFO on ship allocations) up to returnQty.
 */
export function planFefoRestore(
  returnQty: number,
  allocations: FefoAllocation[],
): FefoAllocation[] {
  const need = Number(returnQty);
  if (!(need > 0) || !allocations?.length) return [];
  let left = need;
  const out: FefoAllocation[] = [];
  for (const a of [...allocations].reverse()) {
    if (left <= 0) break;
    const avail = Number(a.qty) || 0;
    if (!(avail > 0)) continue;
    const take = Math.min(avail, left);
    out.push({
      batchId: a.batchId,
      batchNo: a.batchNo,
      expiryDate: a.expiryDate,
      qty: take,
    });
    left -= take;
  }
  return out;
}
