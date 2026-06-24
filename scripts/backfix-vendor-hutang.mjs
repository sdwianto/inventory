#!/usr/bin/env node
/**
 * Diagnosa + backfix tagihan vendor dari GRN POSTED.
 * Usage:
 *   node scripts/backfix-vendor-hutang.mjs           # dry-run (laporan saja)
 *   node scripts/backfix-vendor-hutang.mjs --apply   # perbaiki status + total dari GRN
 */
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv() {
  try {
    const p = resolve(process.cwd(), '.env.local');
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* ignore */ }
}
loadEnv();

const APPLY = process.argv.includes('--apply');
const TENANT = (process.argv.find((a) => a.startsWith('--tenant=')) || '').split('=')[1] || 'sppg';

function hasLegitimateApproval(h) {
  const by = h?.approvedBy;
  if (!by?.userId || by.role === 'SYSTEM') return false;
  return !!h?.approvedAt;
}

function hasLegitimateExternalPayment(h) {
  if (!h?.paidExternalAt) return false;
  return !!(h?.paidExternalBy?.userId);
}

function needsPendingReview(h, fromPostedGrn = false) {
  const approval = h?.approvalStatus || h?.status;
  if (approval === 'PENDING_REVIEW' || approval === 'REJECTED') return false;
  if (fromPostedGrn) {
    if (hasLegitimateExternalPayment(h)) return false;
    return true;
  }
  if (approval === 'APPROVED' && hasLegitimateApproval(h)) return false;
  if (['PAID_EXTERNAL', 'LUNAS'].includes(approval) && hasLegitimateExternalPayment(h)) return false;
  return true;
}

const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'inventory_customer';

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

const tidRegex = new RegExp(`^${TENANT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

console.log(`\n=== DIAGNOSA tagihan vendor (tenant: ${TENANT}) ===\n`);

const hutangs = await db.collection('hutang').find({
  $or: [
    { referenceType: 'VENDOR_INVOICE', tenantId: tidRegex },
    { vendorInvoiceId: { $exists: true, $ne: null }, tenantId: tidRegex },
  ],
}).sort({ tanggal: -1 }).toArray();

console.log(`Total VENDOR hutang: ${hutangs.length}`);
for (const h of hutangs) {
  console.log(JSON.stringify({
    noInvoice: h.noInvoice,
    noDO: h.noDO,
    tenantId: h.tenantId,
    referenceType: h.referenceType,
    approvalStatus: h.approvalStatus,
    status: h.status,
    total: h.total,
    terbayar: h.terbayar,
    approvedBy: h.approvedBy?.role || null,
    needsFix: needsPendingReview(h, true),
  }));
}

const pendingBefore = await db.collection('hutang').countDocuments({
  tenantId: tidRegex,
  $or: [
    { referenceType: 'VENDOR_INVOICE' },
    { vendorInvoiceId: { $exists: true, $ne: null } },
  ],
  $and: [{
    $or: [
      { approvalStatus: 'PENDING_REVIEW' },
      { status: 'PENDING_REVIEW', approvalStatus: { $exists: false } },
    ],
  }],
});
console.log(`\nPENDING_REVIEW sebelum backfix: ${pendingBefore}`);

const grns = await db.collection('goods_receipts').find({
  tenantId: tidRegex,
  status: 'POSTED',
}).toArray();
console.log(`\nGRN POSTED: ${grns.length}`);
for (const g of grns) {
  console.log(JSON.stringify({
    noGRN: g.noGRN,
    noDO: g.noDO,
    receivedTotal: g.receivedTotal,
    noInvoice: g.noInvoice,
    hutangId: g.hutangId,
    vendorInvoiceId: g.vendorInvoiceId,
  }));
}

let fixed = 0;
const actions = [];
const seenHutang = new Set();

for (const grn of grns.sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0))) {
  let hutang = null;
  if (grn.hutangId) hutang = await db.collection('hutang').findOne({ id: grn.hutangId });
  if (!hutang && grn.vendorInvoiceId) {
    hutang = await db.collection('hutang').findOne({ vendorInvoiceId: grn.vendorInvoiceId });
  }
  if (!hutang && grn.noInvoice) {
    hutang = await db.collection('hutang').findOne({ noInvoice: grn.noInvoice });
  }

  const recv = parseInt(grn.receivedTotal || 0, 10);

  if (hutang) {
    if (seenHutang.has(hutang.id)) continue;
    seenHutang.add(hutang.id);

    const stale = needsPendingReview(hutang, true);
    const totalMismatch = recv > 0 && Math.abs((hutang.total || 0) - recv) > 1;
    if (stale || totalMismatch) {
      actions.push({
        action: stale ? 'reset PENDING_REVIEW' : 'fix total',
        noGRN: grn.noGRN,
        noInvoice: hutang.noInvoice,
        from: hutang.approvalStatus || hutang.status,
        total: hutang.total,
        toTotal: recv || hutang.total,
      });
      if (APPLY) {
        const patch = {
          referenceType: 'VENDOR_INVOICE',
          tenantId: TENANT.toLowerCase(),
          updatedAt: new Date(),
        };
        if (stale) {
          patch.approvalStatus = 'PENDING_REVIEW';
          patch.status = 'PENDING_REVIEW';
          patch.terbayar = 0;
          patch.sisa = recv > 0 ? recv : hutang.total;
          if (recv > 0) patch.total = recv;
        } else if (totalMismatch) {
          patch.total = recv;
          patch.sisa = Math.max(0, recv - (hutang.terbayar || 0));
        }
        await db.collection('hutang').updateOne({ id: hutang.id }, {
          $set: patch,
          ...(stale ? {
            $unset: {
              paidExternalAt: '',
              paidExternalBy: '',
              paidExternalNote: '',
              approvedAt: '',
              approvedBy: '',
              rejectedAt: '',
              rejectedBy: '',
              rejectReason: '',
            },
          } : {}),
        });
        if (grn.hutangId !== hutang.id) {
          await db.collection('goods_receipts').updateOne(
            { id: grn.id },
            { $set: { hutangId: hutang.id, vendorInvoiceId: hutang.vendorInvoiceId || grn.vendorInvoiceId } },
          );
        }
        fixed += 1;
      }
    }
  } else if (grn.noDO) {
    actions.push({ action: 'missing hutang — gunakan Buat faktur di Penerimaan atau sync', noGRN: grn.noGRN, noDO: grn.noDO });
  }
}

console.log(`\n=== Rencana backfix (${APPLY ? 'DITERAPKAN' : 'dry-run'}) ===`);
for (const a of actions) console.log(JSON.stringify(a));
console.log(`\n${APPLY ? 'Diperbaiki' : 'Akan diperbaiki'}: ${APPLY ? fixed : actions.filter((a) => a.action !== 'missing hutang — gunakan Buat faktur di Penerimaan atau sync').length} record`);

if (APPLY) {
  const pendingAfter = await db.collection('hutang').countDocuments({
    tenantId: tidRegex,
    $or: [
      { referenceType: 'VENDOR_INVOICE' },
      { vendorInvoiceId: { $exists: true, $ne: null } },
    ],
    $and: [{
      $or: [
        { approvalStatus: 'PENDING_REVIEW' },
        { status: 'PENDING_REVIEW', approvalStatus: { $exists: false } },
      ],
    }],
  });
  console.log(`PENDING_REVIEW setelah backfix: ${pendingAfter}`);
}

await client.close();
if (!APPLY && actions.length) {
  console.log('\nJalankan: node scripts/backfix-vendor-hutang.mjs --apply');
}
