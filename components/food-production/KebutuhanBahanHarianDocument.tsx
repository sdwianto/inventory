'use client';

import { formatDate, formatDateTime } from '@/lib/format';
import {
  cookDateFromPlanTanggal,
  RECIPE_NEED_BUFFER_PCT,
} from '@/lib/food-production/production-plan';
import type { KebutuhanBahanRekapLine } from '@/lib/food-production/kebutuhan-bahan-harian';
import { KebutuhanBahanRekapTable } from '@/components/food-production/MenuHarianDocument';

export const KEBUTUHAN_BAHAN_HARIAN_PRINT_ID = 'kebutuhan-bahan-harian-a4-print';

type Props = {
  tanggal: string;
  kitchenNama?: string;
  tenantName?: string;
  planNos?: string[];
  rekap: KebutuhanBahanRekapLine[];
  printId?: string;
  className?: string;
};

/** Lembar gudang opsional — rekap SKU saja, tanpa hidangan. Tidak mengganti RencanaKebutuhanDocument. */
export default function KebutuhanBahanHarianDocument({
  tanggal,
  kitchenNama,
  tenantName,
  planNos = [],
  rekap,
  printId,
  className = '',
}: Props) {
  const menuLabel = tanggal ? formatDate(`${tanggal}T12:00:00`) : '—';
  const cookIso = tanggal ? cookDateFromPlanTanggal(tanggal) : '';
  const cookLabel = cookIso ? formatDate(`${cookIso}T12:00:00`) : '—';

  return (
    <article
      id={printId || undefined}
      className={`vendor-invoice-document kebutuhan-bahan-harian-document bg-white text-slate-900 mx-auto ${className}`}
      style={{ maxWidth: '210mm', minHeight: '297mm' }}
    >
      <div className="vendor-invoice-sheet p-6 sm:p-8">
        <header className="vendor-invoice-header flex flex-wrap gap-3 justify-between items-start border-b-2 border-orange-500 pb-3 mb-3">
          <div className="min-w-0">
            <div className="text-lg font-bold leading-tight">
              {kitchenNama || tenantName || 'Food Production'}
            </div>
            <div className="text-sm text-slate-600 mt-0.5">
              Tanggal masak: {cookLabel}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Menu / distribusi pagi: {menuLabel}
            </div>
            {planNos.length > 0 && (
              <div className="text-xs text-slate-500 mt-1 font-mono">
                {planNos.join(' · ')}
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <h1 className="text-xl font-bold text-orange-600 tracking-wide">
              KEBUTUHAN BAHAN
            </h1>
            <div className="text-xs text-slate-500 mt-0.5">
              Buffer {RECIPE_NEED_BUFFER_PCT}% · termasuk alergi
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Dicetak: {formatDateTime(new Date().toISOString())}
            </div>
          </div>
        </header>

        <p className="text-sm mb-3">
          Ringkasan: <strong>{rekap.length} SKU</strong> untuk pengambilan gudang.
        </p>

        <KebutuhanBahanRekapTable rekap={rekap} />
      </div>
    </article>
  );
}
