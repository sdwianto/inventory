'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asObject, asArray } from '@/types/json';
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
  const [data, setData] = useState<JsonObject | null>(null);
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
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = () => {
    const rows = asArray(data?.rows) as JsonObject[];
    if (!rows.length) { toast.error('Tidak ada data'); return; }
    const header = ['No PO', 'No Invoice', 'Supplier', 'Estimasi PO', 'Tagihan', 'Selisih PO→Tagihan', 'Catatan selisih tahap', 'Disetujui'];
    const lines = rows.map((r) => [
      str(r.noPO), str(r.noInvoice), str(r.supplierName),
      num(r.poEstimasiTotal), num(r.invoiceTotal), variancePoToInvoice(r),
      stageVarianceNote(r) || '',
      r.approvedAt ? formatDate(str(r.approvedAt)) : '',
    ].join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pengeluaran-pengadaan-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const variancePoToInvoice = (r: JsonObject) => num(r.invoiceTotal) - num(r.poEstimasiTotal);

  /** Hanya tampil jika SO/GRN berbeda dari tagihan — bukan redundan di baris normal. */
  const stageVarianceNote = (r: JsonObject) => {
    const inv = num(r.invoiceTotal);
    const so = num(r.soTotal);
    const grn = num(r.grnReceivedTotal);
    const parts: string[] = [];
    if (so > 0 && so !== inv) parts.push(`SO ${formatIDR(so)}`);
    if (grn > 0 && grn !== inv) parts.push(`GRN ${formatIDR(grn)}`);
    return parts.length ? parts.join(' · ') : '';
  };

  const varianceClass = (v: number) => (v > 0 ? 'text-red-600' : v < 0 ? 'text-green-600' : '');

  const s = asObject(data?.summary);
  const tableRows = asArray(data?.rows) as JsonObject[];
  const byMonth = asArray(data?.byMonth) as JsonObject[];
  const approvedTotal = num(s.approvedTotal, 1);
  const summaryVariancePoToInv = num(s.invoiceTotal) - num(s.poEstimasiTotal);

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
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!tableRows.length}>
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

        {data?.summary != null && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white border rounded-lg p-4">
              <div className="text-2xl font-bold text-orange-600">{formatIDR(num(s.approvedTotal))}</div>
              <div className="text-sm text-slate-500">Total disetujui ({num(s.invoiceCount)})</div>
            </div>
            <div className="bg-white border rounded-lg p-4">
              <div className="text-2xl font-bold text-blue-600">{formatIDR(num(s.pendingReviewTotal))}</div>
              <div className="text-sm text-slate-500">Menunggu review ({num(s.pendingReviewCount)})</div>
            </div>
            <div className="bg-white border rounded-lg p-4">
              <div className="text-2xl font-bold text-slate-700">{formatIDR(num(s.poEstimasiTotal))}</div>
              <div className="text-sm text-slate-500">Total estimasi PO</div>
            </div>
            <div className="bg-white border rounded-lg p-4">
              <div className={`text-2xl font-bold ${varianceClass(summaryVariancePoToInv)}`}>
                {formatIDR(summaryVariancePoToInv)}
              </div>
              <div className="text-sm text-slate-500">Selisih estimasi vs tagihan</div>
            </div>
          </div>
        )}

        {byMonth.length > 0 && (
          <div className="bg-white border rounded-lg p-4">
            <p className="text-sm font-medium mb-3">Belanja per bulan</p>
            <div className="space-y-2">
              {byMonth.map((m) => (
                <div key={str(m.month)} className="flex items-center gap-3 text-sm">
                  <span className="w-20 text-slate-500">{str(m.month)}</span>
                  <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-orange-500 h-full rounded-full"
                      style={{ width: `${Math.min(100, (num(m.approvedTotal) / approvedTotal) * 100)}%` }}
                    />
                  </div>
                  <span className="w-28 text-right tabular-nums">{formatIDR(num(m.approvedTotal))}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">No. PO</th>
                <th className="px-3 py-2 text-left">Invoice</th>
                <th className="px-3 py-2 text-left">Supplier</th>
                <th className="px-3 py-2 text-right">Estimasi PO</th>
                <th className="px-3 py-2 text-right">Tagihan</th>
                <th className="px-3 py-2 text-right">Selisih</th>
                <th className="px-3 py-2 text-left">Disetujui</th>
              </tr>
            </thead>
            <tbody>
              {!tableRows.length && (
                <tr><td colSpan={7} className="text-center py-10 text-slate-400">Belum ada tagihan disetujui dalam periode ini</td></tr>
              )}
              {tableRows.map((r) => {
                const selisih = variancePoToInvoice(r);
                const stageNote = stageVarianceNote(r);
                return (
                  <tr key={str(r.id)} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{str(r.noPO) || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{str(r.noInvoice)}</td>
                    <td className="px-3 py-2 text-xs max-w-[140px] truncate" title={str(r.supplierName)}>{str(r.supplierName) || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-600">{formatIDR(num(r.poEstimasiTotal))}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      <div>{formatIDR(num(r.invoiceTotal))}</div>
                      {stageNote && (
                        <div className="text-[10px] text-amber-700 font-normal mt-0.5" title="Selisih antar tahap pengadaan">
                          {stageNote}
                        </div>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums font-medium ${varianceClass(selisih)}`}>
                      {formatIDR(selisih)}
                    </td>
                    <td className="px-3 py-2 text-xs">{r.approvedAt ? formatDate(str(r.approvedAt)) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
