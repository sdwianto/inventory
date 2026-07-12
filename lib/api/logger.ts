// Structured JSON logging for API / background jobs.

import {
  getCurrentCorrelationId,
  getCurrentTraceId,
} from '@/lib/execution/tracing/trace-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

function traceBindings(): LogFields {
  const traceId = getCurrentTraceId();
  const correlationId = getCurrentCorrelationId();
  const out: LogFields = {};
  if (traceId) out.traceId = traceId;
  if (correlationId) out.correlationId = correlationId;
  return out;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'inventory-app',
    message,
    ...traceBindings(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
