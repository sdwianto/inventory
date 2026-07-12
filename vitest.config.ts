import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));

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
        replacement: resolve(rootDir, 'vendor/platform/src/$1.ts'),
      },
      {
        find: /^@dawam\/contracts\/(.+)$/,
        replacement: resolve(rootDir, 'vendor/contracts/src/$1.ts'),
      },
      { find: '@dawam/contracts', replacement: resolve(rootDir, 'vendor/contracts/src/index.ts') },
      { find: '@dawam/platform', replacement: resolve(rootDir, 'vendor/platform/src/index.ts') },
    ],
  },
});
