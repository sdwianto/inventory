/**
 * ENSURE_PRODUCT_ENRICHMENT — Inventory Detail/Foto → Sales (Category A outbox).
 * aggregateId = local inventory product id; reopen DONE on every edit.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { logger } from '@/lib/api/logger';
import {
  INTEGRATION_OUTBOX_COLLECTION,
  INTEGRATION_OUTBOX_TYPES,
  type IntegrationOutboxDoc,
} from '@/lib/api/integration-outbox';
import { pushProductEnrichmentToSales } from '@/lib/api/product-enrichment-push';

const STALE_PROCESSING_MS = 2 * 60 * 1000;

async function markOutboxDone(db: Db, claimed: IntegrationOutboxDoc): Promise<'done' | 'reopened'> {
  const now = new Date();
  const claimToken = (claimed as { claimToken?: string }).claimToken;
  const current = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne({ id: claimed.id });
  if (current?.reopenAfterDrain === true) {
    await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
      { id: claimed.id, status: 'PROCESSING' },
      {
        $set: {
          status: 'PENDING',
          lastError: null,
          reopenAfterDrain: false,
          updatedAt: now,
        },
        $unset: { claimToken: '' },
      },
    );
    return 'reopened';
  }
  const filter: Record<string, unknown> = { id: claimed.id, status: 'PROCESSING' };
  if (claimToken) filter.claimToken = claimToken;
  await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
    filter,
    {
      $set: { status: 'DONE', lastError: null, updatedAt: now, processedAt: now, reopenAfterDrain: false },
      $unset: { claimToken: '' },
    },
  );
  return 'done';
}

async function markOutboxFailed(db: Db, claimed: IntegrationOutboxDoc, lastError: string): Promise<void> {
  const now = new Date();
  const claimToken = (claimed as { claimToken?: string }).claimToken;
  const current = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne({ id: claimed.id });
  if (current?.reopenAfterDrain === true) {
    await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
      { id: claimed.id, status: 'PROCESSING' },
      {
        $set: {
          status: 'PENDING',
          lastError: null,
          reopenAfterDrain: false,
          updatedAt: now,
        },
        $unset: { claimToken: '' },
      },
    );
    return;
  }
  const filter: Record<string, unknown> = { id: claimed.id, status: 'PROCESSING' };
  if (claimToken) filter.claimToken = claimToken;
  await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
    filter,
    {
      $set: {
        status: 'FAILED',
        lastError: lastError.slice(0, 2000),
        updatedAt: now,
        processedAt: now,
        reopenAfterDrain: false,
      },
      $unset: { claimToken: '' },
    },
  );
}

export async function ensureProductEnrichmentOutboxPending(
  db: Db,
  input: {
    tenantId: string;
    productId: string;
    vendorTenantId: string;
    vendorStokId?: string | null;
    kode?: string | null;
    detailProduk?: string | null;
    fotos?: string[] | null;
    correlationId?: string | null;
  },
): Promise<{ id: string }> {
  const aggregateId = String(input.productId).trim();
  const now = new Date();
  const payload = {
    productId: aggregateId,
    vendorTenantId: input.vendorTenantId,
    vendorStokId: input.vendorStokId || null,
    kode: input.kode || null,
    detailProduk: input.detailProduk ?? '',
    fotos: Array.isArray(input.fotos) ? input.fotos : [],
  };

  const existing = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne({
    type: INTEGRATION_OUTBOX_TYPES.ENSURE_PRODUCT_ENRICHMENT,
    aggregateId,
  });

  if (!existing) {
    const id = randomUUID();
    const doc: IntegrationOutboxDoc = {
      id,
      type: INTEGRATION_OUTBOX_TYPES.ENSURE_PRODUCT_ENRICHMENT,
      aggregateId,
      tenantId: input.tenantId,
      payload,
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      correlationId: input.correlationId || null,
      createdAt: now,
      updatedAt: now,
      processedAt: null,
    };
    try {
      await db.collection(INTEGRATION_OUTBOX_COLLECTION).insertOne(doc);
      return { id };
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? Number((e as { code: number }).code) : 0;
      if (code === 11000) {
        const again = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne({
          type: INTEGRATION_OUTBOX_TYPES.ENSURE_PRODUCT_ENRICHMENT,
          aggregateId,
        });
        if (again) {
          await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
            { id: again.id },
            {
              $set: {
                status: 'PENDING',
                lastError: null,
                payload,
                correlationId: input.correlationId || again.correlationId || null,
                updatedAt: now,
              },
            },
          );
          return { id: String(again.id) };
        }
      }
      throw e;
    }
  }

  // Jangan ganggu PROCESSING segar — refresh payload + flag reopen.
  const status = String(existing.status || '');
  if (status === 'PROCESSING') {
    await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
      { id: existing.id },
      {
        $set: {
          payload,
          correlationId: input.correlationId || existing.correlationId || null,
          reopenAfterDrain: true,
          updatedAt: now,
        },
      },
    );
    return { id: String(existing.id) };
  }

  await db.collection(INTEGRATION_OUTBOX_COLLECTION).updateOne(
    { id: existing.id },
    {
      $set: {
        status: 'PENDING',
        lastError: null,
        payload,
        correlationId: input.correlationId || existing.correlationId || null,
        updatedAt: now,
      },
    },
  );
  return { id: String(existing.id) };
}

async function claimProductEnrichmentOutbox(
  db: Db,
  aggregateId: string,
): Promise<IntegrationOutboxDoc | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  const claimed = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOneAndUpdate(
    {
      type: INTEGRATION_OUTBOX_TYPES.ENSURE_PRODUCT_ENRICHMENT,
      aggregateId,
      $or: [
        { status: 'PENDING' },
        { status: 'FAILED' },
        { status: 'PROCESSING', updatedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        status: 'PROCESSING',
        updatedAt: now,
        claimToken: randomUUID(),
        reopenAfterDrain: false,
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  );
  return (claimed as IntegrationOutboxDoc | null) || null;
}

export async function drainEnsureProductEnrichment(
  db: Db,
  input: {
    tenantId: string;
    productId: string;
    vendorTenantId?: string | null;
    vendorStokId?: string | null;
    kode?: string | null;
    detailProduk?: string | null;
    fotos?: string[] | null;
    correlationId?: string | null;
  },
): Promise<{ ok: boolean; skipped?: boolean; error?: string; outboxId: string | null }> {
  const productId = String(input.productId || '').trim();
  if (!productId) {
    return { ok: false, error: 'productId wajib', outboxId: null };
  }

  if (input.vendorTenantId) {
    await ensureProductEnrichmentOutboxPending(db, {
      tenantId: input.tenantId,
      productId,
      vendorTenantId: String(input.vendorTenantId),
      vendorStokId: input.vendorStokId,
      kode: input.kode,
      detailProduk: input.detailProduk,
      fotos: input.fotos,
      correlationId: input.correlationId,
    });
  }

  const claimed = await claimProductEnrichmentOutbox(db, productId);
  if (!claimed) {
    const again = await db.collection(INTEGRATION_OUTBOX_COLLECTION).findOne({
      type: INTEGRATION_OUTBOX_TYPES.ENSURE_PRODUCT_ENRICHMENT,
      aggregateId: productId,
    });
    if (again?.status === 'DONE') {
      return { ok: true, outboxId: String(again.id) };
    }
    return {
      ok: false,
      error: again?.status === 'PROCESSING'
        ? 'Outbox sedang diproses worker lain'
        : 'Outbox tidak bisa diklaim',
      outboxId: again ? String(again.id) : null,
    };
  }

  const p = claimed.payload || {};
  // Re-read live product — tutup race edit mid-drain + stamp LWW.
  const live = await db.collection('products').findOne(
    { id: productId, tenantId: input.tenantId },
    {
      projection: {
        vendorStokId: 1,
        vendorTenantId: 1,
        kode: 1,
        detailProduk: 1,
        fotos: 1,
        detailFotosUpdatedAt: 1,
      },
    },
  );
  const pushed = await pushProductEnrichmentToSales(db, {
    vendorStokId: String(
      live?.vendorStokId || input.vendorStokId || p.vendorStokId || '',
    ),
    vendorTenantId: String(
      live?.vendorTenantId || input.vendorTenantId || p.vendorTenantId || '',
    ),
    kode: String(live?.kode || input.kode || p.kode || ''),
    detailProduk: live
      ? String(live.detailProduk ?? '')
      : String(input.detailProduk !== undefined ? input.detailProduk : (p.detailProduk ?? '')),
    fotos: live && Array.isArray(live.fotos)
      ? live.fotos.map(String)
      : (Array.isArray(input.fotos)
        ? input.fotos
        : (Array.isArray(p.fotos) ? p.fotos.map(String) : [])),
    detailFotosUpdatedAt: live?.detailFotosUpdatedAt ?? new Date(),
    correlationId: input.correlationId || claimed.correlationId,
  });

  if (pushed.skipped) {
    await markOutboxDone(db, claimed);
    return { ok: true, skipped: true, outboxId: claimed.id };
  }

  if (pushed.ok) {
    const settle = await markOutboxDone(db, claimed);
    logger.info('integration_outbox_drained', {
      tenantId: input.tenantId,
      productId,
      outboxId: claimed.id,
      type: INTEGRATION_OUTBOX_TYPES.ENSURE_PRODUCT_ENRICHMENT,
      status: settle === 'reopened' ? 'PENDING' : 'DONE',
      attempts: claimed.attempts,
    });
    return { ok: true, outboxId: claimed.id };
  }

  await markOutboxFailed(db, claimed, pushed.error || 'enrichment push failed');
  logger.info('integration_outbox_drained', {
    tenantId: input.tenantId,
    productId,
    outboxId: claimed.id,
    type: INTEGRATION_OUTBOX_TYPES.ENSURE_PRODUCT_ENRICHMENT,
    status: 'FAILED',
    attempts: claimed.attempts,
    error: pushed.error,
  });
  return {
    ok: false,
    error: pushed.error,
    outboxId: claimed.id,
  };
}
