export interface InventoryBody extends Record<string, unknown> {
  productId?: string;
  items?: Array<Record<string, unknown>>;
  keterangan?: string;
  userId?: string;
  userName?: string;
  lokasiAsal?: string;
  lokasiTujuan?: string;
  lokasiAsalNama?: string;
  lokasiTujuanNama?: string;
  ids?: unknown[];
  aktif?: boolean;
}

export interface ProductRow extends Record<string, unknown> {
  id: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  stok?: number;
  hargaBeli?: number;
  tenantId?: string;
  gudangKode?: string;
}

export function asProductRow(doc: Record<string, unknown> | null | undefined): ProductRow {
  return doc as ProductRow;
}

export function itemStokId(it: Record<string, unknown>): string {
  return String(it.stokId || '');
}
