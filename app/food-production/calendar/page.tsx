'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { CalendarClock, RefreshCw } from 'lucide-react';
import type { ProductionCalendar } from '@/lib/food-production/production-calendar';

function monthRange(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const from = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  return { from, to, label: d.toLocaleString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
}

export default function ProductionCalendarPage() {
  const [cursor, setCursor] = useState(() => new Date());
  const range = useMemo(() => monthRange(cursor), [cursor]);
  const [data, setData] = useState<ProductionCalendar | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from: range.from, to: range.to });
      const res = await fetch(`/api/production-calendar?${qs}`, {
        headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Gagal memuat kalender');
      setData(json as ProductionCalendar);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            Kalender Produksi
          </h1>
          <p className="text-sm text-muted-foreground">
            Rencana produksi per hari — Multi-Kitchen aware
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCursor((d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)))}
          >
            ←
          </Button>
          <div className="text-sm font-medium self-center min-w-[9rem] text-center">{range.label}</div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCursor((d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))}
          >
            →
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
        </div>
      </div>

      {data && (
        <div className="text-sm flex flex-wrap gap-4">
          <div>Hari: <strong>{data.summary.dayCount}</strong></div>
          <div>Rencana: <strong>{data.summary.planCount}</strong></div>
          <div>Total porsi: <strong>{data.summary.totalTargetPorsi}</strong></div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
        {(data?.days || []).map((day) => (
          <div
            key={day.tanggal}
            className={`border rounded-md p-2 min-h-[5.5rem] text-xs ${
              day.planCount ? 'bg-amber-50 border-amber-200' : 'bg-white'
            }`}
          >
            <div className="font-mono text-[11px] text-muted-foreground">{day.tanggal.slice(8)}</div>
            <div className="font-medium mt-1">{day.planCount ? `${day.planCount} rencana` : '—'}</div>
            {day.planCount > 0 && (
              <div className="text-[11px] text-muted-foreground">{day.totalTargetPorsi} porsi</div>
            )}
            {day.plans.slice(0, 2).map((p) => (
              <Link
                key={p.id}
                href="/food-production/plan"
                className="block truncate text-[10px] text-primary hover:underline mt-0.5"
                title={p.noDokumen}
              >
                {p.noDokumen}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
