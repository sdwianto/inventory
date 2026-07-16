'use client';

import { useCallback, useEffect, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { LineChart, RefreshCw } from 'lucide-react';
import type { ForecastHorizon, ForecastResult } from '@/lib/food-production/forecast';

export default function ForecastPage() {
  const [horizon, setHorizon] = useState<ForecastHorizon>(7);
  const [data, setData] = useState<ForecastResult | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/food-forecasts?horizon=${horizon}`, {
        headers: { ...actingTenantHeaders() },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Gagal forecast');
      setData(json as ForecastResult);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal forecast');
    } finally {
      setLoading(false);
    }
  }, [horizon]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <LineChart className="h-5 w-5" />
            Forecast Bahan
          </h1>
          <p className="text-sm text-muted-foreground">
            Proyeksi kebutuhan dari histori PBL selesai · horizon 7 / 14 / 30 hari
          </p>
        </div>
        <div className="flex gap-2 items-end">
          <div className="space-y-1">
            <Label className="text-xs">Horizon</Label>
            <select
              className="h-9 border rounded-md px-2 text-sm bg-white"
              value={horizon}
              onChange={(e) => setHorizon(Number(e.target.value) as ForecastHorizon)}
            >
              <option value={7}>7 hari</option>
              <option value={14}>14 hari</option>
              <option value={30}>30 hari</option>
            </select>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat ulang
          </Button>
        </div>
      </div>

      {data && (
        <>
          <div className="flex flex-wrap gap-4 text-sm">
            <div>Produk: <strong>{data.summary.productCount}</strong></div>
            <div className="text-destructive">Shortage: <strong>{data.summary.shortCount}</strong></div>
            <div className="text-amber-800">Low: <strong>{data.summary.lowCount}</strong></div>
            <div className="text-muted-foreground">
              Histori {data.fromTanggal || '—'} → {data.toTanggal || '—'} ({data.historyDays} hari jendela)
            </div>
          </div>
          {!!data.tips.length && (
            <ul className="text-xs bg-slate-50 border rounded p-3 space-y-1">
              {data.tips.map((t) => <li key={t}>{t}</li>)}
            </ul>
          )}
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3">Produk</th>
                  <th className="text-right p-3">Avg/hari</th>
                  <th className="text-right p-3">Forecast</th>
                  <th className="text-right p-3">On hand</th>
                  <th className="text-right p-3">Shortage</th>
                  <th className="text-left p-3">Risk</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
                )}
                {!loading && data.lines.length === 0 && (
                  <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Belum ada histori konsumsi</td></tr>
                )}
                {data.lines.map((l) => (
                  <tr key={l.productId} className="border-t">
                    <td className="p-3">
                      <div>{l.productNama || l.productKode || l.productId}</div>
                      <div className="text-[11px] font-mono text-muted-foreground">{l.productKode} · {l.satuan}</div>
                    </td>
                    <td className="p-3 text-right">{l.avgDailyQty}</td>
                    <td className="p-3 text-right">{l.forecastQty}</td>
                    <td className="p-3 text-right">{l.onHandQty}</td>
                    <td className="p-3 text-right">{l.projectedShortage}</td>
                    <td className="p-3">
                      <span className={
                        l.risk === 'SHORT' ? 'text-destructive font-medium'
                          : l.risk === 'LOW' ? 'text-amber-800 font-medium' : 'text-muted-foreground'
                      }>
                        {l.risk}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
