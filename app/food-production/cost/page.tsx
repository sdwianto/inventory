'use client';

import { useCallback, useEffect, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { Calculator, RefreshCw } from 'lucide-react';

interface PlanRow {
  id: string;
  noDokumen: string;
  tanggal: string;
  status: string;
  kitchenNama?: string;
  totalTargetPorsi?: number;
}

interface CostAnalysis {
  scope: string;
  refLabel?: string;
  standard: { totalCost: number; perPorsi: number; yieldPorsi: number; missingPriceCount: number };
  actual?: { totalCost: number; perPorsi: number; yieldPorsi: number };
  variance?: { amount: number; pct: number; perPorsiAmount: number };
  warnings: string[];
  lines?: Array<{ productNama?: string; qty: number; unitCost: number; amount: number; missingPrice?: boolean }>;
  actualLines?: Array<{ productNama?: string; qty: number; unitCost: number; amount: number }>;
}

function idr(n: number) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n || 0);
}

export default function FoodCostPage() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [planId, setPlanId] = useState('');
  const [mode, setMode] = useState<'plan' | 'actual'>('actual');
  const [analysis, setAnalysis] = useState<CostAnalysis | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/food-costs', { headers: { ...actingTenantHeaders() } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat');
      setPlans(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPlans(); }, [loadPlans]);

  async function analyze() {
    if (!planId) {
      toast.error('Pilih rencana');
      return;
    }
    try {
      const res = await fetch(
        `/api/food-costs/analyze?scope=${mode}&id=${encodeURIComponent(planId)}`,
        { headers: { ...actingTenantHeaders() } },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal analisis');
      setAnalysis(data as CostAnalysis);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal analisis');
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Calculator className="h-5 w-5" />
            Biaya Pangan
          </h1>
          <p className="text-sm text-muted-foreground">
            Standard cost (resep × hargaBeli) vs actual (PBL × harga) · variance
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadPlans()} disabled={loading}>
          <RefreshCw className="h-4 w-4 mr-1" /> Muat ulang
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 items-end">
        <div className="space-y-1 min-w-[16rem] grow">
          <Label className="text-xs">Rencana produksi</Label>
          <select
            className="w-full h-9 border rounded-md px-2 text-sm bg-white"
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
          >
            <option value="">— Pilih —</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.noDokumen} · {p.tanggal} · {p.status} · {p.kitchenNama || 'Dapur'}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Mode</Label>
          <select
            className="h-9 border rounded-md px-2 text-sm bg-white"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'plan' | 'actual')}
          >
            <option value="plan">Standard saja</option>
            <option value="actual">Standard + Actual</option>
          </select>
        </div>
        <Button size="sm" onClick={() => void analyze()}>Hitung</Button>
      </div>

      {analysis && (
        <div className="space-y-3">
          {!!analysis.warnings.length && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
              {analysis.warnings.join(' · ')}
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <div className="border rounded p-3">
              <div className="text-[11px] text-muted-foreground">Standard total</div>
              <div className="font-medium">{idr(analysis.standard.totalCost)}</div>
              <div className="text-[11px]">{idr(analysis.standard.perPorsi)} / porsi</div>
            </div>
            {analysis.actual && (
              <div className="border rounded p-3">
                <div className="text-[11px] text-muted-foreground">Actual total</div>
                <div className="font-medium">{idr(analysis.actual.totalCost)}</div>
                <div className="text-[11px]">{idr(analysis.actual.perPorsi)} / porsi</div>
              </div>
            )}
            {analysis.variance && (
              <div className="border rounded p-3">
                <div className="text-[11px] text-muted-foreground">Variance</div>
                <div className={`font-medium ${analysis.variance.amount > 0 ? 'text-destructive' : 'text-emerald-700'}`}>
                  {idr(analysis.variance.amount)} ({analysis.variance.pct}%)
                </div>
                <div className="text-[11px]">{idr(analysis.variance.perPorsiAmount)} / porsi</div>
              </div>
            )}
            <div className="border rounded p-3">
              <div className="text-[11px] text-muted-foreground">Porsi</div>
              <div className="font-medium">{analysis.actual?.yieldPorsi ?? analysis.standard.yieldPorsi}</div>
              <div className="text-[11px]">missing harga: {analysis.standard.missingPriceCount}</div>
            </div>
          </div>

          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2">Bahan</th>
                  <th className="text-right p-2">Qty</th>
                  <th className="text-right p-2">Harga</th>
                  <th className="text-right p-2">Jumlah</th>
                </tr>
              </thead>
              <tbody>
                {(analysis.actualLines?.length ? analysis.actualLines : analysis.lines || []).map((l, i) => (
                  <tr key={i} className="border-t">
                    <td className="p-2">{l.productNama || '—'}</td>
                    <td className="p-2 text-right">{l.qty}</td>
                    <td className="p-2 text-right">{idr(l.unitCost)}</td>
                    <td className="p-2 text-right">{idr(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
