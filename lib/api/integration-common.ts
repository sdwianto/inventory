/** Helper integrasi B2B — shared antara modul Inventory (dedup Phase 3.6). */

export const INTEGRATION_WEBHOOK_EVENTS = [
  'sales_order.confirmed',
  'sales_order.updated',
  'sales_order.cancelled',
  'delivery.shipped',
  'invoice.posted',
  'credit_note.posted',
  'product.created',
  'product.updated',
  'product.deactivated',
] as const;

export const CUSTOMER_INVENTORY_EVENTS = [
  'sales_order.confirmed',
  'sales_order.updated',
  'sales_order.cancelled',
  'delivery.shipped',
  'invoice.posted',
  'credit_note.posted',
  'product.created',
  'product.updated',
  'product.deactivated',
] as const;

/** Trace end-to-end: `{customerPoId}:{noPO}` di webhook, REST, dan log. */
export function integrationCorrelationId(
  customerPoId?: string | null,
  noPO?: string | null,
): string | undefined {
  const id = String(customerPoId || '').trim();
  const po = String(noPO || '').trim();
  if (id && po) return `${id}:${po}`;
  return id || po || undefined;
}

export function withIntegrationCorrelation<T extends Record<string, unknown>>(payload: T): T & { correlationId?: string } {
  const correlationId = integrationCorrelationId(
    payload.customerPoId as string | undefined,
    payload.noPO as string | undefined,
  );
  if (!correlationId) return payload;
  return { ...payload, correlationId };
}

export function getSetupToken(): string | null {
  const configured = (process.env.INTEGRATION_SETUP_TOKEN || '').trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return null;
  return 'dev_pair_token_local_only';
}

/** Pastikan URL webhook inventory lengkap (`…/api/webhooks/sales`), bukan hanya origin. */
export function normalizeInventoryWebhookUrl(raw: string): string {
  const url = String(raw || '').trim();
  if (!url) return 'http://localhost:3001/api/webhooks/sales';
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '') || '/';
    if (path === '/' || path === '') {
      u.pathname = '/api/webhooks/sales';
      return u.toString().replace(/\/$/, '');
    }
    if (!path.includes('/api/webhooks/')) {
      u.pathname = '/api/webhooks/sales';
      return u.toString().replace(/\/$/, '');
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    const base = url.replace(/\/$/, '');
    if (/\/api\/webhooks\/sales$/i.test(base)) return base;
    return `${base}/api/webhooks/sales`;
  }
}

export function inventoryPairUrl(inventoryWebhookUrl: string): string {
  const url = String(inventoryWebhookUrl || '').trim();
  if (!url) return 'http://localhost:3001/api/integrations/pair';
  try {
    const u = new URL(url);
    return `${u.origin}/api/integrations/pair`;
  } catch {
    return url.replace(/\/api\/webhooks\/sales\/?$/, '/api/integrations/pair');
  }
}

export function inventoryPlatformPairUrl(inventoryWebhookUrl: string): string {
  const url = String(inventoryWebhookUrl || '').trim();
  if (!url) return 'http://localhost:3001/api/integrations/platform-pair';
  try {
    const u = new URL(url);
    return `${u.origin}/api/integrations/platform-pair`;
  } catch {
    return url.replace(/\/api\/webhooks\/sales\/?$/, '/api/integrations/platform-pair');
  }
}

export function salesFetchErrorMessage(err: unknown, salesUrl: string): string {
  const e = err as {
    cause?: { code?: string; message?: string };
    code?: string;
    name?: string;
    message?: string;
  };
  const cause = e?.cause || e;
  const code = cause?.code || e?.code;
  if (code === 'ECONNREFUSED') {
    return `Sales.app tidak dapat dihubungi di ${salesUrl}. Pastikan sales.app sudah berjalan (biasanya port 3000).`;
  }
  if (code === 'ENOTFOUND') {
    return `Alamat sales.app tidak ditemukan: ${salesUrl}`;
  }
  const msg = String(cause?.message || e?.message || '');
  if (
    e?.name === 'TimeoutError'
    || code === 'ABORT_ERR'
    || /signal timed out|aborted|timeout/i.test(msg)
  ) {
    return `Sales.app tidak merespons (timeout) — cek ${salesUrl} dan inventory-worker`;
  }
  return `Gagal menghubungi sales.app: ${msg || 'koneksi gagal'}`;
}
