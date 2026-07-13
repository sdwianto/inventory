import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

function resolvePackageRoot(scope: 'contracts' | 'platform') {
  const nm = resolve(rootDir, `node_modules/@dawam/${scope}/src`);
  const vendor = resolve(rootDir, `_vendor/sales/packages/${scope}/src`);
  return existsSync(nm) ? nm : vendor;
}

const contractsRoot = resolvePackageRoot('contracts');
const platformRoot = resolvePackageRoot('platform');

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/execution/**/*.test.ts',
      'tests/e2e/execution/**/*.test.ts',
    ],
    globals: false,
  },
  resolve: {
    alias: [
      { find: '@', replacement: rootDir },
      {
        find: /^@dawam\/platform\/(.+)$/,
        replacement: `${platformRoot}/$1.ts`,
      },
      {
        find: /^@dawam\/contracts\/(.+)$/,
        replacement: `${contractsRoot}/$1.ts`,
      },
      { find: '@dawam/contracts', replacement: `${contractsRoot}/index.ts` },
      { find: '@dawam/platform', replacement: `${platformRoot}/index.ts` },
    ],
  },
});
