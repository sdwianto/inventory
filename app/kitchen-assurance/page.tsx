'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getActingKitchenId } from '@/lib/acting-kitchen-client';
import {
  ArrowRight,
  ClipboardCheck,
  RefreshCw,
  Shield,
  Wrench,
} from 'lucide-react';
import type { KaDashboardSnapshot } from '@/lib/kitchen-assurance/dashboard';
import {
  AUDIT_READINESS_STATUS_LABELS,
  type AuditReadinessSnapshot,
} from '@/lib/food-production/food-safety-audit-readiness';
import {
  resolveFoodSafetyNextAction,
  type FoodSafetyHubMode,
} from '@/lib/food-safety/hub-next-action';

function readinessClass(s: string): string {
  if (s === 'READY') return 'text-emerald-700';
  if (s === 'PARTIAL') return 'text-amber-700';
  return 'text-red-700';
}

function toneClass(tone: string): string {
  if (tone === 'critical') return 'border-red-300 bg-red-50';
  if (tone === 'warning') return 'border-amber-300 bg-amber-50';
  if (tone === 'ok') return 'border-emerald-300 bg-emerald-50';
  return 'border-slate-200 bg-white';
}

type PlanLite = { id: string; status: string; nama?: string; monitoringCount?: number };

const MODE_CARDS: Array<{
  mode: FoodSafetyHubMode;
  href: string;
  title: string;
  blurb: string;
  icon: typeof Shield;
}> = [
  {
    mode: 'setup',
    href: '/kitchen-assurance/setup',
    title: 'Setup kesiapan',
    blurb: 'Checklist prasyarat & rencana HACCP (panduan langkah).',
    icon: ClipboardCheck,
  },
  {
    mode: 'operasi',
    href: '/kitchen-assurance/operasi',
    title: 'Operasi harian',
    blurb: 'Catat CCP, suhu, dan checklist yang jatuh tempo.',
    icon: Shield,
  },
  {
    mode: 'temuan',
    href: '/kitchen-assurance/temuan',
    title: 'Temuan & perbaikan',
    blurb: 'Issue, bukti perbaikan, lepaskan batch yang ditahan.',
    icon: Wrench,
  },
  {
    mode: 'audit',
    href: '/kitchen-assurance/audit',
    title: 'Siap audit',
    blurb: 'Lihat yang masih kurang sebelum auditor datang.',
    icon: ClipboardCheck,
  },
];

export default function KeamananPanganHubPage() {
  const [snap, setSnap] = useState<KaDashboardSnapshot | null>(null);
  const [readiness, setReadiness] = useState<AuditReadinessSnapshot | null>(null);
  const [plans, setPlans] = useState<PlanLite[]>([]);
  const [heldBatches, setHeldBatches] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const kitchenId = getActingKitchenId();
      const q = kitchenId ? `?kitchenId=${encodeURIComponent(kitchenId)}` : '';
      const hdr = actingTenantHeaders();
      const [res, rRes, pRes, bRes] = await Promise.all([
        fetch(`/api/ka-dashboard${q}`, { headers: hdr }),
        fetch(`/api/food-safety-readiness${q}`, { headers: hdr }),
        fetch('/api/haccp-plans', { headers: hdr }),
        fetch(`/api/production-batches${kitchenId ? `?kitchenId=${encodeURIComponent(kitchenId)}` : ''}`, {
          headers: hdr,
        }),
      ]);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat dashboard');
      setSnap(data);
      if (rRes.ok) setReadiness(await rRes.json());
      else setReadiness(null);
      if (pRes.ok) {
        const raw = await pRes.json();
        const list = Array.isArray(raw) ? raw : (raw.items || raw.data || []);
        setPlans(
          (list as Array<PlanLite & { monitoringPlans?: unknown[] }>).map((p) => ({
            id: String(p.id),
            status: String(p.status || ''),
            nama: p.nama,
            monitoringCount: Array.isArray(p.monitoringPlans) ? p.monitoringPlans.length : 0,
          })),
        );
      } else {
        setPlans([]);
      }
      if (bRes.ok) {
        const raw = await bRes.json();
        const list = Array.isArray(raw) ? raw : (raw.items || raw.data || []);
        const holds = (list as Array<{ foodSafetyStatus?: string }>).filter(
          (b) => String(b.foodSafetyStatus || '').toUpperCase() === 'HOLD',
        );
        setHeldBatches(holds.length);
      } else {
        setHeldBatches(0);
      }
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

  const activePlan = plans.find((p) => p.status === 'ACTIVE');
  const draftPlan = plans.find((p) => p.status === 'DRAFT' || p.status === 'UNDER_REVIEW');

  const next = useMemo(
    () => resolveFoodSafetyNextAction({
      openCases: snap?.openCases || 0,
      openFollowUps: snap?.openFollowUps || 0,
      heldBatches,
      hasActiveHaccpPlan: Boolean(activePlan),
      haccpPlanDraftId: draftPlan?.id || null,
      operasiPendingCount: activePlan ? (activePlan.monitoringCount || 0) : null,
      auditStatus: readiness?.status || null,
      prpCovered: readiness
        ? readiness.bgnRequirements.filter((r) => r.hasEvidence).length
        : null,
      prpTotal: readiness?.bgnRequirements.length ?? null,
      extraOpenPillars: readiness
        ? readiness.pillars.filter((p) => p.key !== 'bgn_prp' && p.status !== 'READY').length
        : null,
    }),
    [snap, heldBatches, activePlan, draftPlan, readiness],
  );

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Shield className="h-5 w-5" />
            Keamanan Pangan
          </h1>
          <p className="text-sm text-muted-foreground">
            Satu pintu untuk prasyarat, rencana HACCP, catatan harian, dan perbaikan — tanpa harus hafal istilah teknis.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Muat ulang
        </Button>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      <div className={`rounded-lg border p-4 ${toneClass(next.tone)}`}>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Langkah berikutnya
        </div>
        <h2 className="mt-1 text-lg font-semibold">{next.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{next.description}</p>
        <Button asChild className="mt-3" size="sm">
          <Link href={next.href}>
            Lanjutkan
            <ArrowRight className="ml-1 h-4 w-4" />
          </Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {MODE_CARDS.map((card) => {
          const Icon = card.icon;
          const highlight = card.mode === next.mode;
          let status = '—';
          if (card.mode === 'setup') {
            status = activePlan
              ? `Rencana aktif: ${activePlan.nama || activePlan.id.slice(0, 8)}`
              : draftPlan
                ? 'Ada draft — lanjutkan'
                : 'Belum ada rencana aktif';
          } else if (card.mode === 'operasi') {
            status = activePlan ? 'Siap catat dari rencana aktif' : 'Butuh rencana aktif dulu';
          } else if (card.mode === 'temuan') {
            status = `${snap?.openCases ?? 0} issue · ${snap?.openFollowUps ?? 0} follow-up · ${heldBatches} HOLD`;
          } else if (card.mode === 'audit' && readiness) {
            status = AUDIT_READINESS_STATUS_LABELS[readiness.status];
          }
          return (
            <Link
              key={card.mode}
              href={card.href}
              className={`rounded-lg border bg-white p-4 transition hover:border-slate-400 ${
                highlight ? 'ring-2 ring-slate-900' : ''
              }`}
            >
              <div className="flex items-center gap-2 font-semibold">
                <Icon className="h-4 w-4" />
                {card.title}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{card.blurb}</p>
              <p className={`mt-3 text-xs font-medium ${
                card.mode === 'audit' && readiness ? readinessClass(readiness.status) : 'text-foreground'
              }`}>
                {status}
              </p>
            </Link>
          );
        })}
      </div>

      {heldBatches > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          Ada <strong>{heldBatches}</strong> batch ditahan (HOLD).{' '}
          <Link href="/kitchen-assurance/temuan" className="font-medium underline">
            Buka Temuan & perbaikan
          </Link>
        </div>
      )}

      {(snap?.attentions?.length || 0) > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Perlu perhatian</h2>
          <ul className="divide-y rounded-lg border bg-white">
            {(snap?.attentions || []).slice(0, 8).map((a) => (
              <li key={a.key} className="px-3 py-2.5 text-sm">
                {a.href ? (
                  <Link href={a.href} className="font-medium text-blue-700 hover:underline">
                    {a.label}
                  </Link>
                ) : (
                  <span className="font-medium">{a.label}</span>
                )}
                {a.detail && (
                  <div className="text-xs text-muted-foreground">{a.detail}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="rounded-lg border bg-slate-50 px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-800">
          Pengaturan lanjutan
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          Untuk admin / PIC mutu — bukan jalur kerja harian.
        </p>
        <ul className="mt-2 space-y-1 text-sm">
          <li>
            <Link href="/kitchen-assurance/monitoring" className="text-blue-700 hover:underline">
              Monitoring sinyal
            </Link>
          </li>
          <li>
            <Link href="/kitchen-assurance/reports" className="text-blue-700 hover:underline">
              Reports
            </Link>
          </li>
          <li>
            <Link href="/kitchen-assurance/analytics" className="text-blue-700 hover:underline">
              Analytics
            </Link>
          </li>
          <li>
            <Link href="/food-production/haccp-verification" className="text-blue-700 hover:underline">
              Verifikasi HACCP (daftar)
            </Link>
          </li>
        </ul>
      </details>
    </div>
  );
}
