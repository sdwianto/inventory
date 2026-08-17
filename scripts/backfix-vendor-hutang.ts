#!/usr/bin/env npx tsx
/**
 * Diagnosa + backfix tagihan vendor dari GRN POSTED — memanggil lib/api/hutang-reconcile.ts
 * langsung (bukan reimplementasi terpisah) supaya tidak drift dari logic yang sesungguhnya
 * dipakai app. Sebelumnya script ini (scripts/backfix-vendor-hutang.mjs) reimplementasi
 * sendiri di plain JS dan tertinggal beberapa perbaikan (guard `recv > 0`, koreksi items[]
 * per-baris) — lihat riwayat commit untuk konteks bug yang diperbaiki.
 *
 * Usage:
 *   npx tsx scripts/backfix-vendor-hutang.ts                    # dry-run (laporan saja)
 *   npx tsx scripts/backfix-vendor-hutang.ts --apply             # perbaiki
 *   npx tsx scripts/backfix-vendor-hutang.ts --tenant=sppg --apply
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';
import {
  reconcileHutangItemsFromGrn,
  backfixVendorHutangFromPostedGrns,
} from '../lib/api/hutang-reconcile';
import type { GrnDoc, HutangDoc } from '../types/documents';

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
const TENANT = (process.argv.find((a) => a.startsWith('--tenant=')) || '').split('=')[1] || 'sppg';

async function main() {
  const client = new MongoClient(process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'inventory_customer');

  const tidRegex = new RegExp(`^${TENANT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

  console.log(`\n=== DIAGNOSA tagihan vendor (tenant: ${TENANT}) ===\n`);

  if (!APPLY) {
    // Preview murni baca — pakai fungsi rekonsiliasi asli (pure, tanpa write) supaya laporan
    // sama persis dengan apa yang --apply akan lakukan.
    const grns = await db.collection('goods_receipts').find({
      tenantId: tidRegex,
      status: 'POSTED',
    }).toArray();

    let wouldFix = 0;
    for (const grnRow of grns) {
      const grn = grnRow as unknown as GrnDoc;
      let hutang = null as HutangDoc | null;
      if (grn.hutangId) hutang = await db.collection('hutang').findOne({ id: grn.hutangId }) as HutangDoc | null;
      if (!hutang && grn.vendorInvoiceId) {
        hutang = await db.collection('hutang').findOne({ vendorInvoiceId: grn.vendorInvoiceId }) as HutangDoc | null;
      }
      if (!hutang && grn.noInvoice) {
        hutang = await db.collection('hutang').findOne({ noInvoice: grn.noInvoice }) as HutangDoc | null;
      }
      if (!hutang) continue;

      const reconciled = reconcileHutangItemsFromGrn(
        (hutang.items || []) as Array<Record<string, unknown>>,
        grn.items,
      );
      const totalMismatch = reconciled.matchedCount > 0
        && Math.abs(Number(hutang.total || 0) - reconciled.total) > 1;
      if (reconciled.changed || totalMismatch) {
        wouldFix += 1;
        console.log(JSON.stringify({
          noGRN: grn.noGRN,
          noInvoice: hutang.noInvoice,
          totalSaatIni: hutang.total,
          totalSeharusnya: reconciled.total,
        }));
      }
    }
    console.log(`\nAkan diperbaiki: ${wouldFix} tagihan`);
    console.log('\nJalankan: npx tsx scripts/backfix-vendor-hutang.ts --apply');
    await client.close();
    return;
  }

  const result = await backfixVendorHutangFromPostedGrns(db, TENANT, { replaySales: false });
  console.log('Hasil backfix:', JSON.stringify(result));

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
