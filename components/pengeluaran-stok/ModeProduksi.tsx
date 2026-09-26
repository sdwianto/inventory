'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { mutationIdempotencyHeaders } from '@/lib/hooks/use-api-mutation';
import { useConfirm } from '@/components/ConfirmProvider';
import { StockReversalSection, PendingStockReversals } from '@/components/stok/StockReversal';
import type { JsonObject } from '@/types/json';
import { ArrowUpFromLine, Plus, RefreshCw, Trash2, Eye, CheckCircle2, History } from 'lucide-react';
import {
  ISSUE_STATUS_LABELS,
  ISSUE_ELIGIBLE_PLAN_STATUSES,
  ISSUE_UI_STATUS_NEXT,
  ISSUE_UI_STATUS_NEXT_LABEL,
  isIssueEditable,
  isIssueReconcilable,
  poOutstandingQty,
  referenceSourceLabel,
  type MaterialIssueStatus,
} from '@/lib/food-production/material-issue';
import {
  parseQtyInput,
  shouldSnapSpinnerStep,
  stepQtyFromSpinner,
} from '@/lib/qty-spinner';

const WAREHOUSE_LABELS: Record<string, string> = {
  GKERING: 'Gudang Kering',
  GBASAH: 'Gudang Basah',
  GJANITOR: 'Gudang Janitor',
};

function warehouseLabel(kode?: string | null): string {
  const k = String(kode || '').trim().toUpperCase();
  return WAREHOUSE_LABELS[k] || k || '—';
}

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface PlanOpt {
  id: string;
  noDokumen: string;
  tanggal: string;
  kitchenNama?: string;
  status: string;
}

interface ReconcileLineView {
  productId: string;
  qtyPlanned: number;
  qtyAlreadyIssuedOperational: number;
  qtyAlreadyIssuedPbl: number;
  qtyAlreadyIssued: number;
  qtyRemaining: number;
  qtyOnHand: number;
  suggestedQtyIssued: number;
  mismatch: boolean;
}

interface PlanReferenceLineView {
  productIds: string[];
  sumber: 'PO' | 'MRP' | 'NONE';
  acuanQty: number;
  poQtyOrdered?: number;
  poQtyReceived?: number;
  rlPosted: number;
  pblPosted?: number;
  rlPending?: number;
  sisa: number;
  qtyOnHand?: number;
  satuan?: string;
}

interface IssueReconciliation {
  lines: ReconcileLineView[];
  summary: { mismatchCount: number; suggestedQtyIssuedTotal: number };
  /** Hanya bila flag rlFromPoReference aktif. */
  reference?: { lines: PlanReferenceLineView[] };
}

interface IssueLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  warehouseKode?: string;
  qtyPlanned: number;
  qtyIssued: number;
  productIds?: string[];
  sumber?: 'PO' | 'MRP' | 'NONE';
  acuanQty?: number;
  poQtyReceived?: number;
  rlPosted?: number;
  pblPosted?: number;
  sisa?: number;
}

interface IssueHistoryEntry {
  at?: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  userName?: string;
  note?: string;
}

interface IssueRow {
  id: string;
  noDokumen: string;
  productionPlanId: string;
  productionPlanNo?: string;
  materialRequirementId?: string;
  materialRequirementNo?: string;
  tanggal: string;
  kitchenNama?: string;
  warehouseKode: string;
  status: MaterialIssueStatus;
  summary?: { lineCount: number; qtyIssuedTotal: number; rlPostedTotal?: number; sisaLineCount?: number; poOutstandingLineCount?: number };
  lines: IssueLine[];
  history?: IssueHistoryEntry[];
  stockPostedAt?: string;
  /** REFERENCE: PBL acuan — tidak mengurangi stok; bahan keluar lewat RL. */
  stockMode?: 'STOCK' | 'REFERENCE';
  referenceSnapshotAt?: string;
}

function isReferenceRow(row: Pick<IssueRow, 'stockMode'> | null | undefined): boolean {
  return row?.stockMode === 'REFERENCE';
}

export function ModeProduksi({ initialPlanId }: { initialPlanId?: string }) {
  const confirm = useConfirm();
  const router = useRouter();
  const searchParams = useSearchParams();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<IssueRow[]>([]);
  const [plans, setPlans] = useState<PlanOpt[]>([]);
  const [completedPblPlanIds, setCompletedPblPlanIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [detail, setDetail] = useState<IssueRow | null>(null);
  const [planId, setPlanId] = useState('');
  const [mrpId, setMrpId] = useState('');
  const [saving, setSaving] = useState(false);
  const [planReadiness, setPlanReadiness] = useState<{
    shortageCount: number;
    shortageLines: Array<{ productKode?: string; productNama?: string; qtyNet?: number; satuan?: string }>;
    issueCompleted?: boolean;
    completedIssueNo?: string | null;
    pblReferenceMode?: boolean;
    sisaLineCount?: number;
    poOutstandingLineCount?: number;
  } | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [overrideShortage, setOverrideShortage] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [editLines, setEditLines] = useState<IssueLine[]>([]);
  const [filterTanggal, setFilterTanggal] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<IssueRow | null>(null);
  const [reconciliation, setReconciliation] = useState<IssueReconciliation | null>(null);
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [adjustReason, setAdjustReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filterStatus) qs.set('status', filterStatus);
      if (filterTanggal) qs.set('tanggal', filterTanggal);
      const issueUrl = qs.toString() ? `/api/material-issues?${qs}` : '/api/material-issues';
      const [iRes, pRes, completedRes] = await Promise.all([
        fetch(issueUrl, { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
        fetch('/api/production-plans', { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
        fetch('/api/material-issues?status=COMPLETED', {
          headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
        }),
      ]);
      const iData = await iRes.json();
      const pData = await pRes.json();
      const completedData = await completedRes.json();
      if (!iRes.ok) throw new Error(iData?.error || 'Gagal memuat');
      setRows(Array.isArray(iData) ? iData : []);
      setPlans((Array.isArray(pData) ? pData : []).filter((p: PlanOpt) =>
        ISSUE_ELIGIBLE_PLAN_STATUSES.has(p.status),
      ));
      const donePlanIds = new Set<string>();
      for (const row of (Array.isArray(completedData) ? completedData : []) as IssueRow[]) {
        if (row.productionPlanId) donePlanIds.add(row.productionPlanId);
      }
      setCompletedPblPlanIds(donePlanIds);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterTanggal]);

  const creatablePlans = useMemo(
    () => plans.filter((p) => !completedPblPlanIds.has(p.id)),
    [plans, completedPblPlanIds],
  );

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  useEffect(() => {
    const fromPlan = initialPlanId || searchParams.get('productionPlanId');
    const fromMrp = searchParams.get('materialRequirementId');
    if (fromPlan) {
      setPlanId(fromPlan);
      setOpenCreate(true);
    }
    if (fromMrp) setMrpId(fromMrp);
  }, [initialPlanId, searchParams]);

  // Bahan boleh belum 100% lengkap (blokir lunak) — cek kekurangan begitu plan dipilih,
  // supaya admin bisa lihat & konfirmasi + alasan sebelum submit, bukan gagal di server.
  useEffect(() => {
    setOverrideShortage(false);
    setOverrideReason('');
    if (!planId) {
      setPlanReadiness(null);
      return;
    }
    let cancelled = false;
    setReadinessLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/production-plans/${planId}/material-readiness`, {
          headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setPlanReadiness(null);
          return;
        }
        setPlanReadiness({
          shortageCount: Number(data.shortageCount || 0),
          shortageLines: Array.isArray(data.shortageLines) ? data.shortageLines : [],
          issueCompleted: data.issueCompleted === true,
          completedIssueNo: data.completedIssueNo ? String(data.completedIssueNo) : null,
          pblReferenceMode: data.pblReferenceMode === true,
          sisaLineCount: Number(data.sisaLineCount || 0),
          poOutstandingLineCount: Number(data.poOutstandingLineCount || 0),
        });
      } catch {
        if (!cancelled) setPlanReadiness(null);
      } finally {
        if (!cancelled) setReadinessLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [planId]);

  async function loadReconciliation(issueId: string) {
    setReconcileLoading(true);
    try {
      const res = await fetch(`/api/material-issues/${issueId}/reconciliation`, {
        headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
      });
      const data = await res.json();
      if (!res.ok) {
        setReconciliation(null);
        return;
      }
      setReconciliation(data as IssueReconciliation);
    } catch {
      setReconciliation(null);
    } finally {
      setReconcileLoading(false);
    }
  }

  async function openDetail(row: IssueRow) {
    const res = await fetch(`/api/material-issues/${row.id}`, { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal detail');
      setDetail(row);
      return;
    }
    setDetail(data as IssueRow);
    setEditLines(Array.isArray(data.lines) ? data.lines : []);
    void loadReconciliation(row.id);
  }

  async function syncFromOperational(reason?: string) {
    if (!detail) return;
    const needsReason = detail.status === 'APPROVED' || detail.status === 'PROCESSING';
    if (needsReason && !reason?.trim()) {
      toast.error('Isi alasan penyesuaian dulu');
      return;
    }
    setSaving(true);
    try {
      const url = `/api/material-issues/${detail.id}/reconcile`;
      const body = JSON.stringify({ reason: reason?.trim() || undefined });
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
      if (!res.ok) throw new Error(data?.error || 'Gagal sinkron');
      toast.success(isReferenceRow(detail)
        ? 'Acuan diperbarui dari PO/MRP & RL terbaru'
        : 'Qty disinkronkan dari stok & release operasional');
      setDetail(data as IssueRow);
      setEditLines(Array.isArray(data.lines) ? data.lines : []);
      setAdjustReason('');
      await loadReconciliation(detail.id);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal sinkron');
    } finally {
      setSaving(false);
    }
  }

  function reconcileForProduct(productId: string): ReconcileLineView | undefined {
    return reconciliation?.lines.find((l) => l.productId === productId);
  }

  function referenceForProduct(productId: string): PlanReferenceLineView | undefined {
    return reconciliation?.reference?.lines.find((l) => l.productIds.includes(productId));
  }

  async function createIssue() {
    if (!planId) {
      toast.error('Pilih rencana produksi');
      return;
    }
    if (planReadiness?.issueCompleted) {
      toast.error(
        planReadiness.completedIssueNo
          ? `PBL ${planReadiness.completedIssueNo} sudah selesai — buka detail & Sinkron, jangan buat PBL baru`
          : 'PBL untuk rencana ini sudah selesai',
      );
      return;
    }
    const shortageCount = planReadiness?.shortageCount || 0;
    if (shortageCount > 0 && (!overrideShortage || !overrideReason.trim())) {
      toast.error('Centang "Proses meski belum lengkap" dan isi alasan dulu');
      return;
    }
    setSaving(true);
    try {
      const url = '/api/material-issues';
      const body = JSON.stringify({
        productionPlanId: planId,
        ...(mrpId ? { materialRequirementId: mrpId } : {}),
        ...(shortageCount > 0 ? {
          overrideShortage: true,
          overrideShortageNote: overrideReason.trim(),
        } : {}),
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
      if (!res.ok) throw new Error(data?.error || 'Gagal membuat');
      toast.success(`Issue ${data.noDokumen} siap`);
      setOpenCreate(false);
      setPlanId('');
      setMrpId('');
      await load();
      setDetail(data as IssueRow);
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
      const url = `/api/material-issues/${detail.id}`;
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
      toast.success('Qty tersimpan');
      setDetail(data as IssueRow);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal simpan');
    } finally {
      setSaving(false);
    }
  }

  async function postStatus(
    rowId: string,
    status: MaterialIssueStatus,
    extra: Record<string, unknown> = {},
  ) {
    const url = `/api/material-issues/${rowId}/status`;
    const body = JSON.stringify({ status, ...extra });
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
    return data as IssueRow;
  }

  async function fetchReconciliation(issueId: string): Promise<IssueReconciliation | null> {
    try {
      const res = await fetch(`/api/material-issues/${issueId}/reconciliation`, {
        headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
      });
      return res.ok ? await res.json() as IssueReconciliation : null;
    } catch {
      return null;
    }
  }

  /** PBL acuan: konfirmasi selesai tanpa mutasi stok; sisa acuan / RL tertunda wajib catatan. */
  async function confirmReferenceIssue(row: IssueRow) {
    const rec = detail?.id === row.id && reconciliation ? reconciliation : await fetchReconciliation(row.id);
    const sisaLines = (rec?.reference?.lines || []).filter((l) => l.sisa > 0);
    const askNote = (message: string): string | null => {
      const typed = (adjustReason.trim() || window.prompt(message)?.trim() || '');
      if (typed.length < 5) {
        toast.error('Catatan konfirmasi wajib (min. 5 karakter)');
        return null;
      }
      return typed;
    };
    let note = '';
    if (sisaLines.length) {
      const asked = askNote(
        `${sisaLines.length} bahan belum keluar penuh lewat RL. Catatan konfirmasi (min. 5 karakter):`,
      );
      if (!asked) return;
      note = asked;
    }
    const okConfirm = await confirm({
      title: 'Konfirmasi PBL acuan?',
      description: `${row.noDokumen} — tidak ada stok yang dikurangi. Bahan keluar dari gudang lewat Release (RL); `
        + 'PBL ini mengonfirmasi acuan rencana.',
      confirmText: 'Konfirmasi Selesai',
    });
    if (!okConfirm) return;

    setSaving(true);
    try {
      let current = row;
      if (current.status === 'DRAFT') current = await postStatus(current.id, 'SUBMITTED');
      if (current.status === 'SUBMITTED') current = await postStatus(current.id, 'APPROVED');
      if (current.status === 'APPROVED' || current.status === 'PROCESSING') {
        try {
          current = await postStatus(current.id, 'COMPLETED', note ? { note } : {});
        } catch (e) {
          const msg = e instanceof Error ? e.message : '';
          if (note || !msg.includes('catatan konfirmasi')) throw e;
          const asked = askNote(`${msg}\n\nCatatan konfirmasi:`);
          if (!asked) {
            await load();
            return;
          }
          current = await postStatus(current.id, 'COMPLETED', { note: asked });
        }
      }
      toast.success('PBL acuan dikonfirmasi — tanpa mutasi stok');
      setDetail(null);
      setAdjustReason('');
      await load();
      router.push('/food-production/plan');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal konfirmasi PBL');
      await load();
    } finally {
      setSaving(false);
    }
  }

  /** Setujui / Keluarkan Stok: dialog konfirmasi → post stok → toast → Rencana Produksi. */
  async function approveAndReleaseStock(row: IssueRow) {
    if (isReferenceRow(row)) {
      await confirmReferenceIssue(row);
      return;
    }
    const lines = detail?.id === row.id ? editLines : (row.lines || []);
    const qtyTotal = lines.reduce((s, l) => s + (Number(l.qtyIssued) || 0), 0);
    const isClosure = qtyTotal === 0;

    if (!isClosure && reconciliation && reconciliation.summary.mismatchCount > 0) {
      toast.error('Sinkron dari stok & release operasional dulu — ada baris tidak sesuai');
      return;
    }

    if (isClosure) {
      const reason = adjustReason.trim()
        || window.prompt(
          'Penutupan administratif — bahan sudah keluar via RL. Alasan (wajib):',
        )?.trim();
      if (!reason) {
        toast.error('Alasan penutupan administratif wajib diisi');
        return;
      }
      const okConfirm = await confirm({
        title: 'Tutup PBL administratif?',
        description: `${row.noDokumen} — semua qty keluar = 0. Tidak ada stok yang diposting ulang.`,
        confirmText: 'Tutup PBL',
      });
      if (!okConfirm) return;

      setSaving(true);
      try {
        let current = row;
        if (current.status === 'DRAFT') current = await postStatus(current.id, 'SUBMITTED');
        if (current.status === 'SUBMITTED') current = await postStatus(current.id, 'APPROVED');
        if (current.status === 'APPROVED' || current.status === 'PROCESSING') {
          current = await postStatus(current.id, 'COMPLETED', {
            closureOnly: true,
            closureReason: reason,
          });
        }
        toast.success('PBL ditutup (penutupan administratif)');
        setDetail(null);
        await load();
        router.push('/food-production/plan');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Gagal menutup PBL');
        await load();
      } finally {
        setSaving(false);
      }
      return;
    }

    const okConfirm = await confirm({
      title: 'Keluarkan Stok?',
      description: `${row.noDokumen} akan mengurangi stok gudang produk sesuai baris item. Tidak bisa dibatalkan.`,
      confirmText: 'Keluarkan Stok',
    });
    if (!okConfirm) return;

    setSaving(true);
    try {
      let current = row;
      if (current.status === 'DRAFT') {
        current = await postStatus(current.id, 'SUBMITTED');
      }
      if (current.status === 'SUBMITTED') {
        current = await postStatus(current.id, 'APPROVED');
      }
      if (current.status === 'APPROVED' || current.status === 'PROCESSING') {
        current = await postStatus(current.id, 'COMPLETED');
      }
      toast.success('Selesai & Post Stok Keluar');
      setDetail(null);
      await load();
      router.push('/food-production/plan');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal mengeluarkan stok');
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(row: IssueRow, status: MaterialIssueStatus) {
    // Setujui / Keluarkan Stok → dialog konfirmasi → post stok → Rencana Produksi
    if (status === 'APPROVED' || status === 'COMPLETED') {
      await approveAndReleaseStock(row);
      return;
    }
    try {
      const data = await postStatus(row.id, status);
      toast.success(`Status → ${ISSUE_STATUS_LABELS[status]}`);
      await load();
      if (detail?.id === row.id) {
        setDetail(data);
        setEditLines(data.lines || []);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  async function cancelIssue(row: IssueRow) {
    const okConfirm = await confirm({
      title: 'Batalkan pengambilan?',
      description: row.noDokumen,
      confirmText: 'Batalkan',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    const res = await fetch(`/api/material-issues/${row.id}`, {
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
    <div className="space-y-4">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <PendingStockReversals sourceType="FP_ISSUE" refreshKey={rows.length} onChanged={() => { void load(); }} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ArrowUpFromLine className="h-5 w-5" />
            Mode Produksi — Pengambilan Bahan
          </h2>
          <p className="text-sm text-muted-foreground">
            Ambil bahan dari gudang produk — Setujui membuka konfirmasi Keluarkan Stok
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
              {(Object.keys(ISSUE_STATUS_LABELS) as MaterialIssueStatus[]).map((s) => (
                <option key={s} value={s}>{ISSUE_STATUS_LABELS[s]}</option>
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
            <Button size="sm" onClick={() => setOpenCreate(true)}>
              <Plus className="h-4 w-4 mr-1" /> Dari Rencana
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">No PBL</th>
              <th className="text-left p-3">Rencana</th>
              <th className="text-left p-3">Tanggal</th>
              <th className="text-left p-3">Dapur</th>
              <th className="text-left p-3">Item</th>
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
                <td colSpan={7} className="p-6 text-center text-muted-foreground">
                  Belum ada. Setujui Rencana Produksi lalu buat pengambilan.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const next = ISSUE_UI_STATUS_NEXT[row.status];
              return (
                <tr key={row.id} className="border-t">
                  <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                  <td className="p-3 font-mono text-xs">{row.productionPlanNo}</td>
                  <td className="p-3">{row.tanggal}</td>
                  <td className="p-3">
                    <div>{row.kitchenNama || '—'}</div>
                    {(() => {
                      const whs = [...new Set(
                        (row.lines || []).map((l) => l.warehouseKode).filter(Boolean),
                      )] as string[];
                      if (!whs.length) return null;
                      return (
                        <div className="text-[11px] text-muted-foreground">
                          {whs.map((w) => warehouseLabel(w)).join(' · ')}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="p-3">{row.summary?.lineCount ?? row.lines?.length ?? 0}</td>
                  <td className="p-3">
                    {ISSUE_STATUS_LABELS[row.status]}
                    {isReferenceRow(row) && (
                      <span
                        className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800"
                        title="PBL acuan — tanpa mutasi stok, bahan keluar lewat RL"
                      >
                        Acuan
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1 justify-end">
                      <Button variant="ghost" size="sm" onClick={() => void openDetail(row)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
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
                        <Button variant="outline" size="sm" onClick={() => void changeStatus(row, next)}>
                          {isReferenceRow(row) && (next === 'APPROVED' || next === 'COMPLETED')
                            ? 'Konfirmasi Selesai'
                            : ISSUE_UI_STATUS_NEXT_LABEL[row.status]}
                        </Button>
                      )}
                      {canManage && row.status !== 'CANCELLED' && row.status !== 'COMPLETED' && (
                        <Button variant="ghost" size="sm" onClick={() => void cancelIssue(row)}>
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

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Buat Pengambilan Bahan</DialogTitle></DialogHeader>
          <div className="space-y-2 py-2">
            <Label>Rencana produksi</Label>
            <select
              className="w-full h-10 border rounded-md px-2 text-sm bg-white"
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
            >
              <option value="">— Pilih —</option>
              {creatablePlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.noDokumen} · {p.tanggal} · {p.kitchenNama || 'Dapur'}
                </option>
              ))}
            </select>
            {!creatablePlans.length && (
              <p className="text-xs text-muted-foreground">
                Tidak ada rencana baru — semua rencana aktif sudah punya PBL selesai.
              </p>
            )}
            {planReadiness?.issueCompleted && (
              <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">
                PBL {planReadiness.completedIssueNo || ''} sudah selesai untuk rencana ini.
                Buka detail PBL → <strong>Sinkron</strong> jika ada RL operasional, jangan buat PBL baru.
              </div>
            )}
            {planReadiness?.pblReferenceMode && !planReadiness.issueCompleted && (
              <div className="rounded-md border border-sky-300 bg-sky-50 p-2 text-xs text-sky-900">
                PBL acuan: baris diisi dari acuan PO/MRP rencana, <strong>tanpa mengurangi stok</strong>.
                Bahan keluar dari gudang lewat Release (RL).
                {(planReadiness.sisaLineCount || 0) > 0
                  && ` Saat ini ${planReadiness.sisaLineCount} bahan belum keluar penuh lewat RL.`}
                {(planReadiness.poOutstandingLineCount || 0) > 0
                  && ` ${planReadiness.poOutstandingLineCount} bahan acuan PO belum diterima penuh.`}
              </div>
            )}
            {mrpId && !planReadiness?.pblReferenceMode && (
              <p className="text-xs text-muted-foreground">
                Dari MRP terpilih (seed qtyGross).
              </p>
            )}
            {readinessLoading && (
              <p className="text-xs text-muted-foreground">Cek kelengkapan bahan…</p>
            )}
            {planReadiness && planReadiness.shortageCount > 0 && !planReadiness.issueCompleted && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-2 space-y-2">
                <p className="text-xs text-amber-800 font-medium">
                  Bahan belum lengkap — {planReadiness.shortageCount} item kurang
                </p>
                {planReadiness.shortageLines.length > 0 && (
                  <ul className="text-xs text-amber-700 list-disc list-inside">
                    {planReadiness.shortageLines.slice(0, 5).map((l, i) => (
                      <li key={i}>
                        {l.productNama || l.productKode} — kurang {l.qtyNet ?? 0} {l.satuan || ''}
                      </li>
                    ))}
                  </ul>
                )}
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <Checkbox
                    checked={overrideShortage}
                    onCheckedChange={(v) => setOverrideShortage(v === true)}
                  />
                  Proses meski bahan belum lengkap
                </label>
                {overrideShortage && (
                  <div className="space-y-1">
                    <Label className="text-xs">Alasan (wajib — tercatat di riwayat)</Label>
                    <Textarea
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      rows={2}
                      className="text-xs"
                      placeholder="Mis. bahan pengganti dipakai, sisa dilengkapi susulan, dll."
                    />
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenCreate(false)}>Batal</Button>
            <Button
              onClick={() => void createIssue()}
              disabled={
                saving
                || !planId
                || planReadiness?.issueCompleted
                || Boolean(planReadiness && planReadiness.shortageCount > 0
                  && (!overrideShortage || !overrideReason.trim()))
              }
            >
              {saving ? 'Memproses…' : 'Buat'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) { setDetail(null); setReconciliation(null); } }}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detail?.noDokumen} — {detail ? ISSUE_STATUS_LABELS[detail.status] : ''}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="text-muted-foreground">
                Rencana{' '}
                <Link href="/food-production/plan" className="text-primary font-mono hover:underline">
                  {detail.productionPlanNo}
                </Link>
                {detail.materialRequirementNo ? ` · MRP ${detail.materialRequirementNo}` : ''}
                {' · '}{detail.tanggal} · {detail.kitchenNama}
              </div>
              {reconcileLoading && (
                <p className="text-xs text-muted-foreground">Memuat data stok & release operasional…</p>
              )}
              {reconciliation && reconciliation.summary.mismatchCount > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                  {reconciliation.summary.mismatchCount} baris tidak sesuai stok/sisa —
                  gunakan Sinkron sebelum keluarkan stok.
                </div>
              )}
              {isReferenceRow(detail) && (() => {
                const refLines = reconciliation?.reference?.lines;
                const sisaCount = refLines
                  ? refLines.filter((l) => l.sisa > 0).length
                  : Number(detail.summary?.sisaLineCount || 0);
                const poOutstandingCount = refLines
                  ? refLines.filter((l) => poOutstandingQty(l) > 0).length
                  : Number(detail.summary?.poOutstandingLineCount || 0);
                return (
                  <>
                    <div className="rounded-md border border-sky-300 bg-sky-50 p-2 text-xs text-sky-900 space-y-1">
                      <p>
                        <strong>PBL acuan</strong> — tidak mengurangi stok. Bahan keluar dari gudang lewat Release (RL);
                        dokumen ini mengonfirmasi acuan rencana (PO diterima / MRP) dan membuka tahap Diproses.
                      </p>
                      {detail.status !== 'COMPLETED' && sisaCount > 0 && (
                        <p className="text-amber-800">
                          {sisaCount} bahan belum keluar penuh lewat RL — buat RL dulu, atau isi catatan saat konfirmasi.
                        </p>
                      )}
                      {detail.status !== 'COMPLETED' && poOutstandingCount > 0 && (
                        <p className="text-amber-800">
                          {poOutstandingCount} bahan acuan PO belum diterima penuh — tunggu GRN, atau isi catatan saat konfirmasi.
                        </p>
                      )}
                      {!refLines && detail.referenceSnapshotAt && (
                        <p className="text-muted-foreground">
                          Snapshot acuan {new Date(detail.referenceSnapshotAt).toLocaleString('id-ID')}
                        </p>
                      )}
                    </div>
                    <div className="rounded-md border overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/40">
                          <tr>
                            <th className="text-left p-2">Produk</th>
                            <th className="text-left p-2">Gudang</th>
                            <th className="text-right p-2">Acuan</th>
                            <th className="text-right p-2">PO diterima</th>
                            <th className="text-right p-2">Sudah RL</th>
                            <th className="text-right p-2">PBL lama</th>
                            <th className="text-right p-2">Sisa</th>
                            <th className="text-right p-2">Stok</th>
                            <th className="text-left p-2">Satuan</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(detail.lines || []).map((l) => {
                            const live = detail.status === 'COMPLETED' ? undefined : referenceForProduct(l.productId);
                            const sumber = live?.sumber ?? l.sumber;
                            const acuan = live?.acuanQty ?? l.acuanQty ?? l.qtyPlanned;
                            const poReceived = live?.poQtyReceived ?? l.poQtyReceived;
                            const rl = live?.rlPosted ?? l.rlPosted ?? 0;
                            const pbl = live?.pblPosted ?? l.pblPosted ?? 0;
                            const sisa = live?.sisa ?? l.sisa ?? 0;
                            return (
                              <tr key={l.productId} className={`border-t ${sisa > 0 ? 'bg-amber-50/60' : ''}`}>
                                <td className="p-2">
                                  <div>{l.productNama || l.productKode}</div>
                                  <div className="text-[11px] font-mono text-muted-foreground">{l.productKode}</div>
                                </td>
                                <td className="p-2">
                                  {l.warehouseKode ? (
                                    <>
                                      <div>{warehouseLabel(l.warehouseKode)}</div>
                                      <div className="text-[11px] font-mono text-muted-foreground">{l.warehouseKode}</div>
                                    </>
                                  ) : '—'}
                                </td>
                                <td className="p-2 text-right">
                                  {acuan}
                                  {sumber && <div className="text-[10px] text-muted-foreground">{referenceSourceLabel(sumber)}</div>}
                                </td>
                                <td className="p-2 text-right">{sumber === 'PO' ? (poReceived ?? 0) : '—'}</td>
                                <td className="p-2 text-right">
                                  {rl}
                                  {(live?.rlPending ?? 0) > 0 && (
                                    <div className="text-[10px] text-amber-700">+{live?.rlPending} menunggu</div>
                                  )}
                                </td>
                                <td className="p-2 text-right text-muted-foreground">{pbl || '—'}</td>
                                <td className={`p-2 text-right ${sisa > 0 ? 'text-amber-800 font-medium' : ''}`}>{sisa}</td>
                                <td className="p-2 text-right text-muted-foreground">{live?.qtyOnHand ?? '—'}</td>
                                <td className="p-2">{l.satuan || '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                );
              })()}
              {!isReferenceRow(detail) && (
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left p-2">Produk</th>
                      <th className="text-left p-2">Gudang</th>
                      <th className="text-right p-2">Rencana</th>
                      <th className="text-right p-2">Sudah keluar</th>
                      <th className="text-right p-2">Sisa</th>
                      <th className="text-right p-2">Stok</th>
                      <th className="text-right p-2">Keluar</th>
                      <th className="text-left p-2">Satuan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(isIssueEditable(detail.status) ? editLines : detail.lines || []).map((l, idx) => {
                      const rec = reconcileForProduct(l.productId);
                      const ref = referenceForProduct(l.productId);
                      const rowClass = rec?.mismatch ? 'bg-amber-50/60' : '';
                      return (
                      <tr key={l.productId} className={`border-t ${rowClass}`}>
                        <td className="p-2">
                          <div>{l.productNama || l.productKode}</div>
                          <div className="text-[11px] font-mono text-muted-foreground">{l.productKode}</div>
                        </td>
                        <td className="p-2">
                          {l.warehouseKode ? (
                            <>
                              <div>{warehouseLabel(l.warehouseKode)}</div>
                              <div className="text-[11px] font-mono text-muted-foreground">{l.warehouseKode}</div>
                            </>
                          ) : '—'}
                        </td>
                        <td className="p-2 text-right">
                          {l.qtyPlanned}
                          {ref && (
                            <div
                              className="text-[10px] text-muted-foreground"
                              title={`Acuan ${ref.sumber === 'PO' ? 'PO diterima' : referenceSourceLabel(ref.sumber)} dikurangi RL yang sudah diposting (${ref.satuan || 'satuan dasar'})`}
                            >
                              Acuan {referenceSourceLabel(ref.sumber)} {ref.acuanQty} · sisa {ref.sisa}
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-right text-muted-foreground">
                          {rec?.qtyAlreadyIssued ?? '—'}
                          {rec && (rec.qtyAlreadyIssuedOperational > 0 || rec.qtyAlreadyIssuedPbl > 0) && (
                            <div className="text-[10px] text-muted-foreground">
                              RL {rec.qtyAlreadyIssuedOperational}
                              {rec.qtyAlreadyIssuedPbl > 0 ? ` · PBL ${rec.qtyAlreadyIssuedPbl}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-right">{rec?.qtyRemaining ?? '—'}</td>
                        <td className="p-2 text-right">{rec?.qtyOnHand ?? '—'}</td>
                        <td className="p-2 text-right">
                          {isIssueEditable(detail.status) && canManage ? (
                            <Input
                              type="number"
                              min={0}
                              step={1}
                              inputMode="numeric"
                              className="h-8 w-24 ml-auto text-right tabular-nums"
                              title="Qty keluar (bulat) — spinner: pecahan dibulatkan dulu"
                              value={Number.isFinite(l.qtyIssued) ? l.qtyIssued : ''}
                              onChange={(e) => {
                                const nextText = e.target.value;
                                if (nextText === '') {
                                  setEditLines((prev) => prev.map((x, i) =>
                                    i === idx ? { ...x, qtyIssued: 0 } : x,
                                  ));
                                  return;
                                }
                                const prev = Number(l.qtyIssued);
                                const next = parseQtyInput(nextText);
                                if (!Number.isFinite(next)) return;
                                // Spinner mouse: dari pecahan meloncat ≥0.5 → bulatkan dulu.
                                const snapped = shouldSnapSpinnerStep(prev, next)
                                  ? stepQtyFromSpinner(prev, next > prev ? 'up' : 'down')
                                  : next;
                                setEditLines((prevLines) => prevLines.map((x, i) =>
                                  i === idx ? { ...x, qtyIssued: snapped } : x,
                                ));
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                                  e.preventDefault();
                                  const snapped = stepQtyFromSpinner(
                                    l.qtyIssued,
                                    e.key === 'ArrowUp' ? 'up' : 'down',
                                  );
                                  setEditLines((prev) => prev.map((x, i) =>
                                    i === idx ? { ...x, qtyIssued: snapped } : x,
                                  ));
                                }
                              }}
                            />
                          ) : l.qtyIssued}
                        </td>
                        <td className="p-2">{l.satuan || '—'}</td>
                      </tr>
                    );})}
                  </tbody>
                </table>
              </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {canManage && isIssueReconcilable(detail.status) && (
                  <>
                    {(detail.status === 'APPROVED' || detail.status === 'PROCESSING') && (
                      <Input
                        className="h-8 max-w-xs text-xs"
                        placeholder="Alasan penyesuaian (wajib jika sudah disetujui)"
                        value={adjustReason}
                        onChange={(e) => setAdjustReason(e.target.value)}
                      />
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saving || reconcileLoading}
                      onClick={() => void syncFromOperational(adjustReason)}
                    >
                      <RefreshCw className="h-4 w-4 mr-1" />
                      {isReferenceRow(detail) ? 'Perbarui acuan' : 'Sinkron dari stok & release operasional'}
                    </Button>
                  </>
                )}
                {canManage && isReferenceRow(detail)
                  && (detail.status === 'SUBMITTED' || detail.status === 'APPROVED' || detail.status === 'PROCESSING') && (
                  <Button
                    size="sm"
                    disabled={saving}
                    className="bg-green-600 hover:bg-green-700 text-white"
                    onClick={() => void confirmReferenceIssue(detail)}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1.5" />
                    Konfirmasi Selesai
                  </Button>
                )}
                {canManage && isIssueEditable(detail.status) && !isReferenceRow(detail) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void saveLines()}
                    disabled={saving}
                  >
                    Simpan qty
                  </Button>
                )}
                {canManage && detail.status === 'SUBMITTED' && !isReferenceRow(detail) && (
                  <Button
                    size="sm"
                    disabled={saving}
                    className="bg-green-600 hover:bg-green-700 text-white"
                    onClick={() => void approveAndReleaseStock(detail)}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1.5" />
                    Setujui
                  </Button>
                )}
                {canManage && (detail.status === 'APPROVED' || detail.status === 'PROCESSING') && !isReferenceRow(detail) && (
                  <Button
                    size="sm"
                    disabled={saving}
                    className="bg-green-600 hover:bg-green-700 text-white"
                    onClick={() => void approveAndReleaseStock(detail)}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1.5" />
                    Keluarkan Stok
                  </Button>
                )}
                {canManage && detail.status === 'DRAFT' && ISSUE_UI_STATUS_NEXT[detail.status] && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => void changeStatus(detail, ISSUE_UI_STATUS_NEXT[detail.status]!)}
                  >
                    {ISSUE_UI_STATUS_NEXT_LABEL[detail.status]}
                  </Button>
                )}
              </div>
              <StockReversalSection
                sourceType="FP_ISSUE"
                doc={detail as unknown as JsonObject}
                eligible={detail.status === 'COMPLETED' && !isReferenceRow(detail) && !!detail.stockPostedAt}
                onChanged={() => { void load(); void openDetail(detail); }}
              />
            </div>
          )}
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
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
