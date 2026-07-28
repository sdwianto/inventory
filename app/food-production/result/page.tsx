'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
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
import { mutationIdempotencyHeaders } from '@/lib/hooks/use-api-mutation';
import { useConfirm } from '@/components/ConfirmProvider';
import { Factory, Plus, RefreshCw, Trash2, Eye, CheckCircle2, History } from 'lucide-react';
import {
  RESULT_STATUS_LABELS,
  RESULT_ELIGIBLE_PLAN_STATUSES,
  RESULT_UI_STATUS_NEXT,
  RESULT_UI_STATUS_NEXT_LABEL,
  isResultEditable,
  type ProductionResultStatus,
} from '@/lib/food-production/production-result';
import { PLAN_STATUS_LABELS, type ProductionPlanStatus } from '@/lib/food-production/production-plan';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

/** Current local date-time as `YYYY-MM-DDTHH:mm` for <input type="datetime-local">. */
function nowLocalDatetime(): string {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

interface PlanOpt {
  id: string;
  noDokumen: string;
  tanggal: string;
  kitchenNama?: string;
  status: string;
}

interface ResultLine {
  menuId: string;
  menuKode?: string;
  menuNama?: string;
  recipeId?: string;
  recipeKode?: string;
  recipeNama?: string;
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  satuan?: string;
  targetPorsi: number;
  actualPorsi: number;
  wastePorsi?: number;
}

interface ResultHistoryEntry {
  at?: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  userName?: string;
  note?: string;
}

interface ResultRow {
  id: string;
  noDokumen: string;
  productionPlanId: string;
  productionPlanNo?: string;
  materialIssueNo?: string;
  tanggal: string;
  kitchenNama?: string;
  warehouseKode: string;
  status: ProductionResultStatus;
  summary?: {
    lineCount: number;
    actualPorsiTotal: number;
    warnings?: string[];
  };
  lines: ResultLine[];
  history?: ResultHistoryEntry[];
}

function FoodProductionResultPageContent() {
  const confirm = useConfirm();
  const router = useRouter();
  const searchParams = useSearchParams();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<ResultRow[]>([]);
  const [plans, setPlans] = useState<PlanOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [detail, setDetail] = useState<ResultRow | null>(null);
  const [planId, setPlanId] = useState('');
  const [saving, setSaving] = useState(false);
  const [editLines, setEditLines] = useState<ResultLine[]>([]);
  const [filterTanggal, setFilterTanggal] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<ResultRow | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completeTarget, setCompleteTarget] = useState<ResultRow | null>(null);
  const [completeBatchNo, setCompleteBatchNo] = useState('');
  const [completeExpiry, setCompleteExpiry] = useState('');
  const [deepLinkHandled, setDeepLinkHandled] = useState(false);
  const [resultAkg, setResultAkg] = useState<{
    perPorsi: { energiKcal: number; proteinG: number };
    perPorsiAkgPct: { energiKcal?: number; proteinG?: number };
    akgProfile: string;
    warnings: string[];
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filterStatus) qs.set('status', filterStatus);
      if (filterTanggal) qs.set('tanggal', filterTanggal);
      const resultUrl = qs.toString() ? `/api/production-results?${qs}` : '/api/production-results';
      const [rRes, pRes, allRes] = await Promise.all([
        fetch(resultUrl, { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
        fetch('/api/production-plans', { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
        fetch('/api/production-results', { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
      ]);
      const rData = await rRes.json();
      const pData = await pRes.json();
      const allData = await allRes.json();
      if (!rRes.ok) throw new Error(rData?.error || 'Gagal memuat');
      const list = Array.isArray(rData) ? rData as ResultRow[] : [];
      setRows(list);
      const planList = (Array.isArray(pData) ? pData : []).filter((p: PlanOpt) =>
        RESULT_ELIGIBLE_PLAN_STATUSES.has(p.status),
      ) as PlanOpt[];
      const allResults = Array.isArray(allData) ? allData as ResultRow[] : [];
      const usedPlanIds = new Set(
        allResults
          .filter((r) => r.status !== 'CANCELLED')
          .map((r) => r.productionPlanId),
      );
      setPlans(planList.filter((p) => !usedPlanIds.has(p.id)));
      return { list, planList: planList.filter((p) => !usedPlanIds.has(p.id)) };
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
      return { list: [] as ResultRow[], planList: [] as PlanOpt[] };
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterTanggal]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  useEffect(() => {
    if (!detail?.id) {
      setResultAkg(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/nutrition-profiles/analyze?scope=result&id=${encodeURIComponent(detail.id)}&akg=PORSI_KECIL`,
          { headers: { ...actingTenantHeaders() } },
        );
        const data = await res.json();
        if (!res.ok || cancelled) return;
        setResultAkg({
          perPorsi: {
            energiKcal: Number(data.perPorsi?.energiKcal) || 0,
            proteinG: Number(data.perPorsi?.proteinG) || 0,
          },
          perPorsiAkgPct: {
            energiKcal: Number(data.perPorsiAkgPct?.energiKcal) || 0,
            proteinG: Number(data.perPorsiAkgPct?.proteinG) || 0,
          },
          akgProfile: String(data.akgProfile || 'PORSI_KECIL'),
          warnings: Array.isArray(data.warnings) ? data.warnings : [],
        });
      } catch {
        if (!cancelled) setResultAkg(null);
      }
    })();
    return () => { cancelled = true; };
  }, [detail?.id, detail?.status, detail?.summary?.actualPorsiTotal]);

  useEffect(() => {
    if (deepLinkHandled || loading) return;
    const fromPlan = searchParams.get('productionPlanId');
    const highlight = searchParams.get('highlight');
    if (!fromPlan && !highlight) return;

    void (async () => {
      setDeepLinkHandled(true);
      const { list, planList } = await load();

      if (highlight) {
        const hit = list.find((r) => r.id === highlight)
          || (await (async () => {
            const res = await fetch(`/api/production-results/${highlight}`, {
              headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
            });
            if (!res.ok) return null;
            return res.json() as Promise<ResultRow>;
          })());
        if (hit) {
          setDetail(hit);
          setEditLines(Array.isArray(hit.lines) ? hit.lines : []);
          return;
        }
        toast.error('Dokumen hasil tidak ditemukan');
        return;
      }

      if (fromPlan) {
        const byPlanRes = await fetch(
          `/api/production-results?productionPlanId=${encodeURIComponent(fromPlan)}`,
          { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } },
        );
        const byPlanData = await byPlanRes.json();
        const existing = Array.isArray(byPlanData)
          ? (byPlanData as ResultRow[]).find((r) => r.status !== 'CANCELLED')
          : undefined;
        if (existing) {
          const res = await fetch(`/api/production-results/${existing.id}`, {
            headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
          });
          const data = await res.json();
          if (res.ok) {
            setDetail(data as ResultRow);
            setEditLines(Array.isArray(data.lines) ? data.lines : []);
          } else {
            setDetail(existing);
            setEditLines(existing.lines || []);
          }
          toast.message(`Membuka ${existing.noDokumen}`);
          return;
        }
        if (!planList.some((p) => p.id === fromPlan)) {
          toast.error(
            'Rencana tidak tersedia untuk buat HSL. Pastikan status Disetujui/Diproses (atau Selesai catch-up) dan belum punya HSL.',
          );
          return;
        }
        setPlanId(fromPlan);
        setOpenCreate(true);
      }
    })();
  }, [searchParams, deepLinkHandled, loading, load]);

  async function openDetail(row: ResultRow) {
    const res = await fetch(`/api/production-results/${row.id}`, {
      headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal detail');
      setDetail(row);
      setEditLines(row.lines || []);
      return;
    }
    setDetail(data as ResultRow);
    setEditLines(Array.isArray(data.lines) ? data.lines : []);
  }

  async function createResult() {
    if (!planId) {
      toast.error('Pilih rencana produksi');
      return;
    }
    setSaving(true);
    try {
      const url = '/api/production-results';
      const body = JSON.stringify({ productionPlanId: planId });
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...actingTenantHeaders(),
          ...actingKitchenHeaders(),
          ...mutationIdempotencyHeaders(url, 'POST', body),
        },
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membuat');
      toast.success(`Hasil ${data.noDokumen} siap — isi actual porsi lalu ajukan`);
      if (data.summary?.warnings?.[0]) toast.message(data.summary.warnings[0]);
      setOpenCreate(false);
      setPlanId('');
      router.replace('/food-production/result');
      await load();
      setDetail(data as ResultRow);
      setEditLines(data.lines || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal membuat');
    } finally {
      setSaving(false);
    }
  }

  async function saveLines() {
    if (!detail) return;
    setSaving(true);
    try {
      const url = `/api/production-results/${detail.id}`;
      const body = JSON.stringify({ lines: editLines });
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...actingTenantHeaders(),
          ...actingKitchenHeaders(),
          ...mutationIdempotencyHeaders(url, 'PUT', body),
        },
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal simpan');
      toast.success('Porsi tersimpan');
      setDetail(data as ResultRow);
      setEditLines(data.lines || []);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal simpan');
    } finally {
      setSaving(false);
    }
  }

  function openComplete(row: ResultRow) {
    setCompleteTarget(row);
    setCompleteBatchNo('');
    setCompleteExpiry(nowLocalDatetime());
    setCompleteOpen(true);
  }

  async function changeStatus(
    row: ResultRow,
    status: ProductionResultStatus,
    extras?: { batchNo?: string; expiryDate?: string },
  ) {
    if (status === 'COMPLETED' && !extras) {
      openComplete(row);
      return;
    }
    try {
      const url = `/api/production-results/${row.id}/status`;
      const body = JSON.stringify({
        status,
        ...(extras?.batchNo ? { batchNo: extras.batchNo } : {}),
        ...(extras?.expiryDate ? { expiryDate: extras.expiryDate } : {}),
      });
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...actingTenantHeaders(),
          ...actingKitchenHeaders(),
          ...mutationIdempotencyHeaders(url, 'POST', body),
        },
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal ubah status');
      toast.success(
        status === 'COMPLETED'
          ? 'Hasil selesai — siap distribusi (tanpa post stok FG)'
          : `Status → ${RESULT_STATUS_LABELS[status]}`,
      );
      setCompleteOpen(false);
      setCompleteTarget(null);
      await load();
      if (status === 'COMPLETED' || status === 'CANCELLED') {
        // Selesai/batal: tutup card detail (jangan biarkan modal tetap terbuka).
        if (detail?.id === row.id) {
          setDetail(null);
          setEditLines([]);
        }
      } else if (detail?.id === row.id) {
        setDetail(data as ResultRow);
        setEditLines(data.lines || []);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  async function confirmComplete() {
    if (!completeTarget) return;
    if (completeExpiry && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(completeExpiry)) {
      toast.error('Format expiry tidak valid');
      return;
    }
    const okConfirm = await confirm({
      title: 'Selesaikan hasil produksi?',
      description: completeTarget.materialIssueNo
        ? `${completeTarget.noDokumen} — catat selesai. Mode MBG: stok barang jadi tidak ditambah; lanjut distribusi dari porsi.`
        : `${completeTarget.noDokumen} — belum ada PBL selesai. Selesaikan Pengeluaran Stok dulu.`,
      confirmText: 'Selesai',
    });
    if (!okConfirm) return;
    if (!completeTarget.materialIssueNo) {
      toast.error('Belum ada PBL selesai — selesaikan Pengeluaran Stok dulu');
      return;
    }
    await changeStatus(completeTarget, 'COMPLETED', {
      batchNo: completeBatchNo.trim() || undefined,
      expiryDate: completeExpiry.trim() || undefined,
    });
  }

  async function cancelResult(row: ResultRow) {
    const okConfirm = await confirm({
      title: 'Batalkan hasil produksi?',
      description: row.noDokumen,
      confirmText: 'Batalkan',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    const res = await fetch(`/api/production-results/${row.id}`, {
      method: 'DELETE',
      headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal');
      return;
    }
    toast.success('Dibatalkan');
    if (detail?.id === row.id) setDetail(null);
    await load();
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Factory className="h-5 w-5" />
            Hasil Produksi
          </h1>
          <p className="text-sm text-muted-foreground">
            Catat actual porsi masak — MBG: langsung distribusi, tanpa masuk stok barang jadi
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="space-y-1">
            <Label className="text-xs">Filter tanggal</Label>
            <Input
              type="date"
              value={filterTanggal}
              onChange={(e) => setFilterTanggal(e.target.value)}
              className="h-9 w-[11rem]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Status</Label>
            <select
              className="h-9 border rounded-md px-2 text-sm bg-white min-w-[9rem]"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="">Semua</option>
              {(Object.keys(RESULT_STATUS_LABELS) as ProductionResultStatus[]).map((s) => (
                <option key={s} value={s}>{RESULT_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
          {(filterTanggal || filterStatus) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilterTanggal('');
                setFilterStatus('');
              }}
            >
              Reset filter
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat ulang
          </Button>
          {canManage && (
            <Button
              size="sm"
              onClick={() => {
                setPlanId('');
                setOpenCreate(true);
              }}
            >
              <Plus className="h-4 w-4 mr-1" /> Dari Rencana
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">No HSL</th>
              <th className="text-left p-3">Rencana / Issue</th>
              <th className="text-left p-3">Tanggal</th>
              <th className="text-left p-3">Dapur</th>
              <th className="text-left p-3">Actual</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center space-y-3">
                  <p className="text-muted-foreground">
                    Belum ada dokumen HSL. Setelah bahan dikeluarkan, buat hasil dari rencana yang
                    Disetujui / Diproses.
                  </p>
                  {canManage && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setPlanId('');
                        setOpenCreate(true);
                      }}
                    >
                      <Plus className="h-4 w-4 mr-1" /> Buat dari Rencana
                    </Button>
                  )}
                  <div>
                    <Link href="/food-production/plan" className="text-sm text-primary hover:underline">
                      Ke Rencana Produksi →
                    </Link>
                  </div>
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const next = RESULT_UI_STATUS_NEXT[row.status];
              return (
                <tr key={row.id} className="border-t">
                  <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                  <td className="p-3">
                    <div className="font-mono text-xs">{row.productionPlanNo}</div>
                    <div className="text-[11px] text-muted-foreground">{row.materialIssueNo || '— PBL'}</div>
                  </td>
                  <td className="p-3">{row.tanggal}</td>
                  <td className="p-3">{row.kitchenNama || '—'}</td>
                  <td className="p-3">{row.summary?.actualPorsiTotal ?? '—'}</td>
                  <td className="p-3">{RESULT_STATUS_LABELS[row.status]}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1 justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        title="Detail"
                        onClick={() => void openDetail(row)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        title="Riwayat"
                        onClick={() => {
                          setHistoryRow(row);
                          setHistoryOpen(true);
                        }}
                      >
                        <History className="h-4 w-4" />
                      </Button>
                      {canManage && next && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void changeStatus(row, next)}
                        >
                          {RESULT_UI_STATUS_NEXT_LABEL[row.status]}
                        </Button>
                      )}
                      {canManage && row.status !== 'CANCELLED' && row.status !== 'COMPLETED' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void cancelResult(row)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog
        open={openCreate}
        onOpenChange={(o) => {
          setOpenCreate(o);
          if (!o) setPlanId('');
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Buat Hasil Produksi</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label>Rencana produksi</Label>
            {plans.length === 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
                <p>
                  Tidak ada rencana siap buat HSL. Pilih rencana status Disetujui/Diproses
                  (setelah PBL) — atau rencana Selesai tanpa HSL (catch-up).
                </p>
                <Link href="/food-production/plan" className="text-primary hover:underline text-xs">
                  Buka Rencana Produksi →
                </Link>
              </div>
            ) : (
              <select
                className="w-full h-10 border rounded-md px-2 text-sm bg-white"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
              >
                <option value="">— Pilih —</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.noDokumen} · {p.tanggal} · {p.kitchenNama || 'Dapur'} ·{' '}
                    {PLAN_STATUS_LABELS[p.status as ProductionPlanStatus] || p.status}
                  </option>
                ))}
              </select>
            )}
            <p className="text-xs text-muted-foreground">
              Setelah dibuat: isi actual/waste → Ajukan → Setujui → Selesai (tanpa post stok FG).
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpenCreate(false)}>
              Batal
            </Button>
            <Button
              type="button"
              onClick={() => void createResult()}
              disabled={saving || !planId || plans.length === 0}
            >
              {saving ? 'Memproses…' : 'Buat'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detail?.noDokumen} — {detail ? RESULT_STATUS_LABELS[detail.status] : ''}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="text-muted-foreground">
                Rencana{' '}
                <Link href="/food-production/plan" className="text-primary font-mono hover:underline">
                  {detail.productionPlanNo}
                </Link>
                {detail.materialIssueNo ? ` · Issue ${detail.materialIssueNo}` : ' · PBL belum terhubung'}
                {' · '}{detail.tanggal} · {detail.kitchenNama}
              </div>
              {!!detail.summary?.warnings?.length && (
                <ul className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2 space-y-1">
                  {detail.summary.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
              {resultAkg && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50/70 px-3 py-2 space-y-1">
                  <div className="text-xs font-medium text-emerald-900">
                    {detail.status === 'COMPLETED' ? 'AKG aktual / porsi' : 'Est. AKG / porsi (dari actual saat ini)'}
                    <span className="font-normal text-emerald-800/80"> · profil {resultAkg.akgProfile}</span>
                  </div>
                  <div className="text-sm tabular-nums text-emerald-950">
                    ~{Math.round(resultAkg.perPorsi.energiKcal)} kkal
                    {' · '}
                    {resultAkg.perPorsi.proteinG.toLocaleString('id-ID', { maximumFractionDigits: 1 })} g protein
                    {' · '}
                    {resultAkg.perPorsiAkgPct.energiKcal ?? 0}% energi AKG
                    {' · '}
                    {resultAkg.perPorsiAkgPct.proteinG ?? 0}% protein AKG
                  </div>
                  {!!resultAkg.warnings.length && (
                    <p className="text-[11px] text-amber-800">{resultAkg.warnings.join(' · ')}</p>
                  )}
                </div>
              )}
              {!detail.materialIssueNo && detail.status !== 'COMPLETED' && detail.status !== 'CANCELLED' && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">
                  Post stok FG membutuhkan PBL selesai.{' '}
                  <Link
                    href={`/stok/pengeluaran?mode=produksi&productionPlanId=${detail.productionPlanId}`}
                    className="text-primary hover:underline"
                  >
                    Ke Pengeluaran Stok →
                  </Link>
                </p>
              )}
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left p-2">Menu / Resep</th>
                      <th className="text-right p-2">Target</th>
                      <th className="text-right p-2">Actual</th>
                      <th className="text-right p-2">Waste</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(isResultEditable(detail.status) ? editLines : detail.lines || []).map((l, idx) => (
                      <tr key={`${l.menuId}-${l.finishedGoodProductId}-${idx}`} className="border-t">
                        <td className="p-2">
                          <div>{l.finishedGoodNama || l.recipeNama || l.menuNama || l.finishedGoodKode || l.recipeKode}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {[l.menuKode, l.recipeKode].filter(Boolean).join(' · ') || '—'}
                          </div>
                        </td>
                        <td className="p-2 text-right">{l.targetPorsi}</td>
                        <td className="p-2 text-right">
                          {isResultEditable(detail.status) && canManage ? (
                            <Input
                              type="number"
                              className="h-8 w-24 ml-auto text-right"
                              value={l.actualPorsi}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                setEditLines((prev) => prev.map((x, i) =>
                                  i === idx ? { ...x, actualPorsi: v } : x,
                                ));
                              }}
                            />
                          ) : l.actualPorsi}
                        </td>
                        <td className="p-2 text-right">
                          {isResultEditable(detail.status) && canManage ? (
                            <Input
                              type="number"
                              className="h-8 w-20 ml-auto text-right"
                              value={l.wastePorsi ?? 0}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                setEditLines((prev) => prev.map((x, i) =>
                                  i === idx ? { ...x, wastePorsi: v } : x,
                                ));
                              }}
                            />
                          ) : (l.wastePorsi ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {canManage && isResultEditable(detail.status) && (
                  <Button type="button" size="sm" onClick={() => void saveLines()} disabled={saving}>
                    Simpan porsi
                  </Button>
                )}
                {canManage && RESULT_UI_STATUS_NEXT[detail.status] && detail.status !== 'APPROVED' && detail.status !== 'PROCESSING' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void changeStatus(detail, RESULT_UI_STATUS_NEXT[detail.status]!)}
                  >
                    {RESULT_UI_STATUS_NEXT_LABEL[detail.status]}
                  </Button>
                )}
                {(detail.status === 'APPROVED' || detail.status === 'PROCESSING') && canManage && (
                  <Button
                    type="button"
                    size="sm"
                    className="bg-green-600 hover:bg-green-700 text-white"
                    disabled={!detail.materialIssueNo}
                    title={!detail.materialIssueNo ? 'Butuh PBL selesai' : undefined}
                    onClick={() => void changeStatus(detail, 'COMPLETED')}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1" /> Selesai
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={completeOpen} onOpenChange={setCompleteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Selesai — batch & expiry (opsional)</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              {completeTarget?.noDokumen} — MBG tidak menambah stok barang jadi. Batch opsional untuk jejak produksi.
            </p>
            <div className="space-y-1">
              <Label>Batch no (opsional)</Label>
              <Input
                value={completeBatchNo}
                onChange={(e) => setCompleteBatchNo(e.target.value)}
                placeholder="Auto jika kosong"
              />
            </div>
            <div className="space-y-1">
              <Label>Expiry (tanggal &amp; jam)</Label>
              <Input
                type="datetime-local"
                value={completeExpiry}
                onChange={(e) => setCompleteExpiry(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCompleteOpen(false)}>
              Batal
            </Button>
            <Button type="button" onClick={() => void confirmComplete()}>
              <CheckCircle2 className="h-4 w-4 mr-1" /> Selesai
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Riwayat {historyRow?.noDokumen || ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            {(historyRow?.history || []).length === 0 && (
              <p className="text-sm text-muted-foreground">Belum ada riwayat.</p>
            )}
            {(historyRow?.history || []).map((h, i) => (
              <div key={i} className="border rounded-md p-2 text-sm">
                <div className="font-medium">
                  {h.fromStatus || '—'} → {h.toStatus || '—'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {h.at ? new Date(h.at).toLocaleString('id-ID') : '—'}
                  {h.userName ? ` · ${h.userName}` : ''}
                </div>
                {h.note && <div className="text-xs mt-1">{h.note}</div>}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setHistoryOpen(false)}>
              Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function FoodProductionResultPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Memuat hasil produksi…</div>}>
      <FoodProductionResultPageContent />
    </Suspense>
  );
}
