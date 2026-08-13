'use client';

import type { JsonObject } from '@/types/json';
import { num, str } from '@/types/json';
import { useMemo } from 'react';
import { formatDate, formatIDR, formatNumber } from '@/lib/format';
import {
  buildHutangPrintItemRows,
  type HutangPrintItemRow,
} from '@/lib/hutang-print-items';

export interface HutangVendorPrintDocumentProps {
  rows: JsonObject[];
  settings?: JsonObject | null;
  title?: string;
  subtitle?: string;
  showVendorColumn?: boolean;
  className?: string;
  printId?: string;
}

/** Tanggal ringkas dd/mm/yy — hemat kolom Minta/Aktual. */
function shortDate(raw?: string): string {
  if (!raw) return '—';
  const full = formatDate(raw);
  const m = full.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return full;
  return `${m[1]}/${m[2]}/${m[3].slice(2)}`;
}

/** Dokumen cetak tagihan — detail item seperti Acuan Pengadaan (sales). */
export default function HutangVendorPrintDocument({
  rows,
  settings,
  title = 'DAFTAR TAGIHAN VENDOR',
  subtitle,
  showVendorColumn = true,
  className = '',
  printId = 'hutang-vendor-print',
}: HutangVendorPrintDocumentProps) {
  const company = str(settings?.companyName, 'Perusahaan');
  const logo = str(settings?.logoBase64 || settings?.logoUrl);
  const detailRows = useMemo(() => buildHutangPrintItemRows(rows), [rows]);
  const totalNilai = rows.reduce((s, r) => s + num(r.total), 0);
  const skuCount = new Set(detailRows.map((r) => r.kode).filter((k) => k && k !== '—')).size;
  const vendorCount = new Set(detailRows.map((r) => r.vendor).filter((v) => v && v !== '—')).size;

  if (!rows.length) {
    return (
      <article
        id={printId}
        className={`hutang-vendor-print bg-white text-slate-900 mx-auto p-8 ${className}`}
        style={{ maxWidth: 'none', width: '100%' }}
      >
        <p className="text-center text-slate-500 py-12">Tidak ada tagihan untuk filter ini.</p>
      </article>
    );
  }

  return (
    <article
      id={printId}
      className={`hutang-vendor-print bg-white text-slate-900 mx-auto ${className}`}
      style={{ maxWidth: 'none', width: '100%' }}
    >
      <header className="flex justify-between gap-4 border-b-2 border-orange-500 pb-4 mb-4">
        <div className="flex gap-3 min-w-0">
          {logo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" className="w-16 h-16 object-contain shrink-0" />
          )}
          <div className="min-w-0 text-sm">
            <div className="font-bold text-base">{company}</div>
            {str(settings?.companyAddress) && (
              <div className="text-slate-600 text-xs mt-0.5">{str(settings?.companyAddress)}</div>
            )}
            {str(settings?.companyPhone) && (
              <div className="text-slate-500 text-xs">Telp: {str(settings?.companyPhone)}</div>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <h1 className="text-lg font-bold text-orange-600 leading-tight">{title}</h1>
          {subtitle && <div className="text-xs text-slate-600 mt-1">{subtitle}</div>}
          <div className="text-xs text-slate-500 mt-1">Dicetak: {new Date().toLocaleString('id-ID')}</div>
        </div>
      </header>

      <p className="text-xs text-slate-600 mb-4">
        Ringkasan: <strong>{rows.length} invoice</strong>
        {' '}· <strong>{detailRows.length} baris barang</strong>
        {' '}· <strong>{skuCount} SKU</strong>
        {showVendorColumn ? <> · <strong>{vendorCount} vendor</strong></> : null}
        {' '}· Total <strong className="text-orange-700">{formatIDR(totalNilai)}</strong>
      </p>

      <section>
        <h2 className="text-sm font-bold text-orange-700 border-b-2 border-orange-400 pb-1 mb-2">
          RINGKASAN KEBUTUHAN BARANG
        </h2>
        <p className="text-[11px] text-slate-500 mb-3">
          Daftar barang per invoice vendor beserta tanggal permintaan kirim (PO) dan tanggal aktual kirim —
          format selaras acuan pengadaan supplier.
        </p>
        <ItemTable rows={detailRows} showVendorColumn={showVendorColumn} />
      </section>

      <footer className="text-center text-[10px] text-slate-400 border-t pt-3 mt-6">
        Dokumen tagihan vendor — {company} — {new Date().toLocaleString('id-ID')}
      </footer>
    </article>
  );
}

function ItemTable({
  rows,
  showVendorColumn,
}: {
  rows: HutangPrintItemRow[];
  showVendorColumn: boolean;
}) {
  return (
    <table className="w-full text-[11px] border-collapse table-fixed leading-snug">
      <colgroup>
        <col style={{ width: '22px' }} />
        <col style={{ width: '58px' }} />
        <col />
        <col style={{ width: '28px' }} />
        <col style={{ width: '32px' }} />
        <col style={{ width: '52px' }} />
        <col style={{ width: '52px' }} />
        {showVendorColumn && <col style={{ width: '72px' }} />}
        <col style={{ width: '86px' }} />
        <col style={{ width: '78px' }} />
        <col style={{ width: '78px' }} />
        <col style={{ width: '78px' }} />
      </colgroup>
      <thead>
        <tr className="bg-orange-500 text-white">
          <th className="border border-orange-600 px-0.5 py-1 text-center font-semibold">No</th>
          <th className="border border-orange-600 px-0.5 py-1 text-left font-semibold">Kode</th>
          <th className="border border-orange-600 px-1 py-1 text-left font-semibold">Nama Barang</th>
          <th className="border border-orange-600 px-0.5 py-1 text-center font-semibold">Sat</th>
          <th className="border border-orange-600 px-0.5 py-1 text-right font-semibold">Qty</th>
          <th className="border border-orange-600 px-0.5 py-1 text-center font-semibold" title="Tanggal minta kirim (PO)">Minta</th>
          <th className="border border-orange-600 px-0.5 py-1 text-center font-semibold" title="Tanggal aktual kirim">Aktual</th>
          {showVendorColumn && (
            <th className="border border-orange-600 px-0.5 py-1 text-left font-semibold">Vendor</th>
          )}
          <th className="border border-orange-600 px-0.5 py-1 text-left font-semibold">Invoice</th>
          <th className="border border-orange-600 px-0.5 py-1 text-left font-semibold">SO</th>
          <th className="border border-orange-600 px-0.5 py-1 text-left font-semibold">PO</th>
          <th className="border border-orange-600 px-0.5 py-1 text-left font-semibold">DO</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.key} className={i % 2 ? 'bg-slate-50' : ''}>
            <td className="border border-slate-200 px-0.5 py-1 text-center text-slate-600">{i + 1}</td>
            <td className="border border-slate-200 px-0.5 py-1 font-mono text-[10px] truncate" title={row.kode}>
              {row.kode}
            </td>
            <td className="border border-slate-200 px-1 py-1 break-words font-medium text-[12px]" title={row.nama}>
              {row.nama}
            </td>
            <td className="border border-slate-200 px-0.5 py-1 text-center uppercase truncate text-[10px]" title={row.satuan}>
              {row.satuan}
            </td>
            <td className="border border-slate-200 px-0.5 py-1 text-right font-bold text-orange-700 tabular-nums text-[11px]">
              {formatNumber(row.qty)}
            </td>
            <td className="border border-slate-200 px-0.5 py-1 text-center font-semibold text-orange-800 whitespace-nowrap text-[10px]">
              {shortDate(row.tanggalPermintaanKirim)}
            </td>
            <td className="border border-slate-200 px-0.5 py-1 text-center whitespace-nowrap text-[10px]">
              {shortDate(row.tanggalAktualKirim)}
            </td>
            {showVendorColumn && (
              <td
                className="border border-slate-200 px-0.5 py-1 text-[10px] font-medium text-orange-800 truncate"
                title={row.vendor}
              >
                {row.vendor}
              </td>
            )}
            <td className="border border-slate-200 px-0.5 py-1 font-mono text-[10px] truncate" title={row.noInvoice}>
              {row.noInvoice || '—'}
            </td>
            <td className="border border-slate-200 px-0.5 py-1 font-mono text-[10px] truncate" title={row.noSO}>
              {row.noSO || '—'}
            </td>
            <td className="border border-slate-200 px-0.5 py-1 font-mono text-[10px] truncate" title={row.noPO}>
              {row.noPO || '—'}
            </td>
            <td className="border border-slate-200 px-0.5 py-1 font-mono text-[10px] truncate" title={row.noDO}>
              {row.noDO || '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
