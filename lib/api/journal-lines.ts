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
  PPN_MASUKAN: { kode: '10410', nama: 'PPN Masukan' },
  HUTANG: { kode: '20010', nama: 'Hutang Usaha' },
  GRNI: { kode: '20020', nama: 'Penerimaan Belum Ditagih' },
  PENYESUAIAN: { kode: '40060', nama: 'Penyesuaian Persediaan' },
} as const;

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
}: { noDoc: string; amount: number }): JournalDetail[] {
  const amt = Math.round(amount);
  if (amt <= 0) return [];
  return [
    {
      rekeningKode: COA.HUTANG.kode,
      rekeningNama: COA.HUTANG.nama,
      debet: amt,
      kredit: 0,
      keterangan: `CN ${noDoc}`,
    },
    {
      rekeningKode: COA.PERSEDIAAN.kode,
      rekeningNama: COA.PERSEDIAAN.nama,
      debet: 0,
      kredit: amt,
      keterangan: `CN ${noDoc}`,
    },
  ];
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
