'use client';

import type { JsonObject } from '@/types/json';
import { asArray, asObject, num, str } from '@/types/json';
import { formatDate, formatDateTime, formatIDR } from '@/lib/format';
import { resolvePrintLayout } from '@/lib/printer-settings';
import {
  lineNetQty,
  lineReturnedQty,
  summarizeHutangCreditDisplay,
} from '@/lib/hutang-invoice-display';

const APPROVAL_LABELS = {
  PENDING_REVIEW: 'Menunggu review',
  APPROVED: 'Disetujui',
  REJECTED: 'Ditolak',
  PAID_EXTERNAL: 'Lunas (luar sistem)',
  LUNAS: 'Lunas',
} as const;

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
  const cnSummary = summarizeHutangCreditDisplay(detail);
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
      {str(detail.tanggalPermintaanKirim || asObject(detail.po).tanggalKedatangan) ? (
        <div className="receipt-line">
          Minta: {formatDate(str(detail.tanggalPermintaanKirim || asObject(detail.po).tanggalKedatangan))}
        </div>
      ) : null}
      {str(detail.paymentTerms) ? <div className="receipt-line">Bayar: {str(detail.paymentTerms)}</div> : null}
      {str(detail.jatuhTempo) ? <div className="receipt-line">Jth  : {formatDate(str(detail.jatuhTempo))}</div> : null}
      <div className="line" />
      <table className="receipt-items">
        <tbody>
          {rows.map((it, i) => {
            const qtyInv = num(it.qty);
            const qtyRet = lineReturnedQty(cnSummary, it);
            const qtyNet = lineNetQty(qtyInv, qtyRet);
            return (
            <tr key={str(it.lineNo, String(i))}>
              <td colSpan={2}>
                <div className="receipt-wrap">{str(it.nama || it.kode)}</div>
                <div className="receipt-item-row">
                  <span>
                    &nbsp;&nbsp;{qtyInv} {str(it.satuan, 'PCS')} x {formatIDR(num(it.harga))}
                    {qtyRet > 0 ? ` (retur ${qtyRet} → netto ${qtyNet})` : ''}
                  </span>
                  <span className="text-right">
                    {formatIDR(num(it.jumlah, num(it.harga) * qtyInv))}
                  </span>
                </div>
              </td>
            </tr>
            );
          })}
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
            <td className="bold">{cnSummary.hasCredits ? 'TAGIHAN' : 'TOTAL TAGIHAN'}</td>
            <td className="text-right bold">{formatIDR(num(totals.total ?? detail.total))}</td>
          </tr>
          {cnSummary.hasCredits ? (
            <>
              <tr>
                <td>Credit note / retur</td>
                <td className="text-right">-{formatIDR(cnSummary.creditTotal)}</td>
              </tr>
              <tr>
                <td className="bold">TOTAL TAGIHAN</td>
                <td className="text-right bold">{formatIDR(cnSummary.netTagihan)}</td>
              </tr>
            </>
          ) : null}
        </tbody>
      </table>
      {cnSummary.hasCredits ? (
        <>
          <div className="line" />
          <div className="receipt-line receipt-small bold">Credit note / retur</div>
          {asArray(detail.creditNotes).map((raw, i) => {
            const cn = asObject(raw);
            return (
              <div key={str(cn.creditNoteId) || i} className="receipt-line receipt-small receipt-wrap">
                {str(cn.noCN) || str(cn.creditNoteId)}
                {str(cn.noReturn) ? ` / RTV ${str(cn.noReturn)}` : ''}
                {' '}{formatIDR(num(cn.amount))}
              </div>
            );
          })}
        </>
      ) : null}
      {(poEst > 0 || soT > 0) ? (
        <>
          <div className="line" />
          <div className="receipt-line receipt-small">Estimasi PO: {formatIDR(poEst)}</div>
          {soT > 0 ? <div className="receipt-line receipt-small">Nilai SO   : {formatIDR(soT)}</div> : null}
          <div className="receipt-line receipt-small">Invoice    : {formatIDR(invT)}</div>
        </>
      ) : null}
      <div className="line" />
      <div className="text-center receipt-line receipt-small bold">
        Status: {APPROVAL_LABELS[approval as keyof typeof APPROVAL_LABELS] || approval || '—'}
      </div>
      {(() => {
        const approved = asObject(detail.approvedBy);
        const rejected = asObject(detail.rejectedBy);
        const knowing = asObject(detail.knowingBy);
        const penerima = asObject(detail.penerimaGudang);
        const actor = approval === 'REJECTED'
          ? str(rejected.userName || rejected.name)
          : str(knowing.userName || approved.userName || approved.name);
        return (
          <>
            {actor ? (
              <div className="text-center receipt-line receipt-small">oleh {actor}</div>
            ) : null}
            {str(knowing.nik) ? (
              <div className="text-center receipt-line receipt-small">NIK {str(knowing.nik)}</div>
            ) : null}
            {str(knowing.jabatan) ? (
              <div className="text-center receipt-line receipt-small">{str(knowing.jabatan)}</div>
            ) : null}
            {str(penerima.userName) ? (
              <div className="text-center receipt-line receipt-small">
                Penerima: {str(penerima.userName)}
              </div>
            ) : null}
            {str(penerima.nik) ? (
              <div className="text-center receipt-line receipt-small">NIK penerima {str(penerima.nik)}</div>
            ) : null}
          </>
        );
      })()}
      <div className="text-center receipt-line receipt-small">
        Salinan sistem — bukan faktur pajak vendor
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
