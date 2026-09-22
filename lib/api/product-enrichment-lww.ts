/** LWW nama enrichment Inventory ↔ Sales (stamp detailFotosUpdatedAt). */

function parseSyncTime(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Koreksi nama lokal (namaSource=manual / stamp detailFotosUpdatedAt)
 * tidak ditimpa catalog sync Sales yang lebih basi.
 * Juga menolak wipe nama lokal oleh inbound partial (nama kosong).
 */
export function preserveManualLocalNama(
  syncSet: Record<string, unknown>,
  existing?: { namaSource?: unknown; detailFotosUpdatedAt?: unknown; nama?: unknown } | null,
  snap?: { hasDetailFotosUpdatedAt?: boolean; detailFotosUpdatedAt?: unknown },
): void {
  if (!existing) return;
  const localAt = parseSyncTime(existing.detailFotosUpdatedAt);
  const salesAt = parseSyncTime(
    snap?.hasDetailFotosUpdatedAt ? snap.detailFotosUpdatedAt : null,
  );
  const salesEnrichmentWins = localAt == null
    || (salesAt != null && salesAt >= localAt);
  if (String(existing.namaSource || '') === 'manual' && !salesEnrichmentWins) {
    delete syncSet.nama;
    return;
  }
  if (localAt != null && !salesEnrichmentWins) {
    delete syncSet.nama;
    return;
  }
  if (!String(syncSet.nama || '').trim() && String(existing.nama || '').trim()) {
    delete syncSet.nama;
  }
}

/** True jika Sales mengirim stamp enrichment (detail/foto/nama-only). */
export function shouldApplyEnrichmentFields(snap: {
  hasDetailProduk?: boolean;
  hasFotos?: boolean;
  hasDetailFotosUpdatedAt?: boolean;
}): boolean {
  return Boolean(snap.hasDetailProduk || snap.hasFotos || snap.hasDetailFotosUpdatedAt);
}

/** Sales enrichment stamp menang vs lokal? */
export function salesEnrichmentAllowsOverwrite(
  existing?: { detailFotosUpdatedAt?: unknown } | null,
  snap?: { hasDetailFotosUpdatedAt?: boolean; detailFotosUpdatedAt?: unknown },
): { allow: boolean; salesDetailAt: number | null } {
  const localDetailAt = parseSyncTime(existing?.detailFotosUpdatedAt);
  const salesDetailAt = parseSyncTime(
    snap?.hasDetailFotosUpdatedAt ? snap.detailFotosUpdatedAt : null,
  );
  const allow = localDetailAt == null
    || (salesDetailAt != null && salesDetailAt >= localDetailAt);
  return { allow, salesDetailAt };
}
