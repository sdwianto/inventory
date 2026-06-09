'use client';

import { formatIDR, formatDateTime } from '@/lib/format';
import { sanitizeStoreSettings } from '@/lib/receipt-doc';
import { resolvePrintLayout } from '@/lib/printer-settings';

/**
 * Struk kasir — data dari buildReceiptDoc.
 * Layout cetak mengikuti lib/printer-settings (default: Epson TM-U220).
 */
export default function Receipt({ trx, layout: layoutProp, preview = false, narrow: narrowProp }) {
  if (!trx) return null;

  const layout = layoutProp || resolvePrintLayout();
  const narrow = narrowProp ?? layout.narrow;

  const header = sanitizeStoreSettings(trx.store) || {};
  const company = header.companyName || trx.tenantName || '';
  const address = header.companyAddress || '';
  const phone = header.companyPhone || '';
  const npwp = header.companyNPWP || '';
  const footer = header.receiptFooterText || 'Terima Kasih';
  const tenantWantsLogo = header.showLogoOnReceipt !== false;
  const logo =
    layout.showLogoOnPrint && tenantWantsLogo ? header.logoBase64 : '';
  const items = Array.isArray(trx.items) ? trx.items : [];

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
        maxWidth: `${layout.printableWidthMm}mm`,
      }
    : undefined;

  return (
    <div
      className={rootClass}
      data-nota={trx.noNota || ''}
      data-paper-mm={layout.paperWidthMm}
      style={style}
    >
      {logo && (
        <div className="receipt-logo text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logo}
            alt="logo"
            className="receipt-logo-img"
          />
        </div>
      )}
      {company && <div className="text-center bold receipt-line">{company}</div>}
      {address && <div className="text-center receipt-line receipt-wrap">{address}</div>}
      {phone && <div className="text-center receipt-line">Telp: {phone}</div>}
      {npwp && <div className="text-center receipt-line">NPWP: {npwp}</div>}
      <div className="double-line" />
      <div className="receipt-line">Tgl  : {formatDateTime(trx.tanggal)}</div>
      <div className="receipt-line receipt-wrap">Nota : {trx.noNota}</div>
      <div className="receipt-line">Kasir: {trx.kasirName}</div>
      {trx.lokasi && <div className="receipt-line">Lok  : {trx.lokasi}</div>}
      <div className="receipt-line">
        Mode : {trx.paymentMethod}
        {trx.edcBank ? ` (${trx.edcBank})` : ''}
      </div>
      {trx.pelangganName && (
        <div className="receipt-line receipt-wrap">Pelg : {trx.pelangganName}</div>
      )}
      {trx.memberName && <div className="receipt-line">Mbr  : {trx.memberName}</div>}
      <div className="line" />
      <table className="receipt-items">
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={3} className="text-center">
                — tidak ada item —
              </td>
            </tr>
          )}
          {items.map((it, i) => (
            <tr key={it.stokId || it.kode || i}>
              <td colSpan={3}>
                <div className="receipt-wrap">{it.nama}</div>
                <div className="receipt-item-row">
                  <span>
                    &nbsp;&nbsp;{it.qty} {it.satuan || 'PCS'} x {formatIDR(it.harga)}
                  </span>
                  <span className="text-right">
                    {formatIDR(it.jumlah ?? it.harga * it.qty - (it.diskon || 0))}
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
            <td className="text-right">{formatIDR(trx.subTotal)}</td>
          </tr>
          {(trx.diskonNota || 0) > 0 && (
            <tr>
              <td>Diskon</td>
              <td className="text-right">-{formatIDR(trx.diskonNota)}</td>
            </tr>
          )}
          {(trx.poinDiscount || 0) > 0 && (
            <tr>
              <td>Tukar Poin ({trx.poinDigunakan})</td>
              <td className="text-right">-{formatIDR(trx.poinDiscount)}</td>
            </tr>
          )}
          {(trx.ppn || 0) > 0 && (
            <tr>
              <td>PPN</td>
              <td className="text-right">{formatIDR(trx.ppn)}</td>
            </tr>
          )}
          <tr className="bold">
            <td>TOTAL</td>
            <td className="text-right">{formatIDR(trx.total)}</td>
          </tr>
          {trx.mode === 'KREDIT' ? (
            <>
              <tr>
                <td>Status</td>
                <td className="text-right bold">HUTANG</td>
              </tr>
              {trx.jatuhTempo && (
                <tr>
                  <td>Jatuh Tempo</td>
                  <td className="text-right">
                    {new Date(trx.jatuhTempo).toLocaleDateString('id-ID')}
                  </td>
                </tr>
              )}
            </>
          ) : (
            <>
              <tr>
                <td>Bayar</td>
                <td className="text-right">{formatIDR(trx.bayar)}</td>
              </tr>
              <tr>
                <td>Kembali</td>
                <td className="text-right">{formatIDR(trx.kembali)}</td>
              </tr>
            </>
          )}
          {(trx.poinDidapat || 0) > 0 && (
            <tr>
              <td>Poin Didapat</td>
              <td className="text-right">+{trx.poinDidapat}</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="double-line" />
      <div className="text-center receipt-line">&lt;&lt; {footer} &gt;&gt;</div>
      <div className="text-center receipt-line receipt-small">
        Barang yang sudah dibeli
      </div>
      <div className="text-center receipt-line receipt-small">
        tidak dapat ditukar/dikembalikan
      </div>
      <div className="receipt-feed" aria-hidden="true" />
    </div>
  );
}
