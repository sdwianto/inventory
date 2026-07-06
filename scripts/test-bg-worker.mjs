#!/usr/bin/env node
/**
 * Tes endpoint worker (sama yang dipanggil cron-job.org).
 *
 * Usage:
 *   WORKER_SECRET=xxx npm run test:worker -- https://penarukan2.vercel.app
 *   npm run test:worker -- https://penarukan2.vercel.app   # baca dari .env.local
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadWorkerSecretFromEnvLocal() {
  try {
    const content = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key !== 'WORKER_SECRET' && key !== 'CRON_SECRET') continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value.trim();
    }
  } catch {
    // .env.local opsional
  }
  return '';
}

const base = (process.argv[2] || process.env.WORKER_INTERNAL_URL || 'http://localhost:3001').replace(
  /\/$/,
  '',
);
const secret = (
  process.env.WORKER_SECRET ||
  process.env.CRON_SECRET ||
  loadWorkerSecretFromEnvLocal() ||
  ''
).trim();

if (!secret) {
  console.error('WORKER_SECRET tidak ditemukan.');
  console.error('Set via: WORKER_SECRET=xxx npm run test:worker -- <url>');
  console.error('Atau tambahkan WORKER_SECRET=... di .env.local');
  process.exit(1);
}

if (secret.length !== 64) {
  console.warn(
    `Peringatan: secret panjangnya ${secret.length} karakter (biasanya 64 dari "openssl rand -hex 32").`,
  );
  console.warn('Pastikan nilai sama persis dengan WORKER_SECRET di Vercel.\n');
}

const url = `${base}/api/bg-jobs/process`;
const reconcileUrl = `${base}/api/bg-jobs/enqueue-integration-reconcile`;

async function probeEndpoint(label, endpointUrl) {
  const res = await fetch(endpointUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${secret}`,
      'X-Worker-Secret': secret,
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  console.log(`HTTP ${res.status} ${label}`);
  console.log(JSON.stringify(data, null, 2));
  return res.status;
}

async function main() {
  const processStatus = await probeEndpoint(url, url);
  const reconcileStatus = await probeEndpoint(reconcileUrl, reconcileUrl);
  const failed = [processStatus, reconcileStatus].some((s) => s === 401);
  if (failed) {
    console.error('\n401 Unauthorized — cek:');
    console.error('  1. WORKER_SECRET di Vercel = secret yang dipakai tes (64 hex char, tanpa spasi/karakter tambahan)');
    console.error('  2. Redeploy setelah ubah env di Vercel');
    console.error('  3. cron-job.org: Authorization = "Bearer <secret>" TANPA ":" di akhir');
    console.error('     atau pakai header X-Worker-Secret = <secret> saja (tanpa Bearer)');
    process.exit(1);
  }
  if (![processStatus, reconcileStatus].every((s) => s >= 200 && s < 300)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
