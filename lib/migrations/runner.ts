import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import {
  MIGRATION_RUNS_COLLECTION,
  type Migration,
  type MigrationReport,
  type MigrationRunMode,
  type MigrationRunStatus,
} from '@/lib/migrations/types';

const APPLY_CLAIM_INDEX = 'uniq_migration_apply_claim';

function isDuplicateKey(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as { code?: number }).code === 11000);
}

async function ensureApplyClaimIndex(db: Db): Promise<void> {
  await db.collection(MIGRATION_RUNS_COLLECTION).createIndex(
    { migrationId: 1, tenantId: 1 },
    {
      name: APPLY_CLAIM_INDEX,
      unique: true,
      partialFilterExpression: { activeClaim: true },
    },
  );
}

export function hashMigrationReport(report: MigrationReport): string {
  return createHash('sha256').update(JSON.stringify({
    summary: report.summary,
    before: report.before,
    after: report.after,
    changed: report.changed,
  })).digest('hex');
}

export interface ExecuteMigrationInput {
  db: Db;
  migration: Migration;
  tenantId: string;
  /** Default false: dry-run. */
  apply?: boolean;
  actor: string;
  reportDir: string;
  /** Jalankan lagi walau APPLY sebelumnya sudah OK. Migrasi sendiri wajib idempoten. */
  force?: boolean;
  now?: Date;
}

export interface ExecuteMigrationResult {
  id: string;
  migrationId: string;
  tenantId: string;
  mode: MigrationRunMode;
  status: MigrationRunStatus;
  summary: string;
  reportHash: string | null;
  reportPath: string | null;
  changed: number;
}

export async function executeMigration(input: ExecuteMigrationInput): Promise<ExecuteMigrationResult> {
  const now = input.now ?? new Date();
  const mode: MigrationRunMode = input.apply ? 'APPLY' : 'DRY_RUN';
  const actor = String(input.actor || '').trim() || 'system';
  const base = {
    id: uuidv4(),
    migrationId: input.migration.id,
    tenantId: input.tenantId,
    mode,
    actor,
    startedAt: now,
  };

  let claimed = false;
  if (mode === 'APPLY') {
    await ensureApplyClaimIndex(input.db);
    if (input.force) {
      await input.db.collection(MIGRATION_RUNS_COLLECTION).updateMany(
        { migrationId: input.migration.id, tenantId: input.tenantId, activeClaim: true },
        { $set: { activeClaim: false } },
      );
    }
    try {
      await input.db.collection(MIGRATION_RUNS_COLLECTION).insertOne({
        ...base,
        status: 'RUNNING',
        activeClaim: true,
        summary: 'berjalan',
        reportHash: null,
        reportPath: null,
        changed: 0,
      });
      claimed = true;
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      const prior = await input.db.collection(MIGRATION_RUNS_COLLECTION).findOne({
        migrationId: input.migration.id,
        tenantId: input.tenantId,
        activeClaim: true,
      });
      const skipped: ExecuteMigrationResult = {
        ...base,
        status: 'SKIPPED',
        summary: prior?.status === 'RUNNING'
          ? 'Migrasi yang sama sedang berjalan — tidak dijalankan ulang'
          : `Sudah diterapkan ${String(prior?.finishedAt || prior?.startedAt || '')} — lewati (idempoten)`,
        reportHash: prior?.reportHash ? String(prior.reportHash) : null,
        reportPath: null,
        changed: 0,
      };
      await input.db.collection(MIGRATION_RUNS_COLLECTION).insertOne({
        ...skipped,
        activeClaim: false,
        finishedAt: now,
      });
      return skipped;
    }
  }

  try {
    const report = await input.migration.run({
      db: input.db,
      tenantId: input.tenantId,
      dryRun: mode === 'DRY_RUN',
      now,
    });
    const reportHash = hashMigrationReport(report);
    mkdirSync(input.reportDir, { recursive: true });
    const file = path.join(
      input.reportDir,
      `${input.migration.id}-${input.tenantId}-${mode}-${now.getTime()}.json`,
    );
    writeFileSync(file, JSON.stringify({
      migrationId: input.migration.id,
      tenantId: input.tenantId,
      mode,
      actor,
      at: now.toISOString(),
      reportHash,
      ...report,
    }, null, 2));
    const result: ExecuteMigrationResult = {
      ...base,
      status: 'OK',
      summary: report.summary,
      reportHash,
      reportPath: file,
      changed: report.changed,
    };
    if (claimed) {
      await input.db.collection(MIGRATION_RUNS_COLLECTION).updateOne(
        { id: base.id },
        { $set: { ...result, activeClaim: true, finishedAt: new Date() } },
      );
    } else {
      await input.db.collection(MIGRATION_RUNS_COLLECTION).insertOne({
        ...result,
        activeClaim: false,
        finishedAt: new Date(),
      });
    }
    return result;
  } catch (e) {
    const summary = e instanceof Error ? e.message : String(e);
    const failed = {
      status: 'FAILED' as const,
      summary,
      reportHash: null,
      reportPath: null,
      changed: 0,
      activeClaim: false,
      finishedAt: new Date(),
    };
    if (claimed) {
      await input.db.collection(MIGRATION_RUNS_COLLECTION).updateOne({ id: base.id }, { $set: failed });
    } else {
      await input.db.collection(MIGRATION_RUNS_COLLECTION).insertOne({ ...base, ...failed });
    }
    throw e;
  }
}
