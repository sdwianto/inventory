/**
 * po-receipt-recon: qtyReceived baris PO vs replay GRN yang sudah diterapkan
 * (appliedReceiveGrnIds − appliedReverseGrnIds), plus GRN / pembalik yang belum diterapkan ke PO.
 */

import type { Db } from 'mongodb';
import { grnQtyInPoUnit, type CpoLine } from '@/lib/api/cpo-status-sync';
import { findMatchingGrnLine, type LocalPoLineLike } from '@/lib/uom/match-vendor-line';
import type { ProductUom } from '@/lib/uom/types';
import { qtyEq, roundQty } from '@/lib/stock-ledger/precision';
import type { JsonObject } from '@/types/json';
import type { ReconDetectResult, ReconFinding } from '@/lib/recon/types';

/** Efek samping GRN berjalan async; GRN lebih muda dari ini belum dianggap macet. */
export const PO_RECON_GRACE_MS = 60 * 60 * 1000;
export const PO_RECON_LOOKBACK_DAYS = 180;

type GrnRow = JsonObject & {
  id: string;
  noGRN?: string;
  noPO?: string;
  status?: string;
  items?: JsonObject[];
  postedAt?: Date;
  reversedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
};

type PoRow = {
  id: string;
  noPO: string;
  status?: string;
  items?: CpoLine[];
  appliedReceiveGrnIds?: string[];
  appliedReverseGrnIds?: string[];
};

function ageMs(now: Date, ...dates: Array<Date | undefined>): number {
  const d = dates.find((x) => x && !Number.isNaN(new Date(x).getTime()));
  return d ? now.getTime() - new Date(d).getTime() : Number.POSITIVE_INFINITY;
}

export async function detectPoReceiptRecon(
  db: Db,
  tenantId: string,
  opts: { now?: Date; graceMs?: number } = {},
): Promise<ReconDetectResult> {
  const now = opts.now ?? new Date();
  const grace = opts.graceMs ?? PO_RECON_GRACE_MS;
  const since = new Date(now.getTime() - PO_RECON_LOOKBACK_DAYS * 86_400_000);

  const recentGrns = await db.collection('goods_receipts')
    .find({
      tenantId,
      noPO: { $nin: [null, ''] },
      status: { $in: ['POSTED', 'REVERSED'] },
      $or: [{ postedAt: { $gte: since } }, { createdAt: { $gte: since } }, { updatedAt: { $gte: since } }],
    })
    .project({ id: 1, noGRN: 1, noPO: 1, status: 1, items: 1, postedAt: 1, reversedAt: 1, createdAt: 1, updatedAt: 1 })
    .toArray() as unknown as GrnRow[];
  const noPOs = [...new Set(recentGrns.map((g) => String(g.noPO || '')).filter(Boolean))];
  if (!noPOs.length) return { findings: [], meta: { posScanned: 0, grnsScanned: 0 } };

  const pos = await db.collection('customer_purchase_orders')
    .find({ tenantId, noPO: { $in: noPOs } })
    .project({ id: 1, noPO: 1, status: 1, items: 1, appliedReceiveGrnIds: 1, appliedReverseGrnIds: 1 })
    .toArray() as unknown as PoRow[];
  const poByNo = new Map(pos.map((p) => [p.noPO, p]));

  const findings: ReconFinding[] = [];
  for (const g of recentGrns) {
    const po = poByNo.get(String(g.noPO));
    if (!po) continue;
    const applied = (po.appliedReceiveGrnIds || []).includes(g.id);
    const reversedApplied = (po.appliedReverseGrnIds || []).includes(g.id);
    const ref = { refType: 'PO' as const, refId: po.id, refNo: po.noPO };
    if (g.status === 'POSTED' && !applied && ageMs(now, g.postedAt, g.createdAt) > grace) {
      findings.push({
        ...ref,
        kind: 'PO_GRN_NOT_APPLIED',
        detail: `GRN ${g.noGRN || g.id} POSTED belum menambah qty diterima PO ${po.noPO}`,
      });
    }
    if (g.status === 'REVERSED' && applied && !reversedApplied && ageMs(now, g.reversedAt, g.updatedAt) > grace) {
      findings.push({
        ...ref,
        kind: 'PO_GRN_REVERSAL_NOT_APPLIED',
        detail: `GRN ${g.noGRN || g.id} sudah dibalik, qty diterima PO ${po.noPO} belum dikurangi`,
      });
    }
  }

  const grnById = new Map(recentGrns.map((g) => [g.id, g]));
  const missingIds = [...new Set(pos.flatMap((p) => p.appliedReceiveGrnIds || []))].filter((id) => !grnById.has(id));
  if (missingIds.length) {
    const older = await db.collection('goods_receipts')
      .find({ tenantId, id: { $in: missingIds } })
      .project({ id: 1, noGRN: 1, noPO: 1, status: 1, items: 1 })
      .toArray() as unknown as GrnRow[];
    for (const g of older) grnById.set(g.id, g);
  }

  const uomsCache = new Map<string, ProductUom[]>();
  let posSkipped = 0;
  for (const po of pos) {
    const receiveIds = po.appliedReceiveGrnIds || [];
    if (!receiveIds.length) continue;
    if (receiveIds.some((id) => !grnById.has(id))) {
      posSkipped += 1;
      continue;
    }
    const reverse = new Set(po.appliedReverseGrnIds || []);
    const lines = po.items || [];
    const expected = lines.map(() => ({ received: 0, rejected: 0 }));
    for (const gid of receiveIds) {
      const grn = grnById.get(gid)!;
      const grnItems = Array.isArray(grn.items) ? grn.items : [];
      const used = new Set<number>();
      const sign = reverse.has(gid) ? 0 : 1;
      for (let i = 0; i < lines.length; i++) {
        const recv = findMatchingGrnLine(lines[i] as LocalPoLineLike, grnItems, used);
        const qty = await grnQtyInPoUnit(db, tenantId, lines[i] as JsonObject, recv as JsonObject | undefined, uomsCache);
        expected[i].received += sign * (qty?.received || 0);
        expected[i].rejected += sign * (qty?.rejected || 0);
      }
    }
    lines.forEach((line, i) => {
      const expRecv = Math.max(0, roundQty(expected[i].received));
      const expRej = Math.max(0, roundQty(expected[i].rejected));
      const actRecv = roundQty(Number(line.qtyReceived) || 0);
      const actRej = roundQty(Number(line.qtyRejected) || 0);
      if (qtyEq(expRecv, actRecv) && qtyEq(expRej, actRej)) return;
      findings.push({
        kind: 'PO_QTY_RECEIVED_MISMATCH',
        refType: 'PO',
        refId: po.id,
        refNo: po.noPO,
        productId: line.localStokId ? String(line.localStokId) : undefined,
        kode: line.kode ? String(line.kode) : undefined,
        nama: line.nama ? String(line.nama) : undefined,
        expected: expRecv,
        actual: actRecv,
        delta: roundQty(actRecv - expRecv),
        detail: `PO ${po.noPO} ${line.kode || line.localStokId || ''}: diterima ${actRecv} ${line.satuan || ''}`
          + ` vs GRN ${expRecv}` + (qtyEq(expRej, actRej) ? '' : `; ditolak ${actRej} vs GRN ${expRej}`),
      });
    });
  }

  return {
    findings,
    meta: { posScanned: pos.length, grnsScanned: recentGrns.length, posSkippedMissingGrn: posSkipped, lookbackDays: PO_RECON_LOOKBACK_DAYS },
  };
}
