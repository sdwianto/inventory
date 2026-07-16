/**
 * Forecasting — ADR-001 Phase 3.
 * Horizon 7 / 14 / 30 hari dari histori konsumsi produksi (Issue) + rencana.
 */

import { roundQty } from '@/lib/food-production/material-requirement';

export type ForecastHorizon = 7 | 14 | 30;

export interface DailyConsumptionPoint {
  tanggal: string;
  productId: string;
  qty: number;
}

export interface ForecastLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  avgDailyQty: number;
  forecastQty: number;
  onHandQty: number;
  projectedShortage: number;
  risk: 'OK' | 'LOW' | 'SHORT';
}

export interface ForecastResult {
  horizon: ForecastHorizon;
  historyDays: number;
  fromTanggal?: string;
  toTanggal?: string;
  lines: ForecastLine[];
  summary: {
    productCount: number;
    shortCount: number;
    lowCount: number;
    totalForecastQty: number;
  };
  tips: string[];
}

export function parseHorizon(raw: unknown): ForecastHorizon {
  const n = Number(raw);
  if (n === 14) return 14;
  if (n === 30) return 30;
  return 7;
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Build forecast from daily consumption samples.
 * historyDays = unique tanggal count in points (caller may pass explicit).
 */
export function buildMaterialForecast(input: {
  horizon: ForecastHorizon;
  points: DailyConsumptionPoint[];
  onHandByProduct: Map<string, number>;
  productMeta: Map<string, { productKode?: string; productNama?: string; satuan?: string }>;
  historyDays?: number;
}): ForecastResult {
  const { horizon, points, onHandByProduct, productMeta } = input;
  const byProduct = new Map<string, { tanggal: Set<string>; qtyByDay: Map<string, number> }>();
  const allDays = new Set<string>();

  for (const p of points) {
    const pid = String(p.productId || '').trim();
    if (!pid || !(Number(p.qty) > 0)) continue;
    allDays.add(p.tanggal);
    let row = byProduct.get(pid);
    if (!row) {
      row = { tanggal: new Set(), qtyByDay: new Map() };
      byProduct.set(pid, row);
    }
    row.tanggal.add(p.tanggal);
    row.qtyByDay.set(p.tanggal, roundQty((row.qtyByDay.get(p.tanggal) || 0) + Number(p.qty)));
  }

  const historyDays = input.historyDays && input.historyDays > 0
    ? input.historyDays
    : Math.max(allDays.size, 1);

  const lines: ForecastLine[] = [];
  for (const [productId, row] of byProduct) {
    const daily = [...row.qtyByDay.values()];
    const avgDailyQty = roundQty(avg(daily));
    // Dilute inactive days: avg over full history window if provided
    const diluted = allDays.size > 0
      ? roundQty((daily.reduce((s, q) => s + q, 0)) / historyDays)
      : avgDailyQty;
    const useAvg = diluted > 0 ? diluted : avgDailyQty;
    const forecastQty = roundQty(useAvg * horizon);
    const onHandQty = roundQty(Number(onHandByProduct.get(productId) || 0));
    const projectedShortage = roundQty(Math.max(0, forecastQty - onHandQty));
    let risk: ForecastLine['risk'] = 'OK';
    if (projectedShortage > 0) risk = 'SHORT';
    else if (onHandQty < useAvg * Math.min(3, horizon)) risk = 'LOW';

    const meta = productMeta.get(productId) || {};
    lines.push({
      productId,
      productKode: meta.productKode,
      productNama: meta.productNama,
      satuan: meta.satuan,
      avgDailyQty: useAvg,
      forecastQty,
      onHandQty,
      projectedShortage,
      risk,
    });
  }

  lines.sort((a, b) => {
    const rank = { SHORT: 0, LOW: 1, OK: 2 };
    const d = rank[a.risk] - rank[b.risk];
    if (d !== 0) return d;
    return b.projectedShortage - a.projectedShortage;
  });

  const shortCount = lines.filter((l) => l.risk === 'SHORT').length;
  const lowCount = lines.filter((l) => l.risk === 'LOW').length;
  const tips: string[] = [];
  if (!lines.length) {
    tips.push('Belum ada histori pengambilan bahan — jalankan produksi beberapa hari dulu');
  } else {
    if (shortCount) tips.push(`${shortCount} bahan berisiko kurang dalam ${horizon} hari — buat PR/CPO`);
    if (lowCount) tips.push(`${lowCount} bahan stok tipis (< 3 hari rata-rata)`);
    if (!shortCount && !lowCount) tips.push('Stok bahan terlihat mencukupi untuk horizon ini');
  }

  const tanggalSorted = [...allDays].sort();
  return {
    horizon,
    historyDays,
    fromTanggal: tanggalSorted[0],
    toTanggal: tanggalSorted[tanggalSorted.length - 1],
    lines,
    summary: {
      productCount: lines.length,
      shortCount,
      lowCount,
      totalForecastQty: roundQty(lines.reduce((s, l) => s + l.forecastQty, 0)),
    },
    tips,
  };
}
