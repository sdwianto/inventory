'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { LayoutGrid, RefreshCw } from 'lucide-react';
import type { FoodDashboardSnapshot } from '@/lib/food-production/dashboard';

export default function FoodDashboardPage() {
  const [data, setData] = useState<FoodDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/food-dashboard', { headers: { ...actingTenantHeaders() } });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Gagal memuat dashboard');
      setData(json as FoodDashboardSnapshot);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const k = data?.kpis;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <LayoutGrid className="h-5 w-5" />
            Dashboard Food Production
          </h1>
          <p className="text-sm text-muted-foreground">
            KPI operasional + tips berbasis aturan (bukan chat AI)
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4 mr-1" /> Muat ulang
        </Button>
      </div>

      {loading && !data && (
        <p className="text-sm text-muted-foreground">Memuat…</p>
      )}

      {k && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 text-sm">
          {[
            ['Rencana terbuka', k.openPlans],
            ['Diproses', k.processingPlans],
            ['PBL terbuka', k.openIssues],
            ['HSL terbuka', k.openResults],
            ['QC terbuka', k.openQc],
            ['Bahan tanpa gizi', k.productsMissingNutrition],
            ['Cakupan gizi resep', `${k.recipesCoveredNutritionPct}%`],
            ['Forecast shortage', k.forecastShortCount],
            ['Cost variance alert', k.costVarianceAlerts],
          ].map(([label, value]) => (
            <div key={String(label)} className="border rounded p-3">
              <div className="text-[11px] text-muted-foreground">{label}</div>
              <div className="text-lg font-semibold">{value}</div>
            </div>
          ))}
        </div>
      )}

      {data && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Tips operasional</h2>
            <Link
              href="/food-production/recommendations"
              className="text-xs text-primary hover:underline"
            >
              Rekomendasi penuh (AI rule) →
            </Link>
          </div>
          {data.tips.map((tip) => (
            <div
              key={tip.id}
              className={`border rounded p-3 text-sm ${
                tip.severity === 'critical' ? 'border-red-200 bg-red-50'
                  : tip.severity === 'warn' ? 'border-amber-200 bg-amber-50'
                    : 'bg-slate-50'
              }`}
            >
              <div className="font-medium">{tip.title}</div>
              <div className="text-muted-foreground text-xs mt-0.5">{tip.detail}</div>
              {tip.href && (
                <Link href={tip.href} className="text-xs text-primary hover:underline mt-1 inline-block">
                  Buka →
                </Link>
              )}
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Dihasilkan {new Date(data.generatedAt).toLocaleString('id-ID')}
          </p>
        </div>
      )}
    </div>
  );
}
