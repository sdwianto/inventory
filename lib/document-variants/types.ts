/** Token layout dokumen A4 (Surat Jalan / Faktur) — HTML & PDF membaca bentuk yang sama. */

export type DocumentKind = 'delivery' | 'invoice';

/** Setiap model memakai header unik — siluet kop tidak boleh kembar. */
export type HeaderStyle =
  | 'classic'
  | 'banner'
  | 'centered'
  | 'sidebar'
  | 'boxed'
  | 'bigNumber'
  | 'splitMeta'
  | 'letterhead'
  | 'stackTitle'
  | 'topBar'
  | 'splitPanel'
  | 'banded'
  | 'masthead'
  | 'flag'
  | 'metro';

export type TableStyle = 'filled' | 'lined' | 'minimal' | 'zebra' | 'hairline';
export type InfoStyle = 'twoCards' | 'threeCards' | 'inline' | 'stamp' | 'kvGrid';
export type Density = 'compact' | 'normal' | 'airy';

export interface LayoutExtras {
  hidePrices?: boolean;
  watermark?: boolean;
  doubleRule?: boolean;
  taxEmphasis?: boolean;
  monochrome?: boolean;
  /** Footer 3 kolom: tanda tangan | bayar/jatuh tempo | total — hemat ruang. */
  footerTrio?: boolean;
  /** Tanda tangan rapat dengan garis titik, bukan blok tinggi. */
  compactSign?: boolean;
  /** Qty dan satuan digabung (contoh: 14 KRAT). */
  qtyWithUnit?: boolean;
  /** Catatan komplain H+1 di kaki dokumen. */
  complaintNote?: boolean;
}

export interface LayoutTokens {
  header: HeaderStyle;
  table: TableStyle;
  info: InfoStyle;
  density: Density;
  signatures: 2 | 3;
  extras: LayoutExtras;
}

export interface DocumentVariant {
  id: string;
  name: string;
  description: string;
  kind: DocumentKind;
  tokens: LayoutTokens;
}

export const DEFAULT_DELIVERY_REPORT_ID = 'do-01';
export const DEFAULT_INVOICE_REPORT_ID = 'inv-01';
