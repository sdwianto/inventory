// Normalisasi data struk — transaksi API + keranjang kasir + profil toko.

const MOCK_ADDRESS = 'Jl. Merdeka No. 123, Jakarta';
const MOCK_PHONE = '021-1234567';

export type StoreSettingsInput = {
  tenantId?: string;
  companyName?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyNPWP?: string;
  receiptFooterText?: string;
  showLogoOnReceipt?: boolean;
  showLogoOnInvoice?: boolean;
  logoBase64?: string;
  logoUrl?: string;
  /** Warna brand dokumen (hex #RRGGBB) — header tabel Faktur Tagihan vendor dsb. */
  warnaBrand?: string;
};

type CartItemInput = {
  stokId?: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  qty?: number;
  harga?: number;
  diskon?: number;
  jumlah?: number;
};

type ReceiptCartInput = {
  items?: CartItemInput[];
  diskonNota?: number;
  ppn?: number;
  poinDigunakan?: number;
  bayar?: number;
  noNota?: string;
  mode?: string;
  paymentMethod?: string;
  edcBank?: string;
  pelangganId?: string;
  pelangganName?: string;
  memberId?: string;
  memberName?: string;
  jatuhTempo?: string;
};

type ReceiptUserInput = {
  tenantId?: string;
  tenantName?: string;
  id?: string;
  name?: string;
};

type ReceiptApiTrxInput = {
  id?: string;
  noNota?: string;
  tanggal?: string;
  tenantId?: string;
  store?: StoreSettingsInput;
  items?: CartItemInput[];
  subTotal?: number;
  diskonNota?: number;
  ppn?: number;
  poinDigunakan?: number;
  poinDiscount?: number;
  total?: number;
  bayar?: number;
  kembali?: number;
  kasirId?: string;
  kasirName?: string;
  lokasi?: string;
  mode?: string;
  paymentMethod?: string;
  edcBank?: string;
  pelangganId?: string;
  pelangganName?: string;
  memberId?: string;
  memberName?: string;
  poinDidapat?: number;
  jatuhTempo?: string;
  hutang?: number;
  status?: string;
};

export function sanitizeStoreSettings(s: StoreSettingsInput | null | undefined) {
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
    warnaBrand: s.warnaBrand || '',
  };
}

function mapCartItems(items: CartItemInput[]) {
  return (items || []).map((it) => ({
    stokId: it.stokId,
    kode: it.kode,
    nama: it.nama,
    satuan: it.satuan || 'PCS',
    qty: it.qty,
    harga: it.harga,
    diskon: it.diskon || 0,
    jumlah: it.jumlah ?? ((it.harga || 0) * (it.qty || 0)) - (it.diskon || 0),
  }));
}

/** Gabungkan response API + keranjang aktif + profil toko untuk cetak struk. */
export function buildReceiptDoc({
  apiTrx,
  cart,
  user,
  settings,
}: {
  apiTrx?: ReceiptApiTrxInput | null;
  cart?: ReceiptCartInput | null;
  user?: ReceiptUserInput | null;
  settings?: StoreSettingsInput | null;
}) {
  const store = sanitizeStoreSettings(apiTrx?.store || settings);
  const items = apiTrx?.items?.length ? apiTrx.items : mapCartItems(cart?.items || []);

  const subTotal = apiTrx?.subTotal ?? items.reduce((s: number, it) => s + (it.jumlah || 0), 0);
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
    lokasi: apiTrx?.lokasi || '',
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
