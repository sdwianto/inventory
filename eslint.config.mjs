import { readFileSync } from 'node:fs';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

const boundaryStrict = process.env.EXECUTION_BOUNDARY_STRICT === '1';
const boundaryLevel = boundaryStrict ? 'error' : 'warn';

function readBoundaryAllowlist() {
  try {
    return readFileSync('scripts/ci/execution-boundary-allowlist.txt', 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function allowlistGlobs(entries) {
  return entries.flatMap((entry) => {
    if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) return [entry];
    return [`${entry}/**/*.{ts,tsx,js,mjs,cjs}`];
  });
}

const boundaryAllowlistGlobs = allowlistGlobs(readBoundaryAllowlist());

export default defineConfig([
  ...nextVitals,
  globalIgnores(['.next/**', 'node_modules/**', 'coverage/**', 'playwright-report/**']),
  {
    files: ['lib/api/**/*.ts', 'lib/hooks/**/*.ts', 'app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [boundaryLevel, {
        paths: [{
          name: '@/lib/api/bg-jobs',
          message: 'Use @/lib/execution/api enqueue (CI-2)',
        }],
      }],
    },
  },
  {
    files: boundaryAllowlistGlobs,
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['lib/execution/**/*.ts'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['lib/execution/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@/lib/api/handlers/*', '@/lib/api/handlers/**'],
          message: 'Execution platform boundary (CI-7)',
        }],
      }],
    },
  },
  {
    files: ['lib/api/handlers/**/*.ts'],
    rules: {
      'no-restricted-imports': [boundaryLevel, {
        paths: [
          {
            name: 'prom-client',
            message: 'Handlers use ctx.metrics — not prom-client (CI-6)',
          },
          {
            name: 'ioredis',
            message: 'Handlers use ctx.redis facade — not ioredis (CI-6)',
          },
        ],
        patterns: [{
          group: ['redis', '@upstash/redis'],
          message: 'Handlers use ctx.redis facade (CI-6)',
        }],
      }],
    },
  },
  {
    // Client shells sync session/cache from localStorage — warn, don't fail CI
    // for intentional mount hydration patterns while we migrate to useSyncExternalStore.
    files: ['lib/hooks/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]);
