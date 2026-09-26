/**
 * controls-recon: master data dan kontrol internal dari laporan temuan — lot berkedaluwarsa default,
 * kode produk ganda, konversi resep aktif belum terverifikasi, penyesuaian tanpa penyetuju independen,
 * RL disetujui pembuatnya, dan tagihan EXCEPTION yang tetap berjurnal tanpa override.
 */

import type { Db } from 'mongodb';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { HUTANG_VENDOR_SOURCE } from '@/lib/api/hutang-vendor-journal';
import { PRODUCT_KODE_UNIQUE_FILTER } from '@/lib/api/product-merge';
import { buildRecipeConversionReview } from '@/lib/api/recipe-conversion-review';
import { INVENTORY_RELEASES_COLLECTION, RL_POSTED_STATUSES } from '@/lib/food-production/material-issue-reconcile';
import type { ReconDetectResult, ReconFinding } from '@/lib/recon/types';

/** Kontrol berbasis kejadian (lot, penyesuaian, RL) dilihat mundur sejauh ini. */
export const CONTROLS_WINDOW_DAYS = 7;
const LIST_LIMIT = 500;

type UserRef = { userId?: unknown } | null | undefined;

function userIdOf(u: UserRef): string {
  return String(u?.userId || '').trim();
}

function isMaker(approver: UserRef, makers: UserRef[]): boolean {
  const id = userIdOf(approver);
  return !!id && makers.some((m) => userIdOf(m) === id);
}

async function detectDefaultExpiryLots(db: Db, tenantId: string, since: Date): Promise<ReconFinding[]> {
  const rows = await db.collection('ingredient_lots').aggregate<{
    _id: { grnId: string | null; noGRN: string | null };
    n: number;
    products: string[];
  }>([
    {
      $match: {
        tenantId,
        createdAt: { $gte: since },
        $or: [{ expirySource: 'DEFAULT' }, { expirySource: { $exists: false } }, { expirySource: null }],
      },
    },
    { $group: { _id: { grnId: '$grnId', noGRN: '$noGRN' }, n: { $sum: 1 }, products: { $addToSet: '$productKode' } } },
    { $sort: { n: -1 } },
    { $limit: LIST_LIMIT },
  ]).toArray();
  return rows.map((r) => {
    const label = String(r._id.noGRN || r._id.grnId || 'tanpa GRN');
    const kode = (r.products || []).filter(Boolean).slice(0, 5).join(', ');
    return {
      kind: 'LOT_DEFAULT_EXPIRY',
      refType: 'GRN',
      refId: r._id.grnId ? String(r._id.grnId) : undefined,
      refNo: label,
      actual: r.n,
      detail: `${r.n} lot dari ${label} memakai kedaluwarsa default (tanpa isian / masa simpan master)${kode ? `: ${kode}` : ''}`,
    };
  });
}

async function detectDuplicateKode(db: Db, tenantId: string): Promise<ReconFinding[]> {
  const rows = await db.collection('products').aggregate<{
    _id: string;
    n: number;
    ids: string[];
    nama: string[];
  }>([
    { $match: { tenantId, ...PRODUCT_KODE_UNIQUE_FILTER } },
    { $group: { _id: '$kode', n: { $sum: 1 }, ids: { $push: '$id' }, nama: { $addToSet: '$nama' } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1, _id: 1 } },
    { $limit: LIST_LIMIT },
  ]).toArray();
  return rows.map((r) => ({
    kind: 'PRODUCT_DUPLICATE_KODE',
    refType: 'PRODUCT',
    refId: String(r.ids[0] || ''),
    productId: String(r.ids[0] || ''),
    kode: r._id,
    nama: (r.nama || []).filter(Boolean)[0],
    actual: r.n,
    detail: `Kode ${r._id} dipakai ${r.n} produk aktif (${(r.nama || []).filter(Boolean).slice(0, 3).join(' / ')}) — gabungkan lewat merge produk`,
  }));
}

async function detectRecipeConversion(db: Db, tenantId: string): Promise<ReconFinding[]> {
  const review = await buildRecipeConversionReview(db, tenantId);
  const out: ReconFinding[] = [];
  for (const p of review.products) {
    const active = p.lines.filter((l) => l.recipeAktif);
    if (!active.length) continue;
    const invalid = active.filter((l) => l.status === 'INVALID').length;
    const stale = active.filter((l) => l.status === 'STALE').length;
    if (!invalid && !stale) continue;
    const parts = [
      invalid ? `${invalid} baris tanpa konversi valid` : '',
      stale ? `${stale} baris beda dari konversi ketat (hitung ulang)` : '',
    ].filter(Boolean).join(', ');
    const recipes = [...new Set(active.map((l) => l.recipeKode || l.recipeNama).filter(Boolean))].slice(0, 3).join(', ');
    out.push({
      kind: 'RECIPE_CONVERSION_UNVERIFIED',
      refType: 'RECIPE',
      refId: p.productId,
      productId: p.productId,
      kode: p.kode,
      nama: p.nama,
      actual: invalid + stale,
      detail: `Konversi ${p.nama || p.kode} di resep aktif: ${parts}${recipes ? ` (${recipes})` : ''}`,
    });
  }
  return out;
}

async function detectAdjustmentApproval(
  db: Db,
  tenantId: string,
  since: Date,
): Promise<{ findings: ReconFinding[]; directPosted: number; approvalRequired: boolean }> {
  const approvalRequired = await isTenantFeatureEnabled(db, tenantId, 'adjustmentApproval');
  const docs = await db.collection('penyesuaian_stok')
    .find({ tenantId, status: 'POSTED', postedAt: { $gte: since } })
    .project({ id: 1, noPenyesuaian: 1, createdBy: 1, updatedBy: 1, submittedBy: 1, editorIds: 1, approvedBy: 1, selfApprovedByMaster: 1 })
    .limit(LIST_LIMIT * 4)
    .toArray();
  const findings: ReconFinding[] = [];
  let directPosted = 0;
  for (const d of docs) {
    const label = String(d.noPenyesuaian || d.id);
    const approver = d.approvedBy as UserRef;
    if (!userIdOf(approver)) {
      directPosted += 1;
      if (!approvalRequired) continue;
      findings.push({
        kind: 'ADJUSTMENT_NO_INDEPENDENT_APPROVAL',
        refType: 'ADJUSTMENT',
        refId: String(d.id),
        refNo: label,
        detail: `Penyesuaian ${label} terposting tanpa penyetuju padahal persetujuan wajib`,
      });
      continue;
    }
    const makers: UserRef[] = [
      d.createdBy as UserRef,
      d.updatedBy as UserRef,
      d.submittedBy as UserRef,
      ...((d.editorIds as string[] | undefined) || []).map((userId) => ({ userId })),
    ];
    if (!isMaker(approver, makers) && d.selfApprovedByMaster !== true) continue;
    findings.push({
      kind: 'ADJUSTMENT_NO_INDEPENDENT_APPROVAL',
      refType: 'ADJUSTMENT',
      refId: String(d.id),
      refNo: label,
      detail: `Penyesuaian ${label} disetujui pembuat/penyuntingnya sendiri${d.selfApprovedByMaster ? ' (override MASTER)' : ''}`,
    });
  }
  return { findings, directPosted, approvalRequired };
}

async function detectRlSelfApproved(db: Db, tenantId: string, since: Date): Promise<ReconFinding[]> {
  const docs = await db.collection(INVENTORY_RELEASES_COLLECTION)
    .find({ tenantId, status: { $in: [...RL_POSTED_STATUSES] }, approvedAt: { $gte: since } })
    .project({ id: 1, noRelease: 1, createdBy: 1, submittedBy: 1, lastEditedBy: 1, approvedBy: 1 })
    .limit(LIST_LIMIT * 4)
    .toArray();
  const out: ReconFinding[] = [];
  for (const d of docs) {
    const approver = d.approvedBy as UserRef;
    if (!isMaker(approver, [d.createdBy as UserRef, d.submittedBy as UserRef, d.lastEditedBy as UserRef])) continue;
    const label = String(d.noRelease || d.id);
    const role = String((d.approvedBy as { role?: unknown } | undefined)?.role || '');
    out.push({
      kind: 'RL_SELF_APPROVED',
      refType: 'RELEASE',
      refId: String(d.id),
      refNo: label,
      detail: `RL ${label} disetujui oleh pembuat/pengajunya sendiri${role ? ` (${role})` : ''}`,
    });
  }
  return out;
}

async function detectExceptionInvoicesPosted(db: Db, tenantId: string): Promise<ReconFinding[]> {
  const hutangs = await db.collection('hutang')
    .find({ tenantId, matchStatus: 'EXCEPTION', matchOverride: { $ne: true } })
    .project({ id: 1, noHutang: 1, noInvoice: 1, matchError: 1, total: 1 })
    .limit(LIST_LIMIT * 4)
    .toArray();
  if (!hutangs.length) return [];
  const journals = await db.collection('jurnal')
    .find({
      tenantId,
      sourceType: HUTANG_VENDOR_SOURCE,
      sourceId: { $in: hutangs.map((h) => String(h.id)) },
      voidedAt: { $exists: false },
    })
    .project({ sourceId: 1, noJurnal: 1 })
    .toArray();
  const journalByHutang = new Map(journals.map((j) => [String(j.sourceId), String(j.noJurnal || '')]));
  const out: ReconFinding[] = [];
  for (const h of hutangs) {
    if (!journalByHutang.has(String(h.id))) continue;
    const label = String(h.noInvoice || h.noHutang || h.id);
    out.push({
      kind: 'INVOICE_EXCEPTION_POSTED',
      refType: 'HUTANG',
      refId: String(h.id),
      refNo: label,
      actual: Number(h.total) || 0,
      detail: `Tagihan ${label} berstatus EXCEPTION tanpa override tetapi jurnal hutang ${journalByHutang.get(String(h.id)) || ''} aktif`
        + (h.matchError ? ` — ${h.matchError}` : ''),
    });
  }
  return out;
}

export async function detectControlsRecon(
  db: Db,
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<ReconDetectResult> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - CONTROLS_WINDOW_DAYS * 86_400_000);
  const [lots, dupes, recipes, adjustments, selfRl, invoices] = await Promise.all([
    detectDefaultExpiryLots(db, tenantId, since),
    detectDuplicateKode(db, tenantId),
    detectRecipeConversion(db, tenantId),
    detectAdjustmentApproval(db, tenantId, since),
    detectRlSelfApproved(db, tenantId, since),
    detectExceptionInvoicesPosted(db, tenantId),
  ]);
  return {
    findings: [...lots, ...dupes, ...recipes, ...adjustments.findings, ...selfRl, ...invoices],
    meta: {
      windowDays: CONTROLS_WINDOW_DAYS,
      adjustmentApprovalRequired: adjustments.approvalRequired,
      adjustmentsPostedWithoutApprover: adjustments.directPosted,
    },
  };
}
