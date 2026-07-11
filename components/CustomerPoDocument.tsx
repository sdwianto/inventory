'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asArray } from '@/types/json';
import { formatDate, formatDateTime, formatIDR, formatNumber } from '@/lib/format';
import { getPoArrivalDate, PO_STATUS_STYLE } from '@/lib/po-calendar';

type CustomerPoDocumentProps = {
  po: JsonObject;
  tenantName?: string;
  vendorNameById?: Record<string, string>;
  printId?: string;
  className?: string;
};

/** Dokumen PO ke vendor — cetak A4; baris dibatalkan dicoret. */
export default function CustomerPoDocument({
  po,
  tenantName,
  vendorNameById = {},
  printId = 'customer-po-a4-print',
  className = '',
}: CustomerPoDocumentProps) {
  if (!po) return null;
  const poItems = asArray(po.items) as JsonObject[];
  const vendorSubs = asArray(po.vendorSubmissions) as JsonObject[];
  const arrival = getPoArrivalDate(po);
  const status = str(po.status);
  const statusClass = PO_STATUS_STYLE[status as keyof typeof PO_STATUS_STYLE] || 'bg-slate-100 text-slate-700';

  return (
    <article
      id={printId}
      className={`customer-po-document bg-white text-slate-900 mx-auto p-8 ${className}`}
      style={{ maxWidth: '210mm', minHeight: '297mm' }}
    >
      <header className="flex justify-between gap-4 border-b-2 border-orange-500 pb-4 mb-4">
        <div className="text-sm min-w-0">
          <div className="font-bold text-base">{tenantName || str(po.tenantId) || 'Customer'}</div>
          <div className="text-xs text-slate-600 mt-1">Purchase Order ke Vendor</div>
        </div>
        <div className="text-right shrink-0">
          <h1 className="text-xl font-bold text-orange-600">PURCHASE ORDER</h1>
          <div className="text-sm font-mono font-semibold mt-1">{str(po.noPO)}</div>
          <div className="text-xs text-slate-600 mt-1">
            Kedatangan: {arrival ? formatDate(arrival) : '—'}
          </div>
          <div className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded border mt-1 ${statusClass}`}>
            {status}
          </div>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-4">
        <div><span className="text-slate-500">Vendor SO:</span> {str(po.vendorNoSO) || '—'}</div>
        <div><span className="text-slate-500">Dibuat:</span> {formatDateTime(str(po.createdAt))}</div>
        {!!po.catatan && (
          <div className="col-span-2 text-xs bg-slate-50 rounded px-2 py-1">
            <span className="text-slate-500">Catatan:</span> {str(po.catatan)}
          </div>
        )}
      </section>

      <table className="w-full text-xs border-collapse mb-4">
        <thead>
          <tr className="bg-orange-500 text-white">
            <th className="border border-orange-600 px-2 py-1.5 text-center w-8">No</th>
            <th className="border border-orange-600 px-2 py-1.5 text-left">Kode</th>
            <th className="border border-orange-600 px-2 py-1.5 text-left">Produk</th>
            <th className="border border-orange-600 px-2 py-1.5 text-right">Estimasi</th>
            <th className="border border-orange-600 px-2 py-1.5 text-right">Qty</th>
            <th className="border border-orange-600 px-2 py-1.5 text-center w-12">Sat</th>
          </tr>
        </thead>
        <tbody>
          {poItems.map((it, i) => {
            const cancelled = it.cancelled === true;
            return (
              <tr key={str(it.lineId || it.kode || i)} className={cancelled ? 'bg-rose-50/80 text-slate-400' : i % 2 ? 'bg-slate-50' : ''}>
                <td className="border border-slate-200 px-2 py-1.5 text-center">{i + 1}</td>
                <td className={`border border-slate-200 px-2 py-1.5 font-mono ${cancelled ? 'line-through' : ''}`}>{str(it.kode)}</td>
                <td className={`border border-slate-200 px-2 py-1.5 ${cancelled ? 'line-through' : ''}`}>
                  {str(it.nama)}
                  {cancelled && (
                    <span className="ml-1 text-[10px] font-medium text-rose-700 no-underline">(Dibatalkan)</span>
                  )}
                  {cancelled && !!it.cancelReason && (
                    <div className="text-[10px] text-rose-600 no-underline line-clamp-2">{str(it.cancelReason)}</div>
                  )}
                </td>
                <td className="border border-slate-200 px-2 py-1.5 text-right whitespace-nowrap">
                  {it.estimasiHarga ? formatIDR(num(it.estimasiHarga)) : '—'}
                </td>
                <td className="border border-slate-200 px-2 py-1.5 text-right whitespace-nowrap">
                  {cancelled
                    ? <span className="line-through">{formatNumber(num(it.qtyOriginal ?? it.qty))}</span>
                    : formatNumber(num(it.qty))}
                </td>
                <td className="border border-slate-200 px-2 py-1.5 text-center">{str(it.satuan) || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {poItems.some((it) => it.cancelled) && (
        <p className="text-[10px] text-rose-700 mb-4">
          Baris dicoret = item dibatalkan di sales.app setelah PO dikonfirmasi. Item aktif tetap diproses.
        </p>
      )}

      {vendorSubs.length > 0 && (
        <section className="text-xs border-t pt-3">
          <div className="font-semibold text-slate-700 mb-1">Pengiriman ke vendor</div>
          {vendorSubs.map((sub, idx) => (
            <div key={idx} className="text-slate-600">
              {vendorNameById[str(sub.vendorTenantId)] || str(sub.vendorTenantId)} — {str(sub.status)}
              {sub.vendorNoSO ? ` · SO ${str(sub.vendorNoSO)}` : ''}
            </div>
          ))}
        </section>
      )}

      <footer className="text-center text-[10px] text-slate-400 border-t pt-3 mt-auto">
        Dicetak: {new Date().toLocaleString('id-ID')}
      </footer>
    </article>
  );
}
