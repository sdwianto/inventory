'use client';

import type { JsonObject } from '@/types/json';
import { asArray, asObject, num, str } from '@/types/json';
import { formatDate, formatDateTime, formatIDR } from '@/lib/format';
import { resolvePrintLayout } from '@/lib/printer-settings';

/** Struk faktur tagihan vendor untuk printer thermal / impact. */
export default function VendorInvoiceThermal({
  detail,
  layout: layoutProp,
  preview = false,
}: {
  detail: JsonObject | null;
  layout?: ReturnType<typeof resolvePrintLayout>;
  preview?: boolean;
}) {
  if (!detail) return null;

  const layout = layoutProp || resolvePrintLayout();
  const vendor = asObject(detail.vendorBilling);
  const billTo = str(detail.billToName || asObject(detail.customerBilling).companyName, '—');
  const items = asArray(detail.itemsFull).length ? asArray(detail.itemsFull) : asArray(detail.items);
  const rows = items as JsonObject[];
  const totals = asObject(detail.totals);
  const cmp = asObject(detail.priceComparison);
  const poEst = num(cmp.poEstimasiTotal ?? detail.poEstimasiTotal);
  const soT = num(cmp.soTotal ?? detail.soTotal);
  const invT = num(cmp.invoiceTotal ?? detail.total);
  const approval = str(detail.approvalStatus || detail.status);

  const showVendorLogo = layout.showLogoOnPrint && str(vendor.logoBase64);
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
      data-nota={str(detail.noInvoice)}
      data-paper-mm={layout.paperWidthMm}
      style={style}
    >
      {showVendorLogo ? (
        <div className="receipt-logo text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={str(vendor.logoBase64)} alt="logo" className="receipt-logo-img" />
        </div>
      ) : null}
      <div className="text-center bold receipt-line">{str(vendor.companyName || detail.supplierName, 'Vendor')}</div>
      {str(vendor.companyAddress) ? <div className="text-center receipt-line receipt-wrap">{str(vendor.companyAddress)}</div> : null}
      {str(vendor.companyPhone) ? <div className="text-center receipt-line">Telp: {str(vendor.companyPhone)}</div> : null}
      <div className="double-line" />
      <div className="text-center bold receipt-line">FAKTUR TAGIHAN</div>
      <div className="text-center receipt-line">{str(detail.noInvoice)}</div>
      <div className="line" />
      <div className="receipt-line">Tgl  : {formatDateTime(str(detail.tanggal))}</div>
      <div className="receipt-line receipt-wrap">Kpd  : {billTo}</div>
      <div className="receipt-line">Hutang: {str(detail.noHutang)}</div>
      {str(detail.noPO) ? <div className="receipt-line receipt-wrap">PO   : {str(detail.noPO)}</div> : null}
      {str(detail.noSO) ? <div className="receipt-line">SO   : {str(detail.noSO)}</div> : null}
      {str(detail.noDO) ? <div className="receipt-line">DO   : {str(detail.noDO)}</div> : null}
      {str(detail.paymentTerms) ? <div className="receipt-line">Bayar: {str(detail.paymentTerms)}</div> : null}
      {str(detail.jatuhTempo) ? <div className="receipt-line">Jth  : {formatDate(str(detail.jatuhTempo))}</div> : null}
      <div className="line" />
      <table className="receipt-items">
        <tbody>
          {rows.map((it, i) => (
            <tr key={str(it.lineNo, String(i))}>
              <td colSpan={2}>
                <div className="receipt-wrap">{str(it.nama || it.kode)}</div>
                <div className="receipt-item-row">
                  <span>
                    &nbsp;&nbsp;{num(it.qty)} {str(it.satuan, 'PCS')} x {formatIDR(num(it.harga))}
                  </span>
                  <span className="text-right">
                    {formatIDR(num(it.jumlah, num(it.harga) * num(it.qty)))}
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
            <td className="text-right">{formatIDR(num(totals.subTotal ?? detail.subTotal))}</td>
          </tr>
          {num(totals.ppn ?? detail.ppn) > 0 ? (
            <tr>
              <td>PPN</td>
              <td className="text-right">{formatIDR(num(totals.ppn ?? detail.ppn))}</td>
            </tr>
          ) : null}
          <tr>
            <td className="bold">TOTAL</td>
            <td className="text-right bold">{formatIDR(num(totals.total ?? detail.total))}</td>
          </tr>
        </tbody>
      </table>
      {(poEst > 0 || soT > 0) ? (
        <>
          <div className="line" />
          <div className="receipt-line receipt-small">Estimasi PO: {formatIDR(poEst)}</div>
          {soT > 0 ? <div className="receipt-line receipt-small">Nilai SO   : {formatIDR(soT)}</div> : null}
          <div className="receipt-line receipt-small">Invoice    : {formatIDR(invT)}</div>
        </>
      ) : null}
      <div className="line" />
      <div className="text-center receipt-line receipt-small">
        Status: {approval}
      </div>
      {approval === 'REJECTED' ? (
        <>
          <div className="line" />
          <div className="receipt-line bold">DITOLAK</div>
          <div className="receipt-line receipt-wrap receipt-small">
            Alasan: {str(detail.rejectReason, 'Ditolak admin')}
          </div>
        </>
      ) : null}
      <div className="receipt-feed" aria-hidden="true" />
    </div>
  );
}
