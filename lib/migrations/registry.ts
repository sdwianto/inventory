import type { Migration } from '@/lib/migrations/types';
import { recomputeRecipeConversionMigration } from '@/lib/migrations/0001-recompute-recipe-conversion';
import { backfillRecipeRevisionsMigration } from '@/lib/migrations/0002-backfill-recipe-revisions';
import { mergeDuplicateProductsMigration } from '@/lib/migrations/0003-merge-duplicate-products';
import { fixMasterStockDriftMigration } from '@/lib/migrations/0004-fix-master-stock-drift';
import { realignOrphanLotsMigration } from '@/lib/migrations/0005-realign-orphan-lots';
import { removeRecipeLinesMigration } from '@/lib/migrations/0006-remove-recipe-lines';
import { backfillStockCostMigration } from '@/lib/migrations/0007-backfill-stock-cost';
import { inventoryGlCutoverMigration } from '@/lib/migrations/0008-inventory-gl-cutover';
import { normalizeStockDustMigration } from '@/lib/migrations/0009-normalize-stock-dust';

/** Penanda kerangka aktif. Tidak mengubah data bisnis. */
export const frameworkNoopMigration: Migration = {
  id: '0000-framework-noop',
  description: 'Penanda kerangka migrasi aktif (tidak mengubah data)',
  async run() {
    return { summary: 'kerangka migrasi siap', before: {}, after: {}, changed: 0 };
  },
};

export const MIGRATIONS: readonly Migration[] = [
  frameworkNoopMigration,
  recomputeRecipeConversionMigration,
  backfillRecipeRevisionsMigration,
  mergeDuplicateProductsMigration,
  fixMasterStockDriftMigration,
  realignOrphanLotsMigration,
  removeRecipeLinesMigration,
  backfillStockCostMigration,
  inventoryGlCutoverMigration,
  normalizeStockDustMigration,
];

export function findMigration(id: string): Migration | undefined {
  return MIGRATIONS.find((m) => m.id === id);
}
