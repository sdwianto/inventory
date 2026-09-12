/** Batch upsert produk vendor — mengurangi round-trip MongoDB saat catalog sync. */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { setProductWarehouseStock } from '@/lib/api/product-warehouse';
import { applyInferredClassification, inferredClassificationPatch } from '@/lib/api/apply-product-classification';
import { vendorProductSnapshot, bulkSyncVendorProductUoms, resolveVendorBaseUomId } from '@/lib/api/product-sync';
import { materializeInboundProductFotos } from '@/lib/api/product-media';
import type { JsonObject } from '@/types/json';

const BATCH_SIZE = 250;

interface BatchUpsertResult {
  created: number;
  updated: number;
  skippedStale: number;
  errors: JsonObject[];
  byVendor: Record<string, number>;
  duplicateBarcodes: JsonObject[];
}

type ExistingRow = JsonObject & {
  id: string;
  vendorStokId?: string;
  vendorTenantId?: string;
  kode?: string;
  barcode?: string;
  nama?: string;
  masterProductId?: string | null;
  detailProduk?: string;
  fotos?: string[];
  detailFotosUpdatedAt?: unknown;
  lastVendorSyncEmittedAt?: unknown;
};

function parseSyncTime(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : null;
}

export function buildSyncSet(
  snap: ReturnType<typeof vendorProductSnapshot>,
  vTenant: string,
  now: Date,
  existing?: ExistingRow | null,
  vendorProduct?: Record<string, unknown>,
) {
  const incomingEmit = parseSyncTime(snap.emittedAt);
  const syncSet: Record<string, unknown> = {
    kode: snap.kode,
    barcode: snap.barcode,
    nama: snap.nama,
    grup: snap.grup,
    satuan: snap.satuan,
    aktif: snap.aktif,
    vendorStokId: snap.id,
    vendorTenantId: vTenant,
    vendorTenantName: snap.vendorTenantName || vTenant,
    vendorBaseUomId: resolveVendorBaseUomId(vendorProduct || { id: snap.id }, snap),
    vendorHargaBeli: snap.hargaBeli,
    vendorHargaGrosir: snap.hargaGrosir,
    vendorHargaSpesial: snap.hargaSpesial,
    vendorHargaEcer: snap.hargaEcer,
    hargaGrosir: snap.hargaGrosir,
    hargaSpesial: snap.hargaSpesial,
    hargaEcer: snap.hargaEcer,
    syncSource: 'sales.app',
    masterProductId: snap.masterProductId,
    updatedAt: now,
    ...(incomingEmit != null
      ? { lastVendorSyncEmittedAt: new Date(incomingEmit) }
      : { lastVendorSyncEmittedAt: now }),
  };
  if (snap.hasRecipeBaseGrams) syncSet.recipeBaseGrams = snap.recipeBaseGrams;
  if (snap.hasRecipeBaseMl) syncSet.recipeBaseMl = snap.recipeBaseMl;
  if (snap.hasDetailProduk || snap.hasFotos) {
    const localDetailAt = parseSyncTime(existing?.detailFotosUpdatedAt);
    // Hanya detailFotosUpdatedAt — jangan fallback emittedAt (catalog touch harga ≠ detail baru).
    const salesDetailAt = parseSyncTime(
      snap.hasDetailFotosUpdatedAt ? snap.detailFotosUpdatedAt : null,
    );
    const allowDetail = localDetailAt == null
      || (salesDetailAt != null && salesDetailAt >= localDetailAt);
    if (allowDetail) {
      if (snap.hasDetailProduk) {
        const incoming = snap.detailProduk ?? '';
        const localDetail = existing ? String(existing.detailProduk || '') : '';
        if (incoming || !localDetail) syncSet.detailProduk = incoming;
      }
      if (snap.hasFotos) {
        const incoming = Array.isArray(snap.fotos) ? snap.fotos : [];
        const localFotos = existing && Array.isArray(existing.fotos) ? existing.fotos : [];
        if (incoming.length || !localFotos.length) syncSet.fotos = incoming;
      }
      if (salesDetailAt != null) syncSet.detailFotosUpdatedAt = new Date(salesDetailAt);
    }
  }
  return syncSet;
}

async function loadExistingForBatch(
  db: Db,
  tid: string,
  vendorStokIds: string[],
  vendorKodePairs: { vendorTenantId: string; kode: string }[],
): Promise<Map<string, ExistingRow>> {
  const or: Record<string, unknown>[] = [];
  if (vendorStokIds.length) {
    or.push({ tenantId: tid, vendorStokId: { $in: vendorStokIds } });
  }
  for (const { vendorTenantId, kode } of vendorKodePairs) {
    or.push({ tenantId: tid, vendorTenantId, kode, syncSource: 'sales.app' });
  }
  if (!or.length) return new Map();

  const rows = (await db.collection('products').find({ $or: or }).toArray()) as unknown as ExistingRow[];
  const map = new Map<string, ExistingRow>();
  for (const row of rows) {
    if (row.vendorStokId) map.set(`id:${row.vendorStokId}:${row.vendorTenantId || ''}`, row);
    if (row.kode) map.set(`kode:${row.kode}:${row.vendorTenantId || ''}`, row);
  }
  return map;
}

function findExisting(
  map: Map<string, ExistingRow>,
  snap: ReturnType<typeof vendorProductSnapshot>,
  vTenant: string,
): ExistingRow | undefined {
  return map.get(`id:${snap.id}:${vTenant}`) || map.get(`kode:${snap.kode}:${vTenant}`);
}

/**
 * Peta barcode -> produk aktif dengan barcode itu, untuk deteksi duplikat SKU vendor
 * (barcode sama tapi vendorStokId/kode beda — lihat findBarcodeDuplicate di product-sync.ts).
 */
async function loadBarcodeMap(
  db: Db,
  tid: string,
  barcodes: string[],
): Promise<Map<string, ExistingRow[]>> {
  const uniq = [...new Set(barcodes.filter(Boolean))];
  const map = new Map<string, ExistingRow[]>();
  if (!uniq.length) return map;
  const rows = (await db.collection('products').find({
    tenantId: tid,
    barcode: { $in: uniq },
    aktif: { $ne: false },
  }).project({ id: 1, kode: 1, nama: 1, barcode: 1, vendorStokId: 1, masterProductId: 1 }).toArray()) as unknown as ExistingRow[];
  for (const row of rows) {
    const b = String(row.barcode || '');
    if (!b) continue;
    const arr = map.get(b) || [];
    arr.push(row);
    map.set(b, arr);
  }
  return map;
}

function findBarcodeDuplicate(
  barcodeMap: Map<string, ExistingRow[]>,
  barcode: string,
  selfVendorStokId: string,
  selfId?: string,
): ExistingRow | undefined {
  if (!barcode) return undefined;
  const candidates = barcodeMap.get(barcode) || [];
  return candidates.find((r) => r.vendorStokId !== selfVendorStokId && r.id !== selfId);
}

export async function bulkUpsertProductsFromVendor(
  db: Db,
  customerTenantId: string,
  products: JsonObject[],
): Promise<BatchUpsertResult> {
  const tid = customerTenantId || 'default';
  const result: BatchUpsertResult = {
    created: 0,
    updated: 0,
    skippedStale: 0,
    errors: [],
    byVendor: {},
    duplicateBarcodes: [],
  };
  const now = new Date();

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const chunk = products.slice(i, i + BATCH_SIZE);
    const parsed: { snap: ReturnType<typeof vendorProductSnapshot>; vTenant: string; raw: JsonObject }[] = [];

    for (const p of chunk) {
      const vTenant = String(p.vendorTenantId || p.tenantId || '').trim();
      if (!vTenant) {
        result.errors.push({ kode: p.kode, error: 'missing vendorTenantId' });
        continue;
      }
      try {
        const snap = vendorProductSnapshot(p);
        if (!snap.id) throw new Error('missing vendorStokId');
        parsed.push({ snap, vTenant, raw: p });
      } catch (e) {
        result.errors.push({
          kode: p.kode,
          vendorTenantId: vTenant,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (!parsed.length) continue;

    const existingMap = await loadExistingForBatch(
      db,
      tid,
      parsed.map((x) => String(x.snap.id)),
      parsed.map((x) => ({ vendorTenantId: x.vTenant, kode: String(x.snap.kode) })),
    );
    const barcodeMap = await loadBarcodeMap(db, tid, parsed.map((x) => x.snap.barcode));

    const bulkOps: { updateOne: { filter: Record<string, unknown>; update: { $set: Record<string, unknown> } } }[] = [];
    const toCreate: { doc: Record<string, unknown>; gudangKode: string }[] = [];
    const uomSyncQueue: { productId: string; raw: JsonObject; snap: ReturnType<typeof vendorProductSnapshot> }[] = [];

    for (const { snap, vTenant, raw } of parsed) {
      const existing = findExisting(existingMap, snap, vTenant);
      const incomingEmit = parseSyncTime(snap.emittedAt);
      const lastEmit = parseSyncTime(existing?.lastVendorSyncEmittedAt);
      if (existing && lastEmit != null && incomingEmit != null && incomingEmit < lastEmit) {
        result.skippedStale += 1;
        continue;
      }
      const syncSet = buildSyncSet(snap, vTenant, now, existing, raw);
      if (Array.isArray(syncSet.fotos)) {
        syncSet.fotos = await materializeInboundProductFotos(
          tid,
          (syncSet.fotos as unknown[]).map(String),
        );
      }
      result.byVendor[vTenant] = (result.byVendor[vTenant] || 0) + 1;

      const dup = findBarcodeDuplicate(barcodeMap, snap.barcode, snap.id, existing?.id);
      // Sama seperti upsertProductFromVendor (jalur webhook single-item, product-sync.ts) — redam
      // peringatan duplikat barcode kalau dua produk memang sudah dikonfirmasi Master Product yang
      // sama (barang sama dari vendor berbeda, bukan anomali data).
      const confirmedSameMaster = !!snap.masterProductId && !!dup && dup.masterProductId === snap.masterProductId;
      syncSet.barcodeDuplicateWarning = !!dup && !confirmedSameMaster;
      syncSet.barcodeDuplicateOf = dup?.id ?? null;
      syncSet.barcodeDuplicateConfirmedSameMaster = confirmedSameMaster;
      if (dup) {
        result.duplicateBarcodes.push({
          barcode: snap.barcode,
          kode: snap.kode,
          nama: snap.nama,
          vendorTenantId: vTenant,
          existingId: dup.id,
          existingKode: dup.kode,
          existingNama: dup.nama,
        });
      }

      if (existing) {
        const classPatch = await applyInferredClassification(db, tid, existing, snap);
        bulkOps.push({
          updateOne: {
            filter: { id: existing.id },
            update: { $set: { ...syncSet, ...classPatch } },
          },
        });
        uomSyncQueue.push({ productId: existing.id, raw, snap });
        result.updated += 1;
      } else {
        const classified = inferredClassificationPatch(snap);
        const id = uuidv4();
        toCreate.push({
          gudangKode: classified.gudangKode,
          doc: {
            id,
            tenantId: tid,
            ...syncSet,
            ...classified,
            hargaBeli: 0,
            stok: 0,
            minStok: 0,
            createdAt: now,
          },
        });
        uomSyncQueue.push({ productId: id, raw, snap });
        result.created += 1;
        if (snap.barcode) {
          const arr = barcodeMap.get(snap.barcode) || [];
          arr.push({ id, kode: snap.kode, nama: snap.nama, vendorStokId: snap.id, masterProductId: snap.masterProductId });
          barcodeMap.set(snap.barcode, arr);
        }
      }
    }

    if (bulkOps.length) {
      await db.collection('products').bulkWrite(bulkOps, { ordered: false });
    }
    if (toCreate.length) {
      await db.collection('products').insertMany(toCreate.map((x) => x.doc));
      await Promise.all(
        toCreate.map((x) =>
          setProductWarehouseStock(db, tid, String(x.doc.id), x.gudangKode, 0),
        ),
      );
    }
    if (uomSyncQueue.length) {
      await bulkSyncVendorProductUoms(db, tid, uomSyncQueue);
    }
  }

  return result;
}
