// Pastikan GRN POSTED punya hutang PENDING_REVIEW yang sinkron dengan sales.app.

import type { Db } from 'mongodb';
import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import {
  isVendorInvoiceHutang,
  vendorInvoiceNeedsPendingReview,
} from '@/lib/api/hutang-from-vendor';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';
import { enqueueJob, JOB_TYPES, scheduleJobProcessing } from '@/lib/api/bg-jobs';
import { hutangMatchesGrnVendor, vendorScopedKey } from '@/lib/api/hutang-vendor-match';
import { reconcileHutangItemsFromGrn, type HutangItemLike } from '@/lib/api/hutang-line-reconcile';
import type { GrnDoc, HutangDoc, ReconcileOptions, SalesErrorRow, SalesReplayOptions } from '@/types/documents';
import type { VendorInvoicePayload } from '@/types/integration';

export { reconcileHutangItemsFromGrn, type HutangItemLike } from '@/lib/api/hutang-line-reconcile';

type HutangLookupMaps = {
  byId: Map<string, HutangDoc>;
  byInvoiceVendor: Map<string, HutangDoc>;
  byNoInvoiceVendor: Map<string, HutangDoc>;
};

async function buildHutangLookupMaps(db: Db, tid: string, grns: GrnDoc[]): Promise<HutangLookupMaps> {
  const tenantFilter = tenantIdMatchFilter(tid);
  const hutangIds = [...new Set(grns.map((g) => g.hutangId).filter(Boolean))] as string[];
  const vendorInvoiceIds = [...new Set(grns.map((g) => g.vendorInvoiceId).filter(Boolean))] as string[];
  const noInvoices = [...new Set(grns.map((g) => g.noInvoice).filter(Boolean))] as string[];

  const or: Record<string, unknown>[] = [];
  if (hutangIds.length) or.push({ id: { $in: hutangIds }, ...tenantFilter });
  if (vendorInvoiceIds.length) or.push({ vendorInvoiceId: { $in: vendorInvoiceIds }, ...tenantFilter });
  if (noInvoices.length) or.push({ noInvoice: { $in: noInvoices }, ...tenantFilter });

  const rows = or.length
    ? await db.collection('hutang').find({ $or: or }).toArray()
    : [];

  const byId = new Map<string, HutangDoc>();
  const byInvoiceVendor = new Map<string, HutangDoc>();
  const byNoInvoiceVendor = new Map<string, HutangDoc>();
  for (const row of rows) {
    const h = row as HutangDoc;
    if (h.id) byId.set(h.id, h);
    if (h.vendorInvoiceId) {
      byInvoiceVendor.set(vendorScopedKey(h.vendorTenantId, String(h.vendorInvoiceId)), h);
    }
    if (h.noInvoice) {
      byNoInvoiceVendor.set(vendorScopedKey(h.vendorTenantId, String(h.noInvoice)), h);
    }
  }
  return { byId, byInvoiceVendor, byNoInvoiceVendor };
}

function findVendorHutangFromMaps(maps: HutangLookupMaps, grn: GrnDoc): HutangDoc | null {
  if (grn.hutangId) {
    const h = maps.byId.get(grn.hutangId);
    if (h && hutangMatchesGrnVendor(h, grn)) return h;
  }
  if (grn.vendorInvoiceId) {
    const h = maps.byInvoiceVendor.get(
      vendorScopedKey(grn.vendorTenantId, String(grn.vendorInvoiceId)),
    );
    if (h) return h;
  }
  if (grn.noInvoice) {
    return maps.byNoInvoiceVendor.get(
      vendorScopedKey(grn.vendorTenantId, String(grn.noInvoice)),
    ) || null;
  }
  return null;
}

async function findVendorHutang(
  db: Db,
  tid: string,
  grn: GrnDoc,
  maps: HutangLookupMaps | null = null,
): Promise<HutangDoc | null> {
  if (maps) return findVendorHutangFromMaps(maps, grn);

  const tenantFilter = tenantIdMatchFilter(tid);
  if (grn.hutangId) {
    const byId = await db.collection('hutang').findOne({ id: grn.hutangId, ...tenantFilter });
    if (byId && hutangMatchesGrnVendor(byId as HutangDoc, grn)) return byId as HutangDoc;
  }
  if (grn.vendorInvoiceId) {
    const invoiceFilter: Record<string, unknown> = {
      vendorInvoiceId: grn.vendorInvoiceId,
      ...tenantFilter,
    };
    if (grn.vendorTenantId) invoiceFilter.vendorTenantId = grn.vendorTenantId;
    const byInvoice = await db.collection('hutang').findOne(invoiceFilter);
    if (byInvoice) return byInvoice as HutangDoc;
  }
  if (grn.noInvoice) {
    const noFilter: Record<string, unknown> = {
      noInvoice: grn.noInvoice,
      ...tenantFilter,
    };
    if (grn.vendorTenantId) noFilter.vendorTenantId = grn.vendorTenantId;
    const byNo = await db.collection('hutang').findOne(noFilter);
    if (byNo) return byNo as HutangDoc;
  }
  return null;
}

async function normalizeVendorHutangDoc(
  db: Db,
  tid: string,
  hutang: HutangDoc,
  grn: GrnDoc | null = null,
): Promise<HutangDoc> {
  const patch: Record<string, unknown> = {};
  if (!hutang.referenceType && isVendorInvoiceHutang(hutang)) {
    patch.referenceType = 'VENDOR_INVOICE';
  }
  const wantTid = normalizeTenantId(String(grn?.tenantId || tid));
  const haveTid = normalizeTenantId(String(hutang.tenantId || ''));
  if (haveTid !== wantTid && wantTid) patch.tenantId = wantTid;
  if (!Object.keys(patch).length) return hutang;
  await db.collection('hutang').updateOne(
    { id: hutang.id },
    { $set: { ...patch, updatedAt: new Date() } },
  );
  return { ...hutang, ...patch };
}


async function resetVendorHutangToPendingReview(
  db: Db,
  hutang: HutangDoc,
  { total = null, items = null }: { total?: number | null; items?: HutangItemLike[] | null } = {},
): Promise<void> {
  const nextTotal = total != null ? total : Number(hutang.total || 0);
  await db.collection('hutang').updateOne(
    { id: hutang.id },
    {
      $set: {
        referenceType: 'VENDOR_INVOICE',
        approvalStatus: 'PENDING_REVIEW',
        status: 'PENDING_REVIEW',
        terbayar: 0,
        sisa: nextTotal,
        ...(total != null ? { total: nextTotal } : {}),
        ...(items ? { items } : {}),
        updatedAt: new Date(),
      },
      $unset: {
        paidExternalAt: '',
        paidExternalBy: '',
        paidExternalNote: '',
        approvedAt: '',
        approvedBy: '',
        rejectedAt: '',
        rejectedBy: '',
        rejectReason: '',
        matchOverride: '',
        matchOverrideNote: '',
        matchOverrideBy: '',
      },
    },
  );
}

export async function fixHutangApprovalIfNeeded(
  db: Db,
  hutang: HutangDoc,
  grn: GrnDoc | null = null,
): Promise<boolean> {
  const normalized = await normalizeVendorHutangDoc(db, String(grn?.tenantId || hutang.tenantId || ''), hutang, grn);
  const fromPostedGrn = !!grn;

  // Utamakan koreksi per-baris (paling presisi, dan tidak bergantung pada grn.receivedTotal
  // yang bisa basi/cache). Fallback ke grn.receivedTotal HANYA kalau tidak ada satu pun baris
  // hutang yang bisa dicocokkan ke baris GRN (lineId hilang/beda) — baru di situ kita tidak
  // punya ground truth per-baris sama sekali.
  let correctedItems: HutangItemLike[] | null = null;
  let correctedTotal: number | null = null;
  if (grn) {
    const reconciled = reconcileHutangItemsFromGrn((normalized.items || []) as HutangItemLike[], grn.items);
    if (reconciled.matchedCount > 0) {
      const totalMismatch = Math.abs(Number(normalized.total || 0) - reconciled.total) > 1;
      if (reconciled.changed || totalMismatch) {
        correctedItems = reconciled.changed ? reconciled.items : null;
        correctedTotal = reconciled.total;
      }
    } else {
      const recv = calcGrnReceivedTotal(grn);
      if (Math.abs(Number(normalized.total || 0) - recv) > 1) correctedTotal = recv;
    }
  }

  if (!vendorInvoiceNeedsPendingReview(normalized, { fromPostedGrn })) {
    if (correctedTotal != null) {
      await db.collection('hutang').updateOne(
        { id: normalized.id },
        {
          $set: {
            ...(correctedItems ? { items: correctedItems } : {}),
            total: correctedTotal,
            sisa: Math.max(0, correctedTotal - Number(normalized.terbayar || 0)),
            updatedAt: new Date(),
          },
        },
      );
      return true;
    }
    return false;
  }

  await resetVendorHutangToPendingReview(db, normalized, { total: correctedTotal, items: correctedItems });
  return true;
}

function calcGrnReceivedTotal(grn: GrnDoc): number {
  const direct = parseInt(String(grn?.receivedTotal || 0), 10);
  if (direct > 0) return direct;
  return (grn?.items || []).reduce((s, it) => {
    const qty = parseFloat(String(it.qtyReceived ?? it.qtyOrdered)) || 0;
    const harga = parseInt(String(it.harga || it.hargaSatuan || it.hargaBeliBaru || 0), 10);
    return s + Math.round(qty * harga);
  }, 0);
}

/** Buat tagihan vendor lokal dari GRN POSTED (fallback jika sales.app / jurnal gagal). */
export async function ensureHutangForPostedGrn(
  db: Db,
  tenantId: string,
  grn: GrnDoc,
): Promise<Record<string, unknown>> {
  const tid = normalizeTenantId(String(grn?.tenantId || tenantId));
  if (!grn || grn.status !== 'POSTED') return { error: 'GRN belum POSTED' };
  if (!grn.noDO) return { error: 'noDO kosong' };

  const existing = await findVendorHutang(db, tid, grn);
  if (existing) return { hutangId: existing.id, action: 'exists', noHutang: existing.noHutang };

  const total = calcGrnReceivedTotal(grn);
  if (total <= 0) return { error: 'Nilai penerimaan GRN kosong' };

  const invoiceId = String(grn.vendorInvoiceId || `grn-local:${grn.id}`);
  const payload: VendorInvoicePayload = {
    invoiceId,
    noInvoice: grn.noInvoice || `INV-${grn.noGRN}`,
    noDO: grn.noDO,
    noSO: grn.noSO ?? undefined,
    noPO: grn.noPO ?? undefined,
    subTotal: total,
    ppn: 0,
    total,
    paymentTerms: 'KREDIT',
    items: (grn.items || []).map((it) => ({
      kode: String(it.vendorKode || it.localKode || ''),
      qty: parseFloat(String(it.qtyReceived ?? it.qtyOrdered)) || 0,
      harga: parseInt(String(it.harga || it.hargaSatuan || it.hargaBeliBaru || 0), 10),
    })),
    postedAt: grn.postedAt || new Date(),
  };

  const result = await createHutangFromVendorInvoice(
    db,
    tid,
    payload,
    grn.vendorTenantId ? String(grn.vendorTenantId) : null,
  );
  if ('error' in result && result.error) return { error: result.error };

  await db.collection('goods_receipts').updateOne(
    { id: grn.id },
    {
      $set: {
        hutangId: result.hutangId,
        vendorInvoiceId: invoiceId,
        noInvoice: payload.noInvoice,
        receivedTotal: total,
      },
    },
  );

  return result;
}

/** Perbaiki tagihan vendor stale — termasuk yang ter-link GRN tapi tenantId/referenceType salah. */
export async function repairStaleVendorHutangs(
  db: Db,
  tenantId: string,
  { grnSkip = 0, grnLimit = 500 }: { grnSkip?: number; grnLimit?: number } = {},
): Promise<{ fixed: number; processed: number; hasMore: boolean }> {
  const tid = normalizeTenantId(tenantId);
  const seen = new Set<string>();
  let fixed = 0;

  const grnBatch = await db.collection('goods_receipts').find({
    ...tenantIdMatchFilter(tid),
    status: 'POSTED',
  }).sort({ postedAt: -1 }).skip(grnSkip).limit(grnLimit + 1).toArray();

  const hasMore = grnBatch.length > grnLimit;
  const grns = hasMore ? grnBatch.slice(0, grnLimit) : grnBatch;

  const hutangMaps = await buildHutangLookupMaps(db, tid, grns as GrnDoc[]);

  for (const grnRow of grns) {
    const grn = grnRow as GrnDoc;
    const hutang = await findVendorHutang(db, tid, grn, hutangMaps);
    if (!hutang?.id || seen.has(hutang.id)) continue;
    seen.add(hutang.id);
    if (await fixHutangApprovalIfNeeded(db, hutang, grn)) fixed += 1;
  }

  if (grnSkip === 0) {
    const rows = await db.collection('hutang').find({
      $or: [
        { referenceType: 'VENDOR_INVOICE', ...tenantIdMatchFilter(tid) },
        { vendorInvoiceId: { $exists: true, $ne: null }, ...tenantIdMatchFilter(tid) },
      ],
    }).toArray();

    for (const hutangRow of rows) {
      const hutang = hutangRow as HutangDoc;
      if (!hutang.id || seen.has(hutang.id)) continue;
      seen.add(hutang.id);
      if (await fixHutangApprovalIfNeeded(db, hutang)) fixed += 1;
    }
  }

  return { fixed, processed: grns.length, hasMore };
}

function needsSalesReplay(
  grn: GrnDoc,
  hutang: HutangDoc | null,
  { fullSync = false, salesDoSet = null }: SalesReplayOptions = {},
): boolean {
  if (!grn.noDO && !grn.vendorDeliveryId) return false;
  if (hutang) {
    if (vendorInvoiceNeedsPendingReview(hutang, { fromPostedGrn: true })) return true;
    const recv = parseInt(String(grn.receivedTotal || 0), 10);
    if (recv > 0 && Math.abs(Number(hutang.total || 0) - recv) > 1) return true;
    return false;
  }
  if (!fullSync) return false;
  if (salesDoSet && grn.noDO && salesDoSet.has(String(grn.noDO))) return false;
  return true;
}

export async function reconcileVendorHutangFromPostedGrns(
  db: Db,
  tenantId: string,
  { callSales = false, queueSalesReplays = false, salesDoSet = null }: ReconcileOptions = {},
) {
  const tid = normalizeTenantId(tenantId);
  const queueReplays = queueSalesReplays || callSales === true;
  const repairResult = await repairStaleVendorHutangs(db, tid);
  let fixed = repairResult.fixed;

  if (repairResult.hasMore) {
    await enqueueJob(db, {
      type: JOB_TYPES.HUTANG_REPAIR,
      tenantId: tid,
      payload: {
        grnSkip: repairResult.processed,
        dedupeKey: `hutang-repair:${tid}:${repairResult.processed}`,
      },
    });
    scheduleJobProcessing(db, { limit: 2 });
  }

  const grns = await db.collection('goods_receipts').find({
    ...tenantIdMatchFilter(tid),
    status: 'POSTED',
    noDO: { $exists: true, $ne: null },
  }).sort({ postedAt: -1 }).limit(300).toArray();

  const hutangMaps = await buildHutangLookupMaps(db, tid, grns as GrnDoc[]);

  let created = 0;
  let linked = 0;
  let unlinked = 0;
  let replayed = 0;
  const salesErrors: SalesErrorRow[] = [];

  for (const grnRow of grns) {
    let grn = grnRow as GrnDoc;

    if (grn.hutangId) {
      const linkedHutang = hutangMaps.byId.get(grn.hutangId);
      if (linkedHutang && !hutangMatchesGrnVendor(linkedHutang, grn)) {
        await db.collection('goods_receipts').updateOne(
          { id: grn.id },
          { $unset: { hutangId: '', vendorInvoiceId: '', noInvoice: '' } },
        );
        grn = { ...grn, hutangId: undefined, vendorInvoiceId: undefined, noInvoice: undefined };
        unlinked += 1;
      }
    }

    let hutang = await findVendorHutang(db, tid, grn, hutangMaps);

    if (hutang) {
      hutang = await normalizeVendorHutangDoc(db, tid, hutang, grn);
      if (await fixHutangApprovalIfNeeded(db, hutang, grn)) {
        const fresh = await db.collection('hutang').findOne({ id: hutang.id });
        hutang = (fresh as HutangDoc | null) || hutang;
        fixed += 1;
      }
      if (!hutang?.id) continue;
      const hutangTid = normalizeTenantId(String(hutang.tenantId || ''));
      if (hutangTid !== tid) {
        await db.collection('hutang').updateOne({ id: hutang.id }, { $set: { tenantId: tid } });
        hutang = { ...hutang, tenantId: tid };
        fixed += 1;
      }
      if (grn.hutangId !== hutang.id || grn.noInvoice !== hutang.noInvoice) {
        await db.collection('goods_receipts').updateOne(
          { id: grn.id },
          {
            $set: {
              hutangId: hutang.id,
              noInvoice: hutang.noInvoice || grn.noInvoice,
              vendorInvoiceId: hutang.vendorInvoiceId || grn.vendorInvoiceId,
            },
          },
        );
        linked += 1;
      }
    }

    const doSet = salesDoSet || new Set<string>();
    const fullSync = queueReplays === true;
    if (!queueReplays || !needsSalesReplay(grn, hutang, { fullSync, salesDoSet: doSet })) continue;

    await enqueueJob(db, {
      type: JOB_TYPES.GRN_INVOICE_SYNC,
      tenantId: tid,
      grnId: grn.id,
    });
    replayed += 1;
  }

  if (replayed > 0) scheduleJobProcessing(db, { limit: 5 });

  let localCreated = 0;
  for (const grnRow of grns) {
    const grn = grnRow as GrnDoc;
    if (await findVendorHutang(db, tid, grn, hutangMaps)) continue;
    const local = await ensureHutangForPostedGrn(db, tid, grn);
    if (local.hutangId && local.action === 'created') {
      localCreated += 1;
      created += 1;
    }
  }

  return { created, fixed, linked, unlinked, replayed, scanned: grns.length, salesErrors, localCreated };
}

/** One-time / manual backfix: perbaiki hutang dari GRN POSTED + optional replay sales untuk yang belum punya invoice. */
export async function backfixVendorHutangFromPostedGrns(
  db: Db,
  tenantId: string,
  { replaySales = false } = {},
) {
  const tid = normalizeTenantId(tenantId);
  const reconcile = await reconcileVendorHutangFromPostedGrns(db, tid, {
    queueSalesReplays: replaySales,
  });

  const pending = await db.collection('hutang').countDocuments({
    $or: [
      { referenceType: 'VENDOR_INVOICE', ...tenantIdMatchFilter(tid) },
      { vendorInvoiceId: { $exists: true, $ne: null }, ...tenantIdMatchFilter(tid) },
    ],
    $and: [{
      $or: [
        { approvalStatus: 'PENDING_REVIEW' },
        { status: 'PENDING_REVIEW', approvalStatus: { $exists: false } },
      ],
    }],
  });

  return { ...reconcile, pendingAfter: pending, tenantId: tid };
}
