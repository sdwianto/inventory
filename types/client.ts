import type { SessionUser } from '@/types/auth';

/** Kolom ekspor tabel (CSV / Excel / PDF). */
export interface ExportColumn<T = Record<string, unknown>> {
  key: string;
  label: string;
  value?: (row: T) => string | number;
}

export interface LokasiItem {
  kode: string;
  nama: string;
  keterangan?: string;
  tenantId?: string;
  id?: string;
}

export interface WarehouseDef {
  kode: string;
  nama: string;
  short: string;
}

export interface PrinterProfile {
  id: string;
  label: string;
  driverHint: string;
  paperWidthMm: number;
  printableWidthMm: number;
  fontSizePx: number;
  lineHeight: number;
  feedMm: number;
  showLogoOnPrint: boolean;
  charsPerLine: number;
}

export interface PrinterSettings {
  profileId: string;
  showLogoOnPrint: boolean | null;
  extraFeedMm: number;
}

export type ClientUser = SessionUser;
