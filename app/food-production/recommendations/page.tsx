'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { Lightbulb, RefreshCw } from 'lucide-react';
import {
  REC_TYPE_LABELS,
  type FoodRecommendation,
  type RecommendationsSnapshot,
  type RecAudience,
  type RecType,
} from '@/lib/food-production/recommendations';

const SEV_CLASS: Record<string, string> = {
  critical: 'border-red-300 bg-red-50',
  warn: 'border-amber-300 bg-amber-50',
  info: 'border-slate-200 bg-slate-50',
};

export default function FoodRecommendationsPage() {
  const role = useMemo(
    () => String((getUser() as { role?: string } | null)?.role || ''),
    [],
  );
  const defaultAudience: RecAudience | 'all' = role === 'GUDANG' ? 'kitchen' : 'all';

  const [data, setData] = useState<RecommendationsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [horizon, setHorizon] = useState('7');
  const [audience, setAudience] = useState<RecAudience | 'all'>(defaultAudience);
  const [typeFilter, setTypeFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ horizon });
      if (audience !== 'all') qs.set('audience', audience);
      if (typeFilter) qs.set('types', typeFilter);
      const res = await fetch(`/api/food-recommendations?${qs}`, {
        headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Gagal memuat');
      setData(json as RecommendationsSnapshot);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, [horizon, audience, typeFilter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  const items = data?.items || [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Lightbulb className="h-5 w-5" />
            Rekomendasi FP
          </h1>
          <p className="text-sm text-muted-foreground">
            Saran berbasis data ERP — shortage, boros, stok, pengganti, menu, harga (bukan chat AI)
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4 mr-1" /> Muat ulang
        </Button>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1">
          <Label className="text-xs">Horizon</Label>
          <select
            className="h-9 border rounded-md px-2 text-sm bg-white"
            value={horizon}
            onChange={(e) => setHorizon(e.target.value)}
          >
            <option value="7">7 hari</option>
            <option value="14">14 hari</option>
            <option value="30">30 hari</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Audiens</Label>
          <select
            className="h-9 border rounded-md px-2 text-sm bg-white"
            value={audience}
            onChange={(e) => setAudience(e.target.value as RecAudience | 'all')}
          >
            <option value="all">Semua</option>
            <option value="kitchen">Dapur</option>
            <option value="management">Manajemen</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Tipe</Label>
          <select
            className="h-9 border rounded-md px-2 text-sm bg-white"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">Semua tipe</option>
            {(Object.keys(REC_TYPE_LABELS) as RecType[]).map((t) => (
              <option key={t} value={t}>{REC_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
      </div>

      {data && (
        <div className="flex flex-wrap gap-3 text-sm">
          <div className="border rounded px-3 py-2">
            <span className="text-muted-foreground">Total </span>
            <strong>{data.summary.total}</strong>
          </div>
          <div className="border rounded px-3 py-2">
            <span className="text-muted-foreground">Critical </span>
            <strong>{data.summary.critical}</strong>
          </div>
          <div className="border rounded px-3 py-2 text-muted-foreground">
            Horizon {data.horizon}d · {new Date(data.generatedAt).toLocaleString('id-ID')}
          </div>
        </div>
      )}

      {loading && !data && <p className="text-sm text-muted-foreground">Memuat…</p>}

      <div className="space-y-2">
        {items.map((item: FoodRecommendation) => (
          <div
            key={item.id}
            className={`rounded-md border p-3 space-y-1 ${SEV_CLASS[item.severity] || SEV_CLASS.info}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium text-sm">{item.title}</div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {REC_TYPE_LABELS[item.type]} · {item.severity} · {item.audience}
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{item.detail}</p>
            {(item.actions?.length || item.href) && (
              <div className="flex flex-wrap gap-2 pt-1">
                {(item.actions || (item.href ? [{ label: 'Buka', href: item.href }] : [])).map((a) => (
                  <Button key={a.href + a.label} asChild size="sm" variant="outline">
                    <Link href={a.href}>{a.label}</Link>
                  </Button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
