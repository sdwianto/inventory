'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import { Truck, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  DIST_STATUS_LABELS,
  DIST_UI_STATUS_NEXT,
  DIST_UI_STATUS_NEXT_LABEL,
  type DistributionStatus,
} from '@/lib/food-production/distribution';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface PlanOpt {
  id: string;
  noDokumen: string;
  tanggal: string;
  kitchenNama?: string;
  status: string;
  summary?: { totalTargetPorsi?: number };
}

interface ResultOpt {
  id: string;
  noDokumen: string;
  tanggal: string;
  productionPlanId?: string;
  productionPlanNo?: string;
  kitchenNama?: string;
  status: string;
  summary?: { actualPorsiTotal?: number };
}

interface SpOpt {
  id: string;
  kode?: string;
  nama: string;
  kapasitasPorsi?: number;
}

interface DistRow {
  id: string;
  noDokumen: string;
  tanggal: string;
  sourceType: 'PLAN' | 'RESULT';
  productionPlanNo?: string;
  productionResultNo?: string;
  kitchenNama?: string;
  status: DistributionStatus;
  summary?: { lineCount: number; qtyPorsiTotal: number; servicePointCount: number };
}

function DistributionPageContent() {
  const confirm = useConfirm();
  const searchParams = useSearchParams();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<DistRow[]>([]);
  const [plans, setPlans] = useState<PlanOpt[]>([]);
  const [results, setResults] = useState<ResultOpt[]>([]);
  const [points, setPoints] = useState<SpOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [sourceType, setSourceType] = useState<'PLAN' | 'RESULT'>('PLAN');
  const [planId, setPlanId] = useState('');
  const [resultId, setResultId] = useState('');
  const [selectedPoints, setSelectedPoints] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const deepLinkHandled = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hdr = { ...actingTenantHeaders(), ...actingKitchenHeaders() };
      const [dRes, pRes, rRes, sRes] = await Promise.all([
        fetch('/api/distribution-orders', { headers: hdr }),
        fetch('/api/production-plans', { headers: hdr }),
        fetch('/api/production-results?status=COMPLETED', { headers: hdr }),
        fetch('/api/service-points?aktif=1', { headers: hdr }),
      ]);
      const dData = await dRes.json();
      const pData = await pRes.json();
      const rData = await rRes.json();
      const sData = await sRes.json();
      if (!dRes.ok) throw new Error(dData?.error || 'Gagal memuat');
      setRows(Array.isArray(dData) ? dData : []);
      setPlans((Array.isArray(pData) ? pData : []).filter((p: PlanOpt) =>
        ['APPROVED', 'PROCESSING', 'COMPLETED'].includes(p.status),
      ));
      setResults(Array.isArray(rData) ? rData : []);
      setPoints(Array.isArray(sData) ? sData : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  useEffect(() => {
    const fromPlan = searchParams.get('productionPlanId');
    const fromResult = searchParams.get('productionResultId');
    const key = fromResult ? `R:${fromResult}` : fromPlan ? `P:${fromPlan}` : null;
    if (!key) return;
    if (deepLinkHandled.current === key) return;

    if (fromResult) {
      deepLinkHandled.current = key;
      setSourceType('RESULT');
      setResultId(fromResult);
      setOpen(true);
      return;
    }
    if (!fromPlan) return;
    // Wait until results loaded so we can prefer HSL when available.
    if (loading) return;

    const hsl = results.find(
      (r) => r.productionPlanId === fromPlan && r.status === 'COMPLETED',
    );
    deepLinkHandled.current = key;
    if (hsl) {
      setSourceType('RESULT');
      setResultId(hsl.id);
      setPlanId('');
      setOpen(true);
      toast.message(`Rencana sudah punya HSL ${hsl.noDokumen} — distribusi dari Hasil Produksi`);
    } else {
      setSourceType('PLAN');
      setPlanId(fromPlan);
      setOpen(true);
    }
  }, [searchParams, results, loading]);

  function togglePoint(id: string) {
    setSelectedPoints((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function create() {
    if (sourceType === 'PLAN' && !planId) {
      toast.error('Pilih rencana produksi');
      return;
    }
    if (sourceType === 'RESULT' && !resultId) {
      toast.error('Pilih hasil produksi');
      return;
    }
    if (!selectedPoints.length) {
      toast.error('Pilih minimal satu titik layanan');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/distribution-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          sourceType,
          productionPlanId: sourceType === 'PLAN' ? planId : undefined,
          productionResultId: sourceType === 'RESULT' ? resultId : undefined,
          servicePointIds: selectedPoints,
          allocate: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal');
      toast.success(`DST ${data.noDokumen} · ${data.summary?.qtyPorsiTotal || 0} porsi`);
      setOpen(false);
      setSelectedPoints([]);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function advance(row: DistRow) {
    const next = DIST_UI_STATUS_NEXT[row.status];
    if (!next) return;
    const res = await fetch(`/api/distribution-orders/${row.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
      body: JSON.stringify({ status: next }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal');
      return;
    }
    toast.success(`Status → ${DIST_STATUS_LABELS[next]}`);
    await load();
  }

  async function cancelDist(row: DistRow) {
    const okConfirm = await confirm({
      title: 'Batalkan distribusi?',
      description: row.noDokumen,
      confirmText: 'Batalkan',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    const res = await fetch(`/api/distribution-orders/${row.id}`, {
      method: 'DELETE',
      headers: { ...actingTenantHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal');
      return;
    }
    toast.success('Distribusi dibatalkan');
    await load();
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Truck className="h-5 w-5" />
            Distribusi / Packing
          </h1>
          <p className="text-sm text-muted-foreground">
            Packing list dari Plan atau HSL ke titik layanan — kirim → terima (tanpa mutasi stok)
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
          {canManage && (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Packing baru
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">No DST</th>
              <th className="text-left p-3">Sumber</th>
              <th className="text-left p-3">Dapur</th>
              <th className="text-left p-3">Tanggal</th>
              <th className="text-right p-3">Porsi</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Belum ada distribusi</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                <td className="p-3 text-xs">
                  {row.sourceType === 'RESULT' ? 'HSL' : 'RPN'}{' '}
                  {row.productionResultNo || row.productionPlanNo}
                  {row.summary?.servicePointCount != null && (
                    <span className="text-muted-foreground"> · {row.summary.servicePointCount} titik</span>
                  )}
                </td>
                <td className="p-3">{row.kitchenNama || '—'}</td>
                <td className="p-3">{row.tanggal}</td>
                <td className="p-3 text-right">{row.summary?.qtyPorsiTotal ?? '—'}</td>
                <td className="p-3">{DIST_STATUS_LABELS[row.status]}</td>
                <td className="p-3 text-right space-x-1">
                  {canManage && DIST_UI_STATUS_NEXT[row.status] && (
                    <Button size="sm" variant="outline" onClick={() => void advance(row)}>
                      {DIST_UI_STATUS_NEXT_LABEL[row.status] || 'Lanjut'}
                    </Button>
                  )}
                  {canManage && row.status !== 'COMPLETED' && row.status !== 'CANCELLED' && (
                    <Button size="sm" variant="ghost" onClick={() => void cancelDist(row)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Packing / Distribusi baru</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Sumber</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as 'PLAN' | 'RESULT')}
              >
                <option value="PLAN">Rencana produksi (target porsi)</option>
                <option value="RESULT">Hasil produksi HSL (actual porsi)</option>
              </select>
            </div>
            {sourceType === 'PLAN' ? (
              <div className="space-y-1">
                <Label>Rencana</Label>
                <select
                  className="w-full h-10 border rounded-md px-2 text-sm"
                  value={planId}
                  onChange={(e) => setPlanId(e.target.value)}
                >
                  <option value="">—</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.noDokumen} · {p.tanggal} · {p.kitchenNama || ''}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-1">
                <Label>Hasil produksi</Label>
                <select
                  className="w-full h-10 border rounded-md px-2 text-sm"
                  value={resultId}
                  onChange={(e) => setResultId(e.target.value)}
                >
                  <option value="">—</option>
                  {results.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.noDokumen} · {r.tanggal} · {r.kitchenNama || ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-2">
              <Label>Titik layanan (alokasi otomatis berbobot kapasitas)</Label>
              <div className="max-h-48 overflow-y-auto border rounded-md p-2 space-y-1">
                {points.length === 0 && (
                  <p className="text-xs text-muted-foreground">Belum ada titik aktif — buat di Titik Layanan.</p>
                )}
                {points.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm py-1">
                    <input
                      type="checkbox"
                      checked={selectedPoints.includes(p.id)}
                      onChange={() => togglePoint(p.id)}
                    />
                    <span>
                      {p.kode ? `${p.kode} · ` : ''}{p.nama}
                      {p.kapasitasPorsi != null ? ` (${p.kapasitasPorsi} porsi)` : ''}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button onClick={() => void create()} disabled={saving}>
              {saving ? 'Menyimpan…' : 'Buat DST'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function DistributionPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Memuat distribusi…</div>}>
      <DistributionPageContent />
    </Suspense>
  );
}
