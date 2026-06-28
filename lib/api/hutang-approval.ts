import type { Db } from 'mongodb';
// Validasi & aksi approval tagihan vendor.

import type { HutangDoc } from '@/types/documents';
import type { JsonObject } from '@/types/json';

const APPROVABLE_PO_STATUSES = new Set(['RECEIVED', 'INVOICED']);

export async function actorSnapshot(db: Db, auth) {
  let userName = String(auth?.name || auth?.email || '').trim();
  let role = auth?.role || '';
  if (auth?.userId) {
    const u = await db.collection('users').findOne({ id: auth.userId });
    if (u) {
      if (!userName) userName = String(u.name || u.email || '').trim();
      if (!role) role = u.role || '';
    }
  }
  return {
    userId: auth?.userId || '',
    userName: userName || 'Pengguna',
    role,
  };
}

export async function assertCanApproveInvoice(db: Db, hutang, { overrideMatch = false } = {}) {
  const approval = hutang.approvalStatus || hutang.status;
  if (approval !== 'PENDING_REVIEW') {
    return { ok: false, error: 'Tagihan tidak dalam status menunggu review' };
  }

  const tid = hutang.tenantId || 'default';

  if (hutang.noPO) {
    const po = await db.collection('customer_purchase_orders').findOne({ tenantId: tid, noPO: hutang.noPO });
    if (po && !APPROVABLE_PO_STATUSES.has(po.status)) {
      return {
        ok: false,
        error: `PO ${hutang.noPO} belum diterima lengkap (status: ${po.status})`,
        code: 'PO_NOT_RECEIVED',
      };
    }
  } else if (hutang.noDO) {
    const grn = await db.collection('goods_receipts').findOne({
      tenantId: tid,
      noDO: hutang.noDO,
      status: 'POSTED',
    });
    if (!grn) {
      return {
        ok: false,
        error: `Belum ada GRN POSTED untuk DO ${hutang.noDO}`,
        code: 'GRN_NOT_POSTED',
      };
    }
  }

  if (hutang.matchStatus === 'EXCEPTION' && !overrideMatch) {
    return {
      ok: false,
      error: hutang.matchError || '3-way match exception — setujui dengan override jika sudah diverifikasi',
      code: 'MATCH_EXCEPTION',
    };
  }

  return { ok: true };
}

export async function enrichHutangDetail(db: Db, hutang: HutangDoc) {
  const tid = hutang.tenantId || 'default';
  let po: JsonObject | null = null;
  let grns: JsonObject[] = [];

  if (hutang.noPO) {
    po = await db.collection('customer_purchase_orders').findOne({ tenantId: tid, noPO: hutang.noPO }) as JsonObject | null;
  }
  if (hutang.noDO) {
    grns = await db.collection('goods_receipts')
      .find({ tenantId: tid, noDO: hutang.noDO })
      .sort({ postedAt: -1 })
      .limit(20)
      .toArray() as JsonObject[];
  }

  const poReceived = po?.status === 'RECEIVED' || po?.status === 'INVOICED';
  const hasPostedGrn = grns.some((g) => g.status === 'POSTED');

  return {
    po: po ? {
      id: po.id,
      noPO: po.noPO,
      status: po.status,
      estimasiTotal: po.estimasiTotal,
      vendorSoSnapshot: po.vendorSoSnapshot,
      poReceived,
    } : null,
    grns: grns.map((g) => ({
      id: g.id,
      noGRN: g.noGRN,
      status: g.status,
      receivedTotal: g.receivedTotal,
      postedAt: g.postedAt,
    })),
    canApprove: (hutang.approvalStatus || hutang.status) === 'PENDING_REVIEW'
      && (poReceived || (!po && hasPostedGrn)),
  };
}
