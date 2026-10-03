// Profil pajak tenant pembeli (NPWP, PKP, alamat) → pelanggan B2B di tiap vendor Sales.
// Faktur pajak keluaran vendor memakai identitas pelanggan itu; tanpa NPWP pembeli, PPN-nya tidak bisa dikreditkan.

import type { Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { enqueueJob, JOB_TYPES, scheduleJobProcessing } from '@/lib/api/bg-jobs';
import { listActiveLinksForCustomer, resolveSalesApiAccess } from '@/lib/api/integration-links';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { normalizeTenantTax, normalizeNpwpDigits } from '@/lib/api/tenant-tax';
import { createIntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
import type { JsonObject } from '@/types/json';

export type CustomerTaxProfile = {
  npwp: string;
  pkp: boolean;
  alamat: string;
  /** Versi profil (LWW di Sales) — waktu terakhir NPWP/status PKP/alamat diubah. */
  profileUpdatedAt: string;
};

export async function loadCustomerTaxProfile(db: Db, tenantId: string): Promise<CustomerTaxProfile> {
  const s = await db.collection('tenant_settings').findOne(
    { tenantId: normalizeTenantId(tenantId) },
    { projection: { companyNPWP: 1, companyAddress: 1, tax: 1, taxProfileUpdatedAt: 1, createdAt: 1 } },
  );
  const stamp = s?.taxProfileUpdatedAt || s?.createdAt || new Date(0);
  return {
    npwp: normalizeNpwpDigits(s?.companyNPWP),
    pkp: normalizeTenantTax(s?.tax).pkp,
    alamat: String(s?.companyAddress || '').trim().slice(0, 1000),
    profileUpdatedAt: new Date(stamp as string | Date).toISOString(),
  };
}

/** Antrekan push profil ke semua vendor ter-link (atau satu vendor). Dedupe per versi profil. */
export async function enqueueCustomerTaxProfilePush(
  db: Db,
  tenantId: string,
  vendorTenantId?: string,
  { schedule = true }: { schedule?: boolean } = {},
) {
  const tid = normalizeTenantId(tenantId);
  const { profileUpdatedAt } = await loadCustomerTaxProfile(db, tid);
  const enqueued = await enqueueJob(db, {
    type: JOB_TYPES.CUSTOMER_TAX_PROFILE_PUSH,
    tenantId: tid,
    payload: {
      ...(vendorTenantId ? { vendorTenantId } : {}),
      dedupeKey: `customer-tax-profile:${tid}:${vendorTenantId || '*'}:${profileUpdatedAt}`,
    },
  });
  if (schedule) scheduleJobProcessing(db, { limit: 1 });
  return enqueued;
}

/**
 * Sales baru membuat pelanggan B2B saat customer PO pertama masuk — push saat link dibuat bisa 404.
 * Dipanggil setelah PO tersinkron ke vendor: antrekan push bila versi profil terkini belum OK di vendor itu.
 */
export async function ensureCustomerTaxProfileSynced(db: Db, tenantId: string, vendorTenantId: string) {
  const tid = normalizeTenantId(tenantId);
  const link = await db.collection('integration_links').findOne(
    { customerTenantId: tid, vendorTenantId },
    { projection: { _id: 0, taxProfileSync: 1 } },
  );
  if (!link) return false;
  const { profileUpdatedAt } = await loadCustomerTaxProfile(db, tid);
  const sync = link.taxProfileSync as { status?: string; code?: string; retryable?: boolean; profileUpdatedAt?: string } | undefined;
  if (sync?.profileUpdatedAt === profileUpdatedAt) {
    if (sync.status === 'OK') return false;
    // Gagal bisnis lain (mis. NPWP duplikat) tidak sembuh dengan push ulang per PO.
    if (sync.code !== 'PELANGGAN_TIDAK_ADA' && sync.retryable === false) return false;
  }
  await enqueueCustomerTaxProfilePush(db, tid, vendorTenantId);
  return true;
}

export async function runCustomerTaxProfilePushJob(db: Db, job: JsonObject & { tenantId?: string; payload?: JsonObject }) {
  const tid = normalizeTenantId(job.tenantId || 'default');
  const onlyVendor = String(job.payload?.vendorTenantId || '').trim();
  const profile = await loadCustomerTaxProfile(db, tid);
  const links = (await listActiveLinksForCustomer(db, tid))
    .filter((l) => !onlyVendor || l.vendorTenantId === onlyVendor);
  const client = createIntegrationClient(db);
  const results: Array<{ vendorTenantId: string; ok: boolean; error?: string }> = [];
  let retryable = false;
  for (const link of links) {
    const access = await resolveSalesApiAccess(db, tid, String(link.vendorTenantId || ''));
    if (!access) continue;
    let status: { status: 'OK' | 'FAILED'; error?: string; code?: string; retryable?: boolean; applied?: boolean; reason?: string };
    try {
      const res = await client.pushCustomerTaxProfile({
        salesAppUrl: access.salesAppUrl,
        apiKey: access.salesApiKey,
        idempotencyKey: `customer-tax-profile:${tid}:${link.vendorTenantId}:${profile.profileUpdatedAt}`,
        correlationId: randomUUID(),
        body: { customerTenantId: tid, vendorTenantId: link.vendorTenantId, ...profile },
      });
      const data = (res || {}) as { applied?: unknown; reason?: unknown };
      status = {
        status: 'OK',
        ...(typeof data.applied === 'boolean' ? { applied: data.applied } : {}),
        ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
      };
    } catch (e) {
      const err = e instanceof IntegrationError ? e : null;
      const message = e instanceof Error ? e.message : String(e);
      // 4xx bisnis (mis. NPWP sudah dipakai pelanggan lain) tidak akan sembuh dengan retry.
      const canRetry = !err || err.retryable !== false;
      if (canRetry) retryable = true;
      status = { status: 'FAILED', error: message, retryable: canRetry, ...(err?.code ? { code: err.code } : {}) };
    }
    await db.collection('integration_links').updateOne(
      { customerTenantId: tid, vendorTenantId: link.vendorTenantId },
      { $set: { taxProfileSync: { ...status, profileUpdatedAt: profile.profileUpdatedAt, at: new Date() } } },
    );
    results.push({ vendorTenantId: String(link.vendorTenantId), ok: status.status === 'OK', ...(status.error ? { error: status.error } : {}) });
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length && retryable) {
    return { error: `Profil pajak gagal dikirim ke ${failed.map((f) => f.vendorTenantId).join(', ')}`, results };
  }
  return { pushed: results.length - failed.length, failed: failed.length, results };
}
