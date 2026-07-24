import type { Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { finishIntegrationCommand, startIntegrationCommand } from '@/lib/integration/command-log';
import { IntegrationError } from '@/lib/integration/errors';
import { defaultHttpTransport, throwIfHttpFailed } from '@/lib/integration/transport/http';
import type { IntegrationTransport } from '@/lib/integration/transport/types';
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
}

export function createIntegrationClient(db: Db, transport?: IntegrationTransport): IntegrationClient {
  return new IntegrationClient(db, transport);
}
