/**
 * Barang SO vendor yang tidak ada di PO customer, dan tagihan yang tertahan karenanya.
 * Sinkron SO menambahkan baris ini otomatis (`cpo-extra-so-lines`); temuan di sini berarti sinkron
 * terlewat (webhook gagal, data sebelum perbaikan) — perbaiki lewat
 * `scripts/backfill-cpo-extra-so-lines.ts --po=<noPO>`.
 * Juga: tambahan vendor yang lama belum diterima/ditolak, dan keputusan baris yang belum sampai ke vendor.
 */

import type { Db } from 'mongodb';
import { findExtraSoItems, type PoLine } from '@/lib/api/cpo-extra-so-lines';
import { isVendorLinePendingDecision } from '@/lib/api/cpo-vendor-line-acceptance';
import { INTEGRATION_OUTBOX_COLLECTION, INTEGRATION_OUTBOX_TYPES } from '@/lib/api/integration-outbox';
import { MAX_DECISION_PUSH_ATTEMPTS } from '@/lib/api/vendor-line-decision-push';
import type { JsonObject } from '@/types/json';
import type { ReconDetectResult, ReconFinding } from '@/lib/recon/types';

export const VENDOR_LINE_RECON_LOOKBACK_DAYS = 60;
/** Tambahan vendor yang belum diputuskan selama ini menahan tagihan — eskalasi ke purchasing. */
export const VENDOR_LINE_PENDING_AGED_MS = 24 * 60 * 60 * 1000;
/** Job + sweeper mengulang push; lewat batas ini berarti macet (API key/URL vendor, SO tidak ditemukan). */
export const DECISION_PUSH_STUCK_MS = 30 * 60 * 1000;
/** Tagihan baru dibuat bisa masih menunggu sinkron SO; jangan langsung dilaporkan. */
export const HUTANG_OFF_PO_GRACE_MS = 2 * 60 * 60 * 1000;

/** PO INVOICED: tagihannya sudah lolos — selisih baris historis bukan lagi tindakan. */
export const OPEN_PO_STATUSES = [
  'SUBMITTED', 'CONFIRMED', 'PARTIAL_CANCELLED', 'PARTIAL_SHIPPED', 'SHIPPED',
  'PARTIAL_RECEIVED', 'RECEIVED',
];

type SoSource = { vendorTenantId: string; noSO?: string; items: JsonObject[] };

/** Item SO per vendor yang tersimpan di PO (submission per vendor; snapshot untuk PO single-vendor). */
export function vendorSoSourcesOfPo(po: JsonObject): SoSource[] {
  const out: SoSource[] = [];
  const subs = Array.isArray(po.vendorSubmissions) ? po.vendorSubmissions as JsonObject[] : [];
  for (const s of subs) {
    const so = (s.vendorSo || {}) as JsonObject;
    const vid = String(s.vendorTenantId || so.vendorTenantId || '').trim();
    const items = Array.isArray(so.items) ? so.items as JsonObject[] : [];
    if (vid && items.length && String(s.status || '') !== 'CANCELLED') {
      out.push({ vendorTenantId: vid, noSO: String(so.noSO || s.vendorNoSO || ''), items });
    }
  }
  const top = String(po.vendorTenantId || '').trim();
  if (!out.length && top && top !== 'multi') {
    const snap = (po.vendorSoSnapshot || {}) as JsonObject;
    const items = Array.isArray(snap.items) ? snap.items as JsonObject[] : [];
    if (items.length) out.push({ vendorTenantId: top, noSO: String(snap.noSO || po.vendorNoSO || ''), items });
  }
  return out;
}

export function detectExtraSoLinesForPo(po: JsonObject): Array<{ vendorTenantId: string; noSO?: string; item: JsonObject }> {
  const items = (Array.isArray(po.items) ? po.items : []) as PoLine[];
  const multiVendor = String(po.vendorTenantId || '') === 'multi';
  const out: Array<{ vendorTenantId: string; noSO?: string; item: JsonObject }> = [];
  for (const src of vendorSoSourcesOfPo(po)) {
    for (const item of findExtraSoItems(items, src.items, { vendorTenantId: src.vendorTenantId, multiVendor })) {
      out.push({ vendorTenantId: src.vendorTenantId, noSO: src.noSO, item });
    }
  }
  return out;
}

export async function detectPoVendorLineRecon(
  db: Db,
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<ReconDetectResult> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - VENDOR_LINE_RECON_LOOKBACK_DAYS * 86_400_000);
  const findings: ReconFinding[] = [];

  const pos = await db.collection('customer_purchase_orders')
    .find({ tenantId, status: { $in: OPEN_PO_STATUSES }, updatedAt: { $gte: since } })
    .project({ id: 1, noPO: 1, vendorTenantId: 1, items: 1, vendorSubmissions: 1, vendorSoSnapshot: 1, vendorNoSO: 1 })
    .toArray() as JsonObject[];
  for (const po of pos) {
    for (const extra of detectExtraSoLinesForPo(po)) {
      findings.push({
        kind: 'PO_VENDOR_SO_LINE_MISSING',
        refType: 'PO',
        refId: String(po.id || ''),
        refNo: String(po.noPO || ''),
        kode: extra.item.kode ? String(extra.item.kode) : undefined,
        nama: extra.item.nama ? String(extra.item.nama) : undefined,
        actual: parseFloat(String(extra.item.qty ?? extra.item.qtyOrdered ?? 0)) || 0,
        detail: `SO ${extra.noSO || '-'} vendor ${extra.vendorTenantId}: ${String(extra.item.kode || '')} tidak ada di PO ${String(po.noPO || '')}`,
      });
    }
  }

  const hutang = await db.collection('hutang')
    .find({
      tenantId,
      referenceType: 'VENDOR_INVOICE',
      approvalStatus: 'PENDING_REVIEW',
      matchStatus: 'EXCEPTION',
      matchError: { $regex: 'tidak ada di PO' },
      createdAt: { $lt: new Date(now.getTime() - HUTANG_OFF_PO_GRACE_MS) },
    })
    .project({ id: 1, noInvoice: 1, noHutang: 1, noPO: 1, vendorTenantId: 1, matchError: 1 })
    .limit(200)
    .toArray();
  for (const h of hutang) {
    findings.push({
      kind: 'HUTANG_OFF_PO_PENDING',
      refType: 'HUTANG',
      refId: String(h.id || ''),
      refNo: String(h.noInvoice || h.noHutang || ''),
      detail: `Tagihan ${String(h.noInvoice || h.noHutang || '')} (${String(h.vendorTenantId || '-')}) PO ${String(h.noPO || '-')}: ${String(h.matchError || '')}`,
    });
  }

  let pendingAged = 0;
  const pendingBefore = now.getTime() - VENDOR_LINE_PENDING_AGED_MS;
  for (const po of pos) {
    for (const line of (Array.isArray(po.items) ? po.items : []) as JsonObject[]) {
      if (!isVendorLinePendingDecision(line)) continue;
      const addedAt = new Date(String(line.addedAt || '')).getTime();
      if (Number.isFinite(addedAt) && addedAt > pendingBefore) continue;
      pendingAged += 1;
      const reason = String((line.vendorLineAcceptance as JsonObject | undefined)?.reason || '').trim();
      findings.push({
        kind: 'PO_VENDOR_LINE_PENDING_AGED',
        refType: 'PO',
        refId: String(po.id || ''),
        refNo: String(po.noPO || ''),
        kode: line.kode ? String(line.kode) : undefined,
        nama: line.nama ? String(line.nama) : undefined,
        actual: parseFloat(String(line.qty ?? 0)) || 0,
        detail: `PO ${String(po.noPO || '')}: ${String(line.kode || '')} tambahan vendor ${String(line.vendorTenantId || '-')} belum diterima/ditolak${reason ? ` — ${reason}` : ''}`,
      });
    }
  }

  const stuckPushes = await db.collection(INTEGRATION_OUTBOX_COLLECTION)
    .find({
      tenantId,
      type: INTEGRATION_OUTBOX_TYPES.ENSURE_PUSH_VENDOR_LINE_DECISION,
      status: { $in: ['PENDING', 'FAILED', 'PROCESSING'] },
      updatedAt: { $lt: new Date(now.getTime() - DECISION_PUSH_STUCK_MS) },
    })
    .project({ payload: 1, attempts: 1, lastError: 1 })
    .limit(200)
    .toArray();
  for (const row of stuckPushes) {
    const p = (row.payload || {}) as JsonObject;
    findings.push({
      kind: 'PO_VENDOR_LINE_DECISION_PUSH_STUCK',
      refType: 'PO',
      refId: String(p.poId || ''),
      refNo: String(p.noPO || ''),
      kode: p.kode ? String(p.kode) : undefined,
      detail: `Keputusan ${String(p.decision || '')} baris ${String(p.kode || p.lineId || '')} ke ${String(p.vendorTenantId || '-')} belum terkirim (percobaan ${Number(row.attempts || 0)}${Number(row.attempts || 0) >= MAX_DECISION_PUSH_ATTEMPTS ? ', berhenti otomatis' : ''})${row.lastError ? `: ${String(row.lastError).slice(0, 300)}` : ''}`,
    });
  }

  return {
    findings,
    meta: {
      vendorLinePosScanned: pos.length,
      offPoHutang: hutang.length,
      vendorLinePendingAged: pendingAged,
      vendorLineDecisionPushStuck: stuckPushes.length,
    },
  };
}
