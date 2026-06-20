'use client';

import { useCallback, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { TrendingDown, Download } from 'lucide-react';
import { formatIDR, formatDate } from '@/lib/format';

function monthStartISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function PengeluaranPengadaanPage() {
  const [from, setFrom] = useState(monthStartISO);
  const [to, setTo] = useState(todayISO);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ from, to });
      const res = await fetch(`/api/procurement-expenses?${q}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Gagal memuat');
      setData(json);
    } catch (e) {
      toast.error(e.message);
    }
    setLoading(false);
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = () => {
    if (!data?.rows?.length) { toast.error('Tidak ada data'); return; }
    const header = ['No PO', 'No SO', 'No Invoice', 'Supplier', 'Estimasi PO', 'Nilai SO', 'Invoice', 'Selisih PO→SO', 'Selisih SO→Inv', 'Disetujui'];
    const lines = data.rows.map((r) => [
      r.noPO || '', r.noSO || '', r.noInvoice || '', r.supplierName || '',
      r.poEstimasiTotal, r.soTotal, r.invoiceTotal,
      r.variancePoToSo, r.varianceSoToInvoice,
      r.approvedAt ? formatDate(r.approvedAt) : '',
    ].join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pengeluaran-pengadaan-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const s = data?.summary;

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <TrendingDown className="w-6 h-6" /> Pengeluaran Pengadaan
            </h1>
            <p className="text-sm text-slate-500">Total belanja dari tagihan vendor yang disetujui</p>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!data?.rows?.length}>
            <Download className="w-4 h-4 mr-1" /> Export CSV
          </Button>
        </div>
        <OperationalScopeBar />

        <div className="flex flex-wrap gap-3 items-end bg-white border rounded-lg p-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Dari</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Sampai</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
          <Button onClick={load} disabled={loading} className="bg-orange-500 hover:bg-orange-600">
            {loading ? '...' : 'Terapkan'}
          </Button>
        </div>

        {s && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white border rounded-lg p-4">
              <div className="text-2xl font-bold text-orange-600">{formatIDR(s.approvedTotal)}</div>
              <div className="text-sm text-slate-500">Total disetujui ({s.invoiceCount})</div>
            </div>
            <div className="bg-white border rounded-lg p-4">
              <div className="text-2xl font-bold text-blue-600">{formatIDR(s.pendingReviewTotal)}</div>
              <div className="text-sm text-slate-500">Menunggu review ({s.pendingReviewCount})</div>
            </div>
            <div className="bg-white border rounded-lg p-4">
              <div className={`text-2xl font-bold ${s.variancePoToSo > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {formatIDR(s.variancePoToSo)}
              </div>
              <div className="text-sm text-slate-500">Selisih PO → SO</div>
            </div>
            <div className="bg-white border rounded-lg p-4">
              <div className={`text-2xl font-bold ${s.varianceSoToInvoice > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {formatIDR(s.varianceSoToInvoice)}
              </div>
              <div className="text-sm text-slate-500">Selisih SO → Invoice</div>
            </div>
          </div>
        )}

        {data?.byMonth?.length > 0 && (
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm font-medium mb-3">Belanja per bulan</p>
            <div className="space-y-2">
              {data.byMonth.map((m) => (
                <div key={m.month} className="flex items-center gap-3 text-sm">
                  <span className="w-20 text-slate-500">{m.month}</span>
                  <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-orange-500 h-full rounded-full"
                      style={{ width: `${Math.min(100, (m.approvedTotal / (s?.approvedTotal || 1)) * 100)}%` }}
                    />
                  </div>
                  <span className="w-28 text-right tabular-nums">{formatIDR(m.approvedTotal)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">No. PO</th>
                <th className="px-3 py-2 text-left">Invoice</th>
                <th className="px-3 py-2 text-right">Estimasi PO</th>
                <th className="px-3 py-2 text-right">Nilai SO</th>
                <th className="px-3 py-2 text-right">Invoice</th>
                <th className="px-3 py-2 text-right">Δ PO→SO</th>
                <th className="px-3 py-2 text-right">Δ SO→Inv</th>
                <th className="px-3 py-2 text-left">Disetujui</th>
              </tr>
            </thead>
            <tbody>
              {!data?.rows?.length && (
                <tr><td colSpan={8} className="text-center py-10 text-slate-400">Belum ada tagihan disetujui dalam periode ini</td></tr>
              )}
              {(data?.rows || []).map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{r.noPO || '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.noInvoice}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatIDR(r.poEstimasiTotal)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatIDR(r.soTotal)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{formatIDR(r.invoiceTotal)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.variancePoToSo > 0 ? 'text-red-600' : ''}`}>
                    {formatIDR(r.variancePoToSo)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.varianceSoToInvoice > 0 ? 'text-red-600' : ''}`}>
                    {formatIDR(r.varianceSoToInvoice)}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.approvedAt ? formatDate(r.approvedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
