'use client';

import type { JsonObject } from '@/types/json';
import { asObject, str } from '@/types/json';
import { formatIDR, formatDateTime } from '@/lib/format';
import { sanitizeStoreSettings } from '@/lib/receipt-doc';
import { resolvePrintLayout } from '@/lib/printer-settings';

/**
 * Struk kasir — data dari buildReceiptDoc.
 * Layout cetak mengikuti lib/printer-settings (default: Epson TM-U220).
 */
export default function Receipt({
  trx,
  layout: layoutProp,
  preview = false,
  narrow: narrowProp,
}: {
  trx?: JsonObject | null;
  layout?: ReturnType<typeof resolvePrintLayout>;
  preview?: boolean;
  narrow?: boolean;
}) {
  if (!trx) return null;

  const layout = layoutProp || resolvePrintLayout();
  const narrow = narrowProp ?? layout.narrow;

  const header = asObject(sanitizeStoreSettings(asObject(trx.store)));
  const company = str(header.companyName || trx.tenantName);
  const address = str(header.companyAddress);
  const phone = str(header.companyPhone);
  const npwp = str(header.companyNPWP);
  const footer = str(header.receiptFooterText, 'Terima Kasih');
  const tenantWantsLogo = header.showLogoOnReceipt !== false;
  const logo =
    layout.showLogoOnPrint && tenantWantsLogo ? str(header.logoBase64) : '';
  const items = Array.isArray(trx.items) ? trx.items as JsonObject[] : [];

  const rootClass = [
    'receipt-print',
    narrow ? 'narrow' : '',
    preview ? 'receipt-preview' : '',
    layout.profileId ? `profile-${layout.profileId}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const style = preview
    ? {
        fontSize: `${layout.fontSizePx}px`,
        lineHeight: layout.lineHeight,
        width: `${layout.paperWidthMm}mm`,
        maxWidth: '100%',
      }
    : undefined;

  return (
    <div className={rootClass} style={style}>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={String(logo)} alt="" className="receipt-logo" />
      ) : null}
      <div className="receipt-header">
        {company ? <div className="receipt-company">{String(company)}</div> : null}
        {address ? <div className="receipt-address">{String(address)}</div> : null}
        {phone ? <div className="receipt-phone">{String(phone)}</div> : null}
        {npwp ? <div className="receipt-npwp">NPWP: {String(npwp)}</div> : null}
      </div>

      <div className="receipt-meta">
        <div>{trx.noTransaksi ? `No: ${trx.noTransaksi}` : ''}</div>
        <div>{trx.tanggal ? formatDateTime(trx.tanggal as string) : ''}</div>
        {trx.kasir ? <div>Kasir: {String(trx.kasir)}</div> : null}
        {trx.pelanggan ? <div>Pelanggan: {String(trx.pelanggan)}</div> : null}
      </div>

      <table className="receipt-items">
        <thead>
          <tr>
            <th>Item</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td>
                <div>{String(it.nama || it.kode || '—')}</div>
                {it.harga != null ? (
                  <div className="receipt-item-sub">
                    {formatIDR(Number(it.harga))} × {String(it.qty ?? 1)}
                  </div>
                ) : null}
              </td>
              <td className="text-right">{String(it.qty ?? 1)}</td>
              <td className="text-right">{formatIDR(Number(it.jumlah || it.total || 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="receipt-totals">
        {trx.subTotal != null ? (
          <div className="receipt-row">
            <span>Subtotal</span>
            <span>{formatIDR(Number(trx.subTotal))}</span>
          </div>
        ) : null}
        {trx.diskon != null && Number(trx.diskon) > 0 ? (
          <div className="receipt-row">
            <span>Diskon</span>
            <span>-{formatIDR(Number(trx.diskon))}</span>
          </div>
        ) : null}
        {trx.ppn != null && Number(trx.ppn) > 0 ? (
          <div className="receipt-row">
            <span>PPN</span>
            <span>{formatIDR(Number(trx.ppn))}</span>
          </div>
        ) : null}
        <div className="receipt-row receipt-grand">
          <span>TOTAL</span>
          <span>{formatIDR(Number(trx.total || 0))}</span>
        </div>
        {trx.bayar != null ? (
          <div className="receipt-row">
            <span>Bayar</span>
            <span>{formatIDR(Number(trx.bayar))}</span>
          </div>
        ) : null}
        {trx.kembali != null ? (
          <div className="receipt-row">
            <span>Kembali</span>
            <span>{formatIDR(Number(trx.kembali))}</span>
          </div>
        ) : null}
      </div>

      <div className="receipt-footer">{footer}</div>
    </div>
  );
}
