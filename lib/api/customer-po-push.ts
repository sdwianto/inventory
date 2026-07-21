/** Kirim PO ke sales.app — shared oleh handler & bg_jobs. */

import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { enrichPoItemsForVendor, groupPoItemsByVendorTenant } from '@/lib/api/customer-po-vendor';
import { buildVendorSoSnapshot, mergeVendorSoSnapshots } from '@/lib/api/vendor-so-snapshot';
import {
  enrichSubmissionsWithSoFromSales,
  extractPushedVendorSo,
  submissionHasVendorSo,
  summarizeVendorNoSo,
} from '@/lib/api/customer-po-so-extract';
import { integrationCorrelationId, salesFetchErrorMessage } from '@/lib/api/integration-common';
import { recordIntegrationHold } from '@/lib/api/erp-hotpath-metrics';
import type { JsonObject } from '@/types/json';

const VENDOR_PUSH_RETRIES = 1;
/** Default hold per vendor — selaras Performance Budget PO_VENDOR_SYNC (P95 < 15s). */
const VENDOR_PUSH_TIMEOUT_MS = 15_000;

export type PushPoToVendorResult =
  | { error: string; partialFailures?: JsonObject[] }
  | { submissions: JsonObject[]; partialFailures?: JsonObject[] };

export type PushPoToVendorOptions = {
  /** Timeout per vendor per attempt (ms). */
  timeoutMs?: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function isTimeoutError(msg: string) {
  return /timeout|aborted|tidak merespons/i.test(msg);
}

/** Wake cold Vercel lambda sebelum push berat. */
export async function warmUpSalesApp(salesUrl: string): Promise<void> {
  try {
    await fetch(`${salesUrl.replace(/\/$/, '')}/api/`, {
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    /* ignore — warm-up best effort */
  }
}

async function pushPoGroupOnce(
  db: Db,
  { tenantId, config, po, vendorTenantId, items, timeoutMs }: {
    tenantId: string;
    config: { salesAppUrl: string };
    po: Record<string, unknown>;
    vendorTenantId: string;
    items: JsonObject[];
    timeoutMs: number;
  },
) {
  const salesUrl = config.salesAppUrl.replace(/\/$/, '');
  const apiKey = await getSalesApiKeyForVendor(db, tenantId, vendorTenantId);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  headers['Idempotency-Key'] = `cpo-push:${String(po.id)}:${vendorTenantId}`;

  let res: Response;
  try {
    res = await fetch(`${salesUrl}/api/integrations/customer-po`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        customerTenantId: tenantId,
        vendorTenantId,
        noPO: po.noPO,
        customerPoId: po.id,
        correlationId: integrationCorrelationId(String(po.id || ''), String(po.noPO || '')),
        tanggalKedatangan: po.tanggalKedatangan || po.tanggal || null,
        items,
        catatan: po.catatan || '',
        paymentTerms: po.paymentTerms || 'KREDIT',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { error: salesFetchErrorMessage(e, salesUrl), vendorTenantId };
  }

  let data: JsonObject;
  try {
    data = await res.json() as JsonObject;
  } catch {
    return {
      error: `Sales.app merespons HTTP ${res.status} tanpa data JSON valid`,
      vendorTenantId,
    };
  }
  if (!res.ok) return { error: String(data.error || `Sales.app ${res.status}`), vendorTenantId };
  return { vendorSo: data, vendorTenantId };
}

export async function pushPoGroupToVendor(
  db: Db,
  args: {
    tenantId: string;
    config: { salesAppUrl: string };
    po: Record<string, unknown>;
    vendorTenantId: string;
    items: JsonObject[];
    timeoutMs?: number;
  },
) {
  const timeoutMs = args.timeoutMs ?? VENDOR_PUSH_TIMEOUT_MS;
  const holdStarted = Date.now();
  let last = await pushPoGroupOnce(db, { ...args, timeoutMs });
  for (let attempt = 1; attempt < VENDOR_PUSH_RETRIES && last.error && isTimeoutError(last.error); attempt += 1) {
    await sleep(1_500 * attempt);
    last = await pushPoGroupOnce(db, { ...args, timeoutMs });
  }
  recordIntegrationHold(
    'inventory',
    'po_vendor_push',
    !last.error,
    Date.now() - holdStarted,
  );
  return last;
}

export async function pushPoToVendor(
  db: Db,
  po: Record<string, unknown>,
  tenantId: string,
  opts: PushPoToVendorOptions = {},
): Promise<PushPoToVendorResult> {
  const timeoutMs = opts.timeoutMs ?? VENDOR_PUSH_TIMEOUT_MS;
  const config = await getIntegrationConfig(db, tenantId);
  const apiKey = await getSalesApiKeyForVendor(db, tenantId);
  if (!apiKey) {
    return { error: 'Belum terhubung ke sales.app — jalankan pairing dari menu Integrasi atau sales.app /integrasi' };
  }

  const enriched = await enrichPoItemsForVendor(db, tenantId, (po.items || []) as JsonObject[]);
  if (enriched.error) return { error: enriched.error };

  const grouped = groupPoItemsByVendorTenant(enriched.items || []);
  if (grouped.error) return { error: grouped.error };

  const submissions: JsonObject[] = [];
  const partialFailures: JsonObject[] = [];
  const existingSubs = ((po.vendorSubmissions || []) as JsonObject[]);
  const syncedByVendor = new Map(
    existingSubs
      .filter((s) => s.status === 'SYNCED')
      .map((s) => [String(s.vendorTenantId), s]),
  );
  try {
    const groups = grouped.groups || [];
    const needsPush = groups.some((g) => !syncedByVendor.has(g.vendorTenantId));
    if (needsPush) await warmUpSalesApp(config.salesAppUrl);

    for (const { vendorTenantId, items } of groups) {
      const alreadySynced = syncedByVendor.get(vendorTenantId);
      if (alreadySynced) {
        submissions.push(alreadySynced);
        continue;
      }

      const pushed = await pushPoGroupToVendor(db, {
        tenantId,
        config,
        po,
        vendorTenantId,
        items,
        timeoutMs,
      });
      if (pushed.error) {
        partialFailures.push({
          vendorTenantId,
          status: 'FAILED',
          error: pushed.error,
          itemCount: items.length,
        });
        continue;
      }
      const soDoc = extractPushedVendorSo(pushed.vendorSo as JsonObject);
      submissions.push({
        vendorTenantId,
        status: 'SYNCED',
        vendorSoId: soDoc.id || soDoc.salesOrderId,
        vendorNoSO: soDoc.noSO,
        vendorSo: soDoc,
        itemCount: items.length,
      });
    }
  } catch (e) {
    return { error: salesFetchErrorMessage(e, config.salesAppUrl) };
  }

  if (!submissions.length && partialFailures.length) {
    return {
      error: String(partialFailures[0].error || 'Semua vendor gagal'),
      partialFailures,
    };
  }

  return {
    submissions,
    ...(partialFailures.length ? { partialFailures } : {}),
  };
}

export async function finalizePoSubmission(
  db: Db,
  po: Record<string, unknown>,
  submissions: JsonObject[],
  approver: Record<string, unknown> | null | undefined,
  { partialFailures = [] }: { partialFailures?: JsonObject[] } = {},
) {
  const needsSoLookup = submissions.some((sub) => !submissionHasVendorSo(sub));
  const syncedSubs = needsSoLookup && submissions.length
    ? await enrichSubmissionsWithSoFromSales(db, po as JsonObject, submissions)
    : submissions;
  const primary = syncedSubs[0] || {};
  const now = new Date();
  const allSubs = [...syncedSubs, ...partialFailures];
  const hasFailures = partialFailures.length > 0;
  const patch: Record<string, unknown> = {
    status: syncedSubs.length ? 'SUBMITTED' : 'APPROVED',
    vendorSubmissions: allSubs,
    vendorTenantId: syncedSubs.length === 1 ? primary.vendorTenantId : (syncedSubs.length ? 'multi' : po.vendorTenantId),
    vendorSoId: primary.vendorSoId,
    vendorNoSO: syncedSubs.length === 1
      ? primary.vendorNoSO
      : summarizeVendorNoSo(syncedSubs),
    submittedAt: syncedSubs.length ? now : po.submittedAt || null,
    updatedAt: now,
    vendorSyncPending: hasFailures,
    vendorSyncError: hasFailures
      ? partialFailures.map((f) => `${f.vendorTenantId}: ${f.error}`).join('; ')
      : null,
  };
  if (approver) {
    patch.approvedBy = {
      userId: approver.userId,
      userName: approver.userName,
      role: approver.role,
    };
    patch.approvedAt = now;
  }
  const soSnaps = syncedSubs.map((sub) => buildVendorSoSnapshot({
    ...(sub.vendorSo as JsonObject),
    salesOrderId: sub.vendorSoId,
    noSO: sub.vendorNoSO,
  })).filter(Boolean);
  const soSnap = mergeVendorSoSnapshots(soSnaps);
  if (soSnap) patch.vendorSoSnapshot = soSnap;
  await db.collection('customer_purchase_orders').updateOne({ id: po.id }, { $set: patch });
  return db.collection('customer_purchase_orders').findOne({ id: po.id });
}
