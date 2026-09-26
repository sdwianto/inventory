/**
 * grni-recon: GRNI per tagihan (kliring tagihan vs akrual bersih GRN tertaut), GRN lama belum ditagih,
 * dan saldo GL Persediaan vs nilai buku stok. Kliring dan GL hanya dibandingkan sesudah cutover costingV2:
 * sebelum itu tagihan mengkliring subTotal sehingga selisih lama memang tertinggal di GRNI.
 */

import type { Db } from 'mongodb';
import { COA } from '@/lib/api/journal-lines';
import { HUTANG_VENDOR_SOURCE } from '@/lib/api/hutang-vendor-journal';
import { GRN_ACCRUAL_REVERSAL_SOURCE } from '@/lib/api/grn-reversal-constants';
import { inventoryGlBalance } from '@/lib/api/stock-cost-journal';
import { valueInventoryAtAvg } from '@/lib/stock-ledger/valuation';
import { roundMoney } from '@/lib/stock-ledger/precision';
import { resolveCostingCutoverAt } from '@/lib/recon/context';
import type { ReconDetectResult, ReconFinding } from '@/lib/recon/types';

export const GRN_ACCRUAL_SOURCE = 'AUTO_GRN_ACCRUAL';
/** Tautan GRN ke tagihan bisa menyusul; tagihan lebih muda dari ini belum dibandingkan. */
export const GRNI_BILL_GRACE_MS = 24 * 60 * 60 * 1000;
export const GRNI_UNBILLED_AGE_DAYS = 30;
export const GRNI_LOOKBACK_DAYS = 365;
export const GRNI_RESIDUAL_TOLERANCE = 1;
export const GL_VALUATION_TOLERANCE_MIN = 1000;
export const GL_VALUATION_TOLERANCE_PCT = 0.1;

type JournalDetail = { rekeningKode?: string; debet?: number; kredit?: number };
type JournalRow = { id?: string; noJurnal?: string; sourceId?: string; sourceType?: string; createdAt?: Date; details?: JournalDetail[] };

function grniNet(details: JournalDetail[] | undefined, side: 'debet' | 'kredit'): number {
  let n = 0;
  for (const d of details || []) {
    if (d.rekeningKode !== COA.GRNI.kode) continue;
    const debet = Number(d.debet) || 0;
    const kredit = Number(d.kredit) || 0;
    n += side === 'debet' ? debet - kredit : kredit - debet;
  }
  return n;
}

async function detectBillResiduals(db: Db, tenantId: string, cutoverAt: Date, now: Date): Promise<ReconFinding[]> {
  const from = new Date(Math.max(cutoverAt.getTime(), now.getTime() - GRNI_LOOKBACK_DAYS * 86_400_000));
  const journals = await db.collection('jurnal')
    .find({
      tenantId,
      sourceType: HUTANG_VENDOR_SOURCE,
      voidedAt: { $exists: false },
      createdAt: { $gte: from, $lte: new Date(now.getTime() - GRNI_BILL_GRACE_MS) },
      'details.rekeningKode': COA.GRNI.kode,
    })
    .project({ id: 1, noJurnal: 1, sourceId: 1, createdAt: 1, details: 1 })
    .toArray() as unknown as JournalRow[];
  if (!journals.length) return [];

  const hutangIds = [...new Set(journals.map((j) => String(j.sourceId || '')).filter(Boolean))];
  const hutangs = await db.collection('hutang')
    .find({ tenantId, id: { $in: hutangIds } })
    .project({ id: 1, noHutang: 1, noInvoice: 1, vendorInvoiceId: 1, noDO: 1, vendorTenantId: 1, supplierName: 1 })
    .toArray();
  const hutangById = new Map(hutangs.map((h) => [String(h.id), h]));
  const invoiceIds = hutangs.map((h) => String(h.vendorInvoiceId || '')).filter(Boolean);
  const noDOs = hutangs.map((h) => String(h.noDO || '')).filter(Boolean);

  const grns = await db.collection('goods_receipts')
    .find({
      tenantId,
      status: { $in: ['POSTED', 'REVERSED'] },
      $or: [
        { hutangId: { $in: hutangIds } },
        ...(invoiceIds.length ? [{ vendorInvoiceId: { $in: invoiceIds } }] : []),
        ...(noDOs.length ? [{ noDO: { $in: noDOs } }] : []),
      ],
    })
    .project({ id: 1, hutangId: 1, vendorInvoiceId: 1, noDO: 1, vendorTenantId: 1 })
    .toArray();

  const grnIdsByHutang = new Map<string, string[]>();
  for (const h of hutangs) {
    const hid = String(h.id);
    const inv = String(h.vendorInvoiceId || '');
    let ids = grns
      .filter((g) => String(g.hutangId || '') === hid || (inv && String(g.vendorInvoiceId || '') === inv))
      .map((g) => String(g.id));
    if (!ids.length && h.noDO) {
      const vid = String(h.vendorTenantId || '');
      ids = grns
        .filter((g) => String(g.noDO || '') === String(h.noDO)
          && (!vid || String(g.vendorTenantId || '') === vid)
          && !g.hutangId && !g.vendorInvoiceId)
        .map((g) => String(g.id));
    }
    grnIdsByHutang.set(hid, [...new Set(ids)]);
  }

  const allGrnIds = [...new Set([...grnIdsByHutang.values()].flat())];
  const accruals = allGrnIds.length
    ? await db.collection('jurnal')
      .find({ tenantId, sourceType: { $in: [GRN_ACCRUAL_SOURCE, GRN_ACCRUAL_REVERSAL_SOURCE] }, sourceId: { $in: allGrnIds } })
      .project({ sourceId: 1, sourceType: 1, details: 1 })
      .toArray() as unknown as JournalRow[]
    : [];
  const accrualByGrn = new Map<string, number>();
  for (const a of accruals) {
    const gid = String(a.sourceId || '');
    accrualByGrn.set(gid, (accrualByGrn.get(gid) || 0) + grniNet(a.details, 'kredit'));
  }

  const out: ReconFinding[] = [];
  for (const j of journals) {
    const hid = String(j.sourceId || '');
    const h = hutangById.get(hid);
    const clear = roundMoney(grniNet(j.details, 'debet'));
    const ids = grnIdsByHutang.get(hid) || [];
    const accrued = roundMoney(ids.reduce((s, id) => s + (accrualByGrn.get(id) || 0), 0));
    const residual = roundMoney(clear - accrued);
    if (Math.abs(residual) <= GRNI_RESIDUAL_TOLERANCE) continue;
    const label = String(h?.noHutang || h?.noInvoice || hid);
    out.push({
      kind: 'GRNI_BILL_RESIDUAL',
      refType: 'HUTANG',
      refId: hid,
      refNo: label,
      expected: accrued,
      actual: clear,
      delta: residual,
      detail: ids.length
        ? `Tagihan ${label} mengkliring GRNI ${clear}, akrual bersih ${ids.length} GRN ${accrued} (selisih ${residual})`
        : `Tagihan ${label} mengkliring GRNI ${clear} tanpa GRN tertaut`,
    });
  }
  return out;
}

async function detectUnbilledAged(db: Db, tenantId: string, now: Date): Promise<{ findings: ReconFinding[]; count: number }> {
  const before = new Date(now.getTime() - GRNI_UNBILLED_AGE_DAYS * 86_400_000);
  const filter = {
    tenantId,
    status: 'POSTED',
    postedAt: { $lt: before },
    $and: [
      { $or: [{ hutangId: { $exists: false } }, { hutangId: null }, { hutangId: '' }] },
      { $or: [{ vendorInvoiceId: { $exists: false } }, { vendorInvoiceId: null }, { vendorInvoiceId: '' }] },
    ],
  };
  const candidates = await db.collection('goods_receipts')
    .find(filter)
    .project({ id: 1, noGRN: 1, noDO: 1, noPO: 1, vendorTenantId: 1, postedAt: 1, receivedTotal: 1 })
    .sort({ postedAt: 1 })
    .limit(500)
    .toArray();
  if (!candidates.length) return { findings: [], count: 0 };

  const noDOs = [...new Set(candidates.map((g) => String(g.noDO || '')).filter(Boolean))];
  const billed = noDOs.length
    ? await db.collection('hutang').find({ tenantId, noDO: { $in: noDOs } }).project({ noDO: 1, vendorTenantId: 1 }).toArray()
    : [];
  const billedKeys = new Set(billed.map((h) => `${h.noDO}|${h.vendorTenantId || ''}`));
  const billedDo = new Set(billed.map((h) => String(h.noDO)));
  const accruals = await db.collection('jurnal')
    .find({ tenantId, sourceType: GRN_ACCRUAL_SOURCE, sourceId: { $in: candidates.map((g) => String(g.id)) } })
    .project({ sourceId: 1, details: 1 })
    .toArray() as unknown as JournalRow[];
  const accrualByGrn = new Map(accruals.map((a) => [String(a.sourceId), grniNet(a.details, 'kredit')]));

  const findings: ReconFinding[] = [];
  for (const g of candidates) {
    const accrued = roundMoney(accrualByGrn.get(String(g.id)) || 0);
    if (!(accrued > 0)) continue;
    const doNo = String(g.noDO || '');
    if (doNo && (billedKeys.has(`${doNo}|${g.vendorTenantId || ''}`) || (!g.vendorTenantId && billedDo.has(doNo)))) continue;
    const days = Math.floor((now.getTime() - new Date(g.postedAt as Date).getTime()) / 86_400_000);
    findings.push({
      kind: 'GRNI_UNBILLED_AGED',
      refType: 'GRN',
      refId: String(g.id),
      refNo: String(g.noGRN || g.id),
      actual: accrued,
      detail: `GRN ${g.noGRN || g.id} (PO ${g.noPO || '—'}, DO ${doNo || '—'}) diterima ${days} hari lalu, belum ditagih — GRNI ${accrued}`,
    });
  }
  return { findings, count: findings.length };
}

async function detectGlVsValuation(db: Db, tenantId: string): Promise<{ finding: ReconFinding | null; meta: Record<string, number> }> {
  const [gl, valuation] = await Promise.all([inventoryGlBalance(db, tenantId), valueInventoryAtAvg(db, tenantId)]);
  const value = Math.round(valuation.value);
  const diff = gl - value;
  const tolerance = Math.max(GL_VALUATION_TOLERANCE_MIN, Math.abs(value) * GL_VALUATION_TOLERANCE_PCT / 100);
  const meta = { glPersediaan: gl, nilaiStok: value, selisih: diff, toleransi: Math.round(tolerance) };
  if (Math.abs(diff) <= tolerance) return { finding: null, meta };
  return {
    finding: {
      kind: 'GL_INVENTORY_VS_VALUATION',
      refType: 'TENANT',
      refId: tenantId,
      expected: value,
      actual: gl,
      delta: diff,
      detail: `Saldo GL Persediaan ${gl} ≠ nilai buku stok ${value} (selisih ${diff}, toleransi ${Math.round(tolerance)})`,
    },
    meta,
  };
}

export async function detectGrniRecon(
  db: Db,
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<ReconDetectResult> {
  const now = opts.now ?? new Date();
  const cutoverAt = await resolveCostingCutoverAt(db, tenantId);
  const unbilled = await detectUnbilledAged(db, tenantId, now);
  const findings: ReconFinding[] = [...unbilled.findings];
  let glMeta: Record<string, number> | undefined;
  if (cutoverAt) {
    findings.push(...(await detectBillResiduals(db, tenantId, cutoverAt, now)));
    const gl = await detectGlVsValuation(db, tenantId);
    glMeta = gl.meta;
    if (gl.finding) findings.push(gl.finding);
  }
  return {
    findings,
    meta: {
      costingCutoverAt: cutoverAt ? cutoverAt.toISOString() : null,
      unbilledAgeDays: GRNI_UNBILLED_AGE_DAYS,
      ...(glMeta ? { gl: glMeta } : {}),
    },
  };
}
