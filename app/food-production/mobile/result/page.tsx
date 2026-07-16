'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import { ArrowLeft, CheckCircle2, RefreshCw } from 'lucide-react';
import {
  RESULT_STATUS_LABELS,
  RESULT_UI_STATUS_NEXT,
  RESULT_UI_STATUS_NEXT_LABEL,
  isResultEditable,
  type ProductionResultStatus,
} from '@/lib/food-production/production-result';

const MANAGE = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface ResultLine {
  menuId: string;
  finishedGoodProductId: string;
  finishedGoodNama?: string;
  finishedGoodKode?: string;
  satuan?: string;
  targetPorsi: number;
  actualPorsi: number;
  wastePorsi?: number;
}

interface ResultRow {
  id: string;
  noDokumen: string;
  productionPlanNo?: string;
  tanggal: string;
  kitchenNama?: string;
  status: ProductionResultStatus;
  lines: ResultLine[];
  summary?: { lineCount: number; actualPorsiTotal: number; warnings?: string[] };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function ReadOnlyBanner() {
  return (
    <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-100">
      Mode lihat saja — ubah porsi/status butuh SUPERVISOR / ADMIN / OWNER.
    </div>
  );
}

export default function MobileResultPage() {
  const confirm = useConfirm();
  const canManage = useMemo(() => MANAGE.has(String((getUser() as { role?: string } | null)?.role || '')), []);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [active, setActive] = useState<ResultRow | null>(null);
  const [lines, setLines] = useState<ResultLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tanggal, setTanggal] = useState(todayIso);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [batchNo, setBatchNo] = useState('');
  const [expiryDate, setExpiryDate] = useState('');

  const hdr = () => ({ ...actingTenantHeaders(), ...actingKitchenHeaders() });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (tanggal) qs.set('tanggal', tanggal);
      const res = await fetch(`/api/production-results?${qs}`, { headers: hdr() });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat');
      const list = (Array.isArray(data) ? data : []) as ResultRow[];
      setRows(list.filter((r) => r.status !== 'CANCELLED' && r.status !== 'COMPLETED'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, [tanggal]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  async function openRow(row: ResultRow) {
    const res = await fetch(`/api/production-results/${row.id}`, { headers: hdr() });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal detail');
      return;
    }
    setActive(data as ResultRow);
    setLines(Array.isArray(data.lines) ? data.lines : []);
  }

  async function saveLines() {
    if (!active) return;
    if (!canManage) {
      toast.error('Peran Anda hanya bisa melihat');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/production-results/${active.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...hdr() },
        body: JSON.stringify({ lines }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal simpan');
      toast.success('Porsi tersimpan');
      setActive(data as ResultRow);
      setLines(data.lines || []);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(status: ProductionResultStatus, extras?: { batchNo?: string; expiryDate?: string }) {
    if (!active) return;
    if (!canManage) {
      toast.error('Peran Anda hanya bisa melihat');
      return;
    }
    try {
      const res = await fetch(`/api/production-results/${active.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...hdr() },
        body: JSON.stringify({
          status,
          ...(extras?.batchNo ? { batchNo: extras.batchNo } : {}),
          ...(extras?.expiryDate ? { expiryDate: extras.expiryDate } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal status');
      toast.success(`→ ${RESULT_STATUS_LABELS[status]}`);
      setCompleteOpen(false);
      if (status === 'COMPLETED') {
        setActive(null);
        await load();
        return;
      }
      setActive(data as ResultRow);
      setLines(data.lines || []);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  async function nextStatus() {
    if (!active) return;
    if (!canManage) {
      toast.error('Peran Anda hanya bisa melihat');
      return;
    }
    const next = RESULT_UI_STATUS_NEXT[active.status];
    if (!next) return;
    if (next === 'COMPLETED') {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 3);
      setBatchNo('');
      setExpiryDate(d.toISOString().slice(0, 10));
      setCompleteOpen(true);
      return;
    }
    await changeStatus(next);
  }

  async function confirmComplete() {
    if (!active) return;
    const ok = await confirm({
      title: 'Selesai & post stok masuk FG?',
      description: `${active.noDokumen} akan menambah stok finished good. Wajib ada PBL selesai. Tidak bisa dibatalkan.`,
      confirmText: 'Post Stok',
    });
    if (!ok) return;
    await changeStatus('COMPLETED', {
      batchNo: batchNo.trim() || undefined,
      expiryDate: expiryDate.trim() || undefined,
    });
  }

  if (active) {
    const editable = canManage && isResultEditable(active.status);
    const next = RESULT_UI_STATUS_NEXT[active.status];
    const warnings = active.summary?.warnings || [];
    return (
      <div className="mx-auto max-w-lg space-y-4 p-4 pb-24">
        <button type="button" className="flex items-center gap-1 text-sm text-muted-foreground" onClick={() => setActive(null)}>
          <ArrowLeft className="h-4 w-4" /> Kembali
        </button>
        {!canManage && <ReadOnlyBanner />}
        <div>
          <div className="font-mono text-sm text-muted-foreground">{active.noDokumen}</div>
          <h1 className="text-xl font-semibold">{active.productionPlanNo || 'Hasil'}</h1>
          <div className="text-sm">{RESULT_STATUS_LABELS[active.status]} · {active.tanggal}</div>
          {warnings.length > 0 && (
            <ul className="mt-2 space-y-1 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-100">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-3">
          {lines.map((l, idx) => (
            <div key={`${l.menuId}-${idx}`} className="rounded-xl border p-3">
              <div className="font-medium">{l.finishedGoodNama || l.finishedGoodKode || l.menuId}</div>
              <div className="text-xs text-muted-foreground">Target {l.targetPorsi} {l.satuan || 'porsi'}</div>
              {editable ? (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Aktual</Label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      className="h-12 text-lg"
                      value={l.actualPorsi}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setLines((prev) => prev.map((x, i) => (i === idx ? { ...x, actualPorsi: Number.isFinite(v) ? v : 0 } : x)));
                      }}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Waste</Label>
                    <Input
                      type="number"
                      inputMode="decimal"
                      className="h-12 text-lg"
                      value={l.wastePorsi ?? 0}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setLines((prev) => prev.map((x, i) => (i === idx ? { ...x, wastePorsi: Number.isFinite(v) ? v : 0 } : x)));
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-2xl font-semibold">
                  {l.actualPorsi}
                  {(l.wastePorsi || 0) > 0 && (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">waste {l.wastePorsi}</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="fixed inset-x-0 bottom-0 border-t bg-background p-3">
          <div className="mx-auto flex max-w-lg gap-2">
            {editable && (
              <Button className="h-12 flex-1 text-base" variant="outline" disabled={saving} onClick={() => void saveLines()}>
                Simpan Porsi
              </Button>
            )}
            {canManage && next && (
              <Button className="h-12 flex-1 text-base" onClick={() => void nextStatus()}>
                <CheckCircle2 className="mr-1 h-5 w-5" />
                {RESULT_UI_STATUS_NEXT_LABEL[active.status]}
              </Button>
            )}
          </div>
        </div>

        <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Batch & expiry</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1">
                <Label>No. batch (opsional)</Label>
                <Input className="h-12" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Expiry</Label>
                <Input type="date" className="h-12" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCompleteOpen(false)}>Batal</Button>
              <Button className="h-11" onClick={() => void confirmComplete()}>Post Stok</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-10">
      <Link href="/food-production/mobile" className="flex items-center gap-1 text-sm text-muted-foreground">
        <ArrowLeft className="h-4 w-4" /> Mode Dapur
      </Link>
      <OperationalScopeBar />
      <KitchenScopeBar />
      {!canManage && <ReadOnlyBanner />}
      <div className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Hasil Masak</h1>
          <p className="text-sm text-muted-foreground">HSL terbuka hari ini</p>
        </div>
        <Button variant="outline" size="sm" aria-label="Muat ulang" title="Muat ulang" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <Input type="date" className="h-12" value={tanggal} onChange={(e) => setTanggal(e.target.value)} />
      {loading && <p className="text-center text-muted-foreground py-8">Memuat…</p>}
      {!loading && rows.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">
          Tidak ada HSL terbuka. Buat di{' '}
          <Link href="/food-production/result" className="underline">halaman penuh</Link>.
        </p>
      )}
      <div className="space-y-2">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => void openRow(row)}
            className="flex w-full min-h-[4.5rem] flex-col items-start rounded-xl border px-4 py-3 text-left active:bg-muted/40"
          >
            <div className="font-mono text-xs text-muted-foreground">{row.noDokumen}</div>
            <div className="text-base font-semibold">{row.productionPlanNo || row.kitchenNama || '—'}</div>
            <div className="text-sm text-muted-foreground">
              {RESULT_STATUS_LABELS[row.status]} · {row.summary?.actualPorsiTotal ?? 0} porsi
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
