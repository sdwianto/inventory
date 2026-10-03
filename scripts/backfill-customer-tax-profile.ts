#!/usr/bin/env npx tsx
/**
 * Backfill sekali jalan: kirim profil pajak (NPWP, PKP, alamat) tenant pembeli yang sudah ter-link ke vendor Sales.
 * Push otomatis hanya terjadi saat setting pajak berubah atau link dibuat — link lama perlu diantrekan manual.
 *
 * Usage:
 *   npx tsx scripts/backfill-customer-tax-profile.ts                 # dry-run (laporan saja)
 *   npx tsx scripts/backfill-customer-tax-profile.ts --tenant=sppg   # satu tenant pembeli
 *   npx tsx scripts/backfill-customer-tax-profile.ts --apply         # antrekan job (diproses worker app)
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';
import { enqueueCustomerTaxProfilePush, loadCustomerTaxProfile } from '../lib/api/customer-tax-profile-push';

function loadEnv() {
  for (const name of ['.env.local', '.env.docker', '.env']) {
    const p = resolve(process.cwd(), name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

const APPLY = process.argv.includes('--apply');
const TENANT = ((process.argv.find((a) => a.startsWith('--tenant=')) || '').split('=')[1] || '').trim().toLowerCase();

const npwp16 = (d: string) => (d.length === 16 ? d : d.length === 15 ? `0${d}` : '');

async function main() {
  const client = new MongoClient(process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'inventory_customer');
  console.log(`\n=== Backfill profil pajak pembeli → Sales (${APPLY ? 'APPLY' : 'dry-run'}) db=${db.databaseName} ===\n`);

  const links = await db.collection('integration_links')
    .find({ status: 'ACTIVE', ...(TENANT ? { customerTenantId: TENANT } : {}) }, { projection: { _id: 0, customerTenantId: 1, vendorTenantId: 1, taxProfileSync: 1 } })
    .toArray();
  const byCustomer = new Map<string, Array<{ vendorTenantId: string; sync?: { status?: string } }>>();
  for (const l of links) {
    const tid = String(l.customerTenantId || '');
    if (!tid) continue;
    byCustomer.set(tid, [...(byCustomer.get(tid) || []), { vendorTenantId: String(l.vendorTenantId || ''), sync: l.taxProfileSync }]);
  }

  const rows: Array<{ tid: string; npwp: string; pkp: boolean; alamat: boolean; vendors: number; synced: number; status: string }> = [];
  const byNpwp = new Map<string, string[]>();
  for (const [tid, vendors] of byCustomer) {
    const p = await loadCustomerTaxProfile(db, tid);
    const npwp = npwp16(p.npwp);
    let status = 'KIRIM';
    if (!p.npwp) status = 'LEWATI: NPWP kosong';
    else if (!npwp) status = 'LEWATI: NPWP tidak 15/16 digit';
    if (npwp) byNpwp.set(npwp, [...(byNpwp.get(npwp) || []), tid]);
    rows.push({ tid, npwp: p.npwp, pkp: p.pkp, alamat: Boolean(p.alamat), vendors: vendors.length, synced: vendors.filter((v) => v.sync?.status === 'OK').length, status });
  }
  for (const [npwp, tids] of byNpwp) {
    if (tids.length < 2) continue;
    for (const r of rows) if (tids.includes(r.tid) && r.status === 'KIRIM') r.status = `RISIKO 409: NPWP ${npwp} dipakai ${tids.length} tenant`;
  }

  console.table(rows.map((r) => ({ tenant: r.tid, npwp: r.npwp || '-', pkp: r.pkp, alamat: r.alamat, vendor: r.vendors, sudahOK: r.synced, status: r.status })));
  const kirim = rows.filter((r) => r.status === 'KIRIM' || r.status.startsWith('RISIKO'));
  console.log(`\nTenant pembeli ter-link: ${rows.length}; akan dikirim: ${kirim.length}; dilewati: ${rows.length - kirim.length}`);

  if (APPLY) {
    let enq = 0;
    for (const r of kirim) {
      const res = await enqueueCustomerTaxProfilePush(db, r.tid, undefined, { schedule: false });
      if (res) enq++;
    }
    console.log(`Job diantrekan: ${enq} (duplikat versi profil yang sama di-dedupe). Diproses oleh worker bg-jobs app.`);
  } else {
    console.log('Dry-run — tidak ada yang diubah. Jalankan dengan --apply untuk mengantrekan job.');
  }
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
