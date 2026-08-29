import type { DocumentKind, DocumentVariant, LayoutTokens } from './types';
import { DEFAULT_DELIVERY_REPORT_ID, DEFAULT_INVOICE_REPORT_ID } from './types';

function t(
  header: LayoutTokens['header'],
  table: LayoutTokens['table'],
  info: LayoutTokens['info'],
  density: LayoutTokens['density'],
  signatures: LayoutTokens['signatures'],
  extras: LayoutTokens['extras'] = {},
): LayoutTokens {
  return { header, table, info, density, signatures, extras };
}

export const DELIVERY_VARIANTS: DocumentVariant[] = [
  { id: 'do-01', kind: 'delivery', name: 'Klasik', description: 'Logo kiri, judul kanan, dua kartu info, header tabel berwarna.', tokens: t('classic', 'filled', 'twoCards', 'normal', 2) },
  { id: 'do-02', kind: 'delivery', name: 'Banner Brand', description: 'Pita warna brand penuh di header, logo di dalam pita.', tokens: t('banner', 'filled', 'twoCards', 'normal', 2) },
  { id: 'do-03', kind: 'delivery', name: 'Kop Tengah', description: 'Logo dan identitas di tengah, tabel bergaris.', tokens: t('centered', 'lined', 'twoCards', 'normal', 2) },
  { id: 'do-04', kind: 'delivery', name: 'Niaga Compact', description: 'Kop kiri + meta titik dua kanan, tanpa kartu, tabel garis tipis, footer 3 kolom.', tokens: t('splitMeta', 'hairline', 'kvGrid', 'compact', 2, { footerTrio: true, compactSign: true, qtyWithUnit: true }) },
  { id: 'do-05', kind: 'delivery', name: 'Formal Pajak', description: 'Seluruh kop berbingkai, nomor seperti cap, garis ganda.', tokens: t('boxed', 'filled', 'stamp', 'airy', 2, { doubleRule: true }) },
  { id: 'do-06', kind: 'delivery', name: 'Kop Surat', description: 'Gaya kop surat: logo + nama satu baris, judul di antara dua garis.', tokens: t('letterhead', 'minimal', 'inline', 'airy', 2, { compactSign: true }) },
  { id: 'do-07', kind: 'delivery', name: 'Sidebar Brand', description: 'Pita vertikal tipis di kiri halaman, logo di kop klasik.', tokens: t('sidebar', 'filled', 'twoCards', 'normal', 2) },
  { id: 'do-08', kind: 'delivery', name: 'Packing List', description: 'Judul besar di atas, tanpa harga, tiga tanda tangan.', tokens: t('stackTitle', 'zebra', 'threeCards', 'normal', 3, { hidePrices: true }) },
  { id: 'do-09', kind: 'delivery', name: 'Pita Atas', description: 'Garis brand di tepi atas halaman, tiga blok tanda tangan.', tokens: t('topBar', 'filled', 'twoCards', 'normal', 3) },
  { id: 'do-10', kind: 'delivery', name: 'Panel Brand', description: 'Kolom kiri berwarna berisi logo, judul di panel putih kanan.', tokens: t('splitPanel', 'lined', 'stamp', 'normal', 2) },
  { id: 'do-11', kind: 'delivery', name: 'Dua Pita', description: 'Baris brand + baris judul terpisah, garis ganda.', tokens: t('banded', 'lined', 'twoCards', 'normal', 2, { doubleRule: true }) },
  { id: 'do-12', kind: 'delivery', name: 'Masthead', description: 'Logo besar, nama perusahaan menonjol, watermark samar.', tokens: t('masthead', 'zebra', 'twoCards', 'airy', 2, { watermark: true }) },
  { id: 'do-13', kind: 'delivery', name: 'Bendera Mono', description: 'Kolom kiri lebar hitam-putih dengan logo, tanpa warna brand.', tokens: t('flag', 'lined', 'inline', 'normal', 2, { monochrome: true }) },
  { id: 'do-14', kind: 'delivery', name: 'Metro 3 Kolom', description: 'Kop tiga kotak: logo | identitas | nomor dokumen.', tokens: t('metro', 'filled', 'threeCards', 'normal', 2) },
  { id: 'do-15', kind: 'delivery', name: 'Nomor Besar', description: 'Nomor Surat Jalan ditonjolkan di pita brand di bawah logo.', tokens: t('bigNumber', 'filled', 'twoCards', 'normal', 2) },
];

export const INVOICE_VARIANTS: DocumentVariant[] = [
  { id: 'inv-01', kind: 'invoice', name: 'Klasik', description: 'Logo kiri, judul kanan, dua kartu pelanggan dan referensi.', tokens: t('classic', 'filled', 'twoCards', 'normal', 2) },
  { id: 'inv-02', kind: 'invoice', name: 'Banner Brand', description: 'Pita warna brand penuh di header, logo di dalam pita.', tokens: t('banner', 'filled', 'twoCards', 'normal', 2) },
  { id: 'inv-03', kind: 'invoice', name: 'Kop Tengah', description: 'Logo dan identitas di tengah, tabel bergaris.', tokens: t('centered', 'lined', 'twoCards', 'normal', 2) },
  { id: 'inv-04', kind: 'invoice', name: 'Niaga Compact', description: 'Faktur niaga: judul kiri, meta titik dua kanan, footer 3 kolom.', tokens: t('splitMeta', 'hairline', 'kvGrid', 'compact', 2, { footerTrio: true, compactSign: true, qtyWithUnit: true, complaintNote: true }) },
  { id: 'inv-05', kind: 'invoice', name: 'Formal Pajak', description: 'Kop kotak, NPWP/cap nomor, blok PPN ditonjolkan.', tokens: t('boxed', 'filled', 'stamp', 'airy', 2, { doubleRule: true, taxEmphasis: true }) },
  { id: 'inv-06', kind: 'invoice', name: 'Kop Surat', description: 'Gaya kop surat: logo + nama satu baris, judul di antara dua garis.', tokens: t('letterhead', 'minimal', 'inline', 'airy', 2, { compactSign: true }) },
  { id: 'inv-07', kind: 'invoice', name: 'Sidebar Brand', description: 'Pita vertikal tipis di kiri, logo di kop.', tokens: t('sidebar', 'filled', 'twoCards', 'normal', 2) },
  { id: 'inv-08', kind: 'invoice', name: 'Rincian Pajak', description: 'Judul besar di atas, tiga kartu, blok PPN/DPP ditonjolkan.', tokens: t('stackTitle', 'zebra', 'threeCards', 'normal', 2, { taxEmphasis: true }) },
  { id: 'inv-09', kind: 'invoice', name: 'Pita Atas', description: 'Garis brand di tepi atas, tiga tanda tangan Penjual/Pembeli/Mengetahui.', tokens: t('topBar', 'filled', 'twoCards', 'normal', 3) },
  { id: 'inv-10', kind: 'invoice', name: 'Panel Brand', description: 'Kolom kiri berwarna berisi logo, nomor faktur di panel kanan.', tokens: t('splitPanel', 'lined', 'stamp', 'normal', 2) },
  { id: 'inv-11', kind: 'invoice', name: 'Dua Pita', description: 'Baris brand + baris judul terpisah, garis ganda.', tokens: t('banded', 'lined', 'twoCards', 'normal', 2, { doubleRule: true }) },
  { id: 'inv-12', kind: 'invoice', name: 'Masthead', description: 'Logo besar, nama perusahaan menonjol, watermark samar.', tokens: t('masthead', 'zebra', 'twoCards', 'airy', 2, { watermark: true }) },
  { id: 'inv-13', kind: 'invoice', name: 'Bendera Mono', description: 'Kolom kiri lebar monokrom dengan logo, tabel bergaris.', tokens: t('flag', 'lined', 'inline', 'normal', 2, { monochrome: true }) },
  { id: 'inv-14', kind: 'invoice', name: 'Metro 3 Kolom', description: 'Kop tiga kotak: logo | identitas | nomor faktur.', tokens: t('metro', 'filled', 'threeCards', 'normal', 2) },
  { id: 'inv-15', kind: 'invoice', name: 'Nomor Besar', description: 'Nomor faktur besar di pita brand di bawah logo.', tokens: t('bigNumber', 'filled', 'twoCards', 'normal', 2) },
];

const BY_ID = new Map<string, DocumentVariant>(
  [...DELIVERY_VARIANTS, ...INVOICE_VARIANTS].map((v) => [v.id, v]),
);

export function listVariants(kind: DocumentKind): DocumentVariant[] {
  return kind === 'delivery' ? DELIVERY_VARIANTS : INVOICE_VARIANTS;
}

export function getVariantById(id: string | null | undefined): DocumentVariant | null {
  if (!id) return null;
  return BY_ID.get(String(id).trim()) || null;
}

export function defaultVariantId(kind: DocumentKind): string {
  return kind === 'delivery' ? DEFAULT_DELIVERY_REPORT_ID : DEFAULT_INVOICE_REPORT_ID;
}

export function isVariantId(kind: DocumentKind, id: string | null | undefined): boolean {
  const v = getVariantById(id);
  return !!v && v.kind === kind;
}
