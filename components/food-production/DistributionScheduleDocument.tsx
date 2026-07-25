'use client';

import { formatDate, formatDateTime } from '@/lib/format';
import {
  DIST_STATUS_LABELS,
  loadingLabel,
  resolveDistLoadings,
  type DistributionArmada,
  type DistributionLoading,
  type DistributionStatus,
} from '@/lib/food-production/distribution';
import {
  KATEGORI_PORSI_OPTIONS,
  KATEGORI_PORSI_SHORT,
  type ServicePointPorsiByKategori,
} from '@/lib/food-production/service-point';

export const DIST_SCHEDULE_PRINT_ID = 'distribution-schedule-a4-print';

export type DistSchedulePrintDoc = {
  noDokumen?: string;
  tanggal: string;
  sourceType: 'PLAN' | 'RESULT';
  productionPlanNo?: string;
  productionResultNo?: string;
  kitchenNama?: string;
  status: DistributionStatus;
  catatan?: string;
  loadings?: DistributionLoading[] | null;
  armadas?: DistributionArmada[] | null;
  summary?: {
    qtyPorsiTotal?: number;
    servicePointCount?: number;
    armadaCount?: number;
    loadingCount?: number;
  };
};

type Props = {
  doc: DistSchedulePrintDoc;
  tenantName?: string;
  printId?: string;
  className?: string;
};

function formatKategoriShort(map: ServicePointPorsiByKategori | undefined): string {
  if (!map) return '—';
  const parts = KATEGORI_PORSI_OPTIONS
    .map((o) => {
      const n = Number(map[o.value]) || 0;
      if (!(n > 0)) return null;
      const short = KATEGORI_PORSI_SHORT[o.value] || o.label;
      return `${short}:${n.toLocaleString('id-ID')}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}

/** Dokumen cetak A4 — jadwal loading / armada / rute titik. */
export default function DistributionScheduleDocument({
  doc,
  tenantName,
  printId,
  className = '',
}: Props) {
  const loadings = resolveDistLoadings(doc);
  const dateLabel = doc.tanggal
    ? formatDate(`${doc.tanggal}T12:00:00`)
    : '—';
  const sourceLabel = doc.sourceType === 'RESULT'
    ? `HSL ${doc.productionResultNo || '—'}`
    : `RPN ${doc.productionPlanNo || '—'}`;
  const totalPorsi = doc.summary?.qtyPorsiTotal
    ?? loadings.reduce((s, L) => s + (Number(L.qtyPorsiTotal) || 0), 0);

  return (
    <article
      id={printId || undefined}
      className={`vendor-invoice-document distribution-schedule-document bg-white text-slate-900 mx-auto ${className}`}
      style={{ maxWidth: '210mm', minHeight: '297mm' }}
    >
      <div className="vendor-invoice-sheet p-6 sm:p-8">
        <header className="vendor-invoice-header flex flex-wrap gap-3 justify-between items-start border-b-2 border-orange-500 pb-3 mb-3">
          <div className="min-w-0">
            <div className="text-lg font-bold leading-tight">
              {doc.kitchenNama || tenantName || 'Food Production'}
            </div>
            <div className="text-sm text-slate-600 mt-0.5">
              Tanggal kirim: {dateLabel}
            </div>
            <div className="text-xs text-slate-500 mt-1 font-mono">
              {doc.noDokumen || 'Draft'} · {sourceLabel}
            </div>
          </div>
          <div className="text-right shrink-0">
            <h1 className="text-xl font-bold text-orange-600 tracking-wide">
              JADWAL PENGIRIMAN
            </h1>
            {tenantName && (
              <div className="text-xs text-slate-600 mt-1">Tenant: {tenantName}</div>
            )}
            <div className="text-xs text-slate-500 mt-0.5">
              Status: {DIST_STATUS_LABELS[doc.status] || doc.status}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Dicetak: {formatDateTime(new Date().toISOString())}
            </div>
          </div>
        </header>

        <p className="text-sm mb-3">
          Ringkasan:{' '}
          <strong>
            {totalPorsi.toLocaleString('id-ID')} porsi
            {' · '}
            {doc.summary?.servicePointCount
              ?? loadings.reduce((s, L) => s + (Number(L.servicePointCount) || 0), 0)}
            {' '}titik
            {' · '}
            {loadings.length} loading
          </strong>
        </p>

        {doc.catatan ? (
          <p className="text-xs text-slate-600 mb-3 border rounded px-2 py-1.5">
            Catatan: {doc.catatan}
          </p>
        ) : null}

        <h2 className="text-sm font-bold text-orange-600 mb-2">
          LOADING · ARMADA · RUTE
        </h2>

        {loadings.length === 0 && (
          <p className="text-sm text-slate-500 py-6 text-center">
            Belum ada gelombang loading / armada pada dokumen ini.
          </p>
        )}

        <div className="space-y-4">
          {loadings.map((L, idx) => {
            const tones = [
              { head: 'bg-sky-600', border: 'border-sky-200' },
              { head: 'bg-amber-600', border: 'border-amber-200' },
              { head: 'bg-emerald-700', border: 'border-emerald-200' },
              { head: 'bg-violet-700', border: 'border-violet-200' },
            ] as const;
            const tone = tones[idx % tones.length];
            return (
            <section key={`print-load-${L.urutan}`} className="break-inside-avoid">
              <div className={`${tone.head} text-white px-2 py-1.5 text-sm font-semibold rounded-t`}>
                {L.label || loadingLabel(L.urutan)}
                <span className="font-normal opacity-90 ml-2">
                  Start {L.jamStart.replace(':', '.')} · Maks {L.jamMax.replace(':', '.')}
                  {' · '}
                  {(L.qtyPorsiTotal || 0).toLocaleString('id-ID')} porsi
                </span>
              </div>
              <div className={`border border-t-0 ${tone.border} rounded-b divide-y`}>
                {(L.armadas || []).map((armada) => (
                  <div key={`${L.urutan}-${armada.armadaId}`} className="p-2.5 space-y-1.5">
                    <div className="flex flex-wrap justify-between gap-2 text-sm font-medium">
                      <span>
                        Armada {armada.armadaNama || armada.armadaKode || armada.armadaId}
                        {armada.platNomor ? (
                          <span className="font-mono text-xs text-slate-500 font-normal ml-1">
                            ({armada.platNomor})
                          </span>
                        ) : null}
                      </span>
                      <span className="tabular-nums">
                        Total: {(armada.qtyPorsiTotal || 0).toLocaleString('id-ID')}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600">
                      {formatKategoriShort(armada.porsiByKategori)}
                    </div>
                    <table className="w-full text-xs border-collapse mt-1">
                      <thead>
                        <tr className="bg-slate-100">
                          <th className="border border-slate-200 px-1.5 py-1 text-center w-8">No</th>
                          <th className="border border-slate-200 px-1.5 py-1 text-left w-16">Jam</th>
                          <th className="border border-slate-200 px-1.5 py-1 text-left">Titik</th>
                          <th className="border border-slate-200 px-1.5 py-1 text-right w-16">Qty</th>
                          <th className="border border-slate-200 px-1.5 py-1 text-left">Kategori</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(armada.stops || []).map((stop, i) => (
                          <tr key={`${armada.armadaId}-${stop.servicePointId}-${i}`}>
                            <td className="border border-slate-200 px-1.5 py-1 text-center">
                              {stop.urutan || i + 1}
                            </td>
                            <td className="border border-slate-200 px-1.5 py-1 font-mono">
                              {(stop.jamKirim || '—:—').replace(':', '.')}
                            </td>
                            <td className="border border-slate-200 px-1.5 py-1">
                              {stop.servicePointNama || stop.servicePointId}
                              {stop.servicePointKode ? (
                                <span className="text-slate-500 font-mono ml-1">
                                  ({stop.servicePointKode})
                                </span>
                              ) : null}
                            </td>
                            <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums font-medium">
                              {(stop.qtyPorsi || 0).toLocaleString('id-ID')}
                            </td>
                            <td className="border border-slate-200 px-1.5 py-1 text-slate-600">
                              {formatKategoriShort(stop.porsiByKategori)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </section>
            );
          })}
        </div>

        <footer className="mt-6 pt-3 border-t border-slate-200 text-[10px] text-slate-500">
          Urutan rute mengikuti jam kirim/drop titik layanan. Dokumen operasional SPPG — cetak ulang bila jadwal berubah.
        </footer>
      </div>
    </article>
  );
}
