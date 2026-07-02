import type { Db } from 'mongodb';
// Hutang ke vendor (sales.app) — review, approve, laporan pengadaan.

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole } from '@/lib/api/require-auth';
import { resolveOperationalScope, withTenantFilter } from '@/lib/api/tenant-master';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { guardPosting } from '@/lib/api/period-lock';
import { enrichHutangDetail, assertCanApproveInvoice, actorSnapshot } from '@/lib/api/hutang-approval';
import { resolveHutangVariance } from '@/lib/api/hutang-variance-enrich';
import { buildHutangDetailEnrichment } from '@/lib/api/hutang-detail-enrich';
import { backfillLegacyVendorInvoices } from '@/lib/api/migrate-hutang-approval';
import { backfixVendorHutangFromPostedGrns } from '@/lib/api/hutang-reconcile';
import { runHutangSyncPending } from '@/lib/api/hutang-sync-pending-run';
import { enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import { parseCursorPageParams, applyDescDateIdCursor, cursorPageResponse } from '@/lib/api/cursor-page';
import {
  payableHutangFilter,
  approvalStatusFilter,
  stripHutangListSnapshot,
} from '@/lib/api/hutang-filters';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { buildHutangPaymentJournalLines } from '@/lib/api/journal-lines';
import { createJournal } from '@/lib/api/journal';
import type { HandlerContext } from '@/types/api/handler';

const HUTANG_ADMIN_ROLES = ['ADMIN', 'MASTER'];

interface HutangBody extends Record<string, unknown> {
  replaySales?: boolean;
  overrideMatch?: boolean;
  note?: string;
  reason?: string;
  amount?: number | string;
  metode?: string;
  keterangan?: string;
  userName?: string;
}

interface HutangDoc extends Record<string, unknown> {
  id: string;
  tenantId?: string;
  jatuhTempo?: string | Date;
  approvalStatus?: string;
  status?: string;
  total?: number;
  terbayar?: number;
  sisa?: number;
  noHutang?: string;
  noInvoice?: string;
  matchStatus?: string;
  customerPoId?: string | null;
  poEstimasiTotal?: number;
  soTotal?: number;
  grnReceivedTotal?: number;
}

interface ReconcileSummary {
  created: number;
  fixed: number;
  linked: number;
  replayed: number;
  scanned: number;
  salesErrors: unknown[];
}

function mapHutangRow(h: HutangDoc, today: Date) {
  const jt = new Date(String(h.jatuhTempo));
  const daysLate = Math.floor((today.getTime() - jt.getTime()) / 86400000);
  const approval = String(h.approvalStatus || h.status || '');
  let aging = 'CURRENT';
  const isSettled = ['LUNAS', 'PAID_EXTERNAL'].includes(approval)
    || ['LUNAS', 'PAID_EXTERNAL'].includes(String(h.status || ''));
  if (!isSettled) {
    if (approval === 'PENDING_REVIEW') aging = 'REVIEW';
    else if (daysLate > 90) aging = '90+';
    else if (daysLate > 60) aging = '61-90';
    else if (daysLate > 30) aging = '31-60';
    else if (daysLate > 0) aging = '1-30';
  } else aging = 'LUNAS';
  return stripHutangListSnapshot({
    ...clean(h),
    supplierName: h.supplierName || 'Vendor',
    approvalStatus: approval,
    aging,
    daysLate,
  });
}

export async function handleVendorHutang({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const hutangBody = (body || {}) as HutangBody;

  if (route === '/hutang/backfix' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, tenantId } = resolveOperationalScope(auth, { url, body: hutangBody, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);
    const replaySales = hutangBody.replaySales !== false;

    let result = { fixed: 0, linked: 0, created: 0, replayed: 0, pendingAfter: 0, salesErrors: [] as unknown[] };
    const part = await backfixVendorHutangFromPostedGrns(db, tenantId, { replaySales });
    result.fixed += part.fixed || 0;
    result.linked += part.linked || 0;
    result.created += part.created || 0;
    result.replayed += part.replayed || 0;
    result.pendingAfter += part.pendingAfter || 0;
    if (part.salesErrors?.length) result.salesErrors.push(...part.salesErrors);
    return ok(result);
  }

  if (route === '/hutang/sync-pending' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, body: hutangBody, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);
    const replaySales = hutangBody.replaySales === true;

    const inline = url.searchParams.get('inline') === '1';
    if (inline) {
      const result = await runHutangSyncPending(db, tenantId, scopeAuth, { replaySales });
      if ('error' in result && result.error && !('skipped' in result)) {
        return err(String(result.error), 400);
      }
      return ok(result);
    }

    const { jobId, reused } = await enqueueJob(db, {
      type: JOB_TYPES.HUTANG_SYNC,
      tenantId,
      payload: { replaySales },
    });
    scheduleJobProcessing(db);
    return ok({ jobId, async: true, status: reused ? 'RUNNING' : 'PENDING', reused }, 202);
  }

  if (route === '/hutang/migrate-legacy' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, tenantId } = resolveOperationalScope(auth, { url, body: hutangBody, request });
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);
    const result = await backfillLegacyVendorInvoices(db, tenantId);
    return ok(result);
  }

  if (route === '/hutang' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const status = url.searchParams.get('status') || '';
    const approvalStatus = url.searchParams.get('approvalStatus') || '';
    let filter: Record<string, unknown> = payableHutangFilter(approvalStatusFilter(approvalStatus));
    if (!approvalStatus && status) {
      filter = payableHutangFilter({
        $or: [
          { approvalStatus: status },
          { status, approvalStatus: { $exists: false } },
        ],
      });
    }
    filter = withTenantFilter(scopeAuth, filter);
    const { pageMode, limit, cursor } = parseCursorPageParams(url.searchParams, { defaultLimit: 100, maxLimit: 500 });
    const listFilter = applyDescDateIdCursor(filter, cursor, 'tanggal');
    const list = await db.collection('hutang')
      .find(listFilter)
      .sort({ tanggal: -1, id: -1 })
      .limit(limit)
      .toArray();

    const today = new Date();
    const mapped = list.map((h) => mapHutangRow(h as unknown as HutangDoc, today));
    if (pageMode) {
      const last = list[list.length - 1] as Record<string, unknown> | undefined;
      return ok(cursorPageResponse(mapped, limit, 'tanggal', last));
    }
    return ok(mapped);
  }

  if (path[0] === 'hutang' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const doc = await db.collection('hutang').findOne(withTenantFilter(scopeAuth, { id: path[1] })) as HutangDoc | null;
    if (!doc) return err('Tidak ditemukan', 404);
    const [pembayaran, detail, billing, variance] = await Promise.all([
      db.collection('hutang_pembayaran').find({ hutangId: doc.id }).sort({ tanggal: -1 }).toArray(),
      enrichHutangDetail(db, doc),
      buildHutangDetailEnrichment(db, doc),
      resolveHutangVariance(db, doc),
    ]);
    if (
      (doc.poEstimasiTotal || 0) !== variance.poEstimasiTotal
      || (doc.soTotal || 0) !== variance.soTotal
      || (doc.grnReceivedTotal || 0) !== variance.grnReceivedTotal
    ) {
      await db.collection('hutang').updateOne(
        { id: doc.id },
        {
          $set: {
            poEstimasiTotal: variance.poEstimasiTotal,
            soTotal: variance.soTotal,
            soSubTotal: variance.soSubTotal,
            grnReceivedTotal: variance.grnReceivedTotal,
            variancePoToSo: variance.variancePoToSo,
            varianceSoToInvoice: variance.varianceSoToInvoice,
            customerPoId: variance.customerPoId || doc.customerPoId || null,
            updatedAt: new Date(),
          },
        },
      );
    }
    return ok({
      ...clean(doc),
      pembayaran: pembayaran.map(clean),
      ...detail,
      ...billing,
      poEstimasiTotal: variance.poEstimasiTotal,
      soTotal: variance.soTotal,
      grnReceivedTotal: variance.grnReceivedTotal,
      variancePoToSo: variance.variancePoToSo,
      varianceSoToInvoice: variance.varianceSoToInvoice,
      varianceGrnToInvoice: variance.varianceGrnToInvoice,
      priceComparison: {
        poEstimasiTotal: variance.poEstimasiTotal,
        soTotal: variance.soTotal,
        grnReceivedTotal: variance.grnReceivedTotal,
        invoiceTotal: variance.invoiceTotal,
        variancePoToSo: variance.variancePoToSo,
        varianceSoToInvoice: variance.varianceSoToInvoice,
        varianceGrnToInvoice: variance.varianceGrnToInvoice,
      },
    });
  }

  if (path[0] === 'hutang' && path[1] && path[2] === 'approve' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: hutangBody, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, hutangBody);
    if (locked) return locked;

    const hutang = await db.collection('hutang').findOne(withTenantFilter(scopeAuth, { id: path[1] })) as HutangDoc | null;
    if (!hutang) return err('Tagihan tidak ditemukan', 404);

    const check = await assertCanApproveInvoice(db, hutang, {
      overrideMatch: hutangBody.overrideMatch === true,
    });
    if (!check.ok) return err(check.error, check.code === 'MATCH_EXCEPTION' ? 409 : 400);

    const now = new Date();
    const approver = await actorSnapshot(db, auth);
    const patch: Record<string, unknown> = {
      approvalStatus: 'APPROVED',
      status: 'APPROVED',
      approvedBy: approver,
      approvedAt: now,
      updatedAt: now,
    };
    if (hutangBody.overrideMatch && hutang.matchStatus === 'EXCEPTION') {
      patch.matchOverride = true;
      patch.matchOverrideNote = hutangBody.note || '';
      patch.matchOverrideBy = approver;
    }

    await db.collection('hutang').updateOne({ id: hutang.id }, { $set: patch });
    await invalidateDashboardSnapshot(db, String(hutang.tenantId || 'default'));
    const updated = await db.collection('hutang').findOne({ id: hutang.id });
    return ok(clean(updated));
  }

  if (path[0] === 'hutang' && path[1] && path[2] === 'reject' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: hutangBody, request });
    if (denied) return denied;

    const hutang = await db.collection('hutang').findOne(withTenantFilter(scopeAuth, { id: path[1] })) as HutangDoc | null;
    if (!hutang) return err('Tagihan tidak ditemukan', 404);
    const approval = String(hutang.approvalStatus || hutang.status || '');
    if (approval !== 'PENDING_REVIEW') return err('Hanya tagihan menunggu review yang bisa ditolak', 400);

    const now = new Date();
    const rejector = await actorSnapshot(db, auth);
    await db.collection('hutang').updateOne(
      { id: hutang.id },
      {
        $set: {
          approvalStatus: 'REJECTED',
          status: 'REJECTED',
          rejectedBy: rejector,
          rejectedAt: now,
          rejectReason: hutangBody.reason || 'Ditolak admin',
          updatedAt: now,
        },
      },
    );
    await invalidateDashboardSnapshot(db, String(hutang.tenantId || 'default'));
    const updated = await db.collection('hutang').findOne({ id: hutang.id });
    return ok(clean(updated));
  }

  if (path[0] === 'hutang' && path[1] && path[2] === 'mark-paid-external' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: hutangBody, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, hutangBody);
    if (locked) return locked;

    const hutang = await db.collection('hutang').findOne(withTenantFilter(scopeAuth, { id: path[1] })) as HutangDoc | null;
    if (!hutang) return err('Tagihan tidak ditemukan', 404);
    const approval = String(hutang.approvalStatus || hutang.status || '');
    if (!['APPROVED', 'OUTSTANDING', 'PARTIAL'].includes(approval)) {
      return err('Tagihan harus disetujui terlebih dahulu', 400);
    }
    if (approval === 'PAID_EXTERNAL' || approval === 'LUNAS') {
      return err('Tagihan sudah lunas', 400);
    }

    const now = new Date();
    const marker = await actorSnapshot(db, auth);
    await db.collection('hutang').updateOne(
      { id: hutang.id },
      {
        $set: {
          approvalStatus: 'PAID_EXTERNAL',
          status: 'PAID_EXTERNAL',
          terbayar: hutang.total,
          sisa: 0,
          paidExternalAt: now,
          paidExternalBy: marker,
          paidExternalNote: hutangBody.note || 'Pembayaran di luar sistem',
          updatedAt: now,
        },
      },
    );
    await invalidateDashboardSnapshot(db, String(hutang.tenantId || 'default'));
    const updated = await db.collection('hutang').findOne({ id: hutang.id });
    return ok(clean(updated));
  }

  if (path[0] === 'hutang' && path[1] && path[2] === 'bayar' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: hutangBody, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, hutangBody);
    if (locked) return locked;

    const amount = parseInt(String(hutangBody.amount || 0), 10);
    if (amount <= 0) return err('Nominal tidak valid');

    const hutang = await db.collection('hutang').findOne(withTenantFilter(scopeAuth, { id: path[1] })) as HutangDoc | null;
    if (!hutang) return err('Hutang tidak ditemukan', 404);
    const approval = String(hutang.approvalStatus || hutang.status || '');
    if (approval === 'PENDING_REVIEW') {
      return err('Tagihan belum disetujui — gunakan approve terlebih dahulu', 400);
    }
    if (approval === 'REJECTED') return err('Tagihan ditolak', 400);
    const sisa = Number(hutang.sisa || 0);
    if (amount > sisa) return err(`Pembayaran melebihi sisa (${sisa})`);

    const tenantId = hutang.tenantId || auth?.tenantId || 'default';
    const now = new Date();
    const newTerbayar = Number(hutang.terbayar || 0) + amount;
    const newSisa = Number(hutang.total || 0) - newTerbayar;
    const newStatus = newSisa <= 0 ? 'PAID_EXTERNAL' : 'PARTIAL';

    await db.collection('hutang').updateOne(
      { id: hutang.id },
      {
        $set: {
          terbayar: newTerbayar,
          sisa: newSisa,
          status: newStatus,
          approvalStatus: newSisa <= 0 ? 'PAID_EXTERNAL' : hutang.approvalStatus,
          updatedAt: now,
        },
      },
    );
    await db.collection('hutang_pembayaran').insertOne(stampTenantId(tenantId, {
      id: uuidv4(),
      hutangId: hutang.id,
      tanggal: now,
      amount,
      metode: hutangBody.metode || 'TUNAI',
      keterangan: hutangBody.keterangan || '',
      userName: hutangBody.userName || '',
    }));

    try {
      await createJournal(db, {
        tanggal: now,
        keterangan: `Pelunasan hutang ${hutang.noHutang || hutang.noInvoice}`,
        sourceType: 'AUTO_PELUNASAN_HUTANG',
        sourceId: hutang.id,
        details: buildHutangPaymentJournalLines({
          noDoc: hutang.noInvoice || hutang.noHutang,
          amount,
          metode: hutangBody.metode || 'TUNAI',
        }),
        userName: hutangBody.userName || '',
        tenantId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal posting jurnal pembayaran hutang';
      return err(msg, 500);
    }

    const updated = await db.collection('hutang').findOne({ id: hutang.id });
    await invalidateDashboardSnapshot(db, tenantId);
    return ok(clean(updated));
  }

  return null;
}
