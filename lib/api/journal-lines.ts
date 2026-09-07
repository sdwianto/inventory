// Pembentukan baris jurnal otomatis.

import type {
  HutangPaymentJournalParams,
  JournalDetail,
  VendorHutangJournalParams,
} from '@/types/finance';

export const COA = {
  KAS: { kode: '10010', nama: 'Kas' },
  BANK_MANDIRI: { kode: '10110', nama: 'Bank Mandiri' },
  PERSEDIAAN: { kode: '10310', nama: 'Persediaan Barang Dagangan' },
  /** ADR-005 — qty OUT di Post RTV, clear saat CN accept / vendor reject. */
  BARANG_DALAM_RETUR: { kode: '10315', nama: 'Barang dalam Retur' },
  PPN_MASUKAN: { kode: '10410', nama: 'PPN Masukan' },
  HUTANG: { kode: '20010', nama: 'Hutang Usaha' },
  GRNI: { kode: '20020', nama: 'Penerimaan Belum Ditagih' },
  PENYESUAIAN: { kode: '40060', nama: 'Penyesuaian Persediaan' },
} as const;

/** Post RTV: Dr Barang dalam retur / Cr Persediaan (net line, tanpa PPN). */
export function buildVendorReturnTransitOutJournalLines({
  noDoc,
  amount,
}: { noDoc: string; amount: number }): JournalDetail[] {
  const amt = Math.round(Number(amount) || 0);
  if (amt <= 0) return [];
  return [
    {
      rekeningKode: COA.BARANG_DALAM_RETUR.kode,
      rekeningNama: COA.BARANG_DALAM_RETUR.nama,
      debet: amt,
      kredit: 0,
      keterangan: `RTV transit OUT ${noDoc}`,
    },
    {
      rekeningKode: COA.PERSEDIAAN.kode,
      rekeningNama: COA.PERSEDIAAN.nama,
      debet: 0,
      kredit: amt,
      keterangan: `RTV transit OUT ${noDoc}`,
    },
  ];
}

/** Vendor reject baris: Dr Persediaan / Cr Barang dalam retur. */
export function buildVendorReturnTransitRestoreJournalLines({
  noDoc,
  amount,
  lineLabel,
}: { noDoc: string; amount: number; lineLabel?: string }): JournalDetail[] {
  const amt = Math.round(Number(amount) || 0);
  if (amt <= 0) return [];
  const tag = lineLabel ? ` ${lineLabel}` : '';
  return [
    {
      rekeningKode: COA.PERSEDIAAN.kode,
      rekeningNama: COA.PERSEDIAAN.nama,
      debet: amt,
      kredit: 0,
      keterangan: `RTV transit restore ${noDoc}${tag}`,
    },
    {
      rekeningKode: COA.BARANG_DALAM_RETUR.kode,
      rekeningNama: COA.BARANG_DALAM_RETUR.nama,
      debet: 0,
      kredit: amt,
      keterangan: `RTV transit restore ${noDoc}${tag}`,
    },
  ];
}

export function buildVendorHutangJournalLines({
  noDoc,
  subTotal,
  ppn = 0,
  total,
  clearGrni = false,
}: VendorHutangJournalParams & { clearGrni?: boolean }): JournalDetail[] {
  const lines: JournalDetail[] = [];
  if (clearGrni) {
    lines.push({
      rekeningKode: COA.GRNI.kode,
      rekeningNama: COA.GRNI.nama,
      debet: subTotal,
      kredit: 0,
      keterangan: `Clear GRNI ${noDoc}`,
    });
  } else {
    lines.push({
      rekeningKode: COA.PERSEDIAAN.kode,
      rekeningNama: COA.PERSEDIAAN.nama,
      debet: subTotal,
      kredit: 0,
      keterangan: `Tagihan vendor ${noDoc}`,
    });
  }
  if (ppn > 0) {
    lines.push({
      rekeningKode: COA.PPN_MASUKAN.kode,
      rekeningNama: COA.PPN_MASUKAN.nama,
      debet: ppn,
      kredit: 0,
      keterangan: `PPN Masukan ${noDoc}`,
    });
  }
  lines.push({
    rekeningKode: COA.HUTANG.kode,
    rekeningNama: COA.HUTANG.nama,
    debet: 0,
    kredit: total,
    keterangan: `Hutang vendor ${noDoc}`,
  });
  return lines;
}

export function buildGrnAccrualJournalLines({
  noDoc,
  subTotal,
}: { noDoc: string; subTotal: number }): JournalDetail[] {
  return [
    {
      rekeningKode: COA.PERSEDIAAN.kode,
      rekeningNama: COA.PERSEDIAAN.nama,
      debet: subTotal,
      kredit: 0,
      keterangan: `GRN ${noDoc}`,
    },
    {
      rekeningKode: COA.GRNI.kode,
      rekeningNama: COA.GRNI.nama,
      debet: 0,
      kredit: subTotal,
      keterangan: `GRN ${noDoc}`,
    },
  ];
}

export function buildPenyesuaianJournalLines({
  noDoc,
  amount,
  increase,
}: { noDoc: string; amount: number; increase: boolean }): JournalDetail[] {
  const amt = Math.abs(Math.round(amount));
  if (amt <= 0) return [];
  if (increase) {
    return [
      {
        rekeningKode: COA.PERSEDIAAN.kode,
        rekeningNama: COA.PERSEDIAAN.nama,
        debet: amt,
        kredit: 0,
        keterangan: `Penyesuaian + ${noDoc}`,
      },
      {
        rekeningKode: COA.PENYESUAIAN.kode,
        rekeningNama: COA.PENYESUAIAN.nama,
        debet: 0,
        kredit: amt,
        keterangan: `Penyesuaian + ${noDoc}`,
      },
    ];
  }
  return [
    {
      rekeningKode: COA.PENYESUAIAN.kode,
      rekeningNama: COA.PENYESUAIAN.nama,
      debet: amt,
      kredit: 0,
      keterangan: `Penyesuaian - ${noDoc}`,
    },
    {
      rekeningKode: COA.PERSEDIAAN.kode,
      rekeningNama: COA.PERSEDIAAN.nama,
      debet: 0,
      kredit: amt,
      keterangan: `Penyesuaian - ${noDoc}`,
    },
  ];
}

export function buildCreditNoteHutangJournalLines({
  noDoc,
  amount,
  /** Gross amount split: PPN proporsional dari rasio hutang invoice asal. */
  ppn = 0,
  invoiceTotal = 0,
  /**
   * ADR-005 transit: bila RTV sudah Dr Barang dalam retur di Post,
   * Cr net ke transit (bukan Persediaan lagi). Legacy RTV tanpa transit → Persediaan.
   */
  clearTransit = false,
}: {
  noDoc: string;
  amount: number;
  ppn?: number;
  invoiceTotal?: number;
  clearTransit?: boolean;
}): JournalDetail[] {
  const gross = Math.round(amount);
  if (gross <= 0) return [];

  const invTotal = Math.round(Number(invoiceTotal) || 0);
  const invPpn = Math.max(0, Math.round(Number(ppn) || 0));
  let ppnPart = 0;
  if (invTotal > 0 && invPpn > 0) {
    ppnPart = Math.min(gross, Math.round((gross * invPpn) / invTotal));
  }
  const netPart = gross - ppnPart;
  const inventoryCoa = clearTransit ? COA.BARANG_DALAM_RETUR : COA.PERSEDIAAN;

  const lines: JournalDetail[] = [
    {
      rekeningKode: COA.HUTANG.kode,
      rekeningNama: COA.HUTANG.nama,
      debet: gross,
      kredit: 0,
      keterangan: `CN ${noDoc}`,
    },
  ];
  if (netPart > 0) {
    lines.push({
      rekeningKode: inventoryCoa.kode,
      rekeningNama: inventoryCoa.nama,
      debet: 0,
      kredit: netPart,
      keterangan: clearTransit ? `CN clear transit ${noDoc}` : `CN ${noDoc}`,
    });
  }
  if (ppnPart > 0) {
    lines.push({
      rekeningKode: COA.PPN_MASUKAN.kode,
      rekeningNama: COA.PPN_MASUKAN.nama,
      debet: 0,
      kredit: ppnPart,
      keterangan: `CN PPN ${noDoc}`,
    });
  }
  return lines;
}

/** Debit Note vendor: naikkan hutang — Dr Persediaan (+ PPN) / Cr Hutang. Stok qty diam. */
export function buildDebitNoteHutangJournalLines({
  noDoc,
  amount,
  ppn = 0,
  invoiceTotal = 0,
}: {
  noDoc: string;
  amount: number;
  ppn?: number;
  invoiceTotal?: number;
}): JournalDetail[] {
  const gross = Math.round(amount);
  if (gross <= 0) return [];
  const invTotal = Math.round(Number(invoiceTotal) || 0);
  const invPpn = Math.max(0, Math.round(Number(ppn) || 0));
  let ppnPart = 0;
  if (invTotal > 0 && invPpn > 0) {
    ppnPart = Math.min(gross, Math.round((gross * invPpn) / invTotal));
  }
  const netPart = gross - ppnPart;
  const lines: JournalDetail[] = [];
  if (netPart > 0) {
    lines.push({
      rekeningKode: COA.PERSEDIAAN.kode,
      rekeningNama: COA.PERSEDIAAN.nama,
      debet: netPart,
      kredit: 0,
      keterangan: `DN ${noDoc}`,
    });
  }
  if (ppnPart > 0) {
    lines.push({
      rekeningKode: COA.PPN_MASUKAN.kode,
      rekeningNama: COA.PPN_MASUKAN.nama,
      debet: ppnPart,
      kredit: 0,
      keterangan: `DN PPN ${noDoc}`,
    });
  }
  lines.push({
    rekeningKode: COA.HUTANG.kode,
    rekeningNama: COA.HUTANG.nama,
    debet: 0,
    kredit: gross,
    keterangan: `DN ${noDoc}`,
  });
  return lines;
}

export function buildPaidExternalJournalLines({
  noDoc,
  amount,
}: { noDoc: string; amount: number }): JournalDetail[] {
  return buildHutangPaymentJournalLines({
    noDoc,
    amount,
    metode: 'TUNAI',
  });
}

/** Balik debet/kredit tiap baris — untuk membatalkan jurnal auto yang sudah terlanjur posting. */
export function reverseJournalDetails(details: JournalDetail[]): JournalDetail[] {
  return details.map((d) => ({
    ...d,
    debet: d.kredit || 0,
    kredit: d.debet || 0,
    keterangan: `Void: ${d.keterangan}`,
  }));
}

export function buildHutangPaymentJournalLines({
  noDoc,
  amount,
  metode = 'TUNAI',
  kasRekeningKode,
  kasRekeningNama,
}: HutangPaymentJournalParams): JournalDetail[] {
  const metodeUpper = String(metode).toUpperCase();
  const bank = kasRekeningKode
    ? { kode: kasRekeningKode, nama: kasRekeningNama || kasRekeningKode }
    : (metodeUpper === 'TRANSFER' ? COA.BANK_MANDIRI : COA.KAS);
  return [
    {
      rekeningKode: COA.HUTANG.kode,
      rekeningNama: COA.HUTANG.nama,
      debet: amount,
      kredit: 0,
      keterangan: `Bayar hutang ${noDoc}`,
    },
    {
      rekeningKode: bank.kode,
      rekeningNama: bank.nama,
      debet: 0,
      kredit: amount,
      keterangan: `Bayar hutang ${noDoc}`,
    },
  ];
}
