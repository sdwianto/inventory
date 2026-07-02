/** Batch upsert produk vendor — mengurangi round-trip MongoDB saat catalog sync. */

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { inferGudangKodeFromProduct, setProductWarehouseStock } from '@/lib/api/product-warehouse';
import { vendorProductSnapshot } from '@/lib/api/product-sync';
import type { JsonObject } from '@/types/json';

const BATCH_SIZE = 250;

interface BatchUpsertResult {
  created: number;
  updated: number;
  errors: JsonObject[];
  byVendor: Record<string, number>;
}

type ExistingRow = JsonObject & { id: string; vendorStokId?: string; vendorTenantId?: string; kode?: string };

function buildSyncSet(snap: ReturnType<typeof vendorProductSnapshot>, vTenant: string, now: Date) {
  return {
    kode: snap.kode,
    barcode: snap.barcode,
    nama: snap.nama,
    grup: snap.grup,
    satuan: snap.satuan,
    aktif: snap.aktif,
    vendorStokId: snap.id,
    vendorTenantId: vTenant,
    vendorTenantName: snap.vendorTenantName || vTenant,
    vendorHargaBeli: snap.hargaBeli,
    vendorHargaGrosir: snap.hargaGrosir,
    vendorHargaSpesial: snap.hargaSpesial,
    vendorHargaEcer: snap.hargaEcer,
    hargaGrosir: snap.hargaGrosir,
    hargaSpesial: snap.hargaSpesial,
    hargaEcer: snap.hargaEcer,
    syncSource: 'sales.app',
    updatedAt: now,
  };
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

export async function bulkUpsertProductsFromVendor(
  db: Db,
  customerTenantId: string,
  products: JsonObject[],
): Promise<BatchUpsertResult> {
  const tid = customerTenantId || 'default';
  const result: BatchUpsertResult = { created: 0, updated: 0, errors: [], byVendor: {} };
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

    const bulkOps: { updateOne: { filter: Record<string, unknown>; update: { $set: Record<string, unknown> } } }[] = [];
    const toCreate: { doc: Record<string, unknown>; gudangKode: string }[] = [];

    for (const { snap, vTenant } of parsed) {
      const syncSet = buildSyncSet(snap, vTenant, now);
      const existing = findExisting(existingMap, snap, vTenant);
      result.byVendor[vTenant] = (result.byVendor[vTenant] || 0) + 1;

      if (existing) {
        bulkOps.push({
          updateOne: {
            filter: { id: existing.id },
            update: { $set: syncSet },
          },
        });
        result.updated += 1;
      } else {
        const gudangKode = inferGudangKodeFromProduct(snap);
        const id = uuidv4();
        toCreate.push({
          gudangKode,
          doc: {
            id,
            tenantId: tid,
            ...syncSet,
            gudangKode,
            hargaBeli: 0,
            stok: 0,
            minStok: 0,
            createdAt: now,
          },
        });
        result.created += 1;
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
  }

  return result;
}
