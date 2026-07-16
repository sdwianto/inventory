'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { ClipboardList, RefreshCw } from 'lucide-react';
import type { ProductionReport } from '@/lib/food-production/production-report';
import { PLAN_STATUS_LABELS, type ProductionPlanStatus } from '@/lib/food-production/production-plan';

export default function ProductionReportPage() {
  const [rows, setRows] = useState<ProductionReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTanggal, setFilterTanggal] = useState('');
  const [detail, setDetail] = useState<ProductionReport | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filterTanggal ? `?tanggal=${encodeURIComponent(filterTanggal)}` : '';
      const res = await fetch(`/api/production-reports${qs}`, {
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat laporan');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, [filterTanggal]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ClipboardList className="h-5 w-5" />
            Laporan Produksi
          </h1>
          <p className="text-sm text-muted-foreground">
            Agregat rencana · PBL · cooking (status) · HSL — apa yang sudah dimasak
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="space-y-1">
            <Label className="text-xs">Tanggal rencana</Label>
            <Input
              type="date"
              className="h-9 w-[11rem]"
              value={filterTanggal}
              onChange={(e) => setFilterTanggal(e.target.value)}
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat ulang
          </Button>
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Rencana</th>
              <th className="text-left p-3">Cooking</th>
              <th className="text-left p-3">PBL</th>
              <th className="text-left p-3">HSL</th>
              <th className="text-right p-3">Actual / Target</th>
              <th className="text-left p-3">Integrity</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">
                  Belum ada rencana eligible (Disetujui / Diproses / Selesai).
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.plan.id} className="border-t">
                <td className="p-3">
                  <div className="font-mono text-xs">{row.plan.noDokumen}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {row.plan.tanggal} · {row.plan.kitchenNama || '—'} ·{' '}
                    {PLAN_STATUS_LABELS[row.plan.status as ProductionPlanStatus] || row.plan.status}
                  </div>
                </td>
                <td className="p-3">
                  <div className={
                    row.cooking.phase === 'DONE' ? 'text-emerald-700 font-medium'
                      : row.cooking.phase === 'IN_PROGRESS' ? 'text-amber-800 font-medium'
                        : 'text-muted-foreground'
                  }>
                    {row.cooking.label}
                  </div>
                </td>
                <td className="p-3 font-mono text-xs">{row.issue?.noDokumen || '—'}</td>
                <td className="p-3 font-mono text-xs">{row.result?.noDokumen || '—'}</td>
                <td className="p-3 text-right">
                  {row.summary.actualPorsi} / {row.summary.targetPorsi}
                  {row.summary.yieldPct != null && (
                    <div className="text-[11px] text-muted-foreground">{row.summary.yieldPct}% yield</div>
                  )}
                </td>
                <td className="p-3 text-xs">
                  {row.integrity.canCompletePlan
                    ? <span className="text-emerald-700">Siap tutup</span>
                    : <span className="text-amber-800">{row.integrity.message || 'Belum siap'}</span>}
                </td>
                <td className="p-3 text-right">
                  <Button size="sm" variant="outline" onClick={() => setDetail(row)}>Detail</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="rounded-md border p-4 space-y-3 text-sm">
          <div className="flex justify-between gap-2">
            <h2 className="font-medium">{detail.plan.noDokumen} — {detail.cooking.label}</h2>
            <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>Tutup</Button>
          </div>
          <p className="text-xs text-muted-foreground">{detail.cooking.note}</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="border rounded p-2">
              <div className="text-[11px] text-muted-foreground">Qty keluar (PBL)</div>
              <div className="font-medium">{detail.summary.qtyIssuedTotal}</div>
            </div>
            <div className="border rounded p-2">
              <div className="text-[11px] text-muted-foreground">Actual porsi</div>
              <div className="font-medium">{detail.summary.actualPorsi}</div>
            </div>
            <div className="border rounded p-2">
              <div className="text-[11px] text-muted-foreground">Waste</div>
              <div className="font-medium">{detail.summary.wastePorsi}</div>
            </div>
            <div className="border rounded p-2">
              <div className="text-[11px] text-muted-foreground">Yield</div>
              <div className="font-medium">{detail.summary.yieldPct != null ? `${detail.summary.yieldPct}%` : '—'}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            <Link href={`/food-production/issue?productionPlanId=${detail.plan.id}`} className="text-primary hover:underline">
              Pengambilan bahan →
            </Link>
            <Link href={`/food-production/result?productionPlanId=${detail.plan.id}`} className="text-primary hover:underline">
              Hasil produksi →
            </Link>
            <Link href="/food-production/plan" className="text-primary hover:underline">
              Rencana →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
