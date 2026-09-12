/** Inventory → Sales: sync detailProduk + fotos for vendor-sourced products. */

import type { Db } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import { resolveEffectiveSalesAppUrl } from '@/lib/api/sales-app-url';
import { absolutizeMediaUrls } from '@/lib/api/product-media';

export async function pushProductEnrichmentToSales(
  db: Db,
  product: {
    vendorStokId?: string | null;
    vendorTenantId?: string | null;
    kode?: string | null;
    detailProduk?: string | null;
    fotos?: string[] | null;
    detailFotosUpdatedAt?: unknown;
    correlationId?: string | null;
  },
): Promise<{ ok: boolean; skipped?: boolean; error?: string; skipReason?: string }> {
  void db;
  const vendorTenantId = String(product.vendorTenantId || '').trim();
  const productId = String(product.vendorStokId || '').trim();
  const kode = String(product.kode || '').trim();
  if (!vendorTenantId || (!productId && !kode)) {
    return { ok: true, skipped: true, skipReason: 'not_vendor_linked' };
  }

  const salesAppUrl = resolveEffectiveSalesAppUrl();
  const secret = String(process.env.WORKER_SECRET || process.env.CRON_SECRET || '').trim();
  if (!salesAppUrl || !secret) {
    return { ok: false, error: 'SALES_APP_URL atau WORKER_SECRET belum dikonfigurasi', skipReason: 'misconfigured' };
  }

  const correlationId = String(product.correlationId || randomUUID()).trim();
  const detailProduk = product.detailProduk ?? '';
  const fotos = absolutizeMediaUrls(Array.isArray(product.fotos) ? product.fotos.map(String) : []);
  const detailFotosUpdatedAt = product.detailFotosUpdatedAt instanceof Date
    ? product.detailFotosUpdatedAt.toISOString()
    : (product.detailFotosUpdatedAt != null ? String(product.detailFotosUpdatedAt) : new Date().toISOString());
  const body = {
    tenantId: vendorTenantId,
    ...(productId ? { productId } : {}),
    ...(kode ? { kode } : {}),
    detailProduk,
    fotos,
    detailFotosUpdatedAt,
    correlationId,
  };
  const contentRev = createHash('sha256')
    .update(JSON.stringify({ detailProduk, fotos, detailFotosUpdatedAt }))
    .digest('hex')
    .slice(0, 16);

  try {
    const res = await fetch(`${salesAppUrl}/api/integrations/product-enrichment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        'x-worker-secret': secret,
        'X-Correlation-Id': correlationId,
        'Idempotency-Key': productId
          ? `product-enrichment:${vendorTenantId}:${productId}:${contentRev}`
          : `product-enrichment:${vendorTenantId}:${kode}:${contentRev}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Sales enrichment HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
