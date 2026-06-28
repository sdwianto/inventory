// Pembentukan baris jurnal otomatis.

export const COA = {
  KAS: { kode: '10010', nama: 'Kas' },
  BANK_MANDIRI: { kode: '10110', nama: 'Bank Mandiri' },
  PERSEDIAAN: { kode: '10310', nama: 'Persediaan Barang Dagangan' },
  PPN_MASUKAN: { kode: '10410', nama: 'PPN Masukan' },
  HUTANG: { kode: '20010', nama: 'Hutang Usaha' },
};

export function buildVendorHutangJournalLines({ noDoc, subTotal, ppn = 0, total }) {
  const lines = [
    {
      rekeningKode: COA.PERSEDIAAN.kode,
      rekeningNama: COA.PERSEDIAAN.nama,
      debet: subTotal,
      kredit: 0,
      keterangan: `Tagihan vendor ${noDoc}`,
    },
  ];
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

export function buildHutangPaymentJournalLines({ noDoc, amount, metode = 'TUNAI' }) {
  const bank = String(metode).toUpperCase() === 'TRANSFER' ? COA.BANK_MANDIRI : COA.KAS;
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
