'use client';

import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import {
  cookDateFromPlanTanggal,
  KATEGORI_PORSI_OPTIONS,
  PLAN_STATUS_LABELS,
  RECIPE_NEED_BUFFER_PCT,
  type ProductionPlanStatus,
} from '@/lib/food-production/production-plan';
import { KATEGORI_MENU_OPTIONS } from '@/lib/food-production/recipe';
import { recipeYieldOneWarning } from '@/lib/food-production/rencana-kebutuhan';
import {
  sumAllPorsi,
  sumPosyanduPorsi,
  sumSekolahPorsi,
  type PortionTargetMap,
} from '@/lib/food-production/portion-target';
import type {
  KebutuhanBahanHidangan,
  KebutuhanBahanRekapLine,
} from '@/lib/food-production/kebutuhan-bahan-harian';

export const MENU_HARIAN_PRINT_ID = 'menu-harian-acuan-kerja-a4-print';

export type MenuHarianDocumentProps = {
  tanggal: string;
  kitchenNama?: string;
  tenantName?: string;
  porsiByKategori: PortionTargetMap;
  hidangan: KebutuhanBahanHidangan[];
  rekap: KebutuhanBahanRekapLine[];
  note?: string;
  productionPlanNo?: string;
  productionPlanStatus?: ProductionPlanStatus | string;
  draftWatermark?: boolean;
  errors?: string[];
  /** Isi semua slot kategori menu (papan minggu). RPN tanpa slot: false. */
  fillEmptySlots?: boolean;
  printId?: string;
  className?: string;
};

/** PDF acuan kerja dapur — halaman menu + total bahan baku (Fase 2). */
export default function MenuHarianDocument({
  tanggal,
  kitchenNama,
  tenantName,
  porsiByKategori,
  hidangan,
  rekap,
  note,
  productionPlanNo,
  productionPlanStatus,
  draftWatermark,
  errors = [],
  fillEmptySlots = false,
  printId,
  className = '',
}: MenuHarianDocumentProps) {
  const menuLabel = tanggal ? formatDate(`${tanggal}T12:00:00`) : '—';
  const cookIso = tanggal ? cookDateFromPlanTanggal(tanggal) : '';
  const cookLabel = cookIso ? formatDate(`${cookIso}T12:00:00`) : '—';
  const total = sumAllPorsi(porsiByKategori);
  const statusLabel = productionPlanStatus
    ? (PLAN_STATUS_LABELS[productionPlanStatus as ProductionPlanStatus] || productionPlanStatus)
    : (productionPlanNo ? 'Terbit' : 'Draft');
  const slotRows = hidangan.filter((h) => !h.isAlergi);
  const alergiRows = hidangan.filter((h) => h.isAlergi);

  return (
    <article
      id={printId || undefined}
      className={`vendor-invoice-document menu-harian-document bg-white text-slate-900 mx-auto relative ${className}`}
      style={{ maxWidth: '210mm', minHeight: '297mm' }}
    >
      {draftWatermark ? (
        <div
          className="acuan-kerja-watermark pointer-events-none absolute inset-0 flex items-center justify-center z-30"
          aria-hidden
        >
          <span
            className="text-7xl font-black tracking-widest text-orange-400/25 select-none"
            style={{ transform: 'rotate(-28deg)' }}
          >
            DRAFT
          </span>
        </div>
      ) : null}

      <div className="vendor-invoice-sheet p-6 sm:p-8 relative z-20">
        <header className="vendor-invoice-header flex flex-wrap gap-3 justify-between items-start border-b-2 border-orange-500 pb-3 mb-3">
          <div className="min-w-0">
            <div className="text-lg font-bold leading-tight">
              {kitchenNama || tenantName || 'Food Production'}
            </div>
            <div className="text-sm text-slate-600 mt-0.5">
              Tanggal menu / distribusi: {menuLabel}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Tanggal masak (H−1): {cookLabel}
            </div>
            <div className="text-xs text-slate-500 mt-1 font-mono">
              {productionPlanNo
                ? `RPN ${productionPlanNo} · ${statusLabel}`
                : `Belum terbit · ${statusLabel}`}
            </div>
          </div>
          <div className="text-right shrink-0">
            <h1 className="text-xl font-bold text-orange-600 tracking-wide">
              ACUAN KERJA DAPUR
            </h1>
            {tenantName ? (
              <div className="text-xs text-slate-600 mt-1">Tenant: {tenantName}</div>
            ) : null}
            <div className="text-xs text-slate-500 mt-0.5">
              Dicetak: {formatDateTime(new Date().toISOString())}
            </div>
          </div>
        </header>

        <p className="text-sm mb-3">
          Penerima manfaat:{' '}
          <strong>{total.toLocaleString('id-ID')} porsi</strong>
          {' · '}Sekolah {sumSekolahPorsi(porsiByKategori).toLocaleString('id-ID')}
          {' · '}Posyandu {sumPosyanduPorsi(porsiByKategori).toLocaleString('id-ID')}
        </p>

        <table className="w-full text-xs border-collapse mb-4">
          <thead>
            <tr className="bg-orange-500 text-white">
              <th className="border border-orange-600 px-1.5 py-1.5 text-left">Kategori</th>
              <th className="border border-orange-600 px-1.5 py-1.5 text-right">Porsi</th>
            </tr>
          </thead>
          <tbody>
            {KATEGORI_PORSI_OPTIONS.map((opt) => (
              <tr key={opt.value}>
                <td className="border border-slate-200 px-1.5 py-1">
                  {opt.label}
                  <span className="text-slate-500"> — {opt.hint}</span>
                </td>
                <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums font-semibold">
                  {(Number(porsiByKategori[opt.value]) || 0).toLocaleString('id-ID')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="text-sm font-bold text-orange-600 mb-1">HIDANGAN</h2>
        <table className="w-full text-xs border-collapse mb-4">
          <thead>
            <tr className="bg-orange-500 text-white">
              <th className="border border-orange-600 px-1.5 py-1.5 text-left">Slot</th>
              <th className="border border-orange-600 px-1.5 py-1.5 text-left">Resep</th>
              <th className="border border-orange-600 px-1.5 py-1.5 text-right">Porsi</th>
            </tr>
          </thead>
          <tbody>
            {fillEmptySlots
              ? KATEGORI_MENU_OPTIONS.map((opt) => {
                const rows = slotRows.filter((h) => h.slot === opt.value);
                if (!rows.length) {
                  return (
                    <tr key={`empty-${opt.value}`}>
                      <td className="border border-slate-200 px-1.5 py-1 whitespace-nowrap">{opt.label}</td>
                      <td className="border border-slate-200 px-1.5 py-1 text-slate-400">—</td>
                      <td className="border border-slate-200 px-1.5 py-1 text-right text-slate-400">—</td>
                    </tr>
                  );
                }
                return rows.map((row, i) => (
                  <tr key={`slot-${opt.value}-${row.recipeId}-${i}`}>
                    <td className="border border-slate-200 px-1.5 py-1 whitespace-nowrap">{opt.label}</td>
                    <td className="border border-slate-200 px-1.5 py-1">
                      {[row.recipeKode, row.recipeNama].filter(Boolean).join(' · ') || row.recipeId}
                    </td>
                    <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums">
                      {row.targetPorsi.toLocaleString('id-ID')}
                    </td>
                  </tr>
                ));
              })
              : (
                <>
                  {slotRows.length === 0 && (
                    <tr>
                      <td colSpan={3} className="border border-slate-200 px-2 py-3 text-center text-slate-500">
                        Belum ada resep di slot hari ini.
                      </td>
                    </tr>
                  )}
                  {slotRows.map((row, i) => (
                    <tr key={`slot-${row.recipeId}-${row.slotLabel}-${i}`}>
                      <td className="border border-slate-200 px-1.5 py-1 whitespace-nowrap">{row.slotLabel}</td>
                      <td className="border border-slate-200 px-1.5 py-1">
                        {[row.recipeKode, row.recipeNama].filter(Boolean).join(' · ') || row.recipeId}
                      </td>
                      <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums">
                        {row.targetPorsi.toLocaleString('id-ID')}
                      </td>
                    </tr>
                  ))}
                </>
              )}
          </tbody>
        </table>

        {note ? (
          <p className="text-xs text-slate-700 mb-3 border rounded px-2 py-1.5">
            Catatan: {note}
          </p>
        ) : null}

        <h2 className="text-sm font-bold text-orange-600 mb-1">ALERGI (porsi ekstra)</h2>
        {alergiRows.length ? (
          <table className="w-full text-xs border-collapse mb-4">
            <thead>
              <tr className="bg-orange-500 text-white">
                <th className="border border-orange-600 px-1.5 py-1.5 text-left">Resep pengganti</th>
                <th className="border border-orange-600 px-1.5 py-1.5 text-right">Porsi</th>
                <th className="border border-orange-600 px-1.5 py-1.5 text-left">Catatan</th>
              </tr>
            </thead>
            <tbody>
              {alergiRows.map((row, i) => (
                <tr key={`al-${row.recipeId}-${i}`}>
                  <td className="border border-slate-200 px-1.5 py-1">
                    {[row.recipeKode, row.recipeNama].filter(Boolean).join(' · ') || row.recipeId}
                  </td>
                  <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums">
                    {row.targetPorsi.toLocaleString('id-ID')}
                  </td>
                  <td className="border border-slate-200 px-1.5 py-1">
                    {row.notes?.replace(/^ALERGI:\s*/i, '') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-slate-500 mb-4">Tidak ada resep alergi hari ini.</p>
        )}

        <section
          className="acuan-kerja-bahan"
          style={{ breakBefore: 'page', pageBreakBefore: 'always' }}
        >
          <h2 className="text-sm font-bold text-orange-600 mb-1">KEBUTUHAN BAHAN PER HIDANGAN</h2>
          <p className="text-xs text-slate-600 mb-3">
            Qty dari BOM resep master × porsi hari ini, buffer {RECIPE_NEED_BUFFER_PCT}%.
            Alergi dihitung sebagai porsi ekstra (tidak mengurangi PM).
          </p>

          {hidangan.map((dish, i) => {
            const yieldWarn = recipeYieldOneWarning(dish.yieldQty || 1, dish.targetPorsi);
            return (
            <div key={`bom-${dish.slot || dish.slotLabel}-${dish.recipeId}-${i}`} className="mb-3">
              <p className="text-xs font-semibold">
                {dish.slotLabel}
                {' · '}
                {[dish.recipeKode, dish.recipeNama].filter(Boolean).join(' · ') || dish.recipeId}
                {' · '}
                {dish.targetPorsi.toLocaleString('id-ID')} porsi
                {dish.isAlergi ? ' (alergi)' : ''}
              </p>
              {yieldWarn ? (
                <p className="text-[10px] text-amber-800">{yieldWarn}</p>
              ) : null}
              {dish.error ? (
                <p className="text-[11px] text-amber-800">{dish.error}</p>
              ) : (
                <table className="w-full text-[11px] border-collapse mt-1">
                  <thead>
                    <tr className="bg-slate-100">
                      <th className="border border-slate-200 px-1.5 py-1 text-left">Bahan</th>
                      <th className="border border-slate-200 px-1.5 py-1 text-right">Besar</th>
                      <th className="border border-slate-200 px-1.5 py-1 text-right">Kecil</th>
                      <th className="border border-slate-200 px-1.5 py-1 text-right">Total</th>
                      <th className="border border-slate-200 px-1.5 py-1 text-center">Sat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dish.lines.length === 0 && (
                      <tr>
                        <td colSpan={5} className="border border-slate-200 px-1.5 py-1 text-slate-500">
                          Tidak ada baris bahan.
                        </td>
                      </tr>
                    )}
                    {dish.lines.map((line) => (
                      <tr key={`${dish.recipeId}-${line.productId}-${line.satuan || ''}`}>
                        <td className="border border-slate-200 px-1.5 py-1">
                          {line.productNama || line.productKode || line.productId}
                        </td>
                        <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums whitespace-nowrap">
                          {(Number(line.qtyBesarPart) || 0) > 0 ? formatNumber(line.qtyBesarPart) : '—'}
                        </td>
                        <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums whitespace-nowrap">
                          {(Number(line.qtyKecilPart) || 0) > 0 ? formatNumber(line.qtyKecilPart) : '—'}
                        </td>
                        <td className="border border-slate-200 px-1.5 py-1 text-right tabular-nums font-semibold whitespace-nowrap">
                          {formatNumber(line.qty)}
                        </td>
                        <td className="border border-slate-200 px-1.5 py-1 text-center">
                          {line.satuan || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            );
          })}

          <h2 className="text-sm font-bold text-orange-600 mb-1 mt-4">REKAP TOTAL BAHAN (gudang)</h2>
          <p className="text-xs text-slate-600 mb-2">
            Jumlah semua hidangan + alergi, termasuk buffer {RECIPE_NEED_BUFFER_PCT}%.
          </p>
          <KebutuhanBahanRekapTable rekap={rekap} />

          {errors.length ? (
            <p className="text-[11px] text-amber-800 mt-3">{errors[0]}</p>
          ) : null}

          <footer className="mt-6 pt-3 border-t border-slate-200 text-[10px] text-slate-500">
            Acuan masak SPPG — satu lembar untuk tim dapur (hidangan, porsi, dan total bahan yang diambil).
          </footer>
        </section>
      </div>
    </article>
  );
}

export function KebutuhanBahanRekapTable({ rekap }: { rekap: KebutuhanBahanRekapLine[] }) {
  return (
    <table className="w-full text-xs border-collapse">
      <colgroup>
        <col style={{ width: '6%' }} />
        <col style={{ width: '16%' }} />
        <col style={{ width: '48%' }} />
        <col style={{ width: '14%' }} />
        <col style={{ width: '16%' }} />
      </colgroup>
      <thead>
        <tr className="bg-orange-500 text-white">
          <th className="border border-orange-600 px-1.5 py-1.5 text-center">No</th>
          <th className="border border-orange-600 px-1.5 py-1.5 text-left">Kode</th>
          <th className="border border-orange-600 px-1.5 py-1.5 text-left">Nama bahan</th>
          <th className="border border-orange-600 px-1.5 py-1.5 text-right">Qty</th>
          <th className="border border-orange-600 px-1.5 py-1.5 text-center">Sat</th>
        </tr>
      </thead>
      <tbody>
        {rekap.length === 0 && (
          <tr>
            <td colSpan={5} className="border border-slate-200 px-2 py-4 text-center text-slate-500">
              Belum ada kebutuhan bahan yang bisa dihitung.
            </td>
          </tr>
        )}
        {rekap.map((line, i) => (
          <tr key={`${line.productId}-${line.satuan || i}`} className={i % 2 ? 'bg-slate-50' : ''}>
            <td className="border border-slate-200 px-1.5 py-1.5 text-center">{i + 1}</td>
            <td className="border border-slate-200 px-1.5 py-1.5 font-mono truncate">
              {line.productKode || '—'}
            </td>
            <td className="border border-slate-200 px-1.5 py-1.5">
              {line.productNama || line.productId}
            </td>
            <td className="border border-slate-200 px-1.5 py-1.5 text-right font-semibold text-orange-700 tabular-nums">
              {formatNumber(line.qty)}
            </td>
            <td className="border border-slate-200 px-1.5 py-1.5 text-center">{line.satuan || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
