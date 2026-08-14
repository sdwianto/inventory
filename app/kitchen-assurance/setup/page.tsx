'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { ClipboardList, Plus } from 'lucide-react';
import { HACCP_PLAN_STATUS_LABELS } from '@/lib/food-production/haccp-plan';
import PrpSetupAccordion from '@/components/food-safety/PrpSetupAccordion';

type PlanRow = {
  id: string;
  kode?: string;
  nama?: string;
  status?: string;
  version?: number;
  isExample?: boolean;
};

export default function KeamananPanganSetupPage() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/haccp-plans', { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat rencana');
      const list = Array.isArray(data) ? data : (data.items || data.data || []);
      setPlans(list as PlanRow[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <p className="text-xs text-muted-foreground">
          <Link href="/kitchen-assurance" className="text-blue-700 hover:underline">
            Keamanan Pangan
          </Link>
          <span className="mx-1">/</span>
          Setup kesiapan
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Setup kesiapan</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Dua fondasi sebelum operasi harian: checklist prasyarat (kebersihan & fasilitas), lalu rencana HACCP
          yang dituntun langkah demi langkah.
        </p>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      <PrpSetupAccordion />

      <div className="grid gap-4">
        <section className="rounded-lg border bg-white p-4 space-y-3">
          <div className="flex items-center gap-2 font-semibold">
            <ClipboardList className="h-4 w-4" />
            2. Rencana HACCP
          </div>
          <p className="text-sm text-muted-foreground">
            Ikuti panduan: tim → produk → alur dapur → bahaya & CCP → cek & pelatihan. Tidak perlu hafal nomor pasal BGN.
          </p>
          <Button asChild size="sm">
            <Link href="/food-production/haccp-plan?wizard=1">
              <Plus className="mr-1 h-4 w-4" />
              Buat / lanjutkan rencana
            </Link>
          </Button>
        </section>
      </div>

      <section className="rounded-lg border bg-white overflow-hidden">
        <div className="border-b px-4 py-2 text-sm font-medium">Rencana yang ada</div>
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-2">Kode</th>
              <th className="p-2">Nama</th>
              <th className="p-2">Status</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="p-2 font-mono text-xs">{p.kode || '—'}</td>
                <td className="p-2">
                  {p.nama || '—'}
                  {p.isExample ? (
                    <span className="ml-2 text-[10px] text-muted-foreground">contoh</span>
                  ) : null}
                </td>
                <td className="p-2 text-xs">
                  {HACCP_PLAN_STATUS_LABELS[(p.status || '') as keyof typeof HACCP_PLAN_STATUS_LABELS]
                    || p.status
                    || '—'}
                </td>
                <td className="p-2 text-right">
                  <Link
                    href={`/food-production/haccp-plan?planId=${encodeURIComponent(p.id)}&wizard=1`}
                    className="text-xs text-blue-700 hover:underline"
                  >
                    Buka panduan
                  </Link>
                  <span className="mx-1 text-muted-foreground">·</span>
                  <Link
                    href={`/food-production/haccp-plan?planId=${encodeURIComponent(p.id)}&step=E`}
                    className="text-xs text-blue-700 hover:underline"
                  >
                    Cek & pelatihan
                  </Link>
                </td>
              </tr>
            ))}
            {!loading && plans.length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-muted-foreground">
                  Belum ada rencana — buat dari tombol di atas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
