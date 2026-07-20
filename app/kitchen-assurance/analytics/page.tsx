'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getActingKitchenId } from '@/lib/acting-kitchen-client';
import { LineChart, RefreshCw } from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart as RLineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  BarChart,
  Bar,
} from 'recharts';
import type { KaAnalyticsSnapshot } from '@/lib/kitchen-assurance/analytics';

const DAY_OPTIONS = [7, 14, 30] as const;

function priorityClass(p: string): string {
  if (p === 'HIGH') return 'border-red-200 bg-red-50 text-red-900';
  if (p === 'MEDIUM') return 'border-amber-200 bg-amber-50 text-amber-900';
  return 'border-slate-200 bg-slate-50 text-slate-800';
}

export default function KaAnalyticsPage() {
  const [days, setDays] = useState<number>(14);
  const [snap, setSnap] = useState<KaAnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const kitchenId = getActingKitchenId();
      const params = new URLSearchParams({ days: String(days) });
      if (kitchenId) params.set('kitchenId', kitchenId);
      const res = await fetch(`/api/ka-analytics?${params}`, { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat analytics');
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
            <LineChart className="h-5 w-5" />
            Analytics
          </h1>
          <p className="text-sm text-muted-foreground">
            Tren operasional + rekomendasi (rule-based — bukan prediction suite).
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

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">AI Recommendation</h2>
        <ul className="space-y-2">
          {(snap?.recommendations || []).map((r) => (
            <li
              key={r.id}
              className={`rounded-md border px-3 py-2.5 text-sm ${priorityClass(r.priority)}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">
                    <span className="mr-2 text-xs uppercase tracking-wide opacity-70">
                      {r.priority}
                    </span>
                    {r.title}
                  </div>
                  <p className="mt-0.5 text-xs opacity-90">{r.rationale}</p>
                </div>
                {r.href && (
                  <Button size="sm" variant="outline" asChild>
                    <Link href={r.href}>Buka</Link>
                  </Button>
                )}
              </div>
            </li>
          ))}
          {!snap?.recommendations?.length && (
            <li className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              Belum ada rekomendasi
            </li>
          )}
        </ul>
      </section>

      <section className="rounded-lg border bg-white p-3">
        <h2 className="mb-2 text-sm font-semibold">Tren harian</h2>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <RLineChart data={snap?.trend || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="tanggal" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="issuesOpened" name="Issue dibuka" stroke="#b45309" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="issuesClosed" name="Issue ditutup" stroke="#047857" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="tempAlerts" name="Alert suhu" stroke="#1d4ed8" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="followUpsOpened" name="FU dibuka" stroke="#0f766e" strokeWidth={2} dot={false} />
            </RLineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-lg border bg-white p-3">
        <h2 className="mb-2 text-sm font-semibold">Open load per pilar</h2>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={snap?.byPillarOpen || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="openIssues" name="Issue terbuka" fill="#b45309" />
              <Bar dataKey="activeFollowUps" name="FU aktif" fill="#0f766e" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
