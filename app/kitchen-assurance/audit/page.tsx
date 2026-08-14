'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getActingKitchenId } from '@/lib/acting-kitchen-client';
import { ArrowRight, ClipboardList, RefreshCw } from 'lucide-react';
import {
  AUDIT_READINESS_STATUS_LABELS,
  type AuditReadinessSnapshot,
} from '@/lib/food-production/food-safety-audit-readiness';

function statusClass(s: string): string {
  if (s === 'READY') return 'border-emerald-200 bg-emerald-50 text-emerald-900';
  if (s === 'PARTIAL') return 'border-amber-200 bg-amber-50 text-amber-950';
  return 'border-red-200 bg-red-50 text-red-900';
}

function statusText(s: string): string {
  if (s === 'READY') return 'text-emerald-800';
  if (s === 'PARTIAL') return 'text-amber-800';
  return 'text-red-800';
}

export default function KeamananPanganAuditPage() {
  const [snap, setSnap] = useState<AuditReadinessSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const kitchenId = getActingKitchenId();
      const q = kitchenId ? `?kitchenId=${encodeURIComponent(kitchenId)}` : '';
      const res = await fetch(`/api/food-safety-readiness${q}`, {
        headers: actingTenantHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat kesiapan');
      setSnap(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
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

  const redPrp = useMemo(
    () => (snap?.bgnRequirements || []).filter((r) => !r.hasEvidence),
    [snap],
  );
  const openPillars = useMemo(
    () => (snap?.pillars || []).filter((p) => p.status !== 'READY'),
    [snap],
  );

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            <Link href="/kitchen-assurance" className="text-blue-700 hover:underline">
              Keamanan Pangan
            </Link>
            <span className="mx-1">/</span>
            Siap audit
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Siap audit</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Item merah bisa diklik — langsung ke Setup, Operasi, Temuan, atau langkah validasi rencana.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Muat ulang
        </Button>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      {snap && (
        <section className={`rounded-lg border p-4 ${statusClass(snap.status)}`}>
          <div className="flex items-center gap-2 font-semibold">
            <ClipboardList className="h-4 w-4" />
            {AUDIT_READINESS_STATUS_LABELS[snap.status]}
          </div>
          <p className="mt-1 text-sm opacity-90">
            {openPillars.length === 0 && redPrp.length === 0
              ? 'Bukti operasional sudah lengkap untuk klaim kesiapan (bukan sertifikasi resmi).'
              : `${openPillars.length} pilar dan ${redPrp.length} item prasyarat masih kurang.`}
          </p>
          <p className="mt-2 text-xs opacity-80">{snap.disclaimer}</p>
        </section>
      )}

      {snap && (
        <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {snap.pillars.map((p) => {
            const href = p.href || '/kitchen-assurance/setup';
            const open = p.status !== 'READY';
            return (
              <Link
                key={p.key}
                href={href}
                className={`rounded-lg border bg-white p-3 transition hover:border-slate-400 ${
                  open ? 'ring-1 ring-red-200' : ''
                }`}
              >
                <div className={`text-xs font-semibold ${statusText(p.status)}`}>
                  {AUDIT_READINESS_STATUS_LABELS[p.status]}
                </div>
                <div className="mt-1 font-medium text-sm">{p.label}</div>
                <p className="mt-1 text-xs text-muted-foreground">{p.detail}</p>
                {open && (
                  <span className="mt-2 inline-flex items-center text-xs text-blue-700">
                    Perbaiki
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </span>
                )}
              </Link>
            );
          })}
        </section>
      )}

      {redPrp.length > 0 && (
        <section className="overflow-hidden rounded-lg border bg-white">
          <div className="bg-red-50 px-3 py-2 text-sm font-medium text-red-950">
            Item prasyarat belum ada bukti ({redPrp.length})
          </div>
          <ul className="divide-y">
            {redPrp.slice(0, 40).map((r) => (
              <li key={r.requirementId}>
                <Link
                  href={r.href || '/kitchen-assurance/setup'}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-slate-50"
                >
                  <span>
                    <span className="font-mono text-xs text-muted-foreground">{r.kode}</span>
                    {' '}
                    {r.nama}
                  </span>
                  <span className="inline-flex shrink-0 items-center text-xs text-blue-700">
                    Buka Setup
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Telusur lot / batch ada di{' '}
        <Link href="/food-production/audit-readiness" className="text-blue-700 hover:underline">
          panel teknis
        </Link>
        {' '}(bukan jalur harian).
      </p>
    </div>
  );
}
