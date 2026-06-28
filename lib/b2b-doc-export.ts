import { formatIDR, formatDateTime } from '@/lib/format';

export function deliveryPdfColumns() {
  return [
    { key: 'kode', label: 'Kode' },
    { key: 'nama', label: 'Produk' },
    { key: 'satuan', label: 'Sat' },
    { key: 'qty', label: 'Qty', value: (r) => String(r.qty ?? '') },
    { key: 'harga', label: 'Harga', value: (r) => formatIDR(r.harga) },
    { key: 'jumlah', label: 'Jumlah', value: (r) => formatIDR(r.jumlah || (r.harga || 0) * (r.qty || 0)) },
  ];
}

export function invoicePdfColumns() {
  return deliveryPdfColumns();
}

export async function exportB2bDocPdf(type, doc) {
  const { downloadPdf } = await import('@/lib/export-table');
  const rows = doc.items || [];
  const stamp = new Date().toISOString().slice(0, 10);
  if (type === 'delivery') {
    const title = `Surat Jalan ${doc.noDO}\n${doc.pelangganName} · SO ${doc.noSO || '-'}\n${formatDateTime(doc.tanggal)}`;
    await downloadPdf(`surat-jalan-${doc.noDO}-${stamp}.pdf`, title, rows, deliveryPdfColumns());
  } else {
    const title = `Faktur ${doc.noInvoice}\n${doc.pelangganName} · SO ${doc.noSO || '-'}\n${formatDateTime(doc.tanggal)}\nTotal: ${formatIDR(doc.total)}`;
    await downloadPdf(`faktur-${doc.noInvoice}-${stamp}.pdf`, title, rows, invoicePdfColumns());
  }
}
