import { withBulkhead, type BulkheadPool } from '@/lib/integration/bulkhead';
import { withCircuitBreaker } from '@/lib/integration/circuit-breaker';
import { IntegrationError, classifyHttpStatus } from '@/lib/integration/errors';
import type { IntegrationTransport, TransportRequest, TransportResponse } from '@/lib/integration/transport/types';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAbortTimeout(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = String((e as { name?: string }).name || '');
  return name === 'TimeoutError' || name === 'AbortError';
}

type BufferedResponse = TransportResponse & { _bodyText?: string };

async function rawFetch(req: TransportRequest): Promise<BufferedResponse> {
  const timeoutMs = req.timeoutMs ?? 35_000;
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (isAbortTimeout(e)) {
      throw new IntegrationError(`Timeout ${timeoutMs}ms ke ${req.url}`, {
        code: 'TIMEOUT',
        errorClass: 'timeout',
        retryable: true,
        correlationId: req.correlationId,
        cause: e,
      });
    }
    throw new IntegrationError(`Network error ke ${req.url}`, {
      code: 'NETWORK',
      errorClass: 'network',
      retryable: true,
      correlationId: req.correlationId,
      cause: e,
    });
  }

  const bodyText = await res.text();
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    _bodyText: bodyText,
    json: async () => {
      if (!bodyText) return {};
      return JSON.parse(bodyText) as unknown;
    },
    text: async () => bodyText,
  };
}

/**
 * HttpTransport — satu-satunya tempat retry / CB / bulkhead.
 * HTTP 5xx / 429 trip circuit breaker (Sales-down) agar fail-fast.
 */
export class HttpTransport implements IntegrationTransport {
  async request(req: TransportRequest): Promise<TransportResponse> {
    const maxAttempts = Math.max(1, req.maxAttempts ?? 1);
    const circuitName = `sales:${req.pool}`;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await withBulkhead(req.pool as BulkheadPool, () =>
          withCircuitBreaker(circuitName, async () => {
            const res = await rawFetch(req);
            // Trip CB on server/unavailable — validation 4xx tidak membuka circuit.
            if (!res.ok && (res.status >= 500 || res.status === 429)) {
              let body: Record<string, unknown> = {};
              try {
                body = await res.json() as Record<string, unknown>;
              } catch {
                body = {};
              }
              throwIfHttpFailed(res, body, req.correlationId);
            }
            return res;
          }),
        );
      } catch (e) {
        lastError = e;
        const code = e && typeof e === 'object' ? String((e as { code?: string }).code || '') : '';
        if (code === 'CIRCUIT_OPEN' || code === 'BULKHEAD_SATURATED') {
          throw new IntegrationError(
            code === 'CIRCUIT_OPEN'
              ? 'Sales unavailable (circuit open)'
              : `Bulkhead saturated (${req.pool})`,
            {
              code: code === 'CIRCUIT_OPEN' ? 'SERVICE_UNAVAILABLE' : 'BULKHEAD_SATURATED',
              errorClass: code === 'CIRCUIT_OPEN' ? 'circuit_open' : 'bulkhead',
              httpStatus: 503,
              retryable: false,
              correlationId: req.correlationId,
              cause: e,
            },
          );
        }
        const retryable = e instanceof IntegrationError ? e.retryable : true;
        if (!retryable || attempt >= maxAttempts) throw e;
        await sleep(Math.min(1000 * attempt, 3000));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new IntegrationError('Transport failed', { correlationId: req.correlationId, cause: lastError });
  }
}

export function throwIfHttpFailed(
  res: TransportResponse,
  body: Record<string, unknown>,
  correlationId?: string,
): void {
  if (res.ok) return;
  const classified = classifyHttpStatus(res.status);
  const msg = String(body.error || `HTTP ${res.status}`);
  throw new IntegrationError(msg, {
    code: String(body.code || classified.code),
    errorClass: classified.errorClass,
    httpStatus: res.status,
    retryable: classified.retryable,
    correlationId,
  });
}

export const defaultHttpTransport = new HttpTransport();
