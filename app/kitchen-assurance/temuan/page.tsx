'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { ArrowRight, FolderOpen, SquareCheck } from 'lucide-react';
import { buildHaccpHoldRepairHrefs } from '@/lib/food-safety/hold-repair-href';

function queryParam(name: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(name) || '';
}

export default function KeamananPanganTemuanPage() {
  const [caseId, setCaseId] = useState('');
  const [batchId, setBatchId] = useState('');

  useEffect(() => {
    setCaseId(queryParam('caseId'));
    setBatchId(queryParam('batch') || queryParam('batchId'));
  }, []);

  const casesHref = useMemo(() => {
    const p = new URLSearchParams();
    p.set('status', 'OPEN');
    if (batchId) p.set('batchId', batchId);
    return `/kitchen-assurance/cases?${p.toString()}`;
  }, [batchId]);

  const followUpHref = useMemo(() => {
    if (!caseId) return '/kitchen-assurance/follow-up';
    return buildHaccpHoldRepairHrefs({ caseId, batchId: batchId || undefined }).followUpHref;
  }, [caseId, batchId]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <p className="text-xs text-muted-foreground">
          <Link href="/kitchen-assurance" className="text-blue-700 hover:underline">
            Keamanan Pangan
          </Link>
          <span className="mx-1">/</span>
          Temuan & perbaikan
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Temuan & perbaikan</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tempat menyelesaikan masalah keamanan pangan: isu terbuka → tugas perbaikan → unggah bukti → verifikasi
          → batch yang ditahan bisa dilanjutkan.
        </p>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      {(caseId || batchId) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div>
            Konteks dari catatan CCP gagal
            {batchId ? <> · batch <code className="text-xs">{batchId.slice(0, 8)}…</code></> : null}
            {caseId ? <> · case <code className="text-xs">{caseId.slice(0, 8)}…</code></> : null}
            .
          </div>
          {caseId && (
            <Button asChild size="sm" className="mt-2">
              <Link href={followUpHref}>
                Unggah bukti perbaikan
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border bg-white p-4 space-y-3">
          <div className="flex items-center gap-2 font-semibold">
            <FolderOpen className="h-4 w-4" />
            Issue terbuka
          </div>
          <p className="text-sm text-muted-foreground">
            Temuan dari gagal CCP, suhu kritis, atau checklist prasyarat. Mulai dari sini bila ada batch HOLD.
          </p>
          <Button asChild size="sm">
            <Link href={casesHref}>
              Buka daftar issue
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </section>
        <section className="rounded-lg border bg-white p-4 space-y-3">
          <div className="flex items-center gap-2 font-semibold">
            <SquareCheck className="h-4 w-4" />
            Follow-up & bukti
          </div>
          <p className="text-sm text-muted-foreground">
            Kerjakan tugas, unggah foto bukti, lalu minta verifikasi. Tanpa bukti, batch tidak dilepas.
          </p>
          <Button asChild size="sm" variant={caseId ? 'default' : 'secondary'}>
            <Link href={followUpHref}>
              {caseId ? 'Unggah bukti perbaikan' : 'Buka follow-up'}
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </section>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-muted-foreground">
        Tip: setelah catatan CCP gagal, gunakan tombol &quot;Lanjut ke perbaikan&quot; bila muncul — Anda akan diarahkan ke sini
        dengan konteks batch yang sama.
      </div>
    </div>
  );
}
