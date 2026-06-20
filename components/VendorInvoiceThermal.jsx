'use client';

import { formatDate, formatDateTime, formatIDR } from '@/lib/format';
import { resolvePrintLayout } from '@/lib/printer-settings';

/** Struk faktur tagihan vendor untuk printer thermal / impact. */
export default function VendorInvoiceThermal({ detail, layout: layoutProp, preview = false }) {
  if (!detail) return null;

  const layout = layoutProp || resolvePrintLayout();
  const vendor = detail.vendorBilling || {};
  const customer = detail.customerBilling || {};
  const billTo = detail.billToName || customer.companyName || '—';
  const items = detail.itemsFull || detail.items || [];
  const totals = detail.totals || {};
  const cmp = detail.priceComparison || {};
  const poEst = cmp.poEstimasiTotal ?? detail.poEstimasiTotal ?? 0;
  const soT = cmp.soTotal ?? detail.soTotal ?? 0;
  const invT = cmp.invoiceTotal ?? detail.total ?? 0;

  const showVendorLogo = layout.showLogoOnPrint && vendor.logoBase64;
  const rootClass = [
    'receipt-print',
    layout.narrow ? 'narrow' : '',
    preview ? 'receipt-preview' : '',
    layout.profileId ? `profile-${layout.profileId}` : '',
  ].filter(Boolean).join(' ');

  const style = preview
    ? {
        fontSize: `${layout.fontSizePx}px`,
        lineHeight: layout.lineHeight,
        maxWidth: `${layout.printableWidthMm}mm`,
      }
    : undefined;

  return (
    <div
      className={rootClass}
      data-nota={detail.noInvoice || ''}
      data-paper-mm={layout.paperWidthMm}
      style={style}
    >
      {showVendorLogo && (
        <div className="receipt-logo text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={vendor.logoBase64} alt="logo" className="receipt-logo-img" />
        </div>
      )}
      <div className="text-center bold receipt-line">{vendor.companyName || detail.supplierName || 'Vendor'}</div>
      {vendor.companyAddress && <div className="text-center receipt-line receipt-wrap">{vendor.companyAddress}</div>}
      {vendor.companyPhone && <div className="text-center receipt-line">Telp: {vendor.companyPhone}</div>}
      <div className="double-line" />
      <div className="text-center bold receipt-line">FAKTUR TAGIHAN</div>
      <div className="text-center receipt-line">{detail.noInvoice}</div>
      <div className="line" />
      <div className="receipt-line">Tgl  : {formatDateTime(detail.tanggal)}</div>
      <div className="receipt-line receipt-wrap">Kpd  : {billTo}</div>
      <div className="receipt-line">Hutang: {detail.noHutang}</div>
      {detail.noPO && <div className="receipt-line receipt-wrap">PO   : {detail.noPO}</div>}
      {detail.noSO && <div className="receipt-line">SO   : {detail.noSO}</div>}
      {detail.noDO && <div className="receipt-line">DO   : {detail.noDO}</div>}
      {detail.paymentTerms && <div className="receipt-line">Bayar: {detail.paymentTerms}</div>}
      {detail.jatuhTempo && <div className="receipt-line">Jth  : {formatDate(detail.jatuhTempo)}</div>}
      <div className="line" />
      <table className="receipt-items">
        <tbody>
          {items.map((it, i) => (
            <tr key={it.lineNo || i}>
              <td colSpan={2}>
                <div className="receipt-wrap">{it.nama || it.kode}</div>
                <div className="receipt-item-row">
                  <span>
                    &nbsp;&nbsp;{it.qty} {it.satuan || 'PCS'} x {formatIDR(it.harga)}
                  </span>
                  <span className="text-right">
                    {formatIDR(it.jumlah ?? (it.harga || 0) * (it.qty || 0))}
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="line" />
      <table className="receipt-totals">
        <tbody>
          <tr>
            <td>Subtotal</td>
            <td className="text-right">{formatIDR(totals.subTotal ?? detail.subTotal)}</td>
          </tr>
          {(totals.ppn ?? detail.ppn) > 0 && (
            <tr>
              <td>PPN</td>
              <td className="text-right">{formatIDR(totals.ppn ?? detail.ppn)}</td>
            </tr>
          )}
          <tr>
            <td className="bold">TOTAL</td>
            <td className="text-right bold">{formatIDR(totals.total ?? detail.total)}</td>
          </tr>
        </tbody>
      </table>
      {(poEst > 0 || soT > 0) && (
        <>
          <div className="line" />
          <div className="receipt-line receipt-small">Estimasi PO: {formatIDR(poEst)}</div>
          {soT > 0 && <div className="receipt-line receipt-small">Nilai SO   : {formatIDR(soT)}</div>}
          <div className="receipt-line receipt-small">Invoice    : {formatIDR(invT)}</div>
        </>
      )}
      <div className="line" />
      <div className="text-center receipt-line receipt-small">
        Status: {detail.approvalStatus || detail.status}
      </div>
      <div className="receipt-feed" aria-hidden="true" />
    </div>
  );
}
