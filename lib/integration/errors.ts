/** Klasifikasi error integrasi (retry ownership = Transport). */

export type IntegrationErrorClass =
  | 'validation'
  | 'authorization'
  | 'network'
  | 'timeout'
  | 'server'
  | 'circuit_open'
  | 'bulkhead'
  | 'unknown';

export class IntegrationError extends Error {
  readonly code: string;
  readonly errorClass: IntegrationErrorClass;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly correlationId?: string;

  constructor(
    message: string,
    opts: {
      code?: string;
      errorClass?: IntegrationErrorClass;
      httpStatus?: number;
      retryable?: boolean;
      correlationId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'IntegrationError';
    this.code = opts.code || 'INTEGRATION_ERROR';
    this.errorClass = opts.errorClass || 'unknown';
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable ?? false;
    this.correlationId = opts.correlationId;
  }
}

export function classifyHttpStatus(status: number): {
  errorClass: IntegrationErrorClass;
  retryable: boolean;
  code: string;
} {
  if (status === 400 || status === 422) {
    return { errorClass: 'validation', retryable: false, code: 'VALIDATION' };
  }
  if (status === 401 || status === 403) {
    return { errorClass: 'authorization', retryable: false, code: 'AUTH' };
  }
  if (status === 408 || status === 429) {
    return { errorClass: 'timeout', retryable: true, code: 'TIMEOUT' };
  }
  if (status === 503) {
    return { errorClass: 'server', retryable: true, code: 'SERVICE_UNAVAILABLE' };
  }
  if (status >= 500) {
    return { errorClass: 'server', retryable: true, code: 'SERVER_ERROR' };
  }
  return { errorClass: 'unknown', retryable: false, code: 'HTTP_ERROR' };
}
