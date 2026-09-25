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

const MONGO_WRITE_METHODS = '/^(insertOne|insertMany|updateOne|updateMany|replaceOne|findOneAndUpdate|findOneAndReplace|findOneAndDelete|deleteOne|deleteMany|bulkWrite|drop)$/';
const STOCK_LEDGER_COLLECTIONS = '/^(stok_lokasi|stok_kartu|ingredient_lots|stok_bin)$/';
const STOCK_LEDGER_CONSTANTS = '/^(STOK_LOKASI|STOK_KARTU|INGREDIENT_LOTS_COLLECTION|STOK_BIN_COLLECTION)$/';
const STOCK_LEDGER_MESSAGE = 'Tulis stok_lokasi / stok_kartu / ingredient_lots / stok_bin hanya lewat lib/stock-ledger (postStockMovements + lotPolicy, atau operasi yang diekspor modul itu).';
const PRODUCT_UPDATE_METHODS = '/^(updateOne|updateMany|findOneAndUpdate|replaceOne|findOneAndReplace)$/';
const PRODUCTS_COLLECTION_CALL = "[callee.object.callee.property.name='collection'][callee.object.arguments.0.value='products']";
const PRODUCT_STOCK_FIELDS = '/^(stok|stokDisplay)$/';
const PRODUCT_STOCK_MESSAGE = 'products.stok / stokDisplay adalah denormalisasi Σ stok_lokasi — hanya lib/stock-ledger yang menulis (recomputeProductStok / refreshProductsMasterStock).';

const stockLedgerWriteRules = [
  {
    selector: `CallExpression[callee.property.name=${MONGO_WRITE_METHODS}][callee.object.callee.property.name='collection'][callee.object.arguments.0.value=${STOCK_LEDGER_COLLECTIONS}]`,
    message: STOCK_LEDGER_MESSAGE,
  },
  {
    selector: `CallExpression[callee.property.name=${MONGO_WRITE_METHODS}][callee.object.callee.property.name='collection'][callee.object.arguments.0.name=${STOCK_LEDGER_CONSTANTS}]`,
    message: STOCK_LEDGER_MESSAGE,
  },
  {
    selector: `VariableDeclarator > CallExpression.init[callee.property.name='collection'][arguments.0.value=${STOCK_LEDGER_COLLECTIONS}]`,
    message: 'Jangan simpan handle koleksi buku stok ke variabel di luar lib/stock-ledger — panggil langsung agar penulisan terdeteksi lint.',
  },
  {
    selector: `VariableDeclarator > CallExpression.init[callee.property.name='collection'][arguments.0.name=${STOCK_LEDGER_CONSTANTS}]`,
    message: 'Jangan simpan handle koleksi buku stok ke variabel di luar lib/stock-ledger — panggil langsung agar penulisan terdeteksi lint.',
  },
  {
    selector: `CallExpression[callee.property.name=${PRODUCT_UPDATE_METHODS}]${PRODUCTS_COLLECTION_CALL} > ObjectExpression:nth-child(2) :matches(Property[key.name=${PRODUCT_STOCK_FIELDS}], Property[key.value=${PRODUCT_STOCK_FIELDS}])`,
    message: PRODUCT_STOCK_MESSAGE,
  },
  {
    selector: `CallExpression[callee.property.name='bulkWrite']${PRODUCTS_COLLECTION_CALL} :matches(Property[key.name=${PRODUCT_STOCK_FIELDS}], Property[key.value=${PRODUCT_STOCK_FIELDS}])`,
    message: PRODUCT_STOCK_MESSAGE,
  },
  {
    selector: `CallExpression[callee.property.name=/^(insertOne|insertMany)$/]${PRODUCTS_COLLECTION_CALL} :matches(Property[key.name='stok'], Property[key.value='stok']):not([value.value=0])`,
    message: 'Produk baru disisipkan dengan stok: 0 — stok awal lewat postStockMovements (MASTER_PRODUK).',
  },
];

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
    files: ['lib/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...stockLedgerWriteRules],
    },
  },
  {
    // lib/stock-ledger: pemilik tulis stok. sandbox-purge: reset tenant sandbox oleh operator.
    files: ['lib/stock-ledger/**/*.ts', 'lib/api/sandbox-purge.ts'],
    rules: {
      'no-restricted-syntax': 'off',
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
