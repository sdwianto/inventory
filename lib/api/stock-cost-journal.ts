// Jurnal nilai persediaan dari hasil posting buku stok (Fase 4, flag costingV2). Nilai = Σ qty × harga
// kartu yang baru ditulis, jadi GL persediaan selalu sama dengan nilai kartu (toleransi pembulatan rupiah).

import type { ClientSession, Db } from 'mongodb';
import { createJournalIfNotExists } from '@/lib/api/journal';
import { COA, buildPenyesuaianJournalLines } from '@/lib/api/journal-lines';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import type { PostedStockLine } from '@/lib/stock-ledger/post-stock-movements';
import { roundMoney } from '@/lib/stock-ledger/precision';
import type { JournalDetail, JournalEntry } from '@/types/finance';

export const CONSUMPTION_JOURNAL_SOURCE = {
  RELEASE: 'AUTO_RL_CONSUMPTION',
  FP_ISSUE: 'AUTO_PBL_CONSUMPTION',
} as const;

export const MASTER_ADJUSTMENT_JOURNAL_SOURCE = 'AUTO_MASTER_PENYESUAIAN';

export const INVENTORY_CUTOVER_JOURNAL_SOURCE = 'AUTO_INVENTORY_CUTOVER';

/**
 * Nilai kartu RL / PBL (keluar − masuk) yang belum punya jurnal pemakaian: pemakaian bahan sebelum costingV2
 * yang tidak pernah mengkredit Persediaan. Barang memo tidak dihitung.
 */
export async function unjournaledConsumptionValue(db: Db, tenantId: string, session?: ClientSession): Promise<number> {
  const opts = session ? { session } : {};
  // Cutover pertama sudah membebankan seluruh pemakaian historis.
  if (await db.collection('jurnal').findOne({ tenantId, sourceType: INVENTORY_CUTOVER_JOURNAL_SOURCE }, opts)) return 0;
  const rows = await db.collection('stok_kartu').aggregate<{ _id: { sourceType: string; sourceId: string }; value: number }>([
    {
      $match: {
        tenantId,
        costSource: { $ne: 'NON_INVENTORY' },
        $or: [
          { sourceType: { $in: ['RELEASE', 'FP_ISSUE'] } },
          // Pembalik RL / PBL mengembalikan stok: bersih terhadap dokumen asalnya.
          { sourceType: 'STOCK_REVERSAL', reversalOfSourceType: { $in: ['RELEASE', 'FP_ISSUE'] } },
        ],
      },
    },
    {
      $set: {
        sourceType: { $ifNull: ['$reversalOfSourceType', '$sourceType'] },
        sourceId: { $ifNull: ['$reversalOfSourceId', '$sourceId'] },
      },
    },
    { $lookup: { from: 'products', let: { sid: '$stokId' }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$id', '$$sid'] }, { $eq: ['$tenantId', tenantId] }] } } },
      { $project: { _id: 0, itemRole: 1 } },
    ], as: 'p' } },
    { $match: { 'p.itemRole': { $nin: ['FINISHED_GOOD', 'SEMI_FINISHED'] } } },
    {
      $group: {
        _id: { sourceType: '$sourceType', sourceId: '$sourceId' },
        value: {
          $sum: {
            $multiply: [
              { $subtract: [{ $ifNull: ['$keluar', 0] }, { $ifNull: ['$masuk', 0] }] },
              { $ifNull: ['$hargaSatuan', 0] },
            ],
          },
        },
      },
    },
  ], opts).toArray();
  if (!rows.length) return 0;
  const journaled = await db.collection('jurnal').find(
    { tenantId, sourceType: { $in: Object.values(CONSUMPTION_JOURNAL_SOURCE) } },
    { projection: { _id: 0, sourceType: 1, sourceId: 1 }, ...opts },
  ).toArray();
  const done = new Set(journaled.map((j) => `${j.sourceType}\u0000${j.sourceId}`));
  let total = 0;
  for (const r of rows) {
    const src = CONSUMPTION_JOURNAL_SOURCE[r._id.sourceType as keyof typeof CONSUMPTION_JOURNAL_SOURCE];
    if (done.has(`${src}\u0000${r._id.sourceId}`)) continue;
    total += Number(r.value) || 0;
  }
  return Math.max(0, Math.round(total));
}

/**
 * Jurnal cutover: Persediaan bergeser sebesar diff (nilai stok − GL), pemakaian historis ke Beban Bahan Baku,
 * sisanya ke Penyesuaian Persediaan. Baris bernilai 0 dibuang.
 */
export function buildInventoryCutoverJournalLines({
  noDoc,
  diff,
  consumption,
}: { noDoc: string; diff: number; consumption: number }): JournalDetail[] {
  const d = Math.round(diff);
  if (d === 0) return [];
  const c = Math.max(0, Math.round(consumption));
  const nets: Array<[{ kode: string; nama: string }, number, string]> = [
    [COA.PERSEDIAAN, d, `Cutover persediaan ${noDoc}`],
    [COA.BEBAN_BAHAN, c, `Pemakaian bahan sebelum costingV2 ${noDoc}`],
    [COA.PENYESUAIAN, -(d + c), `Selisih cutover persediaan ${noDoc}`],
  ];
  return nets
    .filter(([, net]) => net !== 0)
    .map(([coa, net, keterangan]) => ({
      rekeningKode: coa.kode,
      rekeningNama: coa.nama,
      debet: net > 0 ? net : 0,
      kredit: net < 0 ? -net : 0,
      keterangan,
    }));
}

/** Saldo akun Persediaan (debet − kredit) dari seluruh jurnal tenant. */
export async function inventoryGlBalance(db: Db, tenantId: string, session?: ClientSession): Promise<number> {
  const kode = COA.PERSEDIAAN.kode;
  const [row] = await db.collection('jurnal').aggregate<{ saldo: number }>([
    { $match: { tenantId, 'details.rekeningKode': kode } },
    { $unwind: '$details' },
    { $match: { 'details.rekeningKode': kode } },
    {
      $group: {
        _id: null,
        saldo: { $sum: { $subtract: [{ $ifNull: ['$details.debet', 0] }, { $ifNull: ['$details.kredit', 0] }] } },
      },
    },
  ], session ? { session } : {}).toArray();
  return Math.round(Number(row?.saldo) || 0);
}

/** Σ |qty| × harga baris kartu (barang memo tanpa nilai tidak ikut). */
export function postedLinesValue(lines: Array<Pick<PostedStockLine, 'deltaQtyBase' | 'unitCost' | 'costSource'>>): number {
  let v = 0;
  for (const l of lines) {
    if (l.costSource === 'NON_INVENTORY') continue;
    v += Math.abs(Number(l.deltaQtyBase) || 0) * (Number(l.unitCost) || 0);
  }
  return roundMoney(v);
}

export function buildConsumptionJournalLines({ noDoc, amount }: { noDoc: string; amount: number }): JournalDetail[] {
  const amt = Math.round(Number(amount) || 0);
  if (amt <= 0) return [];
  return [
    { rekeningKode: COA.BEBAN_BAHAN.kode, rekeningNama: COA.BEBAN_BAHAN.nama, debet: amt, kredit: 0, keterangan: `Pemakaian bahan ${noDoc}` },
    { rekeningKode: COA.PERSEDIAAN.kode, rekeningNama: COA.PERSEDIAAN.nama, debet: 0, kredit: amt, keterangan: `Pemakaian bahan ${noDoc}` },
  ];
}

/** RL / PBL berposting stok: Dr Beban Bahan Baku, Cr Persediaan, di sesi posting. Idempoten per dokumen. */
export async function postConsumptionJournal(
  db: Db,
  session: ClientSession | undefined,
  input: {
    tenantId: string;
    sourceType: keyof typeof CONSUMPTION_JOURNAL_SOURCE;
    sourceId: string;
    noDoc: string;
    tanggal: Date;
    userName?: string;
    lines: PostedStockLine[];
  },
): Promise<JournalEntry | null> {
  if (!(await isTenantFeatureEnabled(db, input.tenantId, 'costingV2'))) return null;
  const details = buildConsumptionJournalLines({ noDoc: input.noDoc, amount: postedLinesValue(input.lines) });
  if (!details.length) return null;
  return createJournalIfNotExists(db, {
    tanggal: input.tanggal,
    keterangan: `Pemakaian bahan ${input.noDoc}`,
    sourceType: CONSUMPTION_JOURNAL_SOURCE[input.sourceType],
    sourceId: input.sourceId,
    details,
    userName: input.userName || '',
    tenantId: input.tenantId,
  }, session);
}

/** Selisih stok dari edit master produk: Dr/Cr Persediaan vs Penyesuaian Persediaan pada nilai kartu. */
export async function postMasterAdjustmentJournal(
  db: Db,
  session: ClientSession | undefined,
  input: {
    tenantId: string;
    sourceId: string;
    noDoc: string;
    tanggal: Date;
    userName?: string;
    line: Pick<PostedStockLine, 'deltaQtyBase' | 'unitCost' | 'costSource'>;
  },
): Promise<JournalEntry | null> {
  if (!(await isTenantFeatureEnabled(db, input.tenantId, 'costingV2'))) return null;
  const details = buildPenyesuaianJournalLines({
    noDoc: input.noDoc,
    amount: postedLinesValue([input.line]),
    increase: input.line.deltaQtyBase > 0,
  });
  if (!details.length) return null;
  return createJournalIfNotExists(db, {
    tanggal: input.tanggal,
    keterangan: `Penyesuaian master ${input.noDoc}`,
    sourceType: MASTER_ADJUSTMENT_JOURNAL_SOURCE,
    sourceId: input.sourceId,
    details,
    userName: input.userName || '',
    tenantId: input.tenantId,
  }, session);
}
