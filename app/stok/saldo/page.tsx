'use client';

import { useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatIDR, formatNumber } from '@/lib/format';
import { Boxes, Search, TrendingUp } from 'lucide-react';
import { WAREHOUSES, warehouseName } from '@/lib/warehouses-client';
import StockTrendCharts from '@/components/StockTrendCharts';

interface SaldoSummary {
  qtyKering?: number;
  nilaiKering?: number;
  qtyBasah?: number;
  nilaiBasah?: number;
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
  nilaiStok?: number;
  nilaiTotal?: number;
}

interface StockTrend {
  periods: unknown[];
  totals: Record<string, unknown>;
}

interface GudangFilter {
  GKERING: boolean;
  GBASAH: boolean;
}

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
  const [rows, setRows] = useState<StockRow[]>([]);
  const [summary, setSummary] = useState<SaldoSummary | null>(null);
  const [trend, setTrend] = useState<StockTrend>({ periods: [], totals: {} });
  const [q, setQ] = useState('');
  const [trendMonths, setTrendMonths] = useState('1');
  const [loading, setLoading] = useState(true);
  const [gudangFilter, setGudangFilter] = useState<GudangFilter>({ GKERING: true, GBASAH: true });

  const load = async (query = q, months = trendMonths) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      params.set('trendMonths', months);
      const res = await fetch(`/api/stok/saldo?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat');
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setSummary(data.summary || null);
      setTrend(data.trend || { periods: [], totals: {} });
    } catch {
      setRows([]);
      setSummary(null);
      setTrend({ periods: [], totals: {} });
    }
    setLoading(false);
  };

  useEffect(() => { load('', trendMonths); }, []);

  const toggleGudang = (kode: keyof GudangFilter, checked: boolean) => {
    setGudangFilter((prev) => {
      const next = { ...prev, [kode]: checked };
      if (!next.GKERING && !next.GBASAH) return prev;
      return next;
    });
  };

  const stockRows = useMemo(() => {
    const withStock = rows.filter((r) => (r.stokTotal || r.stokQty || 0) > 0);
    return withStock.filter((r) => {
      const g = (r.gudangKode || 'GKERING') as keyof GudangFilter;
      return gudangFilter[g];
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

  const showAllGudang = gudangFilter.GKERING && gudangFilter.GBASAH;

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-5">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Boxes className="w-6 h-6" /> Saldo Stok per Gudang
          </h1>
          <p className="text-sm text-slate-500">
            Setiap produk hanya di satu gudang — {warehouseName('GKERING')} atau {warehouseName('GBASAH')} (tidak dicampur).
          </p>
        </div>
        <OperationalScopeBar />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
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
                    onCheckedChange={(v) => toggleGudang(w.kode as keyof GudangFilter, v === true)}
                    className={
                      w.kode === 'GBASAH'
                        ? 'border-blue-400 data-[state=checked]:bg-blue-600'
                        : 'border-amber-500 data-[state=checked]:bg-amber-600'
                    }
                  />
                  <Label
                    htmlFor={`gudang-${w.kode}`}
                    className={`text-sm font-medium cursor-pointer ${
                      w.kode === 'GBASAH' ? 'text-blue-800' : 'text-amber-800'
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
              Menampilkan: {[
                gudangFilter.GKERING && warehouseName('GKERING'),
                gudangFilter.GBASAH && warehouseName('GBASAH'),
              ].filter(Boolean).join(' · ')}
            </p>
          )}

          <div className="bg-white border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">Kode</th>
                  <th className="px-3 py-2 text-left">Nama Produk</th>
                  <th className="px-3 py-2 text-left">Gudang</th>
                  <th className="px-3 py-2 text-center">Satuan</th>
                  <th className="px-3 py-2 text-right">Harga Beli</th>
                  <th className="px-3 py-2 text-right">Qty Stok</th>
                  <th className="px-3 py-2 text-right">Nilai Stok</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={7} className="text-center py-10 text-slate-400">Memuat...</td></tr>
                )}
                {!loading && !stockRows.length && (
                  <tr><td colSpan={7} className="text-center py-10 text-slate-400">
                    {!gudangFilter.GKERING && !gudangFilter.GBASAH
                      ? 'Pilih minimal satu gudang'
                      : 'Belum ada stok di gudang yang dipilih'}
                  </td></tr>
                )}
                {!loading && stockRows.map((r) => (
                  <tr key={r.id} className="border-t hover:bg-slate-50">
                    <td className="px-3 py-2 font-mono text-xs">{r.kode}</td>
                    <td className="px-3 py-2">{r.nama}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`px-2 py-0.5 rounded font-medium ${
                        (r.gudangKode || 'GKERING') === 'GBASAH'
                          ? 'bg-blue-50 text-blue-800'
                          : 'bg-amber-50 text-amber-800'
                      }`}>
                        {r.gudangNama || warehouseName(r.gudangKode || 'GKERING')}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center text-xs">{r.satuan}</td>
                    <td className="px-3 py-2 text-right text-xs">{formatIDR(r.hargaBeli || 0)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{formatNumber(r.stokQty ?? r.stokTotal ?? 0)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{formatIDR(r.nilaiStok ?? r.nilaiTotal ?? 0)}</td>
                  </tr>
                ))}
                {!loading && stockRows.length > 0 && (
                  <tr className="border-t bg-slate-50 font-semibold">
                    <td className="px-3 py-2" colSpan={5}>
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
    </AppShell>
  );
}
