/**
 * Kerangka migrasi. Default DRY-RUN. Tulis data hanya dengan --apply.
 *
 *   npx tsx scripts/migrations/run.ts --list
 *   npx tsx scripts/migrations/run.ts 0000-framework-noop sppg
 *   npx tsx scripts/migrations/run.ts 0000-framework-noop sppg --apply --by nama
 *   npx tsx scripts/migrations/run.ts 0000-framework-noop sppg --apply --force
 *   npx tsx scripts/migrations/run.ts 0003-merge-duplicate-products sppg --decisions keputusan.json
 */
import { readFileSync } from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import { executeMigration } from '../../lib/migrations/runner';
import { findMigration, MIGRATIONS } from '../../lib/migrations/registry';

const VALUE_OPTS = new Set(['--by', '--decisions']);

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function opt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  if (flag(argv, '--list') || argv.length === 0) {
    for (const m of MIGRATIONS) console.log(`${m.id}\t${m.description}`);
    return;
  }
  const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(argv[i - 1]));
  const id = positional[0];
  const migration = id ? findMigration(id) : undefined;
  if (!migration) {
    console.error(`Migrasi tidak dikenal: ${id || '(kosong)'}. Pakai --list.`);
    process.exit(2);
  }
  const tenantId = positional[1] || process.env.TENANT_ID || '';
  if (!tenantId) {
    console.error('tenantId wajib: npx tsx scripts/migrations/run.ts <id> <tenantId>');
    process.exit(2);
  }
  const applyFlag = flag(argv, '--apply');
  const dryFlag = flag(argv, '--dry-run');
  if (applyFlag && dryFlag) {
    console.error('Pilih salah satu: --apply atau --dry-run.');
    process.exit(2);
  }
  const decisionsPath = opt(argv, '--decisions');
  let options: Record<string, unknown> | undefined;
  if (decisionsPath) {
    try {
      options = { decisions: JSON.parse(readFileSync(decisionsPath, 'utf8')) };
    } catch (e) {
      console.error(`File keputusan tidak terbaca (${decisionsPath}): ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
  }
  const apply = applyFlag;
  const url = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?directConnection=true';
  const dbName = process.env.DB_NAME || 'inventory_customer';
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    const result = await executeMigration({
      db: client.db(dbName),
      migration,
      tenantId,
      apply,
      force: flag(argv, '--force'),
      actor: opt(argv, '--by') || process.env.USER || 'system',
      reportDir: path.join(process.cwd(), 'scripts/migrations/reports'),
      options,
    });
    console.log(JSON.stringify({ ...result, dbName }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
