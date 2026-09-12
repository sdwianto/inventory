/**
 * Audit / reconcile stok_lokasi + product.stok ke saldo kartu stok.
 *
 * Default: DRY-RUN (aman, tidak menulis).
 *
 * Usage:
 *   npx tsx scripts/reconcile-stok-lokasi-to-ledger.ts sppg
 *   npx tsx scripts/reconcile-stok-lokasi-to-ledger.ts sppg --apply
 *   npx tsx scripts/reconcile-stok-lokasi-to-ledger.ts sppg --apply --clear-negative
 */
import { MongoClient } from 'mongodb';
import { reconcileTenantStockFromLedger } from '../lib/api/stock-ledger';

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, '--apply');
  const clearNegative = hasFlag(argv, '--clear-negative');
  const tenantId = argv.find((a) => !a.startsWith('--')) || process.env.TENANT_ID || 'sppg';
  const url = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?directConnection=true';
  const dbName = process.env.DB_NAME || 'inventory_customer';

  if (clearNegative && !apply) {
    console.error('Refusing --clear-negative without --apply (would be a no-op / confusing).');
    process.exit(2);
  }

  const client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db = client.db(dbName);
  console.log(JSON.stringify({
    tenantId,
    dbName,
    mode: apply ? 'APPLY' : 'DRY_RUN',
    clearNegative,
  }));

  const summary = await reconcileTenantStockFromLedger(db, tenantId, {
    dryRun: !apply,
    clearNegative,
  });

  const preview = (summary.drifts || []).slice(0, 30).map((d) => ({
    kode: d.kode,
    ledger: d.ledgerSaldo,
    lokasiHome: d.lokasiHome,
    master: d.masterStok,
    issues: d.issues,
  }));

  console.log(JSON.stringify({
    dryRun: summary.dryRun,
    clearNegative: summary.clearNegative,
    scanned: summary.scanned,
    driftCount: summary.drifts?.length ?? 0,
    wouldClearNegative: summary.wouldClearNegative,
    reconciled: summary.reconciled,
    clearedNegative: summary.clearedNegative,
    errors: summary.errors,
    driftsPreview: preview,
  }, null, 2));

  await client.close();
  if (summary.errors.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
