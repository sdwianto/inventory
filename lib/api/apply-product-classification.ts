import type { Db } from 'mongodb';
import {
  classifyProduct,
  isManualClassification,
} from '@/lib/api/product-classification';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { relocateProductWarehouseWithAudit } from '@/lib/api/stock-ledger';

type ClassifiableProduct = {
  id?: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  grup?: string;
  hargaBeli?: unknown;
  itemRole?: unknown;
  gudangKode?: string | null;
  classificationSource?: unknown;
};

export function inferredClassificationPatch(prod: { grup?: string; nama?: string }) {
  const c = classifyProduct(prod);
  return {
    itemRole: c.itemRole,
    gudangKode: c.gudangKode,
    classificationSource: 'inferred' as const,
  };
}

export async function applyInferredClassification(
  db: Db,
  tenantId: string,
  existing: ClassifiableProduct | null | undefined,
  snap: { grup?: string; nama?: string },
): Promise<Record<string, unknown>> {
  if (existing && isManualClassification(existing)) return {};
  const patch = inferredClassificationPatch(snap);
  if (
    existing?.id
    && resolveProductGudangKode(existing) !== patch.gudangKode
  ) {
    const moved = await relocateProductWarehouseWithAudit(db, {
      tenantId,
      product: existing,
      nextGudang: patch.gudangKode,
      reason: `Reclassify gudang dari grup ${snap.grup || '-'}`,
    });
    if ('error' in moved) throw new Error(moved.error);
  }
  return patch;
}

export async function reclassifyProductsForTenant(
  db: Db,
  tenantId: string | null | undefined,
  opts?: { dryRun?: boolean },
) {
  const tid = tenantId || 'default';
  const dryRun = opts?.dryRun === true;
  const products = await db.collection<ClassifiableProduct & { id: string }>('products')
    .find({ tenantId: tid })
    .toArray();

  const changes: Array<{
    id: string;
    kode?: string;
    nama?: string;
    fromGrup?: string;
    itemRole?: unknown;
    nextRole: string;
    gudangKode?: string | null;
    nextGudang: string;
    skipped?: string;
  }> = [];
  let updated = 0;
  let skipped = 0;
  let relocated = 0;

  for (const prod of products) {
    if (isManualClassification(prod)) {
      skipped += 1;
      changes.push({
        id: prod.id,
        kode: prod.kode,
        nama: prod.nama,
        nextRole: String(prod.itemRole || ''),
        nextGudang: String(prod.gudangKode || ''),
        skipped: 'manual',
      });
      continue;
    }
    const next = inferredClassificationPatch(prod);
    const roleSame = String(prod.itemRole || 'INGREDIENT') === next.itemRole;
    const gudangSame = resolveProductGudangKode(prod) === next.gudangKode;
    if (roleSame && gudangSame && prod.classificationSource === 'inferred') {
      skipped += 1;
      continue;
    }
    changes.push({
      id: prod.id,
      kode: prod.kode,
      nama: prod.nama,
      fromGrup: prod.grup,
      itemRole: prod.itemRole,
      nextRole: next.itemRole,
      gudangKode: prod.gudangKode,
      nextGudang: next.gudangKode,
    });
    if (dryRun) continue;
    if (!gudangSame) {
      const moved = await relocateProductWarehouseWithAudit(db, {
        tenantId: tid,
        product: prod,
        nextGudang: next.gudangKode,
        reason: `Reclassify gudang dari grup ${prod.grup || '-'}`,
      });
      if ('error' in moved) throw new Error(`${prod.kode}: ${moved.error}`);
      if (moved.moved > 0) relocated += 1;
    }
    await db.collection('products').updateOne(
      { tenantId: tid, id: prod.id },
      { $set: { ...next, updatedAt: new Date() } },
    );
    updated += 1;
  }

  return {
    products: products.length,
    updated,
    skipped,
    relocated,
    dryRun,
    changes: changes.filter((c) => !c.skipped || c.skipped === 'manual').slice(0, 500),
  };
}
