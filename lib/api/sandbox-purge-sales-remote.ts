/** Purge / preview sandbox di app Sales via HTTP — pakai SALES_APP_URL + WORKER_SECRET. */

import { resolveEffectiveSalesAppUrl } from '@/lib/api/sales-app-url';
import type { SandboxDbResult } from '@/lib/api/sandbox-purge';
import { summarizeSandboxCounts } from '@/lib/api/sandbox-purge';

type RemoteOutcome =
  | { ok: true; result: SandboxDbResult }
  | { ok: false; status: number; error: string; notFound?: boolean };

function workerHeaders(): Record<string, string> | null {
  const secret = (process.env.WORKER_SECRET || process.env.CRON_SECRET || '').trim();
  if (!secret) return null;
  return {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  };
}

function salesApiBase(): string | null {
  const base = resolveEffectiveSalesAppUrl().trim();
  if (!base) return null;
  return base.replace(/\/$/, '');
}

function mapRemoteDb(data: Record<string, unknown>, label: string): SandboxDbResult {
  const dbName = String(data.dbName || data.databaseName || '');
  const counts = (data.counts || {}) as SandboxDbResult['counts'];
  const summary = (data.summary as { documents?: number; collections?: number } | undefined)
    ?? summarizeSandboxCounts({ label, dbName, counts });
  return { label, dbName, counts, summary } as SandboxDbResult & { summary?: unknown };
}

async function parseRemoteResponse(res: Response): Promise<RemoteOutcome> {
  let data: Record<string, unknown> = {};
  try {
    data = await res.json() as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      notFound: res.status === 404,
      error: String(data.error || `Sales API HTTP ${res.status}`),
    };
  }
  const payload = (data.result || data) as Record<string, unknown>;
  return {
    ok: true,
    result: mapRemoteDb(payload, 'sales'),
  };
}

/** Preview transaksi di DB utama app Sales (kasir_db di server sales). */
export async function previewSalesSandboxRemote(
  tenantId?: string,
): Promise<RemoteOutcome | null> {
  const base = salesApiBase();
  const headers = workerHeaders();
  if (!base || !headers) return null;

  const qs = new URLSearchParams();
  if (tenantId) qs.set('tenantId', tenantId);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';

  try {
    const res = await fetch(`${base}/api/sandbox/worker-preview${suffix}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(45_000),
    });
    return parseRemoteResponse(res);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Eksekusi purge di app Sales — server sales memakai DB_NAME-nya sendiri. */
export async function executeSalesSandboxRemote(
  tenantId?: string,
): Promise<RemoteOutcome | null> {
  const base = salesApiBase();
  const headers = workerHeaders();
  if (!base || !headers) return null;

  try {
    const res = await fetch(`${base}/api/sandbox/worker-purge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tenantId: tenantId || null }),
      signal: AbortSignal.timeout(120_000),
    });
    return parseRemoteResponse(res);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function salesRemotePurgeConfigured(): boolean {
  return Boolean(salesApiBase() && workerHeaders());
}
