'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { ArrowRight, Thermometer, ClipboardList, ShieldAlert, ListChecks } from 'lucide-react';
import {
  buildOperasiCcpQueue,
  buildOperasiSupportQueue,
  type OperasiQueueItem,
} from '@/lib/food-safety/operasi-queue';

type PlanRow = {
  id: string;
  nama?: string;
  status?: string;
  kode?: string;
  monitoringPlans?: Array<{
    key: string;
    ccpKey: string;
    method: string;
    frequency: string;
    responsibleRole?: string;
    templateKodeHint?: string;
  }>;
  ccps?: Array<{ key: string; nama: string; correctiveAction?: string }>;
};

export default function KeamananPanganOperasiPage() {
  const [activePlan, setActivePlan] = useState<PlanRow | null>(null);
  const [heldBatches, setHeldBatches] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hdr = { ...actingTenantHeaders(), ...actingKitchenHeaders() };
      const [pRes, bRes] = await Promise.all([
        fetch('/api/haccp-plans', { headers: hdr }),
        fetch('/api/production-batches', { headers: hdr }),
      ]);
      const data = await pRes.json();
      if (!pRes.ok) throw new Error(data.error || 'Gagal memuat');
      const list = (Array.isArray(data) ? data : (data.items || data.data || [])) as PlanRow[];
      setActivePlan(list.find((p) => p.status === 'ACTIVE') || null);
      if (bRes.ok) {
        const raw = await bRes.json();
        const batches = Array.isArray(raw) ? raw : (raw.items || raw.data || []);
        setHeldBatches(
          (batches as Array<{ foodSafetyStatus?: string }>).filter(
            (b) => String(b.foodSafetyStatus || '').toUpperCase() === 'HOLD',
          ).length,
        );
      } else {
        setHeldBatches(0);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  const ccpQueue = useMemo(
    () => (activePlan ? buildOperasiCcpQueue(activePlan) : []),
    [activePlan],
  );
  const supportQueue = useMemo(
    () => (activePlan ? buildOperasiSupportQueue() : []),
    [activePlan],
  );

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <p className="text-xs text-muted-foreground">
          <Link href="/kitchen-assurance" className="text-blue-700 hover:underline">
            Keamanan Pangan
          </Link>
          <span className="mx-1">/</span>
          Operasi harian
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Operasi harian</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Catat pemantauan sesuai rencana aktif. Jika hasil gagal kritis, sistem menahan batch dan menuntun ke perbaikan.
        </p>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      {heldBatches > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          Ada <strong>{heldBatches}</strong> batch ditahan. Catatan CCP gagal harus diperbaiki dulu.{' '}
          <Link href="/kitchen-assurance/temuan" className="font-medium underline">
            Buka Temuan &amp; perbaikan
          </Link>
        </div>
      )}

      {!loading && !activePlan && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          Belum ada rencana HACCP aktif.{' '}
          <Link href="/kitchen-assurance/setup" className="font-medium underline">
            Ke Setup kesiapan
          </Link>{' '}
          untuk membuat atau mengaktifkan rencana.
        </div>
      )}

      {activePlan && (
        <div className="rounded-lg border bg-white p-4 text-sm">
          <div className="text-xs text-muted-foreground">Rencana aktif</div>
          <div className="font-semibold">
            {activePlan.nama || activePlan.kode || activePlan.id}
          </div>
          <Link
            href={`/food-production/haccp-plan?planId=${encodeURIComponent(activePlan.id)}&wizard=1`}
            className="mt-1 inline-block text-xs text-blue-700 hover:underline"
          >
            Lihat / sunting rencana
          </Link>
        </div>
      )}

      {activePlan && (
        <section className="space-y-2">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <ListChecks className="h-4 w-4" />
            Wajib hari ini — dari rencana
          </div>
          {ccpQueue.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              Rencana aktif belum punya rencana pemantauan CCP. Lengkapi di Setup.
            </div>
          ) : (
            <ul className="space-y-2">
              {ccpQueue.map((item) => (
                <QueueRow key={item.key} item={item} icon={<ClipboardList className="h-4 w-4" />} />
              ))}
            </ul>
          )}
          <ul className="mt-3 space-y-2">
            {supportQueue.map((item) => (
              <QueueRow
                key={item.key}
                item={item}
                icon={
                  item.kind === 'temp'
                    ? <Thermometer className="h-4 w-4" />
                    : <ShieldAlert className="h-4 w-4" />
                }
              />
            ))}
          </ul>
        </section>
      )}

      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-muted-foreground">
        Tip: setelah CCP gagal dan batch ditahan, gunakan tombol{' '}
        <span className="font-medium text-foreground">Lanjut ke perbaikan</span> di notifikasi —
        Anda diarahkan ke Temuan dengan konteks batch yang sama.
      </div>
    </div>
  );
}

function QueueRow({
  item,
  icon,
}: {
  item: OperasiQueueItem;
  icon: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium">{item.title}</div>
          {item.subtitle ? (
            <div className="text-xs text-muted-foreground">{item.subtitle}</div>
          ) : null}
        </div>
      </div>
      <Button asChild size="sm" variant={item.kind === 'ccp' ? 'default' : 'secondary'}>
        <Link href={item.href}>
          Catat
          <ArrowRight className="ml-1 h-4 w-4" />
        </Link>
      </Button>
    </li>
  );
}
