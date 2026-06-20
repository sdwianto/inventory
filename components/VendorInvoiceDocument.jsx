'use client';

import { formatDate, formatDateTime, formatIDR } from '@/lib/format';

const APPROVAL_LABELS = {
  PENDING_REVIEW: 'Menunggu review',
  APPROVED: 'Disetujui',
  REJECTED: 'Ditolak',
  PAID_EXTERNAL: 'Lunas (luar sistem)',
};

function VarianceRow({ label, value, delta, showDelta = true }) {
  const deltaColor = delta > 0 ? 'text-red-600' : delta < 0 ? 'text-green-600' : 'text-slate-500';
  return (
    <div className="flex justify-between text-sm py-1 border-b border-slate-100 last:border-0">
      <span className="text-slate-600">{label}</span>
      <span className="font-medium tabular-nums">
        {formatIDR(value)}
        {showDelta && delta != null && delta !== 0 && (
          <span className={`ml-2 text-xs ${deltaColor}`}>
            ({delta > 0 ? '+' : ''}{formatIDR(delta)})
          </span>
        )}
      </span>
    </div>
  );
}

function BillingLogo({ logo, alt, className = 'w-14 h-14' }) {
  if (!logo) {
    return (
      <div className={`${className} rounded-lg border bg-slate-50 flex items-center justify-center shrink-0 text-slate-400 text-[10px] text-center px-1`}>
        Tanpa logo
      </div>
    );
  }
  return (
    <div className={`${className} rounded-lg border bg-white flex items-center justify-center overflow-hidden shrink-0`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} alt={alt} className="max-w-full max-h-full object-contain" />
    </div>
  );
}

/** Layout faktur tagihan vendor — preview layar & cetak A4. */
export default function VendorInvoiceDocument({ detail, className = '', printId = 'vendor-invoice-a4-print' }) {
  if (!detail) return null;

  const approval = detail.approvalStatus || detail.status;
  const vendor = detail.vendorBilling || {};
  const customer = detail.customerBilling || {};
  const billTo = detail.billToName || customer.companyName || '—';
  const rows = detail.itemsFull || detail.items || [];
  const totals = detail.totals || {};
  const cmp = detail.priceComparison || {};
  const poEst = cmp.poEstimasiTotal ?? detail.poEstimasiTotal ?? detail.po?.estimasiTotal ?? 0;
  const soT = cmp.soTotal ?? detail.soTotal ?? detail.po?.vendorSoSnapshot?.total ?? 0;
  const invT = cmp.invoiceTotal ?? detail.total ?? 0;
  const showCustomerLogo = customer.showLogoOnInvoice !== false;

  return (
    <article
      id={printId}
      className={`vendor-invoice-document bg-white text-slate-900 ${className}`}
    >
      <div className="vendor-invoice-sheet">
      <header className="vendor-invoice-header flex flex-wrap gap-3 justify-between items-start border-b-2 border-orange-500 pb-3 mb-3">
        <div className="flex gap-3 min-w-0">
          <BillingLogo logo={vendor.logoBase64} alt="Logo vendor" />
          <div className="min-w-0 text-sm">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Penagih / Vendor</p>
            <p className="font-bold text-base leading-tight">{vendor.companyName || detail.supplierName || 'Vendor'}</p>
            {vendor.companyAddress && (
              <p className="text-xs text-slate-600 mt-0.5 whitespace-pre-line">{vendor.companyAddress}</p>
            )}
            <div className="flex flex-wrap gap-x-3 text-xs text-slate-500 mt-1">
              {vendor.companyPhone && <span>Telp: {vendor.companyPhone}</span>}
              {vendor.companyNPWP && <span>NPWP: {vendor.companyNPWP}</span>}
            </div>
          </div>
        </div>
        <div className="text-right shrink min-w-0 max-w-[45%]">
          <h1 className="text-base font-bold text-orange-600 uppercase tracking-wide">Faktur Tagihan</h1>
          <p className="text-lg font-bold font-mono text-slate-900 mt-0.5 break-all">{detail.noInvoice}</p>
          <p className="text-xs text-slate-600 mt-1">{formatDateTime(detail.tanggal)}</p>
          <span className={`inline-block mt-2 px-2 py-0.5 rounded text-xs font-medium ${
            approval === 'APPROVED' ? 'bg-green-100 text-green-800'
              : approval === 'PENDING_REVIEW' ? 'bg-blue-100 text-blue-800'
                : approval === 'REJECTED' ? 'bg-red-100 text-red-800'
                  : 'bg-slate-100 text-slate-700'
          }`}
          >
            {APPROVAL_LABELS[approval] || approval}
          </span>
        </div>
      </header>

      <section className="vendor-invoice-meta-grid grid sm:grid-cols-2 gap-3 mb-3">
        <div className="border rounded-lg p-3 bg-slate-50">
          <div className="flex gap-3 items-start">
            {showCustomerLogo && customer.logoBase64 && (
              <BillingLogo logo={customer.logoBase64} alt="Logo toko" className="w-12 h-12" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase text-slate-500 mb-1">Tagihan kepada</p>
              <p className="font-semibold text-sm">{billTo}</p>
              {customer.companyAddress && (
                <p className="text-xs text-slate-600 mt-1 whitespace-pre-line">{customer.companyAddress}</p>
              )}
              {customer.companyPhone && <p className="text-xs text-slate-500 mt-1">Telp: {customer.companyPhone}</p>}
              {customer.companyNPWP && <p className="text-xs text-slate-500">NPWP: {customer.companyNPWP}</p>}
            </div>
          </div>
        </div>
        <div className="border rounded-lg p-3 bg-white text-xs grid grid-cols-2 gap-x-3 gap-y-1.5">
          <div><span className="text-slate-500 block">No. Hutang</span><span className="font-mono font-medium">{detail.noHutang}</span></div>
          <div><span className="text-slate-500 block">Jatuh tempo</span><span className="font-medium">{formatDate(detail.jatuhTempo)}</span></div>
          <div><span className="text-slate-500 block">No. PO</span><span className="font-mono">{detail.noPO || '—'}</span></div>
          <div><span className="text-slate-500 block">No. SO</span><span className="font-mono">{detail.noSO || '—'}</span></div>
          <div><span className="text-slate-500 block">No. DO</span><span className="font-mono">{detail.noDO || '—'}</span></div>
          <div><span className="text-slate-500 block">Syarat bayar</span><span>{detail.paymentTerms || '—'}</span></div>
          <div><span className="text-slate-500 block">Status PO</span><span>{detail.po?.status || '—'}</span></div>
          <div><span className="text-slate-500 block">Match GRN</span><span>{detail.matchStatus || '—'}</span></div>
        </div>
      </section>

      <table className="vendor-invoice-items-table w-full text-xs border-collapse mb-4">
        <colgroup>
          <col className="vi-col-no" />
          <col className="vi-col-kode" />
          <col className="vi-col-nama" />
          <col className="vi-col-sat" />
          <col className="vi-col-qty" />
          <col className="vi-col-harga" />
          <col className="vi-col-diskon" />
          <col className="vi-col-jumlah" />
        </colgroup>
        <thead>
          <tr className="bg-orange-500 text-white">
            <th className="border border-orange-600 px-1.5 py-1 text-center">#</th>
            <th className="border border-orange-600 px-1.5 py-1 text-left">Kode</th>
            <th className="border border-orange-600 px-1.5 py-1 text-left">Nama Barang</th>
            <th className="border border-orange-600 px-1.5 py-1 text-center">Sat</th>
            <th className="border border-orange-600 px-1.5 py-1 text-right">Qty</th>
            <th className="border border-orange-600 px-1.5 py-1 text-right">Harga</th>
            <th className="border border-orange-600 px-1.5 py-1 text-right">Diskon</th>
            <th className="border border-orange-600 px-1.5 py-1 text-right">Jumlah</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((it, i) => (
            <tr key={it.lineNo || i} className={i % 2 ? 'bg-slate-50' : ''}>
              <td className="border border-slate-200 px-1.5 py-1 text-center text-slate-500">{it.lineNo || i + 1}</td>
              <td className="border border-slate-200 px-1.5 py-1 font-mono text-[10px] break-all">{it.kode}</td>
              <td className="border border-slate-200 px-1.5 py-1 break-words">{it.nama || '—'}</td>
              <td className="border border-slate-200 px-1.5 py-1 text-center">{it.satuan || '—'}</td>
              <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums">{it.qty}</td>
              <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums vi-money">{formatIDR(it.harga)}</td>
              <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums vi-money">{it.diskon ? formatIDR(it.diskon) : '—'}</td>
              <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums font-medium vi-money">
                {formatIDR(it.jumlah ?? (it.qty * it.harga))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="vendor-invoice-footer-grid grid sm:grid-cols-2 gap-3">
        <div className="border rounded-lg p-3 bg-slate-50">
          <p className="font-medium text-sm mb-2">Perbandingan harga</p>
          <VarianceRow label="Estimasi PO" value={poEst} showDelta={false} />
          <VarianceRow label="Nilai SO (sales.app)" value={soT} delta={soT && poEst ? soT - poEst : null} showDelta={!!soT} />
          <VarianceRow label="Invoice (aktual)" value={invT} delta={soT ? invT - soT : null} showDelta={!!soT} />
        </div>
        <div className="border rounded-lg p-3 space-y-1 min-w-0 vendor-invoice-totals">
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">Subtotal barang</span>
            <span className="tabular-nums">{formatIDR(totals.itemsSubTotal ?? detail.subTotal)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">DPP / Subtotal</span>
            <span className="tabular-nums">{formatIDR(totals.subTotal ?? detail.subTotal)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">PPN</span>
            <span className="tabular-nums">{formatIDR(totals.ppn ?? detail.ppn)}</span>
          </div>
          <div className="flex justify-between font-bold text-base pt-2 border-t mt-2">
            <span>Total tagihan</span>
            <span className="text-orange-600 tabular-nums">{formatIDR(totals.total ?? detail.total)}</span>
          </div>
        </div>
      </section>
      </div>
    </article>
  );
}
