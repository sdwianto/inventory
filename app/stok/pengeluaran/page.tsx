'use client';

import { Suspense, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowUpFromLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModeProduksi } from '@/components/pengeluaran-stok/ModeProduksi';
import { ModeOperasional } from '@/components/pengeluaran-stok/ModeOperasional';

type Mode = 'produksi' | 'operasional';

function PengeluaranStokContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const mode: Mode = useMemo(() => {
    const m = searchParams.get('mode');
    if (m === 'produksi' || m === 'operasional') return m;
    if (searchParams.get('productionPlanId')) return 'produksi';
    return 'operasional';
  }, [searchParams]);

  const productionPlanId = searchParams.get('productionPlanId') || undefined;

  function setMode(next: Mode) {
    const qs = new URLSearchParams(searchParams.toString());
    qs.set('mode', next);
    if (next !== 'produksi') {
      qs.delete('productionPlanId');
      qs.delete('materialRequirementId');
    }
    if (next !== 'operasional') {
      qs.delete('wrId');
    }
    const q = qs.toString();
    router.replace(q ? `${pathname}?${q}` : pathname);
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ArrowUpFromLine className="w-6 h-6" />
          Pengeluaran Stok
        </h1>
        <p className="text-sm text-slate-500">
          Mode Produksi (dari Rencana) · Mode Operasional (release gudang)
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={mode === 'produksi' ? 'default' : 'outline'}
          className={mode === 'produksi' ? 'bg-orange-500 hover:bg-orange-600' : undefined}
          onClick={() => setMode('produksi')}
        >
          Produksi
        </Button>
        <Button
          size="sm"
          variant={mode === 'operasional' ? 'default' : 'outline'}
          className={mode === 'operasional' ? 'bg-orange-500 hover:bg-orange-600' : undefined}
          onClick={() => setMode('operasional')}
        >
          Operasional
        </Button>
      </div>

      {mode === 'produksi' ? (
        <ModeProduksi initialPlanId={productionPlanId} />
      ) : (
        <ModeOperasional />
      )}
    </div>
  );
}

export default function PengeluaranStokPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Memuat pengeluaran stok…</div>}>
      <PengeluaranStokContent />
    </Suspense>
  );
}
