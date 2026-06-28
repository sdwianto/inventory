'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
import { formatIDR, formatNumber } from '@/lib/format';
import type { JsonObject } from '@/types/json';
import { num, str } from '@/types/json';
import Link from 'next/link';
import { Wrench, AlertCircle, Cog, CheckCircle2, Banknote, CalendarClock } from 'lucide-react';

const WR_CHART_CONFIG = {
  count: { label: 'Permintaan', color: '#6366f1' },
};

const COST_RES_CONFIG = {
  total: { label: 'Biaya', color: '#f97316' },
};

const COST_MONTH_CONFIG = {
  total: { label: 'Biaya maintenance', color: '#8b5cf6' },
};

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="h-[220px] flex items-center justify-center text-sm text-slate-400 border border-dashed rounded-lg bg-slate-50/50">
      {message}
    </div>
  );
}

interface MaintenanceDashboardProps {
  data?: JsonObject | null;
}

export default function DashboardMaintenanceSection({ data }: MaintenanceDashboardProps) {
  const maintenance = (data?.maintenance || {}) as JsonObject;
  const summary = (maintenance.summary || {}) as JsonObject;
  const wrByStatus = (maintenance.wrByStatus || []) as JsonObject[];
  const costByResolution = (maintenance.costByResolution || []) as JsonObject[];
  const costByMonth = (maintenance.costByMonth || []) as JsonObject[];
  const recentOpen = (maintenance.recentOpen || []) as JsonObject[];
  const pm = (maintenance.pm || {}) as JsonObject;
  const pmRun = (maintenance.pmRun || {}) as JsonObject;

  const totalWr = wrByStatus.reduce((s, r) => s + num(r.count), 0);
  const totalCostResolution = costByResolution.reduce((s, r) => s + num(r.total), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Wrench className="w-5 h-5 text-indigo-600" />
            Maintenance
          </h2>
          <p className="text-sm text-slate-500">Permintaan perbaikan aset & biaya bulan ini</p>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href="/maintenance/permintaan" className="text-orange-600 hover:underline">
            Permintaan WR →
          </Link>
          <Link href="/maintenance/jadwal" className="text-orange-600 hover:underline">
            Jadwal PM →
          </Link>
          <Link href="/maintenance/laporan" className="text-orange-600 hover:underline">
            Laporan →
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Link href="/maintenance/jadwal" className="bg-indigo-50 border border-indigo-100 rounded-lg p-3 hover:border-indigo-300 transition-colors">
          <CalendarClock className="w-4 h-4 text-indigo-600 mb-1" />
          <div className="text-xl font-bold text-indigo-700">{num(pm.active)}</div>
          <div className="text-xs text-slate-600">Jadwal PM aktif</div>
        </Link>
        <Link href="/maintenance/jadwal" className="bg-red-50 border border-red-100 rounded-lg p-3 hover:border-red-300 transition-colors">
          <div className="text-xl font-bold text-red-700">{num(pm.overdue)}</div>
          <div className="text-xs text-slate-600">PM jatuh tempo</div>
        </Link>
        <div className="bg-amber-50 border border-amber-100 rounded-lg p-3">
          <div className="text-xl font-bold text-amber-700">{num(pm.dueSoon)}</div>
          <div className="text-xs text-slate-600">PM segera jatuh tempo</div>
        </div>
        {num(pmRun.generated) > 0 && (
          <div className="bg-green-50 border border-green-100 rounded-lg p-3">
            <div className="text-xl font-bold text-green-700">{num(pmRun.generated)}</div>
            <div className="text-xs text-slate-600">WR preventif dibuat (sesi ini)</div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Link
          href="/maintenance/permintaan?status=PENDING_APPROVAL"
          className="bg-white border rounded-lg p-4 hover:border-amber-300 transition-colors"
        >
          <AlertCircle className="w-5 h-5 text-amber-600 mb-2" />
          <div className="text-2xl font-bold text-amber-600">{num(summary.pendingApproval)}</div>
          <div className="text-sm text-slate-500">Menunggu approval</div>
        </Link>
        <Link
          href="/maintenance/permintaan"
          className="bg-white border rounded-lg p-4 hover:border-indigo-300 transition-colors"
        >
          <Wrench className="w-5 h-5 text-indigo-600 mb-2" />
          <div className="text-2xl font-bold text-indigo-600">{num(summary.inProgress)}</div>
          <div className="text-sm text-slate-500">Aktif / dikerjakan</div>
        </Link>
        <Link
          href="/maintenance/aset"
          className="bg-white border rounded-lg p-4 hover:border-orange-300 transition-colors"
        >
          <Cog className="w-5 h-5 text-orange-600 mb-2" />
          <div className="text-2xl font-bold text-orange-600">{num(summary.assetsInRepair)}</div>
          <div className="text-sm text-slate-500">Aset dalam perbaikan</div>
        </Link>
        <div className="bg-white border rounded-lg p-4">
          <CheckCircle2 className="w-5 h-5 text-green-600 mb-2" />
          <div className="text-2xl font-bold text-green-700">{num(summary.closedMonth)}</div>
          <div className="text-sm text-slate-500">Ditutup bulan ini</div>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <Banknote className="w-5 h-5 text-violet-600 mb-2" />
          <div className="text-lg font-bold text-violet-700 leading-tight">{formatIDR(num(summary.costMonth))}</div>
          <div className="text-sm text-slate-500">Biaya maintenance bulan ini</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white border rounded-lg p-4 shadow-sm">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-slate-800">Status Permintaan (WR)</h3>
            <p className="text-xs text-slate-500">{totalWr} total permintaan</p>
          </div>
          {!wrByStatus.length ? (
            <EmptyChart message="Belum ada permintaan maintenance" />
          ) : (
            <>
              <ChartContainer config={WR_CHART_CONFIG} className="h-[220px] w-full aspect-auto mx-auto max-w-[260px]">
                <PieChart>
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, _name, item) => [
                          `${value} WR (${totalWr ? Math.round((Number(value) / totalWr) * 100) : 0}%)`,
                          str(item?.payload?.label),
                        ]}
                      />
                    }
                  />
                  <Pie
                    data={wrByStatus}
                    dataKey="count"
                    nameKey="label"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {wrByStatus.map((entry, i) => (
                      <Cell key={`wr-${i}`} fill={str(entry.fill, '#64748b')} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 justify-center">
                {wrByStatus.map((r) => (
                  <span key={str(r.status)} className="text-xs text-slate-600 flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full" style={{ background: str(r.fill) }} />
                    {str(r.label)} ({num(r.count)})
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="bg-white border rounded-lg p-4 shadow-sm">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-slate-800">Biaya per Jalur (bulan ini)</h3>
            <p className="text-xs text-slate-500">{formatIDR(totalCostResolution)} total</p>
          </div>
          {!costByResolution.some((r) => num(r.total) > 0) ? (
            <EmptyChart message="Belum ada biaya maintenance bulan ini" />
          ) : (
            <ChartContainer config={COST_RES_CONFIG} className="h-[240px] w-full aspect-auto">
              <BarChart data={costByResolution} layout="vertical" margin={{ left: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickFormatter={(v) => formatNumber(v)} />
                <YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 11 }} />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => [formatIDR(Number(value)), 'Biaya']}
                    />
                  }
                />
                <Bar dataKey="total" radius={[0, 4, 4, 0]}>
                  {costByResolution.map((entry, i) => (
                    <Cell key={`cost-${i}`} fill={str(entry.fill, '#8b5cf6')} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          )}
        </div>

        <div className="bg-white border rounded-lg p-4 shadow-sm">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-slate-800">Biaya Maintenance (6 bulan)</h3>
          </div>
          {!costByMonth.some((r) => num(r.total) > 0) ? (
            <EmptyChart message="Belum ada data biaya" />
          ) : (
            <ChartContainer config={COST_MONTH_CONFIG} className="h-[240px] w-full aspect-auto">
              <BarChart data={costByMonth} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => formatNumber(v)} width={48} tick={{ fontSize: 10 }} />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => [formatIDR(Number(value)), 'Biaya']}
                    />
                  }
                />
                <Bar dataKey="total" fill="var(--color-total)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </div>
      </div>

      {recentOpen.length > 0 && (
        <div className="bg-white border rounded-lg p-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">Permintaan aktif terbaru</h3>
          <div className="divide-y">
            {recentOpen.map((wr) => (
              <Link
                key={str(wr.id)}
                href="/maintenance/permintaan"
                className="flex flex-wrap items-center justify-between gap-2 py-2 hover:bg-slate-50 -mx-2 px-2 rounded transition-colors"
              >
                <div>
                  <span className="font-mono text-xs text-slate-500 mr-2">{str(wr.noWR)}</span>
                  <span className="text-sm font-medium">{str(wr.judul)}</span>
                  <span className="text-xs text-slate-500 ml-2">
                    {str(wr.assetKode)} — {str(wr.assetNama)}
                  </span>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800">
                  {str(wr.status)}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
