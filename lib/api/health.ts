/** Liveness/readiness — ping MongoDB untuk orchestrator (Docker/K8s). */

import type { Db } from 'mongodb';

const startedAt = Date.now();

export interface HealthPayload {
  status: 'ok' | 'degraded';
  app: string;
  uptimeSec: number;
  checks: {
    database: 'ok' | 'fail' | 'skipped';
    databaseError?: string;
  };
  timestamp: string;
}

export async function buildHealthResponse(db: Db | null, appName: string): Promise<HealthPayload> {
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  let database: HealthPayload['checks']['database'] = 'skipped';
  let databaseError: string | undefined;

  if (db) {
    try {
      await db.command({ ping: 1 });
      database = 'ok';
    } catch (e) {
      database = 'fail';
      databaseError = e instanceof Error ? e.message : 'ping failed';
    }
  } else {
    database = 'fail';
    databaseError = 'database connection unavailable';
  }

  const ready = database === 'ok';
  return {
    status: ready ? 'ok' : 'degraded',
    app: appName,
    uptimeSec,
    checks: {
      database,
      ...(databaseError ? { databaseError } : {}),
    },
    timestamp: new Date().toISOString(),
  };
}
