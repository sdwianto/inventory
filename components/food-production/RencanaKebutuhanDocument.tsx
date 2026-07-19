'use client';

import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import type { RencanaKebutuhanLine } from '@/lib/food-production/rencana-kebutuhan';

export const RENCANA_KEBUTUHAN_PRINT_ID = 'rencana-kebutuhan-a4-print';

type Props = {
  tanggal: string;
  kitchenLabel?: string;
  planNos?: string[];
  lines: RencanaKebutuhanLine[];
  tenantName?: string;
  printId?: string;
  className?: string;
};

/** Draft dokumen kebutuhan bahan harian — pola Acuan Pengadaan (preview + cetak A4). */
export default function RencanaKebutuhanDocument({
  tanggal,
  kitchenLabel,
  planNos = [],
  lines,
  tenantName,
  printId,
  className = '',
}: Props) {
  const dateLabel = tanggal
    ? formatDate(`${tanggal}T12:00:00`)
    : '—';
  const skuCount = lines.length;
  const planCount = planNos.length;

  return (
    <article
      id={printId || undefined}
      className={`vendor-invoice-document rencana-kebutuhan-document bg-white text-slate-900 mx-auto ${className}`}
      style={{ maxWidth: '210mm', minHeight: '297mm' }}
    >
      <div className="vendor-invoice-sheet p-6 sm:p-8">
        <header className="vendor-invoice-header flex flex-wrap gap-3 justify-between items-start border-b-2 border-orange-500 pb-3 mb-3">
          <div className="min-w-0">
            <div className="text-lg font-bold leading-tight">
              {kitchenLabel || tenantName || 'Food Production'}
            </div>
            <div className="text-sm text-slate-600 mt-0.5">
              Tanggal masak: {dateLabel}
            </div>
            {planNos.length > 0 && (
              <div className="text-xs text-slate-500 mt-1 font-mono">
                {planNos.join(' · ')}
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <h1 className="text-xl font-bold text-orange-600 tracking-wide">
              RENCANA KEBUTUHAN
            </h1>
            {tenantName && (
              <div className="text-xs text-slate-600 mt-1">Tenant: {tenantName}</div>
            )}
            <div className="text-xs text-slate-500 mt-0.5">
              Dicetak: {formatDateTime(new Date().toISOString())}
            </div>
          </div>
        </header>

        <p className="text-sm mb-3">
          Ringkasan:{' '}
          <strong>
            {planCount} RPN · {skuCount} SKU dibutuhkan
          </strong>
        </p>

        <h2 className="text-sm font-bold text-orange-600 mb-1">
          RINGKASAN KEBUTUHAN BARANG
        </h2>
        <p className="text-xs text-slate-600 mb-3">
          Daftar bahan yang perlu dipenuhi dari gudang untuk produksi pada tanggal ini —
          acuan pengadaan / pengambilan stok.
        </p>

        <table className="w-full text-xs border-collapse mb-4 table-fixed">
          <colgroup>
            <col style={{ width: '5%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '48%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '15%' }} />
          </colgroup>
          <thead>
            <tr className="bg-orange-500 text-white">
              <th className="border border-orange-600 px-1.5 py-1.5 text-center">No</th>
              <th className="border border-orange-600 px-1.5 py-1.5 text-left">Kode</th>
              <th className="border border-orange-600 px-1.5 py-1.5 text-left">Nama Barang</th>
              <th className="border border-orange-600 px-1.5 py-1.5 text-right">Qty</th>
              <th className="border border-orange-600 px-1.5 py-1.5 text-center">Sat</th>
              <th className="border border-orange-600 px-1.5 py-1.5 text-left">No RPN</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="border border-slate-200 px-2 py-4 text-center text-slate-500">
                  Belum ada kebutuhan bahan yang bisa dihitung dari rencana hari ini.
                </td>
              </tr>
            )}
            {lines.map((line, i) => {
              const rpn = [...new Set(line.sources.map((s) => s.planNo).filter(Boolean))].join(', ') || '—';
              return (
                <tr key={line.productId} className={i % 2 ? 'bg-slate-50' : ''}>
                  <td className="border border-slate-200 px-1.5 py-1.5 text-center">{i + 1}</td>
                  <td className="border border-slate-200 px-1.5 py-1.5 font-mono truncate">
                    {line.productKode || '—'}
                  </td>
                  <td className="border border-slate-200 px-1.5 py-1.5 break-words">
                    {line.productNama || line.productId}
                  </td>
                  <td className="border border-slate-200 px-1.5 py-1.5 text-right font-semibold text-orange-700 tabular-nums whitespace-nowrap">
                    {formatNumber(line.qty)}
                  </td>
                  <td className="border border-slate-200 px-1.5 py-1.5 text-center whitespace-nowrap">
                    {line.satuan || '—'}
                  </td>
                  <td className="border border-slate-200 px-1.5 py-1.5 font-mono text-[10px] break-words">
                    {rpn}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </article>
  );
}
