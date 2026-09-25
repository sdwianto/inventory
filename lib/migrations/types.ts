import type { Db } from 'mongodb';

export const MIGRATION_RUNS_COLLECTION = 'migration_runs';

export interface MigrationContext {
  db: Db;
  tenantId: string;
  /** true = jangan menulis data bisnis. Catatan migration_runs tetap disimpan oleh runner. */
  dryRun: boolean;
  now: Date;
  /** Pelaku (--by) untuk audit log dan riwayat dokumen. */
  actor?: string;
  /** Masukan tambahan migrasi (mis. file keputusan --decisions). Ikut dicatat di laporan. */
  options?: Record<string, unknown>;
}

export interface MigrationReport {
  summary: string;
  before: unknown;
  after: unknown;
  /** Jumlah dokumen yang berubah (0 pada dry-run yang tidak menulis). */
  changed: number;
}

export interface Migration {
  id: string;
  description: string;
  run(ctx: MigrationContext): Promise<MigrationReport>;
}

export type MigrationRunMode = 'DRY_RUN' | 'APPLY';
export type MigrationRunStatus = 'OK' | 'SKIPPED' | 'FAILED';
