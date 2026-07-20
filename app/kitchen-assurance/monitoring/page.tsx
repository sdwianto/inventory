'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getActingKitchenId } from '@/lib/acting-kitchen-client';
import { ListChecks, RefreshCw } from 'lucide-react';
import {
  KA_PILLARS,
  KA_PILLAR_LABELS,
  type KaPillar,
} from '@/lib/kitchen-assurance/categories';
import type { KaAttentionItem } from '@/lib/kitchen-assurance/attention';

function pillarFromQuery(): KaPillar | '' {
  if (typeof window === 'undefined') return '';
  const raw = (new URLSearchParams(window.location.search).get('category') || '').toUpperCase();
  return (KA_PILLARS as readonly string[]).includes(raw) ? (raw as KaPillar) : '';
}

/** Already Issues / Follow Ups — don't raise again from Monitoring. */
function canRaiseIssue(a: KaAttentionItem): boolean {
  return !a.key.startsWith('case:') && !a.key.startsWith('fu:') && !a.key.startsWith('obs:');
}

export default function KaMonitoringPage() {
  const [pillar, setPillar] = useState<KaPillar | ''>('');
  const [attentions, setAttentions] = useState<KaAttentionItem[]>([]);
  const [allClear, setAllClear] = useState(false);
  const [loading, setLoading] = useState(false);
  const [raising, setRaising] = useState<string | null>(null);

  useEffect(() => {
    setPillar(pillarFromQuery());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const kitchenId = getActingKitchenId();
      const params = new URLSearchParams();
      if (kitchenId) params.set('kitchenId', kitchenId);
      if (pillar) params.set('category', pillar);
      const q = params.toString() ? `?${params}` : '';
      const res = await fetch(`/api/ka-monitoring${q}`, { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat monitoring');
      setAttentions(Array.isArray(data.attentions) ? data.attentions : []);
      setAllClear(Boolean(data.allClear));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, [pillar]);

  useEffect(() => {
    void load();
    const onKitchen = () => void load();
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<KaPillar, KaAttentionItem[]>();
    for (const p of KA_PILLARS) map.set(p, []);
    for (const a of attentions) {
      map.get(a.pillar)?.push(a);
    }
    return map;
  }, [attentions]);

  async function raiseIssue(a: KaAttentionItem) {
    setRaising(a.key);
    try {
      const res = await fetch('/api/ka-monitoring/raise-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          sourceKey: a.key,
          title: a.label,
          detail: a.detail,
          pillar: a.pillar,
          level: a.level,
          kitchenId: a.kitchenId || getActingKitchenId() || undefined,
          href: a.href,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal buat Issue');
      if (data.created === false) {
        toast.message(`Issue sudah ada: ${data.noDokumen}`);
      } else {
        toast.success(`Issue ${data.noDokumen} dibuat`);
      }
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setRaising(null);
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <ListChecks className="h-5 w-5" />
            Monitoring
          </h1>
          <p className="text-sm text-muted-foreground">
            Apa yang perlu perhatian? — exception-driven. Satu klik → Issue (P3).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={pillar === '' ? 'default' : 'outline'}
          onClick={() => {
            setPillar('');
            const url = new URL(window.location.href);
            url.searchParams.delete('category');
            window.history.replaceState({}, '', url.pathname + (url.search || ''));
          }}
        >
          Semua
        </Button>
        {KA_PILLARS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={pillar === p ? 'default' : 'outline'}
            onClick={() => {
              setPillar(p);
              const url = new URL(window.location.href);
              url.searchParams.set('category', p);
              window.history.replaceState({}, '', `${url.pathname}?${url.searchParams}`);
            }}
          >
            {KA_PILLAR_LABELS[p]}
          </Button>
        ))}
      </div>

      {allClear || !attentions.length ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-10 text-center text-sm text-emerald-800">
          {pillar
            ? `✓ ${KA_PILLAR_LABELS[pillar]} aman`
            : '✓ Semua aman'}
        </div>
      ) : (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold">Attention Needed</h2>
          {KA_PILLARS.filter((p) => !pillar || pillar === p).map((p) => {
            const items = grouped.get(p) || [];
            if (!items.length) return null;
            return (
              <section key={p} className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {KA_PILLAR_LABELS[p]}
                </h3>
                <ul className="divide-y rounded-lg border bg-white">
                  {items.map((a) => (
                    <li key={a.key} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
                      <div>
                        <span className="mr-2">{a.level === 'CRITICAL' ? '🔴' : '🟡'}</span>
                        {a.href ? (
                          <Link href={a.href} className="font-medium text-blue-700 hover:underline">
                            {a.label}
                          </Link>
                        ) : (
                          <span className="font-medium">{a.label}</span>
                        )}
                        {a.detail && (
                          <div className="ml-6 text-xs text-muted-foreground">{a.detail}</div>
                        )}
                        <div className="ml-6 text-[11px] text-muted-foreground">
                          Source: {a.source.replace(/_/g, ' ')}
                        </div>
                      </div>
                      {canRaiseIssue(a) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={raising === a.key}
                          onClick={() => void raiseIssue(a)}
                        >
                          Buat Issue
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
