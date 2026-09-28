import type { Db } from 'mongodb';
// Validasi & aksi approval tagihan vendor.

import type { HutangDoc } from '@/types/documents';
import type { JsonObject } from '@/types/json';
import type { AuthContext } from '@/types/auth';
import type { VendorInvoiceLine, VendorInvoicePayload } from '@/types/integration';
import { validateInvoiceAgainstGrn } from '@/lib/api/three-way-match';

const APPROVABLE_PO_STATUSES = new Set(['RECEIVED', 'INVOICED']);

/** Payload 3-way match dari dokumen hutang tersimpan (untuk cek ulang saat review/approve). */
export function invoicePayloadFromHutang(hutang: HutangDoc): VendorInvoicePayload {
  const items = (Array.isArray(hutang.items) ? hutang.items : []) as VendorInvoiceLine[];
  return {
    invoiceId: hutang.vendorInvoiceId,
    noInvoice: hutang.noInvoice,
    noDO: hutang.noDO,
    noSO: hutang.noSO ?? null,
    noPO: hutang.noPO ?? null,
    salesOrderId: hutang.salesOrderId,
    vendorTenantId: hutang.vendorTenantId,
    items: items.map((it) => ({
      lineId: it.lineId,
      stokId: it.stokId,
      uomId: it.uomId,
      satuan: it.satuan,
      kode: it.kode,
      qty: it.qty,
      harga: it.harga,
    })),
  } as VendorInvoicePayload;
}

export type PoReceiptGate =
  | { ok: true; via: 'NO_PO' | 'PO_RECEIVED' | 'MATCHED' | 'QTY_COVERED' }
  | { ok: false; error: string; code: 'PO_NOT_RECEIVED' };

/**
 * Gerbang "barang sudah diterima" untuk approve tagihan ber-PO.
 * po.status adalah rollup seluruh baris PO; pada PO multi-pengiriman yang sah sebagian baris
 * bisa belum dikirim. Yang menentukan adalah baris yang DITAGIH invoice ini: bila qty tiap
 * baris tertutup GRN POSTED (dikurangi retur & invoice lain) dan sisa qty PO, gerbang lolos —
 * apa pun jenis selisih match-nya. Selisih harga/EXCEPTION tetap diputuskan lewat override.
 */
export async function resolvePoReceiptGate(
  db: Db,
  hutang: HutangDoc,
  po: JsonObject | null,
): Promise<PoReceiptGate> {
  if (!hutang.noPO || !po) return { ok: true, via: 'NO_PO' };
  if (APPROVABLE_PO_STATUSES.has(String(po.status || ''))) return { ok: true, via: 'PO_RECEIVED' };
  if (hutang.matchStatus === 'MATCHED') return { ok: true, via: 'MATCHED' };

  const items = Array.isArray(hutang.items) ? hutang.items : [];
  if (hutang.noDO && items.length) {
    const tid = hutang.tenantId || 'default';
    const qty = await validateInvoiceAgainstGrn(db, tid, invoicePayloadFromHutang(hutang), {
      excludeHutangId: hutang.id,
      qtyOnly: true,
    });
    if (qty.ok) return { ok: true, via: 'QTY_COVERED' };
    return {
      ok: false,
      error: `PO ${hutang.noPO} belum diterima lengkap untuk baris yang ditagih (status PO: ${po.status}) — ${qty.error}`,
      code: 'PO_NOT_RECEIVED',
    };
  }
  return {
    ok: false,
    error: `PO ${hutang.noPO} belum diterima lengkap (status: ${po.status})`,
    code: 'PO_NOT_RECEIVED',
  };
}

export async function actorSnapshot(db: Db, auth: AuthContext | null | undefined) {
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
    role: String(role || ''),
  };
}

/** Validasi body knowingBy / receivedBy untuk stamp — Nama + NIK wajib. */
export function parseKnowingSignature(
  raw: unknown,
  slotLabel = 'Mengetahui',
):
  | { ok: true; value: { userName: string; nik: string; jabatan?: string } }
  | { ok: false; error: string } {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
  const userName = String(o?.userName || o?.nama || '').trim();
  const nik = String(o?.nik || '').trim();
  const jabatan = String(o?.jabatan || '').trim();
  if (!userName || !nik) {
    return {
      ok: false,
      error: `Signature ${slotLabel} wajib: isi Nama dan NIK lewat tombol Buat signature`,
    };
  }
  return {
    ok: true,
    value: {
      userName,
      nik,
      ...(jabatan ? { jabatan } : {}),
    },
  };
}

export async function assertCanApproveInvoice(
  db: Db,
  hutang: HutangDoc,
  { overrideMatch = false }: { overrideMatch?: boolean } = {},
) {
  const approval = hutang.approvalStatus || hutang.status;
  if (approval !== 'PENDING_REVIEW') {
    return { ok: false, error: 'Tagihan tidak dalam status menunggu review' };
  }

  const tid = hutang.tenantId || 'default';

  if (hutang.noPO) {
    const po = await db.collection('customer_purchase_orders').findOne({ tenantId: tid, noPO: hutang.noPO });
    const gate = await resolvePoReceiptGate(db, hutang, po as JsonObject | null);
    if (!gate.ok) return gate;
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
  // Fallback: GRN yang sudah ter-link hutangId (jika noDO kosong / drift).
  if (!grns.length && hutang.id) {
    grns = await db.collection('goods_receipts')
      .find({ tenantId: tid, hutangId: hutang.id })
      .sort({ postedAt: -1 })
      .limit(20)
      .toArray() as JsonObject[];
  }

  const poReceived = po?.status === 'RECEIVED' || po?.status === 'INVOICED';
  const hasPostedGrn = grns.some((g) => g.status === 'POSTED');
  const pendingReview = (hutang.approvalStatus || hutang.status) === 'PENDING_REVIEW';
  const poGate = po && pendingReview
    ? (await resolvePoReceiptGate(db, hutang, po)).ok
    : poReceived || hutang.matchStatus === 'MATCHED';

  const tanggalPermintaanKirim = hutang.tanggalPermintaanKirim
    || po?.tanggalKedatangan
    || grns.find((g) => g.tanggalPermintaanKirim)?.tanggalPermintaanKirim
    || null;
  const grnAktual = grns.find((g) => g.tanggalAktualKirim || g.shippedAt || g.tanggal);
  const tanggalAktualKirim = hutang.tanggalAktualKirim
    || hutang.shippedAt
    || grnAktual?.tanggalAktualKirim
    || grnAktual?.shippedAt
    || grnAktual?.tanggal
    || null;

  // Tampilkan stempel Penerima dari GRN POSTED: lengkap dulu, lalu nama legacy, lalu tanggal terima.
  const postedGrn = grns.find((g) => g.status === 'POSTED' && resolvePenerimaGudang(g, { requireComplete: true }))
    || grns.find((g) => g.status === 'POSTED' && resolvePenerimaGudang(g))
    || grns.find((g) => g.status === 'POSTED')
    || null;
  const penerimaResolved = resolvePenerimaGudang(postedGrn, { requireComplete: true })
    || resolvePenerimaGudang(postedGrn);
  const penerimaGudang = postedGrn
    ? { ...(penerimaResolved || {}), postedAt: postedGrn.postedAt || null }
    : null;

  return {
    po: po ? {
      id: po.id,
      noPO: po.noPO,
      status: po.status,
      estimasiTotal: po.estimasiTotal,
      vendorSoSnapshot: po.vendorSoSnapshot,
      tanggalKedatangan: po.tanggalKedatangan || null,
      poReceived,
    } : null,
    grns: grns.map((g) => ({
      id: g.id,
      noGRN: g.noGRN,
      status: g.status,
      receivedTotal: g.receivedTotal,
      postedAt: g.postedAt,
      tanggalPermintaanKirim: g.tanggalPermintaanKirim || null,
      tanggalAktualKirim: g.tanggalAktualKirim || g.shippedAt || g.tanggal || null,
      // Stempel hanya untuk POSTED — jangan expose legacy nama di DRAFT.
      receivedBy: g.status === 'POSTED' ? resolvePenerimaGudang(g) : null,
      userName: g.userName || null,
    })),
    penerimaGudang,
    tanggalPermintaanKirim,
    tanggalAktualKirim,
    canApprove: pendingReview && (poGate || (!po && hasPostedGrn)),
  };
}

/**
 * Stempel Penerima gudang dari GRN.
 * Default: receivedBy lalu userName legacy (nama saja).
 * requireComplete: wajib receivedBy.userName + nik (stempel enterprise).
 */
export function resolvePenerimaGudang(
  grn: JsonObject | null | undefined,
  { requireComplete = false }: { requireComplete?: boolean } = {},
): {
  userId: string;
  userName: string;
  role: string;
  nik?: string;
  jabatan?: string;
} | null {
  if (!grn) return null;
  const rb = grn.receivedBy && typeof grn.receivedBy === 'object'
    ? (grn.receivedBy as JsonObject)
    : null;
  if (requireComplete) {
    const userName = String(rb?.userName || '').trim();
    const nik = String(rb?.nik || '').trim();
    if (!userName || !nik) return null;
    const jabatan = String(rb?.jabatan || '').trim();
    return {
      userId: String(rb?.userId || ''),
      userName,
      role: String(rb?.role || ''),
      nik,
      ...(jabatan ? { jabatan } : {}),
    };
  }
  const userName = String(rb?.userName || grn.userName || '').trim();
  if (!userName) return null;
  const nik = String(rb?.nik || '').trim();
  const jabatan = String(rb?.jabatan || '').trim();
  return {
    userId: String(rb?.userId || ''),
    userName,
    role: String(rb?.role || ''),
    ...(nik ? { nik } : {}),
    ...(jabatan ? { jabatan } : {}),
  };
}
