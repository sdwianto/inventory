'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getActingKitchenId } from '@/lib/acting-kitchen-client';
import { FileChartColumn, RefreshCw } from 'lucide-react';
import type { KaReportsSnapshot } from '@/lib/kitchen-assurance/reports';
import { KA_PILLAR_LABELS } from '@/lib/kitchen-assurance/categories';
import { KA_CASE_STATUS_LABELS, type KaCaseStatus } from '@/lib/kitchen-assurance/safety-case';

const DAY_OPTIONS = [7, 14, 30] as const;

export default function KaReportsPage() {
  const [days, setDays] = useState<number>(14);
  const [snap, setSnap] = useState<KaReportsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const kitchenId = getActingKitchenId();
      const params = new URLSearchParams({ days: String(days) });
      if (kitchenId) params.set('kitchenId', kitchenId);
      const res = await fetch(`/api/ka-reports?${params}`, { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat laporan');
      setSnap(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
    const onKitchen = () => void load();
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <FileChartColumn className="h-5 w-5" />
            Reports
          </h1>
          <p className="text-sm text-muted-foreground">
            Ringkasan operasional per Food / People / Operational / Equipment.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {DAY_OPTIONS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? 'default' : 'outline'}
              onClick={() => setDays(d)}
            >
              {d}h
            </Button>
          ))}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      {snap && (
        <p className="text-xs text-muted-foreground">
          Periode {snap.from} → {snap.to}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Issue dibuka" value={snap?.totals.issuesOpened} />
        <Stat label="Issue ditutup" value={snap?.totals.issuesClosed} />
        <Stat label="Issue masih terbuka" value={snap?.totals.issuesStillOpen} />
        <Stat label="Follow-up aktif" value={snap?.totals.followUpsActive} />
        <Stat label="Alert suhu (periode)" value={snap?.totals.tempAlerts} />
        <Stat label="PM overdue" value={snap?.totals.pmOverdue} />
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">Pilar</th>
              <th className="px-3 py-2">Issue dibuka</th>
              <th className="px-3 py-2">Ditutup</th>
              <th className="px-3 py-2">Masih terbuka</th>
              <th className="px-3 py-2">FU dibuka</th>
              <th className="px-3 py-2">FU diverifikasi</th>
              <th className="px-3 py-2">FU aktif</th>
            </tr>
          </thead>
          <tbody>
            {(snap?.pillars || []).map((p) => (
              <tr key={p.pillar} className="border-t">
                <td className="px-3 py-2 font-medium">{p.label}</td>
                <td className="px-3 py-2">{p.issuesOpened}</td>
                <td className="px-3 py-2">{p.issuesClosed}</td>
                <td className="px-3 py-2">{p.issuesStillOpen}</td>
                <td className="px-3 py-2">{p.followUpsOpened}</td>
                <td className="px-3 py-2">{p.followUpsVerified}</td>
                <td className="px-3 py-2">{p.followUpsActive}</td>
              </tr>
            ))}
            {!snap?.pillars?.length && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                  Belum ada data
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Issue terbuka (top)</h2>
          <Link href="/kitchen-assurance/cases" className="text-xs text-blue-700 hover:underline">
            Semua Cases
          </Link>
        </div>
        <ul className="divide-y rounded-lg border bg-white">
          {(snap?.topOpenIssues || []).map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <div>
                <Link
                  href={`/kitchen-assurance/cases?status=${encodeURIComponent(i.status)}`}
                  className="font-mono text-xs text-blue-700 hover:underline"
                >
                  {i.noDokumen}
                </Link>
                <span className="mx-2 font-medium">{i.title}</span>
                <span className="text-xs text-muted-foreground">
                  {KA_PILLAR_LABELS[i.pillar]} ·{' '}
                  {KA_CASE_STATUS_LABELS[i.status as KaCaseStatus] || i.status}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">{i.tanggal}</span>
            </li>
          ))}
          {!snap?.topOpenIssues?.length && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              Tidak ada issue terbuka
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-md border px-3 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value ?? '—'}</div>
    </div>
  );
}
