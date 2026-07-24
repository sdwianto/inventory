import type { Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { finishIntegrationCommand, startIntegrationCommand } from '@/lib/integration/command-log';
import { IntegrationError } from '@/lib/integration/errors';
import { defaultHttpTransport, throwIfHttpFailed } from '@/lib/integration/transport/http';
import type { IntegrationTransport } from '@/lib/integration/transport/types';
import { createIntegrationGateway, IntegrationGateway } from '@sdwianto/integration';
import { buildTraceHttpHeaders } from '@/lib/execution/tracing/trace-context';

export type CreateInvoiceFromGrnInput = {
  salesAppUrl: string;
  apiKey: string;
  correlationId?: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  /** Category A: sync only; default 35s. */
  timeoutMs?: number;
  grnId?: string | null;
};

export type CreateInvoiceFromGrnResult = {
  invoiceId: string;
  invoiceNo: string;
  noInvoice: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  noDO: string;
  vendorTenantId: string;
  hutangPushed?: boolean;
  hutangPushError?: string;
  webhookSent?: boolean;
  created?: boolean;
  posted?: boolean;
  invoicePayload: Record<string, unknown> | null;
  raw: Record<string, unknown>;
};

export type CreateSalesOrderFromPoInput = {
  salesAppUrl: string;
  apiKey: string;
  correlationId?: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  customerPoId?: string | null;
};

export type CreateSalesOrderFromPoResult = {
  salesOrderId: string;
  noSO: string;
  noPO: string;
  status: string;
  created?: boolean;
  existing?: boolean;
  vendorTenantId: string;
  customerPoId?: string;
  raw: Record<string, unknown>;
};

export type GetCustomerPoSoStatusInput = {
  salesAppUrl: string;
  apiKey: string;
  correlationId?: string;
  query: {
    customerTenantId: string;
    customerPoId?: string;
    noPO?: string;
    noSO?: string;
    vendorTenantId?: string;
  };
  timeoutMs?: number;
};

export type GetCustomerPoSoStatusResult = {
  salesOrderId: string;
  noSO: string;
  noPO: string;
  status: string;
  customerPoId?: string | null;
  customerTenantId?: string;
  raw: Record<string, unknown>;
};

export type CancelSalesOrderFromPoInput = {
  salesAppUrl: string;
  apiKey: string;
  correlationId?: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  customerPoId?: string | null;
};

export type CancelSalesOrderFromPoResult = {
  action: string;
  salesOrderId?: string;
  noSO?: string;
  vendorTenantId: string;
  raw: Record<string, unknown>;
};

function normalizeBaseUrl(url: string): string {
  return String(url || '').replace(/\/$/, '');
}

function normalizeInvoiceResponse(data: Record<string, unknown>): CreateInvoiceFromGrnResult {
  const nested = (data.result && typeof data.result === 'object')
    ? data.result as Record<string, unknown>
    : data;
  const invoiceId = String(nested.invoiceId || '').trim();
  const noInvoice = String(nested.invoiceNo || nested.noInvoice || '').trim();
  if (!invoiceId) {
    throw new IntegrationError('Sales.app tidak mengembalikan invoiceId — faktur tidak dibuat', {
      code: 'VALIDATION',
      errorClass: 'validation',
      retryable: false,
    });
  }
  const payload = (nested.invoicePayload && typeof nested.invoicePayload === 'object')
    ? nested.invoicePayload as Record<string, unknown>
    : null;
  const amount = parseInt(String(
    nested.amount ?? payload?.total ?? nested.total ?? 0,
  ), 10) || 0;

  return {
    invoiceId,
    invoiceNo: noInvoice,
    noInvoice,
    amount,
    currency: String(nested.currency || 'IDR'),
    status: String(nested.status || 'POSTED'),
    createdAt: String(nested.createdAt || payload?.postedAt || new Date().toISOString()),
    noDO: String(nested.noDO || ''),
    vendorTenantId: String(nested.vendorTenantId || ''),
    hutangPushed: nested.hutangPushed as boolean | undefined,
    hutangPushError: nested.hutangPushError as string | undefined,
    webhookSent: nested.webhookSent as boolean | undefined,
    created: nested.created as boolean | undefined,
    posted: nested.posted as boolean | undefined,
    invoicePayload: payload || (invoiceId ? {
      invoiceId,
      noInvoice,
      total: amount,
      ...nested,
    } : null),
    raw: nested,
  };
}

/**
 * IntegrationClient — satu pintu domain ke peer app.
 * Retry / CB / bulkhead hidup di Transport, bukan di sini.
 */
export class IntegrationClient {
  constructor(
    private readonly db: Db,
    private readonly transport: IntegrationTransport = defaultHttpTransport,
  ) {}

  /** Category A: CreateInvoice from GRN — sync SUCCESS|FAILED only (no soft-async). */
  async createInvoiceFromGrn(input: CreateInvoiceFromGrnInput): Promise<CreateInvoiceFromGrnResult> {
    const correlationId = String(input.correlationId || randomUUID()).trim();
    const base = normalizeBaseUrl(input.salesAppUrl);
    const url = `${base}/api/v1/integrations/grn-posted`;
    const commandId = await startIntegrationCommand(this.db, {
      correlationId,
      commandType: 'CreateInvoiceFromGrn',
      grnId: input.grnId || null,
    });

    try {
      const res = await this.transport.request({
        method: 'POST',
        url,
        pool: 'invoice',
        timeoutMs: input.timeoutMs ?? 35_000,
        maxAttempts: 1,
        correlationId,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/vnd.dawam.integration.v1+json',
          'X-Api-Key': input.apiKey,
          'Idempotency-Key': input.idempotencyKey,
          'X-Correlation-Id': correlationId,
          ...buildTraceHttpHeaders(),
        },
        body: JSON.stringify({
          ...input.body,
          correlationId,
        }),
      });

      let data: Record<string, unknown> = {};
      try {
        data = await res.json() as Record<string, unknown>;
      } catch {
        data = {};
      }

      if (res.status === 202) {
        throw new IntegrationError(
          'Sales mengembalikan 202 Pending — jalur happy path Category A tidak diizinkan',
          {
            code: 'ASYNC_NOT_ALLOWED',
            errorClass: 'server',
            httpStatus: 202,
            retryable: false,
            correlationId,
          },
        );
      }

      throwIfHttpFailed(res, data, correlationId);
      const normalized = normalizeInvoiceResponse(data);
      await finishIntegrationCommand(this.db, commandId, {
        status: 'SUCCEEDED',
        invoiceId: normalized.invoiceId,
      });
      return normalized;
    } catch (e) {
      const err = e instanceof IntegrationError
        ? e
        : new IntegrationError(e instanceof Error ? e.message : String(e), {
          correlationId,
          cause: e,
        });
      await finishIntegrationCommand(this.db, commandId, {
        status: 'FAILED',
        errorCode: err.code,
      });
      throw err;
    }
  }

  /** Category A: CreateSO from Customer PO — sync SUCCESS|FAILED only. */
  async createSalesOrderFromCustomerPo(
    input: CreateSalesOrderFromPoInput,
  ): Promise<CreateSalesOrderFromPoResult> {
    const correlationId = String(input.correlationId || randomUUID()).trim();
    const base = normalizeBaseUrl(input.salesAppUrl);
    const url = `${base}/api/v1/integrations/customer-po`;
    const commandId = await startIntegrationCommand(this.db, {
      correlationId,
      commandType: 'CreateSalesOrderFromPo',
      grnId: null,
    });

    try {
      const res = await this.transport.request({
        method: 'POST',
        url,
        pool: 'po',
        timeoutMs: input.timeoutMs ?? 25_000,
        maxAttempts: 1,
        correlationId,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/vnd.dawam.integration.v1+json',
          'X-Api-Key': input.apiKey,
          'Idempotency-Key': input.idempotencyKey,
          'X-Correlation-Id': correlationId,
          ...buildTraceHttpHeaders(),
        },
        body: JSON.stringify({
          ...input.body,
          correlationId,
        }),
      });

      let data: Record<string, unknown> = {};
      try {
        data = await res.json() as Record<string, unknown>;
      } catch {
        data = {};
      }

      if (res.status === 202) {
        throw new IntegrationError(
          'Sales mengembalikan 202 Pending — jalur happy path Category A tidak diizinkan',
          {
            code: 'ASYNC_NOT_ALLOWED',
            errorClass: 'server',
            httpStatus: 202,
            retryable: false,
            correlationId,
          },
        );
      }

      throwIfHttpFailed(res, data, correlationId);

      const nested = (data.result && typeof data.result === 'object')
        ? data.result as Record<string, unknown>
        : data;
      const salesOrderId = String(nested.salesOrderId || nested.id || '').trim();
      const noSO = String(nested.noSO || '').trim();
      if (!salesOrderId || !noSO) {
        throw new IntegrationError('Sales.app tidak mengembalikan salesOrderId/noSO', {
          code: 'VALIDATION',
          errorClass: 'validation',
          retryable: false,
          correlationId,
        });
      }

      const normalized: CreateSalesOrderFromPoResult = {
        salesOrderId,
        noSO,
        noPO: String(nested.noPO || input.body.noPO || ''),
        status: String(nested.status || 'DRAFT'),
        created: nested.created as boolean | undefined,
        existing: nested.existing as boolean | undefined,
        vendorTenantId: String(nested.vendorTenantId || nested.tenantId || input.body.vendorTenantId || ''),
        customerPoId: String(nested.customerPoId || input.customerPoId || input.body.customerPoId || ''),
        raw: nested,
      };

      await finishIntegrationCommand(this.db, commandId, {
        status: 'SUCCEEDED',
      });
      return normalized;
    } catch (e) {
      const err = e instanceof IntegrationError
        ? e
        : new IntegrationError(e instanceof Error ? e.message : String(e), {
          correlationId,
          cause: e,
        });
      await finishIntegrationCommand(this.db, commandId, {
        status: 'FAILED',
        errorCode: err.code,
      });
      throw err;
    }
  }

  /**
   * Category C: best-effort wake cold peer (Vercel). VPS/docker skip di caller.
   * Transport-owned — bukan fetch ad-hoc di domain.
   */
  async pingSalesApp(input: {
    salesAppUrl: string;
    correlationId?: string;
    timeoutMs?: number;
  }): Promise<void> {
    const correlationId = String(input.correlationId || randomUUID()).trim();
    const base = normalizeBaseUrl(input.salesAppUrl);
    const url = `${base}/api/`;
    try {
      await this.transport.request({
        method: 'GET',
        url,
        pool: 'notification',
        timeoutMs: input.timeoutMs ?? 8_000,
        maxAttempts: 1,
        correlationId,
        headers: {
          Accept: 'application/json',
          'X-Correlation-Id': correlationId,
          ...buildTraceHttpHeaders(),
        },
      });
    } catch {
      /* warm-up best effort */
    }
  }

  /** Category B: pull SO status for Customer PO (FP / CPO bridge). */
  async getCustomerPoSalesOrderStatus(
    input: GetCustomerPoSoStatusInput,
  ): Promise<GetCustomerPoSoStatusResult> {
    const correlationId = String(input.correlationId || randomUUID()).trim();
    const base = normalizeBaseUrl(input.salesAppUrl);
    const qs = new URLSearchParams({
      customerTenantId: input.query.customerTenantId,
      ...(input.query.customerPoId ? { customerPoId: input.query.customerPoId } : {}),
      ...(input.query.noPO ? { noPO: input.query.noPO } : {}),
      ...(input.query.noSO ? { noSO: input.query.noSO } : {}),
      ...(input.query.vendorTenantId ? { vendorTenantId: input.query.vendorTenantId } : {}),
    });
    const url = `${base}/api/v1/integrations/customer-po-status?${qs}`;
    const commandId = await startIntegrationCommand(this.db, {
      correlationId,
      commandType: 'GetCustomerPoSalesOrderStatus',
      grnId: null,
    });

    try {
      const res = await this.transport.request({
        method: 'GET',
        url,
        pool: 'po',
        timeoutMs: input.timeoutMs ?? 12_000,
        maxAttempts: 2,
        correlationId,
        headers: {
          Accept: 'application/vnd.dawam.integration.v1+json',
          'X-Api-Key': input.apiKey,
          'X-Correlation-Id': correlationId,
          ...buildTraceHttpHeaders(),
        },
      });

      let data: Record<string, unknown> = {};
      try {
        data = await res.json() as Record<string, unknown>;
      } catch {
        data = {};
      }

      throwIfHttpFailed(res, data, correlationId);

      const nested = (data.result && typeof data.result === 'object')
        ? data.result as Record<string, unknown>
        : data;
      const salesOrderId = String(nested.salesOrderId || nested.id || '').trim();
      const noSO = String(nested.noSO || '').trim();
      if (!salesOrderId || !noSO) {
        throw new IntegrationError('Sales.app tidak mengembalikan salesOrderId/noSO', {
          code: 'VALIDATION',
          errorClass: 'validation',
          retryable: false,
          correlationId,
        });
      }

      const normalized: GetCustomerPoSoStatusResult = {
        salesOrderId,
        noSO,
        noPO: String(nested.noPO || ''),
        status: String(nested.status || ''),
        customerPoId: (nested.customerPoId as string | null | undefined) ?? null,
        customerTenantId: String(nested.customerTenantId || input.query.customerTenantId || ''),
        raw: nested,
      };

      await finishIntegrationCommand(this.db, commandId, { status: 'SUCCEEDED' });
      return normalized;
    } catch (e) {
      const err = e instanceof IntegrationError
        ? e
        : new IntegrationError(e instanceof Error ? e.message : String(e), {
          correlationId,
          cause: e,
        });
      await finishIntegrationCommand(this.db, commandId, {
        status: 'FAILED',
        errorCode: err.code,
      });
      throw err;
    }
  }

  /** Category A: cancel SO from Customer PO (FP / CPO cancel). */
  async cancelSalesOrderFromCustomerPo(
    input: CancelSalesOrderFromPoInput,
  ): Promise<CancelSalesOrderFromPoResult> {
    const correlationId = String(input.correlationId || randomUUID()).trim();
    const base = normalizeBaseUrl(input.salesAppUrl);
    const url = `${base}/api/v1/integrations/customer-po/cancel`;
    const commandId = await startIntegrationCommand(this.db, {
      correlationId,
      commandType: 'CancelSalesOrderFromPo',
      grnId: null,
    });

    try {
      const res = await this.transport.request({
        method: 'POST',
        url,
        pool: 'po',
        timeoutMs: input.timeoutMs ?? 15_000,
        maxAttempts: 1,
        correlationId,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/vnd.dawam.integration.v1+json',
          'X-Api-Key': input.apiKey,
          'Idempotency-Key': input.idempotencyKey,
          'X-Correlation-Id': correlationId,
          ...buildTraceHttpHeaders(),
        },
        body: JSON.stringify({
          ...input.body,
          correlationId,
        }),
      });

      let data: Record<string, unknown> = {};
      try {
        data = await res.json() as Record<string, unknown>;
      } catch {
        data = {};
      }

      if (res.status === 202) {
        throw new IntegrationError(
          'Sales mengembalikan 202 Pending — jalur happy path Category A tidak diizinkan',
          {
            code: 'ASYNC_NOT_ALLOWED',
            errorClass: 'server',
            httpStatus: 202,
            retryable: false,
            correlationId,
          },
        );
      }

      throwIfHttpFailed(res, data, correlationId);

      const nested = (data.result && typeof data.result === 'object')
        ? data.result as Record<string, unknown>
        : data;
      const action = String(nested.action || '').trim();
      if (!action) {
        throw new IntegrationError('Sales.app tidak mengembalikan action cancel', {
          code: 'VALIDATION',
          errorClass: 'validation',
          retryable: false,
          correlationId,
        });
      }

      const normalized: CancelSalesOrderFromPoResult = {
        action,
        salesOrderId: nested.salesOrderId ? String(nested.salesOrderId) : undefined,
        noSO: nested.noSO ? String(nested.noSO) : undefined,
        vendorTenantId: String(nested.vendorTenantId || input.body.vendorTenantId || ''),
        raw: nested,
      };

      await finishIntegrationCommand(this.db, commandId, { status: 'SUCCEEDED' });
      return normalized;
    } catch (e) {
      const err = e instanceof IntegrationError
        ? e
        : new IntegrationError(e instanceof Error ? e.message : String(e), {
          correlationId,
          cause: e,
        });
      await finishIntegrationCommand(this.db, commandId, {
        status: 'FAILED',
        errorCode: err.code,
      });
      throw err;
    }
  }

  /** Category B GET helper — Correlation + Api-Key; no Idempotency-Key. */
  private async categoryBGet(input: {
    salesAppUrl: string;
    apiKey: string;
    pathAndQuery: string;
    commandType: string;
    pool: 'po' | 'catalog' | 'notification' | 'invoice';
    correlationId?: string;
    timeoutMs?: number;
    maxAttempts?: number;
    grnId?: string | null;
  }): Promise<Record<string, unknown>> {
    const correlationId = String(input.correlationId || randomUUID()).trim();
    const base = normalizeBaseUrl(input.salesAppUrl);
    const url = `${base}${input.pathAndQuery.startsWith('/') ? '' : '/'}${input.pathAndQuery}`;
    const commandId = await startIntegrationCommand(this.db, {
      correlationId,
      commandType: input.commandType,
      grnId: input.grnId ?? null,
    });
    try {
      const res = await this.transport.request({
        method: 'GET',
        url,
        pool: input.pool,
        timeoutMs: input.timeoutMs ?? 30_000,
        maxAttempts: input.maxAttempts ?? 2,
        correlationId,
        headers: {
          Accept: 'application/vnd.dawam.integration.v1+json',
          'X-Api-Key': input.apiKey,
          'X-Correlation-Id': correlationId,
          ...buildTraceHttpHeaders(),
        },
      });
      let data: Record<string, unknown> = {};
      try {
        data = await res.json() as Record<string, unknown>;
      } catch {
        data = {};
      }
      throwIfHttpFailed(res, data, correlationId);
      await finishIntegrationCommand(this.db, commandId, { status: 'SUCCEEDED' });
      return data;
    } catch (e) {
      const err = e instanceof IntegrationError
        ? e
        : new IntegrationError(e instanceof Error ? e.message : String(e), {
          correlationId,
          cause: e,
        });
      await finishIntegrationCommand(this.db, commandId, {
        status: 'FAILED',
        errorCode: err.code,
      });
      throw err;
    }
  }

  /** Category B: delivery lookup sebelum CreateInvoice. */
  async lookupDeliveryFromSales(input: {
    salesAppUrl: string;
    apiKey: string;
    correlationId?: string;
    query: {
      customerTenantId: string;
      deliveryId?: string;
      noDO?: string;
      vendorTenantId?: string;
    };
    timeoutMs?: number;
    grnId?: string | null;
  }): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({ customerTenantId: input.query.customerTenantId });
    if (input.query.deliveryId) qs.set('deliveryId', input.query.deliveryId);
    if (input.query.noDO) qs.set('noDO', input.query.noDO);
    if (input.query.vendorTenantId) qs.set('vendorTenantId', input.query.vendorTenantId);
    return this.categoryBGet({
      salesAppUrl: input.salesAppUrl,
      apiKey: input.apiKey,
      pathAndQuery: `/api/v1/integrations/delivery-lookup?${qs}`,
      commandType: 'LookupDeliveryFromSales',
      pool: 'notification',
      correlationId: input.correlationId,
      timeoutMs: input.timeoutMs ?? 30_000,
      grnId: input.grnId,
    });
  }

  /** Category B: pull posted invoices (satu halaman cursor). */
  async pullPostedInvoicesPage(input: {
    salesAppUrl: string;
    apiKey: string;
    correlationId?: string;
    query: {
      customerTenantId: string;
      vendorTenantId?: string;
      noDO?: string;
      cursor?: string | null;
      limit?: number;
    };
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({
      customerTenantId: input.query.customerTenantId,
      pageMode: 'cursor',
      limit: String(input.query.limit ?? 100),
    });
    if (input.query.vendorTenantId) qs.set('vendorTenantId', input.query.vendorTenantId);
    if (input.query.noDO) qs.set('noDO', input.query.noDO);
    if (input.query.cursor) qs.set('cursor', input.query.cursor);
    return this.categoryBGet({
      salesAppUrl: input.salesAppUrl,
      apiKey: input.apiKey,
      pathAndQuery: `/api/v1/integrations/customer-invoices?${qs}`,
      commandType: 'PullPostedInvoices',
      pool: 'invoice',
      correlationId: input.correlationId,
      timeoutMs: input.timeoutMs ?? 60_000,
    });
  }

  /** Category B: list customer shipments (DO shipped). */
  async listCustomerShipments(input: {
    salesAppUrl: string;
    apiKey: string;
    correlationId?: string;
    query: { customerTenantId: string; vendorTenantId?: string };
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({ customerTenantId: input.query.customerTenantId });
    if (input.query.vendorTenantId) qs.set('vendorTenantId', input.query.vendorTenantId);
    return this.categoryBGet({
      salesAppUrl: input.salesAppUrl,
      apiKey: input.apiKey,
      pathAndQuery: `/api/v1/integrations/customer-shipments?${qs}`,
      commandType: 'ListCustomerShipments',
      pool: 'notification',
      correlationId: input.correlationId,
      timeoutMs: input.timeoutMs ?? 30_000,
    });
  }

  /** Category B: catalog page (allTenants). */
  async pullCatalogPage(input: {
    salesAppUrl: string;
    apiKey: string;
    correlationId?: string;
    query?: { cursor?: string; updatedSince?: string | null; limit?: number };
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({
      allTenants: 'true',
      limit: String(input.query?.limit ?? 500),
    });
    if (input.query?.cursor) qs.set('cursor', input.query.cursor);
    if (input.query?.updatedSince) qs.set('updatedSince', input.query.updatedSince);
    return this.categoryBGet({
      salesAppUrl: input.salesAppUrl,
      apiKey: input.apiKey,
      pathAndQuery: `/api/v1/integrations/catalog?${qs}`,
      commandType: 'PullCatalog',
      pool: 'catalog',
      correlationId: input.correlationId,
      timeoutMs: input.timeoutMs ?? 60_000,
      maxAttempts: 1,
    });
  }

  /** Category B: customer profile (vendor tiers). */
  async getCustomerProfile(input: {
    salesAppUrl: string;
    apiKey: string;
    correlationId?: string;
    customerTenantId: string;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({ customerTenantId: input.customerTenantId });
    return this.categoryBGet({
      salesAppUrl: input.salesAppUrl,
      apiKey: input.apiKey,
      pathAndQuery: `/api/v1/integrations/customer-profile?${qs}`,
      commandType: 'GetCustomerProfile',
      pool: 'notification',
      correlationId: input.correlationId,
      timeoutMs: input.timeoutMs ?? 20_000,
    });
  }

  /** Category B: vendor profile / store (hutang enrich). Tries profile then store. */
  async getVendorProfile(input: {
    salesAppUrl: string;
    apiKey: string;
    correlationId?: string;
    vendorTenantId: string;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({ tenantId: input.vendorTenantId });
    try {
      return await this.categoryBGet({
        salesAppUrl: input.salesAppUrl,
        apiKey: input.apiKey,
        pathAndQuery: `/api/v1/integrations/vendor-profile?${qs}`,
        commandType: 'GetVendorProfile',
        pool: 'notification',
        correlationId: input.correlationId,
        timeoutMs: input.timeoutMs ?? 8_000,
        maxAttempts: 1,
      });
    } catch (e) {
      if (e instanceof IntegrationError && e.httpStatus === 404) {
        return this.categoryBGet({
          salesAppUrl: input.salesAppUrl,
          apiKey: input.apiKey,
          pathAndQuery: `/api/v1/integrations/vendor-store?${qs}`,
          commandType: 'GetVendorStore',
          pool: 'notification',
          correlationId: input.correlationId,
          timeoutMs: input.timeoutMs ?? 8_000,
          maxAttempts: 1,
        });
      }
      throw e;
    }
  }
}

/** Inject FakeTransport or HttpTransport — Gateway wraps without changing domain methods. */
export function createIntegrationClient(db: Db, transport?: IntegrationTransport): IntegrationClient {
  const underlying = transport ?? defaultHttpTransport;
  const gated = underlying instanceof IntegrationGateway
    ? underlying
    : createIntegrationGateway(underlying);
  return new IntegrationClient(db, gated);
}
