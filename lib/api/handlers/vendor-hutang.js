// Hutang ke vendor (sales.app) — review, approve, laporan pengadaan.

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole } from '@/lib/api/require-auth';
import { resolveOperationalScope, withTenantFilter } from '@/lib/api/tenant-master';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { guardPosting } from '@/lib/api/period-lock';
import { enrichHutangDetail, assertCanApproveInvoice, actorSnapshot } from '@/lib/api/hutang-approval';
import { resolveHutangVariance } from '@/lib/api/hutang-variance-enrich';
import { buildHutangDetailEnrichment } from '@/lib/api/hutang-detail-enrich';
import { syncPostedInvoicesFromSales } from '@/lib/api/invoice-sync-sales';
import { backfillLegacyVendorInvoices } from '@/lib/api/migrate-hutang-approval';
import { backfixVendorHutangFromPostedGrns } from '@/lib/api/hutang-reconcile';
import { createJournal } from '@/lib/api/journal';
import { buildHutangPaymentJournalLines } from '@/lib/api/journal-lines';

const HUTANG_ADMIN_ROLES = ['ADMIN', 'MASTER'];

function vendorInvoiceFilter(extra = {}) {
  const base = {
    $or: [
      { referenceType: 'VENDOR_INVOICE' },
      { vendorInvoiceId: { $exists: true, $ne: null } },
    ],
  };
  if (!extra || Object.keys(extra).length === 0) return base;
  return { $and: [base, extra] };
}

function approvalStatusFilter(approvalStatus) {
  if (!approvalStatus) return {};
  if (approvalStatus === 'PENDING_REVIEW') {
    return {
      $or: [
        { approvalStatus: 'PENDING_REVIEW' },
        { status: 'PENDING_REVIEW', approvalStatus: { $exists: false } },
      ],
    };
  }
  return { approvalStatus };
}

function mapHutangRow(h, today) {
  const jt = new Date(h.jatuhTempo);
  const daysLate = Math.floor((today - jt) / 86400000);
  const approval = h.approvalStatus || h.status;
  let aging = 'CURRENT';
  const isSettled = ['LUNAS', 'PAID_EXTERNAL'].includes(approval)
    || ['LUNAS', 'PAID_EXTERNAL'].includes(h.status);
  if (!isSettled) {
    if (approval === 'PENDING_REVIEW') aging = 'REVIEW';
    else if (daysLate > 90) aging = '90+';
    else if (daysLate > 60) aging = '61-90';
    else if (daysLate > 30) aging = '31-60';
    else if (daysLate > 0) aging = '1-30';
  } else aging = 'LUNAS';
  return {
    ...clean(h),
    supplierName: h.supplierName || 'Vendor',
    approvalStatus: approval,
    aging,
    daysLate,
  };
}

export async function handleVendorHutang({ db, route, method, path, body, url, auth, request }) {
  if (route === '/hutang/backfix' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, tenantId } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const replaySales = body?.replaySales !== false;
    const tenantIds = [tenantId];

    let result = { fixed: 0, linked: 0, created: 0, replayed: 0, pendingAfter: 0, salesErrors: [] };
    for (const t of tenantIds) {
      const part = await backfixVendorHutangFromPostedGrns(db, t, { replaySales });
      result.fixed += part.fixed || 0;
      result.linked += part.linked || 0;
      result.created += part.created || 0;
      result.replayed += part.replayed || 0;
      result.pendingAfter += part.pendingAfter || 0;
      if (part.salesErrors?.length) result.salesErrors.push(...part.salesErrors);
    }
    return ok(result);
  }

  if (route === '/hutang/sync-pending' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const replaySales = body?.replaySales === true;
    let syncResult = { created: 0, existing: 0, refreshed: 0, errors: [], total: 0 };
    let reconcile = { created: 0, fixed: 0, linked: 0, replayed: 0, scanned: 0, salesErrors: [] };

    const tenantIds = [tenantId];

    for (const t of tenantIds) {
      if (replaySales) {
        await backfixVendorHutangFromPostedGrns(db, t, { replaySales: true });
      } else {
        await backfixVendorHutangFromPostedGrns(db, t, { replaySales: false });
      }
      const part = await syncPostedInvoicesFromSales(db, t, { reconcileSales: replaySales });
      if (part.error && !part.skipped && !syncResult.error) syncResult = part;
      else {
        syncResult.created += part.created || 0;
        syncResult.existing += part.existing || 0;
        syncResult.refreshed += part.refreshed || 0;
        syncResult.total += part.total || 0;
        if (part.errors?.length) syncResult.errors.push(...part.errors);
      }
      if (part.reconcile) {
        reconcile.created += part.reconcile.created || 0;
        reconcile.fixed += part.reconcile.fixed || 0;
        reconcile.linked += part.reconcile.linked || 0;
        reconcile.replayed += part.reconcile.replayed || 0;
        reconcile.scanned += part.reconcile.scanned || 0;
        if (part.reconcile.salesErrors?.length) {
          reconcile.salesErrors = (reconcile.salesErrors || []).concat(part.reconcile.salesErrors);
        }
      }
    }

    if (syncResult.error && !syncResult.skipped) return err(syncResult.error, syncResult.skipped ? 501 : 400);

    const pendingFilter = withTenantFilter(
      scopeAuth,
      vendorInvoiceFilter(approvalStatusFilter('PENDING_REVIEW')),
    );
    const pendingAfter = await db.collection('hutang').countDocuments(pendingFilter);
    return ok({ ...syncResult, reconcile, pendingAfter });
  }

  if (route === '/hutang/migrate-legacy' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, tenantId } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const result = await backfillLegacyVendorInvoices(db, tenantId);
    return ok(result);
  }

  if (route === '/hutang/pending-count' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const filter = withTenantFilter(scopeAuth, vendorInvoiceFilter(approvalStatusFilter('PENDING_REVIEW')));
    const count = await db.collection('hutang').countDocuments(filter);
    return ok({ count });
  }

  if (route === '/hutang' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const status = url.searchParams.get('status') || '';
    const approvalStatus = url.searchParams.get('approvalStatus') || '';
    let filter = vendorInvoiceFilter(approvalStatusFilter(approvalStatus));
    if (!approvalStatus && status) {
      filter = vendorInvoiceFilter({
        $or: [
          { approvalStatus: status },
          { status, approvalStatus: { $exists: false } },
        ],
      });
    }
    filter = withTenantFilter(scopeAuth, filter);
    const list = await db.collection('hutang').find(filter).sort({ tanggal: -1, jatuhTempo: 1 }).limit(500).toArray();

    const today = new Date();
    return ok(list.map((h) => mapHutangRow(h, today)));
  }

  if (path[0] === 'hutang' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const doc = await db.collection('hutang').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
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
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, body);
    if (locked) return locked;

    const hutang = await db.collection('hutang').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!hutang) return err('Tagihan tidak ditemukan', 404);

    const check = await assertCanApproveInvoice(db, hutang, {
      overrideMatch: body?.overrideMatch === true,
    });
    if (!check.ok) return err(check.error, check.code === 'MATCH_EXCEPTION' ? 409 : 400);

    const now = new Date();
    const approver = await actorSnapshot(db, auth);
    const patch = {
      approvalStatus: 'APPROVED',
      status: 'APPROVED',
      approvedBy: approver,
      approvedAt: now,
      updatedAt: now,
    };
    if (body?.overrideMatch && hutang.matchStatus === 'EXCEPTION') {
      patch.matchOverride = true;
      patch.matchOverrideNote = body?.note || '';
      patch.matchOverrideBy = approver;
    }

    await db.collection('hutang').updateOne({ id: hutang.id }, { $set: patch });
    const updated = await db.collection('hutang').findOne({ id: hutang.id });
    return ok(clean(updated));
  }

  if (path[0] === 'hutang' && path[1] && path[2] === 'reject' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;

    const hutang = await db.collection('hutang').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!hutang) return err('Tagihan tidak ditemukan', 404);
    const approval = hutang.approvalStatus || hutang.status;
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
          rejectReason: body?.reason || 'Ditolak admin',
          updatedAt: now,
        },
      },
    );
    const updated = await db.collection('hutang').findOne({ id: hutang.id });
    return ok(clean(updated));
  }

  if (path[0] === 'hutang' && path[1] && path[2] === 'mark-paid-external' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, body);
    if (locked) return locked;

    const hutang = await db.collection('hutang').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!hutang) return err('Tagihan tidak ditemukan', 404);
    const approval = hutang.approvalStatus || hutang.status;
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
          paidExternalNote: body?.note || 'Pembayaran di luar sistem',
          updatedAt: now,
        },
      },
    );
    const updated = await db.collection('hutang').findOne({ id: hutang.id });
    return ok(clean(updated));
  }

  if (path[0] === 'hutang' && path[1] && path[2] === 'bayar' && method === 'POST') {
    const deniedRole = requireRole(auth, HUTANG_ADMIN_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, body);
    if (locked) return locked;

    const amount = parseInt(body?.amount || 0, 10);
    if (amount <= 0) return err('Nominal tidak valid');

    const hutang = await db.collection('hutang').findOne(withTenantFilter(scopeAuth, { id: path[1] }));
    if (!hutang) return err('Hutang tidak ditemukan', 404);
    const approval = hutang.approvalStatus || hutang.status;
    if (approval === 'PENDING_REVIEW') {
      return err('Tagihan belum disetujui — gunakan approve terlebih dahulu', 400);
    }
    if (approval === 'REJECTED') return err('Tagihan ditolak', 400);
    if (amount > hutang.sisa) return err(`Pembayaran melebihi sisa (${hutang.sisa})`);

    const tenantId = hutang.tenantId || auth?.tenantId || 'default';
    const now = new Date();
    const newTerbayar = (hutang.terbayar || 0) + amount;
    const newSisa = hutang.total - newTerbayar;
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
      metode: body.metode || 'TUNAI',
      keterangan: body.keterangan || '',
      userName: body.userName || '',
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
          metode: body.metode || 'TUNAI',
        }),
        userName: body.userName || '',
        tenantId,
      });
    } catch (e) {
      return err(e?.message || 'Gagal posting jurnal pembayaran hutang', 500);
    }

    const updated = await db.collection('hutang').findOne({ id: hutang.id });
    return ok(clean(updated));
  }

  return null;
}
