'use client';

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { formatIDR, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { PlanVariance, VarianceCostBasis } from '@/lib/food-production/plan-variance';

type VarianceResponse = PlanVariance & { productionPlanNo?: string; tanggal?: string; status?: string };

const BASIS_LABEL: Record<VarianceCostBasis, string> = {
  KARTU: 'kartu',
  PO: 'PO',
  AVG: 'rata-rata',
  NONE: '—',
};

const SUMBER_LABEL: Record<string, string> = { PO: 'PO', MRP: 'MRP', NONE: 'Di luar acuan' };

function signed(n: number, fmt: (v: number) => string): string {
  if (!n) return fmt(0);
  return `${n > 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
}

export default function PlanVarianceDialog({
  plan,
  onClose,
}: {
  plan: { id: string; noDokumen?: string } | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = useApiQuery<VarianceResponse>(
    ['production-plans', 'variance', plan?.id || ''],
    plan ? `/api/production-plans/${encodeURIComponent(plan.id)}/variance` : null,
  );
  const s = data?.summary;

  return (
    <Dialog open={Boolean(plan)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-6xl w-[min(96vw,72rem)] max-h-[90vh] overflow-y-auto overflow-x-hidden" data-testid="plan-variance-dialog">
        <DialogHeader>
          <DialogTitle>Varians bahan {data?.productionPlanNo || plan?.noDokumen || ''}</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Rencana (MRP) vs acuan PO vs pemakaian aktual (RL POSTED + PBL yang memotong stok), satuan dasar.
            Varians = aktual − acuan; rupiah aktual dari harga kartu saat keluar.
          </p>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Memuat…</p>}
        {isError && <p className="text-sm text-destructive">{error?.message || 'Gagal memuat varians.'}</p>}

        {data && s && (
          <div className="space-y-4 min-w-0">
            <div className="grid gap-2 grid-cols-2 md:grid-cols-5 text-sm">
              <div className="rounded border p-2"><div className="text-xs text-muted-foreground">Rencana (MRP)</div>{formatIDR(s.amountMrp)}</div>
              <div className="rounded border p-2"><div className="text-xs text-muted-foreground">Diterima PO</div>{formatIDR(s.amountPo)}</div>
              <div className="rounded border p-2"><div className="text-xs text-muted-foreground">Nilai acuan</div>{formatIDR(s.amountAcuan)}</div>
              <div className="rounded border p-2"><div className="text-xs text-muted-foreground">Aktual keluar</div>{formatIDR(s.amountActual)}</div>
              <div className={cn('rounded border p-2', s.varianceAmount > 0 ? 'border-amber-400 bg-amber-50' : '')}>
                <div className="text-xs text-muted-foreground">Varians</div>
                {signed(s.varianceAmount, formatIDR)}
                <div className="text-xs text-muted-foreground">{s.overCount} lebih · {s.underCount} kurang</div>
              </div>
            </div>
            {s.zeroCostLines > 0 && (
              <p className="text-xs text-amber-700">
                {s.zeroCostLines} bahan punya kartu keluar tanpa harga — dinilai harga rata-rata produk.
              </p>
            )}

            {!data.lines.length ? (
              <p className="text-sm text-muted-foreground">Rencana ini belum punya acuan maupun pemakaian bahan.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted-foreground border-b">
                    <tr>
                      <th className="py-1 pr-2">Bahan</th>
                      <th className="py-1 pr-2">Acuan</th>
                      <th className="py-1 pr-2 text-right">MRP</th>
                      <th className="py-1 pr-2 text-right">PO diterima</th>
                      <th className="py-1 pr-2 text-right">Aktual (RL+PBL)</th>
                      <th className="py-1 pr-2 text-right">Varians qty</th>
                      <th className="py-1 pr-2 text-right">Rp MRP</th>
                      <th className="py-1 pr-2 text-right">Rp PO</th>
                      <th className="py-1 pr-2 text-right">Rp aktual</th>
                      <th className="py-1 text-right">Varians Rp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((l) => (
                      <tr key={l.productId} className="border-b align-top">
                        <td className="py-1 pr-2">
                          <div>{l.productNama || l.productKode || l.productId}</div>
                          <div className="text-muted-foreground">{l.productKode} · {l.satuan || '—'}</div>
                        </td>
                        <td className="py-1 pr-2 whitespace-nowrap">
                          {SUMBER_LABEL[l.sumber] || l.sumber} {formatNumber(l.acuanQty)}
                        </td>
                        <td className="py-1 pr-2 text-right">{formatNumber(l.qtyMrp)}</td>
                        <td className="py-1 pr-2 text-right">{formatNumber(l.qtyPoReceived)}</td>
                        <td className="py-1 pr-2 text-right">
                          {formatNumber(l.qtyActual)}
                          {l.qtyPbl > 0 && <div className="text-muted-foreground">PBL {formatNumber(l.qtyPbl)}</div>}
                        </td>
                        <td className={cn('py-1 pr-2 text-right whitespace-nowrap', l.varianceQty > 0 && 'text-amber-700 font-medium')}>
                          {signed(l.varianceQty, formatNumber)}
                          {l.variancePct != null && <div className="text-muted-foreground">{signed(l.variancePct, formatNumber)}%</div>}
                        </td>
                        <td className="py-1 pr-2 text-right">{formatIDR(l.amountMrp)}</td>
                        <td className="py-1 pr-2 text-right">{formatIDR(l.amountPo)}</td>
                        <td className="py-1 pr-2 text-right">
                          {formatIDR(l.amountActual)}
                          <div className="text-muted-foreground">@{formatIDR(l.unitCost)} {BASIS_LABEL[l.costBasis]}</div>
                        </td>
                        <td className={cn('py-1 text-right whitespace-nowrap', l.varianceAmount > 0 && 'text-amber-700 font-medium')}>
                          {signed(l.varianceAmount, formatIDR)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Tutup</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
