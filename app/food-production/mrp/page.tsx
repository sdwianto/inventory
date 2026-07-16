'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import {
  Calculator, Plus, RefreshCw, Trash2, Eye, RotateCcw, History, ShoppingCart, ArrowUpFromLine,
} from 'lucide-react';
import {
  MRP_STATUS_LABELS,
  MRP_ELIGIBLE_PLAN_STATUSES,
  isMrpEditable,
  type MaterialRequirementStatus,
} from '@/lib/food-production/material-requirement';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface PlanOpt {
  id: string;
  noDokumen: string;
  tanggal: string;
  kitchenNama?: string;
  status: string;
  totalTargetPorsi?: number;
}

interface MrpSource {
  menuKode?: string;
  recipeKode?: string;
  qty: number;
}

interface MrpLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qtyGross: number;
  qtyOnHand: number;
  qtyNet: number;
  shortage: boolean;
  sources?: MrpSource[];
}

interface MrpHistoryEntry {
  at?: string;
  fromStatus?: string | null;
  toStatus?: string;
  userName?: string;
  note?: string;
}

interface MrpRow {
  id: string;
  noDokumen: string;
  productionPlanId: string;
  productionPlanNo?: string;
  tanggal: string;
  kitchenNama?: string;
  warehouseKode: string;
  status: MaterialRequirementStatus;
  summary?: {
    lineCount: number;
    shortageCount: number;
    qtyGrossTotal: number;
    qtyNetTotal: number;
    warnings?: string[];
  };
  history?: MrpHistoryEntry[];
  lines: MrpLine[];
}

const STATUS_NEXT: Partial<Record<MaterialRequirementStatus, MaterialRequirementStatus>> = {
  DRAFT: 'SUBMITTED',
  SUBMITTED: 'APPROVED',
};

const STATUS_NEXT_LABEL: Partial<Record<MaterialRequirementStatus, string>> = {
  DRAFT: 'Ajukan',
  SUBMITTED: 'Setujui',
};

export default function FoodProductionMrpPage() {
  const confirm = useConfirm();
  const router = useRouter();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);
  const [rows, setRows] = useState<MrpRow[]>([]);
  const [plans, setPlans] = useState<PlanOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [detail, setDetail] = useState<MrpRow | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<MrpRow | null>(null);
  const [planId, setPlanId] = useState('');
  const [saving, setSaving] = useState(false);
  const [filterTanggal, setFilterTanggal] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [shortageOnly, setShortageOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterTanggal) params.set('tanggal', filterTanggal);
      if (filterStatus) params.set('status', filterStatus);
      const qs = params.toString() ? `?${params}` : '';
      const [mRes, pRes] = await Promise.all([
        fetch(`/api/material-requirements${qs}`, { headers: { ...actingTenantHeaders() } }),
        fetch('/api/production-plans', { headers: { ...actingTenantHeaders() } }),
      ]);
      const mData = await mRes.json();
      const pData = await pRes.json();
      if (!mRes.ok) throw new Error(mData?.error || 'Gagal memuat MRP');
      setRows(Array.isArray(mData) ? mData : []);
      const planList = (Array.isArray(pData) ? pData : []).filter((p: PlanOpt) =>
        MRP_ELIGIBLE_PLAN_STATUSES.has(p.status),
      );
      setPlans(planList);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, [filterTanggal, filterStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(row: MrpRow) {
    try {
      const res = await fetch(`/api/material-requirements/${row.id}`, {
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat detail');
      setDetail(data as MrpRow);
      setShortageOnly(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat detail');
      setDetail(row);
    }
  }

  async function createMrp() {
    if (!planId) {
      toast.error('Pilih rencana produksi');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/material-requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ productionPlanId: planId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menghitung');
      toast.success(
        `MRP ${data.noDokumen} siap — kekurangan ${data.summary?.shortageCount ?? 0} item`,
      );
      if (Array.isArray(data.summary?.warnings) && data.summary.warnings.length) {
        toast.message(data.summary.warnings[0]);
      }
      setOpenCreate(false);
      setPlanId('');
      await load();
      setDetail(data as MrpRow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menghitung');
    } finally {
      setSaving(false);
    }
  }

  async function recalculate(row: MrpRow) {
    try {
      const res = await fetch(`/api/material-requirements/${row.id}/recalculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal hitung ulang');
      toast.success('Dihitung ulang');
      await load();
      if (detail?.id === row.id) setDetail(data as MrpRow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal hitung ulang');
    }
  }

  async function changeStatus(row: MrpRow, status: MaterialRequirementStatus) {
    try {
      const res = await fetch(`/api/material-requirements/${row.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal ubah status');
      toast.success(`Status → ${MRP_STATUS_LABELS[status]}`);
      await load();
      if (detail?.id === row.id) setDetail({ ...detail, status });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal ubah status');
    }
  }

  async function cancelMrp(row: MrpRow) {
    const okConfirm = await confirm({
      title: 'Batalkan MRP?',
      description: `${row.noDokumen} akan dibatalkan.`,
      confirmText: 'Batalkan',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    try {
      const res = await fetch(`/api/material-requirements/${row.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membatalkan');
      toast.success('MRP dibatalkan');
      if (detail?.id === row.id) setDetail(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal membatalkan');
    }
  }

  async function createPurchaseRequirement(row: MrpRow) {
    if (row.status !== 'APPROVED') {
      toast.error('MRP harus Disetujui dulu');
      return;
    }
    if (!(row.summary?.shortageCount || 0)) {
      toast.error('Tidak ada kekurangan untuk dibeli');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/purchase-requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ materialRequirementId: row.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membuat kebutuhan beli');
      toast.success(`PR ${data.noDokumen} + Draft CPO ${data.draftCpoNo || ''}`);
      router.push('/food-production/purchase-requirement');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal membuat kebutuhan beli');
    } finally {
      setSaving(false);
    }
  }

  const detailLines = useMemo(() => {
    const list = detail?.lines || [];
    return shortageOnly ? list.filter((l) => l.shortage) : list;
  }, [detail, shortageOnly]);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Calculator className="h-5 w-5" />
            Kebutuhan Bahan
          </h1>
          <p className="text-sm text-muted-foreground">
            MRP dari Rencana Produksi — gross / stok gudang / net shortage
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
              {(Object.keys(MRP_STATUS_LABELS) as MaterialRequirementStatus[]).map((s) => (
                <option key={s} value={s}>{MRP_STATUS_LABELS[s]}</option>
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
            <RefreshCw className="h-4 w-4 mr-1" />
            Muat ulang
          </Button>
          <Button size="sm" onClick={() => setOpenCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Hitung dari Rencana
          </Button>
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">No MRP</th>
              <th className="text-left p-3 font-medium">Rencana</th>
              <th className="text-left p-3 font-medium">Tanggal</th>
              <th className="text-left p-3 font-medium">Dapur / Gudang</th>
              <th className="text-left p-3 font-medium">Item</th>
              <th className="text-left p-3 font-medium">Kurang</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">Memuat…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-muted-foreground">
                  Belum ada perhitungan. Ajukan/setujui Rencana Produksi dulu, lalu hitung kebutuhan.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const next = STATUS_NEXT[row.status];
              return (
                <tr key={row.id} className="border-t">
                  <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                  <td className="p-3 font-mono text-xs">{row.productionPlanNo || '—'}</td>
                  <td className="p-3 whitespace-nowrap">{row.tanggal}</td>
                  <td className="p-3">
                    <div>{row.kitchenNama || '—'}</div>
                    <div className="text-[11px] text-muted-foreground">{row.warehouseKode}</div>
                  </td>
                  <td className="p-3">{row.summary?.lineCount ?? (row.lines || []).length}</td>
                  <td className="p-3">
                    <span className={
                      (row.summary?.shortageCount || 0) > 0
                        ? 'text-destructive font-medium'
                        : 'text-emerald-700'
                    }>
                      {row.summary?.shortageCount ?? 0}
                    </span>
                  </td>
                  <td className="p-3">{MRP_STATUS_LABELS[row.status] || row.status}</td>
                  <td className="p-3 text-right whitespace-nowrap space-x-1">
                    <Button variant="ghost" size="sm" onClick={() => void openDetail(row)} title="Detail">
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setHistoryRow(row);
                        setHistoryOpen(true);
                      }}
                      title="Riwayat"
                    >
                      <History className="h-4 w-4" />
                    </Button>
                    {isMrpEditable(row.status) && (
                      <Button variant="ghost" size="sm" onClick={() => void recalculate(row)} title="Hitung ulang">
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    )}
                    {next && (
                      <Button variant="outline" size="sm" onClick={() => void changeStatus(row, next)}>
                        {STATUS_NEXT_LABEL[row.status]}
                      </Button>
                    )}
                    {canManage && row.status === 'APPROVED' && (row.summary?.shortageCount || 0) > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={saving}
                        onClick={() => void createPurchaseRequirement(row)}
                        title="Buat Kebutuhan Beli + Draft CPO"
                      >
                        <ShoppingCart className="h-4 w-4 mr-1" />
                        Beli
                      </Button>
                    )}
                    {canManage && ['APPROVED', 'PROCESSING', 'COMPLETED'].includes(row.status) && (
                      <Button
                        variant="outline"
                        size="sm"
                        title="Buat Pengambilan Bahan dari MRP ini"
                        onClick={() => router.push(
                          `/food-production/issue?productionPlanId=${encodeURIComponent(row.productionPlanId)}&materialRequirementId=${encodeURIComponent(row.id)}`,
                        )}
                      >
                        <ArrowUpFromLine className="h-4 w-4 mr-1" />
                        Ambil
                      </Button>
                    )}
                    {row.status !== 'CANCELLED' && row.status !== 'COMPLETED' && (
                      <Button variant="ghost" size="sm" onClick={() => void cancelMrp(row)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hitung Kebutuhan Bahan</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Rencana produksi *</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm bg-white"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
              >
                <option value="">— Pilih rencana —</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.noDokumen} · {p.tanggal} · {p.kitchenNama || 'Dapur'} · {p.totalTargetPorsi ?? '?'} porsi
                  </option>
                ))}
              </select>
              {plans.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Tidak ada rencana eligible (status minimal Diajukan).
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenCreate(false)}>Batal</Button>
            <Button onClick={() => void createMrp()} disabled={saving || !planId}>
              {saving ? 'Menghitung…' : 'Hitung'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(detail)} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detail?.noDokumen} — {detail?.productionPlanNo}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {detail.tanggal} · {detail.kitchenNama} · {detail.warehouseKode} ·{' '}
                  {MRP_STATUS_LABELS[detail.status]} · kekurangan{' '}
                  <strong className={detail.summary?.shortageCount ? 'text-destructive' : ''}>
                    {detail.summary?.shortageCount ?? 0}
                  </strong>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {canManage && detail.status === 'APPROVED' && (detail.summary?.shortageCount || 0) > 0 && (
                    <Button
                      size="sm"
                      disabled={saving}
                      onClick={() => void createPurchaseRequirement(detail)}
                    >
                      <ShoppingCart className="h-4 w-4 mr-1" />
                      Kebutuhan Beli + CPO
                    </Button>
                  )}
                  {canManage && ['APPROVED', 'PROCESSING', 'COMPLETED'].includes(detail.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => router.push(
                        `/food-production/issue?productionPlanId=${encodeURIComponent(detail.productionPlanId)}&materialRequirementId=${encodeURIComponent(detail.id)}`,
                      )}
                    >
                      <ArrowUpFromLine className="h-4 w-4 mr-1" />
                      Pengambilan Bahan
                    </Button>
                  )}
                  <label className="text-xs flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={shortageOnly}
                      onChange={(e) => setShortageOnly(e.target.checked)}
                    />
                    Hanya yang kurang
                  </label>
                </div>
              </div>
              {!!detail.summary?.warnings?.length && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-1">
                  {detail.summary.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left p-2">Bahan</th>
                      <th className="text-right p-2">Gross</th>
                      <th className="text-right p-2">Stok</th>
                      <th className="text-right p-2">Net</th>
                      <th className="text-left p-2">Sat</th>
                      <th className="text-left p-2">Sumber</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailLines.length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-4 text-center text-muted-foreground">
                          Tidak ada baris{shortageOnly ? ' kekurangan' : ''}.
                        </td>
                      </tr>
                    )}
                    {detailLines.map((line) => (
                      <tr
                        key={line.productId}
                        className={`border-t ${line.shortage ? 'bg-red-50/60' : ''}`}
                      >
                        <td className="p-2">
                          <div className="font-medium">{line.productNama || line.productId}</div>
                          <div className="text-[11px] font-mono text-muted-foreground">
                            {line.productKode}
                          </div>
                        </td>
                        <td className="p-2 text-right font-mono">{line.qtyGross}</td>
                        <td className="p-2 text-right font-mono">{line.qtyOnHand}</td>
                        <td className={`p-2 text-right font-mono font-medium ${line.shortage ? 'text-destructive' : ''}`}>
                          {line.qtyNet}
                        </td>
                        <td className="p-2">{line.satuan || '—'}</td>
                        <td className="p-2 text-[11px] text-muted-foreground max-w-[12rem]">
                          {(line.sources || []).length
                            ? (line.sources || [])
                              .map((s) => `${s.menuKode || '?'}→${s.recipeKode || '?'} (${s.qty})`)
                              .join('; ')
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>Tutup</Button>
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
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
