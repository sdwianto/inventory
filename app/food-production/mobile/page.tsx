'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { ArrowUpFromLine, BadgeCheck, Factory, Smartphone } from 'lucide-react';
import { getUser } from '@/lib/auth-client';

const MANAGE = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);
const OPS_WRITE = new Set(['GUDANG', 'ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

const TILES = [
  {
    href: '/food-production/mobile/issue',
    label: 'Ambil Bahan',
    subManage: 'PBL — qty & post stok',
    subView: 'PBL — lihat dokumen terbuka',
    needsManage: true,
    icon: ArrowUpFromLine,
  },
  {
    href: '/food-production/mobile/result',
    label: 'Hasil Masak',
    subManage: 'HSL — porsi & post FG',
    subView: 'HSL — lihat dokumen terbuka',
    needsManage: true,
    icon: Factory,
  },
  {
    href: '/food-production/mobile/qc',
    label: 'QC Cepat',
    subManage: 'Checklist PASS/FAIL · ajukan',
    subView: 'Checklist — lihat hasil',
    needsManage: false,
    icon: BadgeCheck,
  },
] as const;

export default function MobileKitchenHubPage() {
  const role = useMemo(() => String((getUser() as { role?: string } | null)?.role || ''), []);
  const canManage = MANAGE.has(role);
  const canLogQc = OPS_WRITE.has(role);

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-10">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Smartphone className="h-7 w-7" />
          Mode Dapur
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Layar besar untuk Issue · Result · QC. Offline draft tidak wajib (lewati).
        </p>
      </div>
      {!canManage && (
        <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-100">
          Issue/Result: lihat saja (post stok butuh SUPERVISOR+).
          {canLogQc ? ' QC: Anda bisa isi checklist & ajukan.' : ''}
        </div>
      )}
      <div className="grid gap-3">
        {TILES.map((t) => {
          const writable = t.needsManage ? canManage : canLogQc;
          return (
            <Link
              key={t.href}
              href={t.href}
              className="flex min-h-[5.5rem] items-center gap-4 rounded-xl border bg-background px-4 py-4 shadow-sm active:scale-[0.99] transition-transform"
            >
              <t.icon className="h-10 w-10 shrink-0 text-foreground/80" />
              <div>
                <div className="text-lg font-semibold">{t.label}</div>
                <div className="text-sm text-muted-foreground">
                  {writable ? t.subManage : t.subView}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Butuh fitur lengkap?{' '}
        <Link href="/food-production/issue" className="underline">Issue</Link>
        {' · '}
        <Link href="/food-production/result" className="underline">Result</Link>
        {' · '}
        <Link href="/food-production/qc" className="underline">QC</Link>
      </p>
    </div>
  );
}
