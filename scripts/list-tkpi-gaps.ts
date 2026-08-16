#!/usr/bin/env node
/**
 * @deprecated Gunakan scripts/fill-usda-gaps-from-master.ts
 *   npx tsx scripts/fill-usda-gaps-from-master.ts --from-xlsx=docs/akg/Review-Mapping-Produk-TKPI.xlsx --andrafarm
 */
import { spawnSync } from 'child_process';

const r = spawnSync('npx', ['tsx', 'scripts/fill-usda-gaps-from-master.ts', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
});
process.exit(r.status ?? 1);
