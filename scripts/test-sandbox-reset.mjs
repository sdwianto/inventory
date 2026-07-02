#!/usr/bin/env node
/**
 * Uji reset sandbox (preview + eksekusi) via API — butuh dev server di port 3001.
 * Usage: node scripts/test-sandbox-reset.mjs [--confirm]
 */
const BASE = process.env.INVENTORY_URL || 'http://localhost:3001';
const confirm = process.argv.includes('--confirm');
const email = process.env.MASTER_EMAIL || 'master@dawam.com';
const password = process.env.MASTER_PASSWORD || 'master123';

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Login gagal (${res.status})`);
  const cookie = res.headers.getSetCookie?.()?.join('; ')
    || res.headers.get('set-cookie');
  if (!cookie) throw new Error('Tidak ada session cookie dari login');
  return cookie.split(';')[0];
}

async function api(cookie, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  return { res, data };
}

function printDbResult(label, db) {
  if (!db) return;
  console.log(`\n--- ${label} (${db.dbName}) ---`);
  console.log(`Summary: ${db.summary.documents} dokumen, ${db.summary.collections} koleksi aktif`);
  for (const [name, info] of Object.entries(db.counts)) {
    if (name === '_stock_reset') {
      if (info.dryRun) {
        console.log(`  [stok reset] dry-run: ${info.stok_lokasi_rows ?? 0} baris stok_lokasi`);
      } else {
        console.log(`  [stok reset] stok_lokasi=${info.stok_lokasi}, products=${info.products}`);
      }
      continue;
    }
    if (info.skipped) continue;
    if (info.dryRun && info.before > 0) console.log(`  ${name}: ${info.before}`);
    if (info.deleted !== undefined) console.log(`  ${name}: hapus ${info.deleted}/${info.before}`);
  }
}

async function main() {
  console.log(`\n=== UJI RESET SANDBOX (${confirm ? 'EKSEKUSI' : 'PREVIEW'}) ===`);
  console.log(`Server: ${BASE}`);

  const cookie = await login();
  console.log(`Login OK: ${email}`);

  const status = await api(cookie, '/api/sandbox/status');
  if (!status.res.ok) throw new Error(status.data.error || 'Status gagal');
  console.log('Status:', {
    enabled: status.data.enabled,
    inventoryDb: status.data.inventoryDbName,
    salesDb: status.data.salesDbName,
  });
  if (!status.data.enabled) throw new Error(status.data.blockReason || 'Sandbox reset tidak aktif');

  if (!confirm) {
    const preview = await api(cookie, '/api/sandbox/preview?includeSales=1');
    if (!preview.res.ok) throw new Error(preview.data.error || 'Preview gagal');
    printDbResult('inventory', preview.data.inventory);
    printDbResult('sales', preview.data.sales);
    console.log('\nPreview selesai. Jalankan dengan --confirm untuk eksekusi reset.\n');
    return;
  }

  const reset = await api(cookie, '/api/sandbox/reset', {
    method: 'POST',
    body: JSON.stringify({
      confirmPhrase: 'RESET SANDBOX',
      includeSales: true,
    }),
  });
  if (!reset.res.ok) throw new Error(reset.data.error || 'Reset gagal');
  printDbResult('inventory', reset.data.inventory);
  printDbResult('sales', reset.data.sales);
  console.log('\nReset sandbox selesai.\n');

  const verify = await api(cookie, '/api/sandbox/preview?includeSales=1');
  if (verify.res.ok) {
    console.log('=== Verifikasi post-reset (harus ~0 transaksi) ===');
    console.log(`inventory: ${verify.data.inventory.summary.documents} dokumen`);
    console.log(`sales: ${verify.data.sales?.summary.documents ?? 0} dokumen`);
  }
}

main().catch((e) => {
  console.error('GAGAL:', e.message);
  process.exit(1);
});
