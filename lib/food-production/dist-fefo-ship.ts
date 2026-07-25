/**
 * W2-2 — compute FG stock-out + FEFO needs when DST ships (PROCESSING).
 * DST lines are Food Tray (no FG id); FG truth lives on linked HSL.
 */

import { FOOD_TRAY_ID, type DistributionLine } from '@/lib/food-production/distribution';
import { roundQty } from '@/lib/food-production/material-requirement';

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

function trayQtyFromDistLines(lines: DistributionLine[]): number {
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
  distLines: DistributionLine[];
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
