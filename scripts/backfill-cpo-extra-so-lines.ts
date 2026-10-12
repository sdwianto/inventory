#!/usr/bin/env npx tsx
/**
 * Backfill: barang SO vendor yang tidak ada di PO customer → tambahkan sebagai baris PO
 * (`addedFromVendorSo`), isi qty dikirim/diterima dari GRN POSTED vendor itu, tautkan perpindahan
 * baris antar PO, terapkan kebijakan auto-terima (pindahan PO / dalam toleransi; sisanya menunggu
 * keputusan purchasing), lalu hitung ulang 3-way match tagihan PENDING_REVIEW pada PO tersebut.
 * PO yang sudah punya baris tambahan vendor tanpa keputusan (data lama) juga dievaluasi ulang.
 * Sinkron SO sekarang melakukan ini otomatis; skrip ini untuk data sebelum perbaikan / sinkron terlewat
 * (lihat temuan rekonsiliasi PO_VENDOR_SO_LINE_MISSING).
 *
 * Usage:
 *   npx tsx scripts/backfill-cpo-extra-so-lines.ts                      # dry-run PO terbuka (belum INVOICED) 60 hari
 *   npx tsx scripts/backfill-cpo-extra-so-lines.ts --po=CPO2610000081   # satu PO (status apa pun)
 *   npx tsx scripts/backfill-cpo-extra-so-lines.ts --tenant=sppg --apply
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';
import {
  appendExtraSoLines,
  afterCpoVendorLinesSynced,
  fillAddedLinesFromAppliedGrns,
  type PoLine,
} from '../lib/api/cpo-extra-so-lines';
import { isVendorLinePendingDecision } from '../lib/api/cpo-vendor-line-acceptance';
import { pickForwardCpoStatus, rollupCpoProgressStatus, type CpoLine } from '../lib/api/cpo-status-sync';
import { OPEN_PO_STATUSES, vendorSoSourcesOfPo, VENDOR_LINE_RECON_LOOKBACK_DAYS } from '../lib/recon/po-vendor-line-recon';
import type { JsonObject } from '../types/json';

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
const arg = (name: string) => ((process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || '').trim();
const PO = arg('po');
const TENANT = arg('tenant').toLowerCase();

async function main() {
  const client = new MongoClient(process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017');
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'inventory_customer');
  console.log(`\n=== Backfill baris SO vendor di luar PO (${APPLY ? 'APPLY' : 'dry-run'}) db=${db.databaseName} ===\n`);

  const since = new Date(Date.now() - VENDOR_LINE_RECON_LOOKBACK_DAYS * 86_400_000);
  const pos = await db.collection('customer_purchase_orders').find({
    ...(PO ? { noPO: PO } : { status: { $in: OPEN_PO_STATUSES }, updatedAt: { $gte: since } }),
    ...(TENANT ? { tenantId: TENANT } : {}),
  }).toArray() as JsonObject[];

  const rows: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];
  let changedPos = 0;
  let pendingOnlyPos = 0;

  const reportDecisions = async (poId: string, lineIds: string[]) => {
    const fresh = await db.collection('customer_purchase_orders').findOne({ id: poId }) as JsonObject | null;
    for (const line of (Array.isArray(fresh?.items) ? fresh.items : []) as JsonObject[]) {
      if (!lineIds.includes(String(line.lineId))) continue;
      const acc = (line.vendorLineAcceptance || {}) as JsonObject;
      decisions.push({
        po: fresh?.noPO,
        kode: line.kode,
        status: String(acc.status || 'PENDING'),
        mode: String(acc.mode || '-'),
        alasan: String(acc.reason || '-').slice(0, 120),
      });
    }
  };
  for (const po of pos) {
    const tenantId = String(po.tenantId || 'default');
    const multiVendor = String(po.vendorTenantId || '') === 'multi';
    const original = (Array.isArray(po.items) ? po.items : []) as PoLine[];
    let items = original;
    const added: PoLine[] = [];
    for (const src of vendorSoSourcesOfPo(po)) {
      const res = await appendExtraSoLines(db, tenantId, items, src.items, {
        vendorTenantId: src.vendorTenantId,
        noSO: src.noSO,
        multiVendor,
      });
      items = res.items;
      added.push(...res.added);
    }
    if (!added.length) {
      const pending = original.filter((l) => isVendorLinePendingDecision(l as JsonObject));
      if (!pending.length) continue;
      pendingOnlyPos += 1;
      for (const line of pending) {
        rows.push({ po: po.noPO, vendor: line.vendorTenantId, kode: line.kode, nama: line.nama, qty: line.qty, satuan: line.satuan, catatan: 'sudah ada, belum diputuskan' });
      }
      if (!APPLY) continue;
      await afterCpoVendorLinesSynced(db, String(po.id), { source: 'backfill-cpo-extra-so-lines' });
      await reportDecisions(String(po.id), pending.map((l) => String(l.lineId)));
      continue;
    }

    const grnByLine = new Map(
      (await fillAddedLinesFromAppliedGrns(db, po, original, added)).map((r) => [r.lineId, r.grnNos]),
    );
    for (const line of added) {
      rows.push({
        po: po.noPO,
        vendor: line.vendorTenantId,
        kode: line.kode,
        nama: line.nama,
        qty: line.qty,
        satuan: line.satuan,
        diterima: line.qtyReceived || 0,
        grn: (grnByLine.get(String(line.lineId)) || []).join(',') || '-',
        produkLokal: line.localStokId ? 'ok' : 'BELUM TERPETAKAN',
      });
    }
    changedPos += 1;
    if (!APPLY) continue;

    const ver = Number(po.qtySyncVersion) || 0;
    const nextStatus = pickForwardCpoStatus(String(po.status || ''), rollupCpoProgressStatus(items as CpoLine[]));
    const status = String(po.status || '') === 'INVOICED' && nextStatus !== 'INVOICED' ? String(po.status) : nextStatus;
    const res = await db.collection('customer_purchase_orders').updateOne(
      {
        id: po.id,
        'items.lineId': { $nin: added.map((l) => String(l.lineId)) },
        $or: [{ qtySyncVersion: ver }, ...(ver === 0 ? [{ qtySyncVersion: { $exists: false } }] : [])],
      },
      { $set: { items, status, updatedAt: new Date(), qtySyncVersion: ver + 1 } },
    );
    if (res.matchedCount === 0) {
      console.warn(`PO ${String(po.noPO)}: berubah bersamaan — dilewati, jalankan ulang.`);
      continue;
    }
    await afterCpoVendorLinesSynced(db, String(po.id), { added, itemsChanged: true, source: 'backfill-cpo-extra-so-lines' });
    await reportDecisions(String(po.id), added.map((l) => String(l.lineId)));
    console.log(`PO ${String(po.noPO)}: ${added.length} baris ditambahkan, status ${String(po.status)} → ${status}`);
  }

  if (rows.length) console.table(rows);
  if (decisions.length) {
    console.log('\nHasil kebijakan auto-terima (PENDING = menunggu Terima/Tolak di halaman PO):');
    console.table(decisions);
  }
  console.log(`\nPO diperiksa: ${pos.length}; PO dengan barang SO di luar PO: ${changedPos}; PO dengan tambahan belum diputuskan: ${pendingOnlyPos}; baris: ${rows.length}`);
  if (!APPLY) console.log('Dry-run — tidak ada yang diubah. Keputusan auto-terima dihitung saat --apply.');
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
