'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
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
  ShoppingCart, Plus, RefreshCw, Trash2, Eye, History, ExternalLink,
} from 'lucide-react';
import {
  PR_STATUS_LABELS,
  PR_ELIGIBLE_MRP_STATUSES,
  canRecreateDraftCpo,
  type PurchaseRequirementStatus,
} from '@/lib/food-production/purchase-requirement';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface MrpOpt {
  id: string;
  noDokumen: string;
  productionPlanNo?: string;
  tanggal: string;
  kitchenNama?: string;
  status: string;
  summary?: { shortageCount?: number; lineCount?: number };
}

interface PrLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qtyNet: number;
  qtyGross?: number;
  qtyOnHand?: number;
}

interface PrHistoryEntry {
  at?: string;
  fromStatus?: string | null;
  toStatus?: string;
  userName?: string;
  note?: string;
}

interface PrRow {
  id: string;
  noDokumen: string;
  materialRequirementId: string;
  materialRequirementNo?: string;
  productionPlanId: string;
  productionPlanNo?: string;
  tanggal: string;
  kitchenNama?: string;
  warehouseKode?: string;
  status: PurchaseRequirementStatus;
  summary?: {
    lineCount: number;
    qtyNetTotal: number;
    warnings?: string[];
  };
  draftCpoId?: string;
  draftCpoNo?: string;
  draftCpoStatus?: string;
  history?: PrHistoryEntry[];
  lines: PrLine[];
}

const STATUS_NEXT: Partial<Record<PurchaseRequirementStatus, PurchaseRequirementStatus>> = {
  DRAFT: 'SUBMITTED',
  SUBMITTED: 'APPROVED',
};

const STATUS_NEXT_LABEL: Partial<Record<PurchaseRequirementStatus, string>> = {
  DRAFT: 'Ajukan',
  SUBMITTED: 'Setujui',
};

export default function FoodProductionPurchaseRequirementPage() {
  const confirm = useConfirm();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);
  const [rows, setRows] = useState<PrRow[]>([]);
  const [mrps, setMrps] = useState<MrpOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [detail, setDetail] = useState<PrRow | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<PrRow | null>(null);
  const [mrpId, setMrpId] = useState('');
  const [saving, setSaving] = useState(false);
  const [filterTanggal, setFilterTanggal] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterTanggal) params.set('tanggal', filterTanggal);
      if (filterStatus) params.set('status', filterStatus);
      const qs = params.toString() ? `?${params}` : '';
      const [prRes, mRes] = await Promise.all([
        fetch(`/api/purchase-requirements${qs}`, { headers: { ...actingTenantHeaders() } }),
        fetch('/api/material-requirements?status=APPROVED', { headers: { ...actingTenantHeaders() } }),
      ]);
      const prData = await prRes.json();
      const mData = await mRes.json();
      if (!prRes.ok) throw new Error(prData?.error || 'Gagal memuat kebutuhan beli');
      setRows(Array.isArray(prData) ? prData : []);
      const mrpList = (Array.isArray(mData) ? mData : []).filter((m: MrpOpt) =>
        PR_ELIGIBLE_MRP_STATUSES.has(m.status) && (m.summary?.shortageCount || 0) > 0,
      );
      setMrps(mrpList);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, [filterTanggal, filterStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(row: PrRow) {
    try {
      const res = await fetch(`/api/purchase-requirements/${row.id}`, {
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat detail');
      setDetail(data as PrRow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat detail');
      setDetail(row);
    }
  }

  async function createPr() {
    if (!mrpId) {
      toast.error('Pilih kebutuhan bahan (MRP) yang disetujui');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/purchase-requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ materialRequirementId: mrpId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membuat');
      toast.success(
        `PR ${data.noDokumen} siap — Draft CPO ${data.draftCpoNo || ''}`,
      );
      if (Array.isArray(data.summary?.warnings) && data.summary.warnings.length) {
        toast.message(data.summary.warnings[0]);
      }
      setOpenCreate(false);
      setMrpId('');
      await load();
      setDetail(data as PrRow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal membuat');
    } finally {
      setSaving(false);
    }
  }

  async function recreateDraftCpo(row: PrRow) {
    try {
      const res = await fetch(`/api/purchase-requirements/${row.id}/create-draft-cpo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal buat Draft CPO');
      toast.success(`Draft CPO ${data.draftCpoNo}`);
      await load();
      if (detail?.id === row.id) setDetail(data as PrRow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal buat Draft CPO');
    }
  }

  async function changeStatus(row: PrRow, status: PurchaseRequirementStatus) {
    try {
      const res = await fetch(`/api/purchase-requirements/${row.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal ubah status');
      toast.success(`Status → ${PR_STATUS_LABELS[status]}`);
      await load();
      if (detail?.id === row.id) setDetail(data as PrRow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal ubah status');
    }
  }

  async function openHistory(row: PrRow) {
    try {
      const res = await fetch(`/api/purchase-requirements/${row.id}`, {
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat riwayat');
      setHistoryRow(data as PrRow);
      setHistoryOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat riwayat');
      setHistoryRow(row);
      setHistoryOpen(true);
    }
  }

  async function cancelPr(row: PrRow) {
    const okConfirm = await confirm({
      title: 'Batalkan kebutuhan beli?',
      description: `${row.noDokumen} akan dibatalkan. Draft CPO tertaut (status Draft) ikut dibatalkan.`,
      confirmText: 'Batalkan',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    try {
      const res = await fetch(`/api/purchase-requirements/${row.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membatalkan');
      toast.success(
        data.cancelledDraftCpoNo
          ? `Dibatalkan (+ Draft CPO ${data.cancelledDraftCpoNo})`
          : 'Dibatalkan',
      );
      if (detail?.id === row.id) setDetail(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal membatalkan');
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            Kebutuhan Beli
          </h1>
          <p className="text-sm text-muted-foreground">
            Dari MRP yang disetujui → otomatis Draft CPO ke vendor
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
              {(Object.keys(PR_STATUS_LABELS) as PurchaseRequirementStatus[]).map((s) => (
                <option key={s} value={s}>{PR_STATUS_LABELS[s]}</option>
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
          {canManage && (
            <Button size="sm" onClick={() => setOpenCreate(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Dari MRP
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">No PR</th>
              <th className="text-left p-3 font-medium">MRP / Rencana</th>
              <th className="text-left p-3 font-medium">Tanggal</th>
              <th className="text-left p-3 font-medium">Item</th>
              <th className="text-left p-3 font-medium">Draft CPO</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">Memuat…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">
                  Belum ada. Setujui MRP yang punya shortage, lalu buat kebutuhan beli.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const next = STATUS_NEXT[row.status];
              const showRecreate = canRecreateDraftCpo(row.status, row.draftCpoStatus);
              const cpoLive = row.draftCpoId && row.draftCpoStatus && row.draftCpoStatus !== 'CANCELLED'
                && row.draftCpoStatus !== 'MISSING';
              return (
                <tr key={row.id} className="border-t">
                  <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                  <td className="p-3">
                    <div className="font-mono text-xs">{row.materialRequirementNo || '—'}</div>
                    <div className="text-[11px] text-muted-foreground">{row.productionPlanNo}</div>
                  </td>
                  <td className="p-3 whitespace-nowrap">{row.tanggal}</td>
                  <td className="p-3">{row.summary?.lineCount ?? (row.lines || []).length}</td>
                  <td className="p-3 font-mono text-xs">
                    {cpoLive ? (
                      <Link
                        href={`/pembelian-po?highlight=${encodeURIComponent(row.draftCpoId || '')}`}
                        className="text-primary underline-offset-2 hover:underline inline-flex items-center gap-1"
                      >
                        {row.draftCpoNo}
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    ) : row.draftCpoNo ? (
                      <span className="text-muted-foreground">
                        {row.draftCpoNo}
                        {row.draftCpoStatus ? ` (${row.draftCpoStatus})` : ''}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="p-3">{PR_STATUS_LABELS[row.status] || row.status}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1 justify-end">
                      <Button variant="ghost" size="sm" onClick={() => void openDetail(row)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void openHistory(row)}>
                        <History className="h-4 w-4" />
                      </Button>
                      {canManage && next && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void changeStatus(row, next)}
                        >
                          {STATUS_NEXT_LABEL[row.status]}
                        </Button>
                      )}
                      {canManage && showRecreate && (
                        <Button variant="outline" size="sm" onClick={() => void recreateDraftCpo(row)}>
                          {row.draftCpoId ? 'Buat ulang CPO' : 'Buat CPO'}
                        </Button>
                      )}
                      {canManage && row.status !== 'CANCELLED' && row.status !== 'COMPLETED' && (
                        <Button variant="ghost" size="sm" onClick={() => void cancelPr(row)}>
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
          <DialogHeader>
            <DialogTitle>Buat dari MRP</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>MRP disetujui (ada kekurangan)</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm bg-white"
                value={mrpId}
                onChange={(e) => setMrpId(e.target.value)}
              >
                <option value="">— Pilih —</option>
                {mrps.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.noDokumen} · {m.tanggal} · kurang {m.summary?.shortageCount ?? 0}
                    {m.kitchenNama ? ` · ${m.kitchenNama}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              Sistem membuat dokumen PRB dan Draft CPO sekaligus dari baris shortage (qtyNet &gt; 0).
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenCreate(false)}>Batal</Button>
            <Button onClick={() => void createPr()} disabled={saving || !mrpId}>
              {saving ? 'Memproses…' : 'Buat + Draft CPO'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detail?.noDokumen} — {detail ? PR_STATUS_LABELS[detail.status] : ''}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                <div>MRP: <span className="text-foreground font-mono">{detail.materialRequirementNo}</span></div>
                <div>Rencana: <span className="text-foreground font-mono">{detail.productionPlanNo}</span></div>
                <div>Tanggal: <span className="text-foreground">{detail.tanggal}</span></div>
                <div className="flex flex-wrap items-center gap-2">
                  <span>Draft CPO:</span>
                  {detail.draftCpoId
                    && detail.draftCpoStatus
                    && detail.draftCpoStatus !== 'CANCELLED'
                    && detail.draftCpoStatus !== 'MISSING' ? (
                    <Link
                      href={`/pembelian-po?highlight=${encodeURIComponent(detail.draftCpoId)}`}
                      className="text-primary font-mono hover:underline"
                    >
                      {detail.draftCpoNo}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground font-mono">
                      {detail.draftCpoNo || '—'}
                      {detail.draftCpoStatus ? ` (${detail.draftCpoStatus})` : ''}
                    </span>
                  )}
                  {canManage && canRecreateDraftCpo(detail.status, detail.draftCpoStatus) && (
                    <Button size="sm" variant="outline" onClick={() => void recreateDraftCpo(detail)}>
                      {detail.draftCpoId ? 'Buat ulang' : 'Buat Draft CPO'}
                    </Button>
                  )}
                </div>
              </div>
              {Array.isArray(detail.summary?.warnings) && detail.summary.warnings.length > 0 && (
                <ul className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2 space-y-1">
                  {detail.summary.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left p-2">Produk</th>
                      <th className="text-right p-2">On hand</th>
                      <th className="text-right p-2">Gross</th>
                      <th className="text-right p-2">Beli (net)</th>
                      <th className="text-left p-2">Satuan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.lines || []).map((l) => (
                      <tr key={l.productId} className="border-t">
                        <td className="p-2">
                          <div>{l.productNama || l.productKode || l.productId}</div>
                          <div className="text-[11px] text-muted-foreground font-mono">{l.productKode}</div>
                        </td>
                        <td className="p-2 text-right">{l.qtyOnHand ?? '—'}</td>
                        <td className="p-2 text-right">{l.qtyGross ?? '—'}</td>
                        <td className="p-2 text-right font-medium">{l.qtyNet}</td>
                        <td className="p-2">{l.satuan || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Riwayat {historyRow?.noDokumen}</DialogTitle>
          </DialogHeader>
          <ul className="space-y-2 text-sm max-h-80 overflow-y-auto">
            {(historyRow?.history || []).length === 0 && (
              <li className="text-muted-foreground">Belum ada riwayat</li>
            )}
            {(historyRow?.history || []).map((h, i) => (
              <li key={`${h.at}-${i}`} className="border-b pb-2">
                <div className="font-medium">
                  {h.fromStatus || '—'} → {h.toStatus}
                </div>
                <div className="text-xs text-muted-foreground">
                  {h.userName || '—'} · {h.at ? new Date(h.at).toLocaleString('id-ID') : ''}
                </div>
                {h.note && <div className="text-xs mt-0.5">{h.note}</div>}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
