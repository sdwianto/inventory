'use client';

import type { JsonObject } from '@/types/json';
import { asArray, asObject, num, str } from '@/types/json';
import { formatDate, formatDateTime, formatIDR } from '@/lib/format';

const APPROVAL_LABELS = {
  PENDING_REVIEW: 'Menunggu review',
  APPROVED: 'Disetujui',
  REJECTED: 'Ditolak',
  PAID_EXTERNAL: 'Lunas (luar sistem)',
};

function VarianceRow({
  label,
  value,
  delta,
  showDelta = true,
}: {
  label: string;
  value: number;
  delta?: number | null;
  showDelta?: boolean;
}) {
  const deltaColor = delta != null && delta > 0 ? 'text-red-600' : delta != null && delta < 0 ? 'text-green-600' : 'text-slate-500';
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

function BillingLogo({ logo, alt, className = 'w-14 h-14' }: { logo?: string; alt?: string; className?: string }) {
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
export default function VendorInvoiceDocument({
  detail,
  className = '',
  printId = 'vendor-invoice-a4-print',
}: {
  detail: JsonObject | null;
  className?: string;
  printId?: string;
}) {
  if (!detail) return null;

  const approval = str(detail.approvalStatus || detail.status);
  const rejectedBy = asObject(detail.rejectedBy);
  const po = asObject(detail.po);
  const vendor = asObject(detail.vendorBilling);
  const customer = asObject(detail.customerBilling);
  const billTo = str(detail.billToName || customer.companyName, '—');
  const rows = asArray(detail.itemsFull).length ? asArray(detail.itemsFull) : asArray(detail.items);
  const rowsTyped = rows as JsonObject[];
  const totals = asObject(detail.totals);
  const cmp = asObject(detail.priceComparison);
  const poEst = num(cmp.poEstimasiTotal ?? detail.poEstimasiTotal ?? po.estimasiTotal);
  const soT = num(cmp.soTotal ?? detail.soTotal ?? asObject(po.vendorSoSnapshot).total);
  const invT = num(cmp.invoiceTotal ?? detail.total);
  const showCustomerLogo = customer.showLogoOnInvoice !== false;

  return (
    <article
      id={printId}
      className={`vendor-invoice-document bg-white text-slate-900 ${className}`}
    >
      <div className="vendor-invoice-sheet">
      <header className="vendor-invoice-header flex flex-wrap gap-3 justify-between items-start border-b-2 border-orange-500 pb-3 mb-3">
        <div className="flex gap-3 min-w-0">
          <BillingLogo logo={str(vendor.logoBase64)} alt="Logo vendor" />
          <div className="min-w-0 text-sm">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Penagih / Vendor</p>
            <p className="font-bold text-base leading-tight">{str(vendor.companyName || detail.supplierName, 'Vendor')}</p>
            {str(vendor.companyAddress) && (
              <p className="text-xs text-slate-600 mt-0.5 whitespace-pre-line">{str(vendor.companyAddress)}</p>
            )}
            <div className="flex flex-wrap gap-x-3 text-xs text-slate-500 mt-1">
              {str(vendor.companyPhone) && <span>Telp: {str(vendor.companyPhone)}</span>}
              {str(vendor.companyNPWP) && <span>NPWP: {str(vendor.companyNPWP)}</span>}
            </div>
          </div>
        </div>
        <div className="text-right shrink min-w-0 max-w-[45%]">
          <h1 className="text-base font-bold text-orange-600 uppercase tracking-wide">Faktur Tagihan</h1>
          <p className="text-lg font-bold font-mono text-slate-900 mt-0.5 break-all">{str(detail.noInvoice)}</p>
          <p className="text-xs text-slate-600 mt-1">{formatDateTime(str(detail.tanggal))}</p>
          <span className={`inline-block mt-2 px-2 py-0.5 rounded text-xs font-medium ${
            approval === 'APPROVED' ? 'bg-green-100 text-green-800'
              : approval === 'PENDING_REVIEW' ? 'bg-blue-100 text-blue-800'
                : approval === 'REJECTED' ? 'bg-red-100 text-red-800'
                  : 'bg-slate-100 text-slate-700'
          }`}
          >
            {APPROVAL_LABELS[approval as keyof typeof APPROVAL_LABELS] || approval}
          </span>
        </div>
      </header>

      {approval === 'REJECTED' && (
        <section className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
          <p className="text-[10px] font-bold uppercase tracking-wide text-red-700 mb-1">Alasan penolakan</p>
          <p className="leading-snug">{str(detail.rejectReason, 'Ditolak admin')}</p>
          {(str(rejectedBy.userName) || str(detail.rejectedAt)) ? (
            <p className="text-[11px] text-red-600 mt-1.5">
              {str(rejectedBy.userName) ? `Oleh ${str(rejectedBy.userName)}` : null}
              {str(detail.rejectedAt) ? `${str(rejectedBy.userName) ? ' · ' : ''}${formatDateTime(str(detail.rejectedAt))}` : null}
            </p>
          ) : null}
        </section>
      )}

      <section className="vendor-invoice-meta-grid grid sm:grid-cols-2 gap-3 mb-3">
        <div className="border rounded-lg p-3 bg-slate-50">
          <div className="flex gap-3 items-start">
            {showCustomerLogo && str(customer.logoBase64) && (
              <BillingLogo logo={str(customer.logoBase64)} alt="Logo toko" className="w-12 h-12" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase text-slate-500 mb-1">Tagihan kepada</p>
              <p className="font-semibold text-sm">{billTo}</p>
              {str(customer.companyAddress) && (
                <p className="text-xs text-slate-600 mt-1 whitespace-pre-line">{str(customer.companyAddress)}</p>
              )}
              {str(customer.companyPhone) && <p className="text-xs text-slate-500 mt-1">Telp: {str(customer.companyPhone)}</p>}
              {str(customer.companyNPWP) && <p className="text-xs text-slate-500">NPWP: {str(customer.companyNPWP)}</p>}
            </div>
          </div>
        </div>
        <div className="border rounded-lg p-3 bg-white text-xs grid grid-cols-2 gap-x-3 gap-y-1.5">
          <div><span className="text-slate-500 block">No. Hutang</span><span className="font-mono font-medium">{str(detail.noHutang)}</span></div>
          <div><span className="text-slate-500 block">Jatuh tempo</span><span className="font-medium">{formatDate(str(detail.jatuhTempo))}</span></div>
          <div><span className="text-slate-500 block">No. PO</span><span className="font-mono">{str(detail.noPO, '—')}</span></div>
          <div><span className="text-slate-500 block">No. SO</span><span className="font-mono">{str(detail.noSO, '—')}</span></div>
          <div><span className="text-slate-500 block">No. DO</span><span className="font-mono">{str(detail.noDO, '—')}</span></div>
          <div><span className="text-slate-500 block">Syarat bayar</span><span>{str(detail.paymentTerms, '—')}</span></div>
          <div><span className="text-slate-500 block">Status PO</span><span>{str(po.status, '—')}</span></div>
          <div><span className="text-slate-500 block">Match GRN</span><span>{str(detail.matchStatus, '—')}</span></div>
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
          {rowsTyped.map((it, i) => (
            <tr key={str(it.lineNo, String(i))} className={i % 2 ? 'bg-slate-50' : ''}>
              <td className="border border-slate-200 px-1.5 py-1 text-center text-slate-500">{str(it.lineNo, String(i + 1))}</td>
              <td className="border border-slate-200 px-1.5 py-1 font-mono text-[10px] break-all">{str(it.kode)}</td>
              <td className="border border-slate-200 px-1.5 py-1 break-words">{str(it.nama, '—')}</td>
              <td className="border border-slate-200 px-1.5 py-1 text-center">{str(it.satuan, '—')}</td>
              <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums">{num(it.qty)}</td>
              <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums vi-money">{formatIDR(num(it.harga))}</td>
              <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums vi-money">{num(it.diskon) ? formatIDR(num(it.diskon)) : '—'}</td>
              <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums font-medium vi-money">
                {formatIDR(num(it.jumlah, num(it.qty) * num(it.harga)))}
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
            <span className="tabular-nums">{formatIDR(num(totals.itemsSubTotal ?? detail.subTotal))}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">DPP / Subtotal</span>
            <span className="tabular-nums">{formatIDR(num(totals.subTotal ?? detail.subTotal))}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">PPN</span>
            <span className="tabular-nums">{formatIDR(num(totals.ppn ?? detail.ppn))}</span>
          </div>
          <div className="flex justify-between font-bold text-base pt-2 border-t mt-2">
            <span>Total tagihan</span>
            <span className="text-orange-600 tabular-nums">{formatIDR(num(totals.total ?? detail.total))}</span>
          </div>
        </div>
      </section>
      </div>
    </article>
  );
}
