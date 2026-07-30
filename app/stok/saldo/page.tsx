'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';

import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatIDR, formatNumber } from '@/lib/format';
import { productStockTitle } from '@/lib/uom/display';
import { Boxes, Search, TrendingUp } from 'lucide-react';
import { WAREHOUSES, warehouseName } from '@/lib/warehouses-client';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { queryKeys } from '@/lib/query-keys';

const StockTrendCharts = dynamic(
  () => import('@/components/StockTrendCharts'),
  { ssr: false, loading: () => <div className="h-64 rounded-lg bg-slate-100 animate-pulse" /> },
);

interface SaldoSummary {
  qtyKering?: number;
  nilaiKering?: number;
  qtyBasah?: number;
  nilaiBasah?: number;
  qtyJanitor?: number;
  nilaiJanitor?: number;
  qtyTotal?: number;
  nilaiTotal?: number;
  skuAktif?: number;
  skuTotal?: number;
}

interface StockRow {
  id: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  gudangKode?: string;
  gudangNama?: string;
  hargaBeli?: number;
  stokQty?: number;
  stokTotal?: number;
  stokGudangKering?: number;
  stokGudangBasah?: number;
  stokGudangJanitor?: number;
  stokDisplay?: string;
  nilaiStok?: number;
  nilaiTotal?: number;
  nilaiGudangKering?: number;
  nilaiGudangBasah?: number;
  nilaiGudangJanitor?: number;
}

function gudangBadgeClass(kode?: string | null): string {
  if (kode === 'GBASAH') return 'bg-blue-50 text-blue-800';
  if (kode === 'GJANITOR') return 'bg-emerald-50 text-emerald-800';
  return 'bg-amber-50 text-amber-800';
}

interface StockTrend {
  periods: unknown[];
  totals: Record<string, unknown>;
}

type GudangFilter = Record<string, boolean>;

interface SummaryCardProps {
  title: string;
  qty: number;
  nilai: number;
  qtyClass?: string;
  nilaiClass?: string;
}

function SummaryCard({
  title,
  qty,
  nilai,
  qtyClass = 'text-slate-800',
  nilaiClass = 'text-slate-600',
}: SummaryCardProps) {
  return (
    <div className="bg-white border rounded-lg p-4">
      <p className="text-xs text-slate-500 uppercase">{title}</p>
      <p className={`text-2xl font-bold ${qtyClass}`}>{formatNumber(qty)}</p>
      <p className={`text-sm font-medium mt-1 ${nilaiClass}`}>{formatIDR(nilai)}</p>
      <p className="text-[10px] text-slate-400 mt-0.5">nilai @ harga beli</p>
    </div>
  );
}

export default function SaldoGudangPage() {
  const [q, setQ] = useState('');
  const [trendMonths, setTrendMonths] = useState('1');
  const [gudangFilter, setGudangFilter] = useState<GudangFilter>(() => (
    Object.fromEntries(WAREHOUSES.map((w) => [w.kode, true]))
  ));

  const rowsUrl = `/api/stok/saldo?part=rows${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const trendUrl = `/api/stok/saldo?part=trend&trendMonths=${trendMonths}`;

  const { data: rowData, isLoading: loadingRows, refetch: refetchRows } = useApiQuery<{
    rows?: StockRow[];
    summary?: SaldoSummary;
  }>(
    queryKeys.stokSaldo.rows({ q }),
    rowsUrl,
    { staleTime: 60_000 },
  );

  const { data: trendData, isLoading: loadingTrend } = useApiQuery<{
    trend?: StockTrend;
  }>(
    queryKeys.stokSaldo.trend(trendMonths),
    trendUrl,
    { staleTime: 120_000 },
  );

  const loading = loadingRows;
  const rows = useMemo(
    () => (Array.isArray(rowData?.rows) ? rowData.rows : []),
    [rowData],
  );
  const summary = rowData?.summary || null;
  const trend = trendData?.trend || { periods: [], totals: {} };

  const load = (query = q, months = trendMonths) => {
    if (query !== q) setQ(query);
    if (months !== trendMonths) setTrendMonths(months);
    void refetchRows();
  };

  const toggleGudang = (kode: string, checked: boolean) => {
    setGudangFilter((prev) => {
      const next = { ...prev, [kode]: checked };
      if (!WAREHOUSES.some((w) => next[w.kode])) return prev;
      return next;
    });
  };

  const stockRows = useMemo(() => {
    const withStock = rows.filter((r) => (r.stokTotal || r.stokQty || 0) > 0);
    return withStock.filter((r) => {
      const g = r.gudangKode || 'GKERING';
      return !!gudangFilter[g];
    });
  }, [rows, gudangFilter]);

  const filteredTotals = useMemo(() => {
    let qty = 0;
    let nilai = 0;
    for (const r of stockRows) {
      qty += parseFloat(String(r.stokQty ?? r.stokTotal ?? 0)) || 0;
      nilai += parseFloat(String(r.nilaiStok ?? r.nilaiTotal ?? 0)) || 0;
    }
    return { qty, nilai, sku: stockRows.length };
  }, [stockRows]);

  const showAllGudang = WAREHOUSES.every((w) => gudangFilter[w.kode]);

  return (
    <div className="p-4 md:p-6 space-y-5">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Boxes className="w-6 h-6" /> Saldo Stok per Gudang
          </h1>
          <p className="text-sm text-slate-500">
            Setiap produk hanya di satu gudang — {warehouseName('GKERING')}, {warehouseName('GBASAH')},
            atau {warehouseName('GJANITOR')} (tidak dicampur).
          </p>
        </div>
        <OperationalScopeBar />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          <SummaryCard
            title="Gudang Kering"
            qty={summary?.qtyKering ?? 0}
            nilai={summary?.nilaiKering ?? 0}
            qtyClass="text-amber-700"
            nilaiClass="text-amber-600"
          />
          <SummaryCard
            title="Gudang Basah"
            qty={summary?.qtyBasah ?? 0}
            nilai={summary?.nilaiBasah ?? 0}
            qtyClass="text-blue-700"
            nilaiClass="text-blue-600"
          />
          <SummaryCard
            title="Gudang Janitor"
            qty={summary?.qtyJanitor ?? 0}
            nilai={summary?.nilaiJanitor ?? 0}
            qtyClass="text-emerald-700"
            nilaiClass="text-emerald-600"
          />
          <SummaryCard
            title="Total Semua Gudang"
            qty={summary?.qtyTotal ?? 0}
            nilai={summary?.nilaiTotal ?? 0}
          />
          <div className="bg-white border rounded-lg p-4">
            <p className="text-xs text-slate-500 uppercase">SKU Aktif</p>
            <p className="text-2xl font-bold text-slate-800">{summary?.skuAktif ?? 0}</p>
            <p className="text-sm text-slate-500 mt-1">dari {summary?.skuTotal ?? 0} produk</p>
          </div>
        </div>

        <div className="bg-white border rounded-xl overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-orange-50/80 to-white">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-orange-100">
                <TrendingUp className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <h2 className="font-semibold text-slate-800">Trend Populasi Stok</h2>
                <p className="text-xs text-slate-500">Area saldo + batang masuk/keluar per gudang (otomatis padat jika data jarang)</p>
              </div>
            </div>
            <Select value={trendMonths} onValueChange={(v) => { setTrendMonths(v); load(q, v); }}>
              <SelectTrigger className="w-40 h-9 bg-white"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">30 hari</SelectItem>
                <SelectItem value="3">3 bulan</SelectItem>
                <SelectItem value="6">6 bulan</SelectItem>
                <SelectItem value="12">12 bulan</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="p-4">
            <StockTrendCharts trend={trend} />
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <h2 className="font-semibold text-slate-800">Detail per Produk</h2>
            <div className="relative max-w-md flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                className="pl-9"
                placeholder="Cari produk..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && load(q, trendMonths)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-slate-50 px-3 py-2">
              <span className="text-xs font-medium text-slate-500 uppercase">Tampilkan gudang</span>
              {WAREHOUSES.map((w) => (
                <label
                  key={w.kode}
                  className="inline-flex items-center gap-2 cursor-pointer select-none"
                >
                  <Checkbox
                    id={`gudang-${w.kode}`}
                    checked={!!gudangFilter[w.kode as keyof GudangFilter]}
                    onCheckedChange={(v) => toggleGudang(w.kode, v === true)}
                    className={
                      w.kode === 'GBASAH'
                        ? 'border-blue-400 data-[state=checked]:bg-blue-600'
                        : w.kode === 'GJANITOR'
                          ? 'border-emerald-400 data-[state=checked]:bg-emerald-600'
                          : 'border-amber-500 data-[state=checked]:bg-amber-600'
                    }
                  />
                  <Label
                    htmlFor={`gudang-${w.kode}`}
                    className={`text-sm font-medium cursor-pointer ${
                      w.kode === 'GBASAH'
                        ? 'text-blue-800'
                        : w.kode === 'GJANITOR'
                          ? 'text-emerald-800'
                          : 'text-amber-800'
                    }`}
                  >
                    {w.nama}
                  </Label>
                </label>
              ))}
            </div>
          </div>
          {!showAllGudang && (
            <p className="text-xs text-slate-500 mb-2">
              Menampilkan: {WAREHOUSES
                .filter((w) => gudangFilter[w.kode])
                .map((w) => w.nama)
                .join(' · ')}
            </p>
          )}

          <div className="bg-white border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">Kode</th>
                  <th className="px-3 py-2 text-left">Nama Produk</th>
                  <th className="px-3 py-2 text-left">Gudang Home</th>
                  {showAllGudang && (
                    <>
                      <th className="px-3 py-2 text-right">Qty Kering</th>
                      <th className="px-3 py-2 text-right">Qty Basah</th>
                      <th className="px-3 py-2 text-right">Qty Janitor</th>
                    </>
                  )}
                  <th className="px-3 py-2 text-center">Satuan</th>
                  <th className="px-3 py-2 text-right">Harga Beli</th>
                  <th className="px-3 py-2 text-right">Qty Stok</th>
                  <th className="px-3 py-2 text-right">Nilai Stok</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={showAllGudang ? 10 : 7} className="text-center py-10 text-slate-400">Memuat...</td></tr>
                )}
                {!loading && !stockRows.length && (
                  <tr><td colSpan={showAllGudang ? 10 : 7} className="text-center py-10 text-slate-400">
                    {!WAREHOUSES.some((w) => gudangFilter[w.kode])
                      ? 'Pilih minimal satu gudang'
                      : 'Belum ada stok di gudang yang dipilih'}
                  </td></tr>
                )}
                {!loading && stockRows.map((r) => (
                  <tr key={r.id} className="border-t hover:bg-slate-50">
                    <td className="px-3 py-2 font-mono text-xs">{r.kode}</td>
                    <td className="px-3 py-2">{r.nama}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`px-2 py-0.5 rounded font-medium ${gudangBadgeClass(r.gudangKode || 'GKERING')}`}>
                        {r.gudangNama || warehouseName(r.gudangKode || 'GKERING')}
                      </span>
                    </td>
                    {showAllGudang && (
                      <>
                        <td className="px-3 py-2 text-right font-mono text-amber-800">{formatNumber(r.stokGudangKering ?? 0)}</td>
                        <td className="px-3 py-2 text-right font-mono text-blue-800">{formatNumber(r.stokGudangBasah ?? 0)}</td>
                        <td className="px-3 py-2 text-right font-mono text-emerald-800">{formatNumber(r.stokGudangJanitor ?? 0)}</td>
                      </>
                    )}
                    <td className="px-3 py-2 text-center text-xs">{r.satuan}</td>
                    <td className="px-3 py-2 text-right text-xs">{formatIDR(r.hargaBeli || 0)}</td>
                    <td className="px-3 py-2 text-right font-semibold" title={productStockTitle({ stok: r.stokQty ?? r.stokTotal, stokDisplay: r.stokDisplay })}>
                      {r.stokDisplay || formatNumber(r.stokQty ?? r.stokTotal ?? 0)}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{formatIDR(r.nilaiStok ?? r.nilaiTotal ?? 0)}</td>
                  </tr>
                ))}
                {!loading && stockRows.length > 0 && (
                  <tr className="border-t bg-slate-50 font-semibold">
                    <td className="px-3 py-2" colSpan={showAllGudang ? 7 : 4}>
                      Total ({filteredTotals.sku} SKU
                      {!showAllGudang && ' — filter gudang'})
                    </td>
                    <td className="px-3 py-2 text-right">{formatNumber(filteredTotals.qty)}</td>
                    <td className="px-3 py-2 text-right">{formatIDR(filteredTotals.nilai)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
  );
}
