import type { JsonObject } from '@/types/json';

/** Status sumber yang boleh diganti dengan PO draft baru (noPO baru). */
export const PO_REVISE_SOURCE_STATUSES = ['CANCELLED', 'PARTIAL_CANCELLED'] as const;

export function canReviseCancelledPoStatus(status: string): boolean {
  return (PO_REVISE_SOURCE_STATUSES as readonly string[]).includes(String(status || ''));
}

function parseQty(v: unknown): number {
  return parseFloat(String(v ?? 0)) || 0;
}

/**
 * Salin baris PO lama → payload item draft revisi.
 * Baris yang dicoret dipulihkan dari qtyOriginal agar bisa diedit ulang.
 */
export function buildRevisedPoItemPayloads(items: unknown[]): JsonObject[] {
  const out: JsonObject[] = [];
  for (const raw of items || []) {
    const it = (raw && typeof raw === 'object' ? raw : {}) as JsonObject;
    const cancelled = it.cancelled === true;
    const qty = cancelled
      ? parseQty(it.qtyOriginal ?? it.qtyCancelled ?? it.qty)
      : parseQty(it.qtyOriginal ?? it.qty);
    if (qty <= 0) continue;
    out.push({
      localStokId: it.localStokId != null ? String(it.localStokId) : undefined,
      vendorStokId: it.vendorStokId != null ? String(it.vendorStokId) : undefined,
      vendorTenantId: it.vendorTenantId != null ? String(it.vendorTenantId) : undefined,
      vendorKode: it.vendorKode != null ? String(it.vendorKode) : undefined,
      kode: it.kode != null ? String(it.kode) : (it.vendorKode != null ? String(it.vendorKode) : undefined),
      nama: it.nama != null ? String(it.nama) : undefined,
      satuan: it.satuan != null ? String(it.satuan) : undefined,
      uomId: it.uomId != null ? String(it.uomId) : '',
      vendorUomId: it.vendorUomId != null ? String(it.vendorUomId) : '',
      qty,
      estimasiHarga: parseInt(String(it.estimasiHarga || 0), 10) || 0,
      hargaBeliReferensi: parseInt(String(it.hargaBeliReferensi || 0), 10) || 0,
    });
  }
  return out;
}

export function buildReviseCatatan(sourceNoPO: string, existingCatatan?: string): string {
  const note = `Revisi dari ${sourceNoPO}`;
  const prev = String(existingCatatan || '').trim();
  if (!prev) return note;
  if (prev.includes(note)) return prev;
  return `${note}\n${prev}`;
}

/** Field jejak Food Production / PR yang wajib ikut ke draft revisi. */
export function foodProductionLineageFromPo(source: {
  purchaseRequirementId?: unknown;
  purchaseRequirementNo?: unknown;
  materialRequirementId?: unknown;
  productionPlanId?: unknown;
  maintenanceRequestId?: unknown;
  assetId?: unknown;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const prId = String(source.purchaseRequirementId || '').trim();
  const prNo = String(source.purchaseRequirementNo || '').trim();
  const mrpId = String(source.materialRequirementId || '').trim();
  const planId = String(source.productionPlanId || '').trim();
  const wrId = String(source.maintenanceRequestId || '').trim();
  const assetId = String(source.assetId || '').trim();
  if (prId) out.purchaseRequirementId = prId;
  if (prNo) out.purchaseRequirementNo = prNo;
  if (mrpId) out.materialRequirementId = mrpId;
  if (planId) out.productionPlanId = planId;
  out.maintenanceRequestId = wrId || null;
  out.assetId = assetId || null;
  return out;
}
