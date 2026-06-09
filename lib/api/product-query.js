// Filter pencarian produk — exact barcode/kode lebih cepat dari regex penuh.

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build Mongo filter for product search within tenant scope. */
export function buildProductSearchFilter(q) {
  const term = (q || '').trim();
  if (!term) return {};
  const isCodeLike = /^[A-Za-z0-9\-_.]+$/.test(term) && term.length <= 48;
  if (isCodeLike) {
    return {
      $or: [
        { kode: term },
        { barcode: term },
        { kode: { $regex: `^${escapeRegex(term)}`, $options: 'i' } },
        { barcode: { $regex: `^${escapeRegex(term)}`, $options: 'i' } },
        { nama: { $regex: escapeRegex(term), $options: 'i' } },
      ],
    };
  }
  return {
    $or: [
      { kode: { $regex: escapeRegex(term), $options: 'i' } },
      { nama: { $regex: escapeRegex(term), $options: 'i' } },
      { barcode: { $regex: escapeRegex(term), $options: 'i' } },
    ],
  };
}

export const PRODUCT_LIST_PROJECTION = {
  id: 1,
  tenantId: 1,
  kode: 1,
  barcode: 1,
  nama: 1,
  grup: 1,
  satuan: 1,
  hargaBeli: 1,
  hargaSpesial: 1,
  hargaGrosir: 1,
  hargaEcer: 1,
  stok: 1,
  minStok: 1,
  aktif: 1,
  syncSource: 1,
  vendorStokId: 1,
  vendorTenantId: 1,
};

export const TRANSACTION_LIST_PROJECTION = {
  id: 1,
  noNota: 1,
  tanggal: 1,
  tenantId: 1,
  tenantName: 1,
  kasirId: 1,
  kasirName: 1,
  lokasi: 1,
  mode: 1,
  paymentMethod: 1,
  edcBank: 1,
  pelangganId: 1,
  pelangganName: 1,
  memberId: 1,
  memberName: 1,
  items: 1,
  subTotal: 1,
  diskonNota: 1,
  ppn: 1,
  total: 1,
  bayar: 1,
  kembali: 1,
  hutang: 1,
  status: 1,
  poinDigunakan: 1,
  poinDiscount: 1,
  poinDidapat: 1,
  jatuhTempo: 1,
};
