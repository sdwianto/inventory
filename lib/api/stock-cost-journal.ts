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
  input: { tenantId: string; sourceId: string; noDoc: string; tanggal: Date; userName?: string; line: PostedStockLine },
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
