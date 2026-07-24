import type { BulkheadPool } from '@/lib/integration/bulkhead';

export type TransportRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Timeout per attempt (ms). */
  timeoutMs?: number;
  /** Circuit + bulkhead pool name. */
  pool: BulkheadPool;
  /** Max attempts including first (Transport-owned). Category A: typically 1. */
  maxAttempts?: number;
  correlationId?: string;
};

export type TransportResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

export interface IntegrationTransport {
  request(req: TransportRequest): Promise<TransportResponse>;
}
