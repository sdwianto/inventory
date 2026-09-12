/** Sweep + drain ENSURE_PRODUCT_ENRICHMENT yang PENDING/FAILED. */

import type { Db } from 'mongodb';
import {
  INTEGRATION_OUTBOX_COLLECTION,
  INTEGRATION_OUTBOX_TYPES,
} from '@/lib/api/integration-outbox';
import { drainEnsureProductEnrichment } from '@/lib/api/product-enrichment-outbox';
import { enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import { normalizeTenantId } from '@/lib/api/tenant-scope';

const MAX_AUTO_RECOVERY_ATTEMPTS = 15;
const STALE_BUCKET_MS = 45 * 1000;
const COOLDOWN_RESET_MS = 15 * 60 * 1000;

export async function listPendingProductEnrichmentOutbox(
  db: Db,
  opts: { limit?: number } = {},
): Promise<Array<{ aggregateId: string; tenantId: string; status: string; payload: Record<string, unknown> }>> {
  const limit = opts.limit ?? 40;
  const rows = await db
    .collection(INTEGRATION_OUTBOX_COLLECTION)
    .find({
      type: INTEGRATION_OUTBOX_TYPES.ENSURE_PRODUCT_ENRICHMENT,
      status: { $in: ['PENDING', 'FAILED'] },
    })
    .sort({ updatedAt: 1 })
    .limit(limit * 2)
    .project({ id: 1, aggregateId: 1, tenantId: 1, status: 1, payload: 1, attempts: 1, updatedAt: 1 })
    .toArray();

  const now = Date.now();
  const selected: typeof rows = [];
  for (const r of rows) {
    const attempts = Number(r.attempts || 0);
    const updatedMs = r.updatedAt instanceof Date ? r.updatedAt.getTime() : 0;
    if (attempts >= MAX_AUTO_RECOVERY_ATTEMPTS) {
      if (updatedMs && now - updatedMs >= COOLDOWN_RESET_MS) {
        await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
          { id: r.id },
          { $set: { attempts: 0, updatedAt: new Date() } },
        );
        selected.push(r);
      }
      continue;
    }
    selected.push(r);
    if (selected.length >= limit) break;
  }

  return selected.map((r) => ({
    aggregateId: String(r.aggregateId),
    tenantId: String(r.tenantId),
    status: String(r.status),
    payload: (r.payload && typeof r.payload === 'object')
      ? r.payload as Record<string, unknown>
      : {},
  }));
}

/** Inline drain satu baris outbox enrichment (dipakai job worker). */
export async function runProductEnrichmentSyncJob(
  db: Db,
  job: { tenantId: string; payload?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const productId = String(job.payload?.productId || job.payload?.aggregateId || '').trim();
  if (!productId) return { error: 'productId wajib' };
  const tenantId = normalizeTenantId(job.tenantId);
  const drained = await drainEnsureProductEnrichment(db, {
    tenantId,
    productId,
    vendorTenantId: job.payload?.vendorTenantId ? String(job.payload.vendorTenantId) : null,
    vendorStokId: job.payload?.vendorStokId ? String(job.payload.vendorStokId) : null,
    kode: job.payload?.kode ? String(job.payload.kode) : null,
    detailProduk: job.payload?.detailProduk != null ? String(job.payload.detailProduk) : null,
    fotos: Array.isArray(job.payload?.fotos) ? job.payload!.fotos.map(String) : null,
  });
  return {
    ok: drained.ok,
    skipped: drained.skipped,
    error: drained.error,
    outboxId: drained.outboxId,
    productId,
  };
}

/** Enqueue recovery jobs untuk outbox enrichment yang macet. */
export async function sweepPendingProductEnrichment(
  db: Db,
  opts: { limit?: number } = {},
): Promise<{ scanned: number; enqueued: number; drainedInline: number }> {
  const limit = opts.limit ?? 40;
  const now = Date.now();
  const pending = await listPendingProductEnrichmentOutbox(db, { limit });
  let enqueued = 0;
  let drainedInline = 0;

  for (const row of pending) {
    if (enqueued + drainedInline >= limit) break;
    const productId = row.aggregateId;
    const tenantId = normalizeTenantId(row.tenantId);
    const p = row.payload;

    // Coba drain inline dulu (murah); enqueue jika masih gagal / busy.
    const drained = await drainEnsureProductEnrichment(db, {
      tenantId,
      productId,
      vendorTenantId: p.vendorTenantId ? String(p.vendorTenantId) : null,
      vendorStokId: p.vendorStokId ? String(p.vendorStokId) : null,
      kode: p.kode ? String(p.kode) : null,
      detailProduk: p.detailProduk != null ? String(p.detailProduk) : null,
      fotos: Array.isArray(p.fotos) ? p.fotos.map(String) : null,
    });
    if (drained.ok) {
      drainedInline += 1;
      continue;
    }

    await enqueueJob(db, {
      type: JOB_TYPES.PRODUCT_ENRICHMENT_SYNC,
      tenantId,
      payload: {
        productId,
        aggregateId: productId,
        vendorTenantId: p.vendorTenantId || null,
        vendorStokId: p.vendorStokId || null,
        kode: p.kode || null,
        detailProduk: p.detailProduk ?? null,
        fotos: Array.isArray(p.fotos) ? p.fotos : null,
        recoverOutbox: true,
        dedupeKey: `enrich-sweep:${productId}:${Math.floor(now / STALE_BUCKET_MS)}`,
      },
    });
    enqueued += 1;
  }

  if (enqueued > 0) {
    scheduleJobProcessing(db, { limit: Math.min(20, enqueued) });
  }

  return { scanned: pending.length, enqueued, drainedInline };
}
