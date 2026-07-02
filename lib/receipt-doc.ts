// Normalisasi data struk — transaksi API + keranjang kasir + profil toko.

const MOCK_ADDRESS = 'Jl. Merdeka No. 123, Jakarta';
const MOCK_PHONE = '021-1234567';

export function sanitizeStoreSettings(s) {
  if (!s) return null;
  return {
    tenantId: s.tenantId,
    companyName: s.companyName || '',
    companyAddress: s.companyAddress === MOCK_ADDRESS ? '' : (s.companyAddress || ''),
    companyPhone: s.companyPhone === MOCK_PHONE ? '' : (s.companyPhone || ''),
    companyNPWP: s.companyNPWP || '',
    receiptFooterText: s.receiptFooterText || 'Terima Kasih',
    showLogoOnReceipt: s.showLogoOnReceipt !== false,
    logoBase64: s.logoBase64 || '',
    logoUrl: s.logoUrl || '',
  };
}

function mapCartItems(items) {
  return (items || []).map((it) => ({
    stokId: it.stokId,
    kode: it.kode,
    nama: it.nama,
    satuan: it.satuan || 'PCS',
    qty: it.qty,
    harga: it.harga,
    diskon: it.diskon || 0,
    jumlah: it.jumlah ?? (it.harga * it.qty) - (it.diskon || 0),
  }));
}

/** Gabungkan response API + keranjang aktif + profil toko untuk cetak struk. */
export function buildReceiptDoc({ apiTrx, cart, user, settings }) {
  const store = sanitizeStoreSettings(apiTrx?.store || settings);
  const items = apiTrx?.items?.length ? apiTrx.items : mapCartItems(cart?.items);

  const subTotal = apiTrx?.subTotal ?? items.reduce((s, it) => s + (it.jumlah || 0), 0);
  const diskonNota = apiTrx?.diskonNota ?? cart?.diskonNota ?? 0;
  const ppn = apiTrx?.ppn ?? cart?.ppn ?? 0;
  const poinDigunakan = apiTrx?.poinDigunakan ?? cart?.poinDigunakan ?? 0;
  const poinDiscount = apiTrx?.poinDiscount ?? poinDigunakan * 1000;
  const total = apiTrx?.total ?? (subTotal - diskonNota - poinDiscount + ppn);
  const bayar = apiTrx?.bayar ?? cart?.bayar ?? 0;
  const kembali = apiTrx?.kembali ?? Math.max(0, bayar - total);

  return {
    id: apiTrx?.id,
    noNota: apiTrx?.noNota || cart?.noNota,
    tanggal: apiTrx?.tanggal || new Date().toISOString(),
    tenantId: apiTrx?.tenantId || user?.tenantId || 'default',
    tenantName: store?.companyName || user?.tenantName || '',
    store,
    kasirId: apiTrx?.kasirId || user?.id || '',
    kasirName: apiTrx?.kasirName || user?.name || 'Kasir',
    lokasi: apiTrx?.lokasi || 'L001 - Toko Utama',
    mode: apiTrx?.mode || cart?.mode || 'KASIR',
    paymentMethod: apiTrx?.paymentMethod || cart?.paymentMethod || 'TUNAI',
    edcBank: apiTrx?.edcBank || cart?.edcBank || '',
    pelangganId: apiTrx?.pelangganId ?? cart?.pelangganId,
    pelangganName: apiTrx?.pelangganName ?? cart?.pelangganName,
    memberId: apiTrx?.memberId ?? cart?.memberId,
    memberName: apiTrx?.memberName ?? cart?.memberName,
    poinDigunakan,
    poinDiscount,
    poinDidapat: apiTrx?.poinDidapat ?? 0,
    jatuhTempo: apiTrx?.jatuhTempo ?? cart?.jatuhTempo,
    items,
    subTotal,
    diskonNota,
    ppn,
    total,
    bayar,
    kembali,
    hutang: apiTrx?.hutang ?? 0,
    status: apiTrx?.status || 'COMPLETE',
  };
}
