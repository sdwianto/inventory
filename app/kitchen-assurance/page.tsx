'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getActingKitchenId } from '@/lib/acting-kitchen-client';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import type { KaDashboardSnapshot } from '@/lib/kitchen-assurance/dashboard';
import { trafficEmoji, trafficLabel } from '@/lib/kitchen-assurance/dashboard';
import type { KaKitchenStatusPillar } from '@/lib/kitchen-assurance/attention';

function trafficClass(t: string): string {
  if (t === 'GREEN') return 'text-emerald-700';
  if (t === 'YELLOW') return 'text-amber-700';
  return 'text-red-700';
}

export default function KitchenAssuranceDashboardPage() {
  const [snap, setSnap] = useState<KaDashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const kitchenId = getActingKitchenId();
      const q = kitchenId ? `?kitchenId=${encodeURIComponent(kitchenId)}` : '';
      const res = await fetch(`/api/ka-dashboard${q}`, {
        headers: actingTenantHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat dashboard');
      setSnap(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onKitchen = () => void load();
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  return (
    <div className='space-y-4 p-4 md:p-6'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h1 className='flex items-center gap-2 text-xl font-semibold tracking-tight'>
            <ShieldAlert className='h-5 w-5' />
            Kitchen Assurance
          </h1>
          <p className='text-sm text-muted-foreground'>
            Apakah dapur aman hari ini? — guardrail operasional.
          </p>
        </div>
        <Button
          variant='outline'
          size='sm'
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw
            className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      <div className='rounded-lg border bg-white p-4'>
        <h2 className='text-sm font-semibold'>Kitchen Status</h2>
        <div className='mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          {(snap?.pillars || []).map((p: KaKitchenStatusPillar) => (
            <div key={p.pillar} className='rounded-md border px-3 py-3'>
              <Link
                href={`/kitchen-assurance/monitoring?category=${p.pillar}`}
                className='block transition hover:opacity-80'
              >
                <div className='text-xs text-muted-foreground'>{p.label}</div>
                <div
                  className={`mt-1 text-2xl font-semibold ${trafficClass(p.traffic)}`}
                >
                  {trafficEmoji(p.traffic)}{' '}
                  <span className='text-base'>
                    {trafficLabel(p.traffic, p.pillar)}
                  </span>
                </div>
                <div className='mt-1 text-xs text-muted-foreground'>
                  {p.attentionCount
                    ? `${p.attentionCount} perlu perhatian`
                    : 'Tidak ada exception'}
                </div>
              </Link>
              {!!p.items?.length && (
                <ul className='mt-2 space-y-1 border-t pt-2'>
                  {p.items.slice(0, 3).map((a) => (
                    <li key={a.key} className='text-xs leading-snug'>
                      <span className='mr-1'>
                        {a.level === 'CRITICAL' ? '🔴' : '🟡'}
                      </span>
                      {a.href ? (
                        <Link
                          href={a.href}
                          className='text-blue-700 hover:underline'
                        >
                          {a.label}
                        </Link>
                      ) : (
                        <span>{a.label}</span>
                      )}
                    </li>
                  ))}
                  {p.items.length > 3 && (
                    <li>
                      <Link
                        href={`/kitchen-assurance/monitoring?category=${p.pillar}`}
                        className='text-[11px] text-blue-700 hover:underline'
                      >
                        +{p.items.length - 3} lainnya
                      </Link>
                    </li>
                  )}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>

      {snap?.allClear ? (
        <div className='rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-6 text-center text-sm text-emerald-800'>
          ✓ Semua aman
        </div>
      ) : (
        <div className='space-y-2'>
          <div className='flex items-center justify-between'>
            <h2 className='text-sm font-semibold'>Attention Needed</h2>
            <Link
              href='/kitchen-assurance/monitoring'
              className='text-xs text-blue-700 hover:underline'
            >
              Buka Monitoring
            </Link>
          </div>
          <ul className='divide-y rounded-lg border bg-white'>
            {(snap?.attentions || []).slice(0, 12).map((a) => (
              <li
                key={a.key}
                className='flex items-start justify-between gap-3 px-3 py-2.5 text-sm'
              >
                <div>
                  <span className='mr-2'>
                    {a.level === 'CRITICAL' ? '🔴' : '🟡'}
                  </span>
                  {a.href ? (
                    <Link
                      href={a.href}
                      className='font-medium text-blue-700 hover:underline'
                    >
                      {a.label}
                    </Link>
                  ) : (
                    <span className='font-medium'>{a.label}</span>
                  )}
                  {a.detail && (
                    <div className='ml-6 text-xs text-muted-foreground'>
                      {a.detail}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className='flex flex-wrap gap-4 text-sm text-muted-foreground'>
        <Link href='/kitchen-assurance/cases?status=OPEN' className='hover:underline'>
          Issue terbuka:{' '}
          <strong className='text-foreground'>{snap?.openCases ?? '—'}</strong>
        </Link>
        <Link href='/kitchen-assurance/follow-up?status=' className='hover:underline'>
          Follow-up aktif:{' '}
          <strong className='text-foreground'>
            {snap?.openFollowUps ?? '—'}
          </strong>
        </Link>
      </div>
    </div>
  );
}
