#!/usr/bin/env node
/**
 * execution:doctor — ops reconcile, semaphore drift, worker heartbeats, DLQ warnings.
 *
 * Usage:
 *   npm run execution:doctor
 *   npm run execution:doctor:dry-run
 *   MONGO_URL=... DB_NAME=... npm run execution:doctor
 */

import { MongoClient } from 'mongodb';
import { disconnectMessageBus } from '../lib/execution/bus';
import {
  formatDoctorReport,
  runExecutionDoctor,
} from '../lib/execution/ops/doctor';
import { validatePlatformConfig } from '../lib/execution/runtime/config';

const dryRun = process.argv.includes('--dry-run');
const fix = process.argv.includes('--fix');
const runRecovery = process.argv.includes('--recovery');
const validateConfig = process.argv.includes('--validate-config')
  || process.env.NODE_ENV === 'production';

async function main() {
  if (validateConfig) {
    validatePlatformConfig({ context: 'app' });
  }

  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'inventory_customer';

  let client: MongoClient | null = null;
  let db;

  if (!dryRun && uri) {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
  }

  try {
    const report = await runExecutionDoctor({ db, dryRun, fix, runRecovery });
    console.log(formatDoctorReport(report));
    if (report.warnings.length > 0) process.exitCode = 0;
  } finally {
    await disconnectMessageBus().catch(() => {});
    if (client) await client.close();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error('[execution:doctor] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
