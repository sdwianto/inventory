import type { Migration } from '@/lib/migrations/types';

/** Penanda kerangka aktif. Tidak mengubah data bisnis. */
export const frameworkNoopMigration: Migration = {
  id: '0000-framework-noop',
  description: 'Penanda kerangka migrasi aktif (tidak mengubah data)',
  async run() {
    return { summary: 'kerangka migrasi siap', before: {}, after: {}, changed: 0 };
  },
};

export const MIGRATIONS: readonly Migration[] = [frameworkNoopMigration];

export function findMigration(id: string): Migration | undefined {
  return MIGRATIONS.find((m) => m.id === id);
}
