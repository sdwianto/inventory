import type { JsonObject } from '@/types/json';
import { asArray, asObject, num, str } from '@/types/json';

/** Satu baris detail barang untuk cetak tagihan (format acuan pengadaan). */
export type HutangPrintItemRow = {
  key: string;
  kode: string;
  nama: string;
  satuan: string;
  qty: number;
  harga: number;
  jumlah: number;
  tanggalPermintaanKirim?: string;
  tanggalAktualKirim?: string;
  vendor: string;
  noInvoice: string;
  noSO: string;
  noPO: string;
  noDO: string;
  lokasi: string;
};

function vendorName(hutang: JsonObject): string {
  return (
    str(hutang.supplierName)
    || str(asObject(hutang.vendorBillingSnapshot).companyName)
    || str(asObject(hutang.vendorBilling).companyName)
    || str(hutang.vendorTenantId)
    || '—'
  );
}

function lineItemsOf(hutang: JsonObject): JsonObject[] {
  const full = asArray(hutang.itemsFull) as JsonObject[];
  if (full.length) return full;
  return asArray(hutang.items) as JsonObject[];
}

/** Flatten invoice → baris barang (satu baris per item). */
export function buildHutangPrintItemRows(hutangs: JsonObject[]): HutangPrintItemRow[] {
  const out: HutangPrintItemRow[] = [];
  for (const h of hutangs) {
    const items = lineItemsOf(h);
    const minta = str(h.tanggalPermintaanKirim);
    const aktual = str(h.tanggalAktualKirim || h.shippedAt || h.tanggal);
    const vendor = vendorName(h);
    const noInvoice = str(h.noInvoice);
    const noSO = str(h.noSO);
    const noPO = str(h.noPO);
    const noDO = str(h.noDO);
    const lokasi = str(h.lokasi);

    if (!items.length) {
      out.push({
        key: `${str(h.id)}-empty`,
        kode: '—',
        nama: '(Tanpa detail item)',
        satuan: '—',
        qty: 0,
        harga: 0,
        jumlah: num(h.total),
        tanggalPermintaanKirim: minta || undefined,
        tanggalAktualKirim: aktual || undefined,
        vendor,
        noInvoice,
        noSO,
        noPO,
        noDO,
        lokasi,
      });
      continue;
    }

    items.forEach((it, idx) => {
      const qty = num(it.qty ?? it.qtyOrdered ?? it.qtyReceived);
      const harga = num(it.harga);
      const jumlah = num(it.jumlah, qty * harga);
      out.push({
        key: `${str(h.id)}-${str(it.lineId || it.lineNo || idx)}-${str(it.kode)}`,
        kode: str(it.kode || it.vendorKode || it.localKode, '—'),
        nama: str(it.nama || it.vendorNama || it.localNama, '—'),
        satuan: str(it.satuan, '—'),
        qty,
        harga,
        jumlah,
        tanggalPermintaanKirim: minta || undefined,
        tanggalAktualKirim: aktual || undefined,
        vendor,
        noInvoice,
        noSO,
        noPO,
        noDO,
        lokasi,
      });
    });
  }
  return out;
}

export function hutangHasLineItems(hutang: JsonObject): boolean {
  return lineItemsOf(hutang).length > 0;
}
