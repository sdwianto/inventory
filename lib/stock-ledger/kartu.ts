import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { warehouseLabel } from '@/lib/api/warehouses';
import { roundStockQty, roundUnitCost } from '@/lib/stock-ledger/precision';
import type { StockCostSource } from '@/lib/stock-ledger/cost';

export type { StockCostSource };

export interface StockActor {
  userId?: string;
  userName?: string;
  role?: string;
}

export interface KartuDocInput {
  tenantId: string;
  stokId: string;
  lokasiKode: string;
  lokasiLabel?: string;
  postingDate: Date;
  noTransaksi: string;
  sourceType: string;
  sourceId?: string;
  lineRef: string;
  keterangan: string;
  deltaQtyBase: number;
  unitCost: number;
  costSource: StockCostSource;
  qtyEntered?: number;
  uomId?: string;
  satuan?: string;
  binKode?: string;
  actor?: StockActor | null;
  extra?: Record<string, unknown>;
}

export function buildKartuDoc(input: KartuDocInput): Record<string, unknown> & { id: string } {
  const delta = roundStockQty(input.deltaQtyBase);
  const id = uuidv4();
  return stampTenantId(input.tenantId, {
    ...(input.extra || {}),
    id,
    stokId: input.stokId,
    lokasi: input.lokasiLabel || `${input.lokasiKode} - ${warehouseLabel(input.lokasiKode)}`,
    lokasiKode: input.lokasiKode,
    ...(input.binKode ? { binKode: input.binKode } : {}),
    tanggal: input.postingDate,
    postingDate: input.postingDate,
    noTransaksi: input.noTransaksi,
    keterangan: input.keterangan,
    sourceType: input.sourceType,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    lineRef: input.lineRef,
    masuk: delta > 0 ? delta : 0,
    keluar: delta < 0 ? -delta : 0,
    ...(input.qtyEntered !== undefined ? { qtyEntered: input.qtyEntered } : {}),
    ...(input.uomId ? { uomId: input.uomId } : {}),
    ...(input.satuan ? { satuan: input.satuan } : {}),
    hargaSatuan: roundUnitCost(input.unitCost),
    costSource: input.costSource,
    ...(input.actor?.userId || input.actor?.userName
      ? { createdBy: { userId: input.actor.userId || '', userName: input.actor.userName || '', ...(input.actor.role ? { role: input.actor.role } : {}) } }
      : {}),
    createdAt: new Date(),
  }) as Record<string, unknown> & { id: string };
}
