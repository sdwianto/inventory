'use client';

import type { JsonObject } from '@/types/json';
import { str, num } from '@/types/json';
import { useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { formatIDR, formatNumber } from '@/lib/format';
import { useAssets, useMaintenanceReport } from '@/lib/hooks/use-maintenance';
import {
  RESOLUTION_TYPE_LABELS,
  WR_SOURCE_LABELS,
} from '@/lib/maintenance/constants';
import { BarChart3, RefreshCw, Clock, Banknote, Wrench, ShieldCheck } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';

const SOURCE_CHART = {
  count: { label: 'Jumlah WR', color: '#6366f1' },
};

const MONTH_CHART = {
  preventive: { label: 'Preventif', color: '#8b5cf6' },
  corrective: { label: 'Korektif', color: '#f97316' },
};

function defaultFromDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 5);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

function defaultToDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function MaintenanceLaporanPage() {
  const [from, setFrom] = useState(defaultFromDate);
  const [to, setTo] = useState(defaultToDate);
  const [assetId, setAssetId] = useState('ALL');

  const { data: assets = [] } = useAssets();
  const { data: report, isLoading, refetch, isFetching } = useMaintenanceReport({
    from,
    to,
    assetId: assetId === 'ALL' ? '' : assetId,
  });

  const summary = (report?.summary || {}) as JsonObject;
  const bySource = (report?.bySource || []) as JsonObject[];
  const byResolution = (report?.byResolution || []) as JsonObject[];
  const costByMonth = (report?.costByMonth || []) as JsonObject[];
  const byAsset = (report?.byAsset || []) as JsonObject[];
  const recentClosed = (report?.recentClosed || []) as JsonObject[];

  const totalSourceCount = useMemo(
    () => bySource.reduce((s, r) => s + num(r.count), 0),
    [bySource],
  );

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-5">
        <OperationalScopeBar />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <BarChart3 className="w-6 h-6" /> Laporan Maintenance
            </h1>
            <p className="text-sm text-slate-500">
              Biaya per aset, MTTR, dan perbandingan preventif vs korektif
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={`w-4 h-4 mr-1 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>

        <div className="bg-white border rounded-lg p-4 flex flex-wrap gap-4 items-end">
          <div>
            <Label className="text-xs">Dari</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[160px] h-9" />
          </div>
          <div>
            <Label className="text-xs">Sampai</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[160px] h-9" />
          </div>
          <div>
            <Label className="text-xs">Aset</Label>
            <Select value={assetId} onValueChange={setAssetId}>
              <SelectTrigger className="w-[220px] h-9"><SelectValue placeholder="Semua aset" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Semua aset</SelectItem>
                {assets.map((a) => (
                  <SelectItem key={str(a.id)} value={str(a.id)}>
                    {str(a.kode)} — {str(a.nama)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isLoading ? (
          <div className="text-sm text-slate-500 py-12 text-center">Memuat laporan…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="bg-white border rounded-lg p-4">
                <Wrench className="w-4 h-4 text-indigo-600 mb-1" />
                <div className="text-2xl font-bold">{num(summary.totalWr)}</div>
                <div className="text-xs text-slate-500">Total WR</div>
              </div>
              <div className="bg-white border rounded-lg p-4">
                <div className="text-2xl font-bold text-green-700">{num(summary.closedWr)}</div>
                <div className="text-xs text-slate-500">Selesai / ditutup</div>
              </div>
              <div className="bg-white border rounded-lg p-4">
                <Banknote className="w-4 h-4 text-violet-600 mb-1" />
                <div className="text-lg font-bold text-violet-700 leading-tight">{formatIDR(num(summary.totalCost))}</div>
                <div className="text-xs text-slate-500">Total biaya</div>
              </div>
              <div className="bg-white border rounded-lg p-4">
                <Clock className="w-4 h-4 text-slate-600 mb-1" />
                <div className="text-xl font-bold">{str(summary.avgMttrLabel, '—')}</div>
                <div className="text-xs text-slate-500">Rata-rata MTTR</div>
              </div>
              <div className="bg-white border rounded-lg p-4">
                <ShieldCheck className="w-4 h-4 text-purple-600 mb-1" />
                <div className="text-xl font-bold text-purple-700">{num(summary.preventiveCount)}</div>
                <div className="text-xs text-slate-500">WR preventif · {formatIDR(num(summary.preventiveCost))}</div>
              </div>
              <div className="bg-white border rounded-lg p-4">
                <div className="text-xl font-bold text-orange-700">{num(summary.correctiveCount)}</div>
                <div className="text-xs text-slate-500">WR korektif · {formatIDR(num(summary.correctiveCost))}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="bg-white border rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-3">Preventif vs Korektif</h3>
                {bySource.length ? (
                  <ChartContainer config={SOURCE_CHART} className="h-[220px] w-full aspect-auto mx-auto max-w-[260px]">
                    <PieChart>
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Pie data={bySource} dataKey="count" nameKey="label" innerRadius={45} outerRadius={75}>
                        {bySource.map((e, i) => (
                          <Cell key={i} fill={str(e.fill, '#64748b')} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ChartContainer>
                ) : (
                  <div className="h-[220px] flex items-center justify-center text-sm text-slate-400">Tidak ada data</div>
                )}
                <div className="text-xs text-center text-slate-500 mt-2">{totalSourceCount} permintaan</div>
              </div>

              <div className="bg-white border rounded-lg p-4 lg:col-span-2">
                <h3 className="text-sm font-semibold mb-3">Biaya per Bulan</h3>
                {costByMonth.some((m) => num(m.total) > 0) ? (
                  <ChartContainer config={MONTH_CHART} className="h-[240px] w-full aspect-auto">
                    <BarChart data={costByMonth}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tickFormatter={(v) => formatNumber(v)} width={52} tick={{ fontSize: 10 }} />
                      <ChartTooltip
                        content={
                          <ChartTooltipContent
                            formatter={(value, name) => [formatIDR(Number(value)), String(name)]}
                          />
                        }
                      />
                      <Legend />
                      <Bar dataKey="preventive" stackId="a" fill="var(--color-preventive)" name="Preventif" />
                      <Bar dataKey="corrective" stackId="a" fill="var(--color-corrective)" name="Korektif" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                ) : (
                  <div className="h-[240px] flex items-center justify-center text-sm text-slate-400">Belum ada biaya</div>
                )}
              </div>
            </div>

            <div className="bg-white border rounded-lg p-4 overflow-x-auto">
              <h3 className="text-sm font-semibold mb-3">Biaya & MTTR per Aset</h3>
              {!byAsset.length ? (
                <p className="text-sm text-slate-500">Tidak ada data aset pada periode ini.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-slate-500">
                      <th className="py-2 pr-3">Aset</th>
                      <th className="py-2 pr-3 text-right">WR</th>
                      <th className="py-2 pr-3 text-right">PM</th>
                      <th className="py-2 pr-3 text-right">Korektif</th>
                      <th className="py-2 pr-3 text-right">Biaya</th>
                      <th className="py-2 text-right">MTTR rata-rata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byAsset.map((row) => (
                      <tr key={str(row.assetId)} className="border-b last:border-0 hover:bg-slate-50">
                        <td className="py-2 pr-3">
                          <span className="font-mono text-xs text-slate-500 mr-2">{str(row.assetKode)}</span>
                          {str(row.assetNama)}
                        </td>
                        <td className="py-2 pr-3 text-right">{num(row.wrCount)}</td>
                        <td className="py-2 pr-3 text-right">{num(row.preventiveCount)}</td>
                        <td className="py-2 pr-3 text-right">{num(row.correctiveCount)}</td>
                        <td className="py-2 pr-3 text-right font-medium">{formatIDR(num(row.totalCost))}</td>
                        <td className="py-2 text-right">{str(row.avgMttrLabel, '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white border rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-3">Biaya per Jalur Penyelesaian</h3>
                <div className="space-y-2">
                  {byResolution.map((r) => (
                    <div key={str(r.type)} className="flex items-center justify-between text-sm border-b pb-2">
                      <span>{str(r.label)} ({num(r.count)} WR)</span>
                      <span className="font-medium">{formatIDR(num(r.cost))}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white border rounded-lg p-4 overflow-x-auto">
                <h3 className="text-sm font-semibold mb-3">WR Ditutup Terbaru</h3>
                {!recentClosed.length ? (
                  <p className="text-sm text-slate-500">Belum ada WR ditutup pada periode ini.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-slate-500">
                        <th className="py-1.5 pr-2">WR</th>
                        <th className="py-1.5 pr-2">Aset</th>
                        <th className="py-1.5 pr-2">Tipe</th>
                        <th className="py-1.5 pr-2 text-right">Biaya</th>
                        <th className="py-1.5 text-right">MTTR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentClosed.slice(0, 15).map((row) => (
                        <tr key={str(row.id)} className="border-b last:border-0">
                          <td className="py-1.5 pr-2 font-mono">{str(row.noWR)}</td>
                          <td className="py-1.5 pr-2">{str(row.assetKode)}</td>
                          <td className="py-1.5 pr-2">
                            {WR_SOURCE_LABELS[str(row.sourceType)] || str(row.sourceType)}
                            {row.resolutionType ? ` · ${RESOLUTION_TYPE_LABELS[str(row.resolutionType)] || str(row.resolutionType)}` : ''}
                          </td>
                          <td className="py-1.5 pr-2 text-right">{formatIDR(num(row.cost))}</td>
                          <td className="py-1.5 text-right">
                            {row.mttrHours != null ? `${num(row.mttrHours)} jam` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
