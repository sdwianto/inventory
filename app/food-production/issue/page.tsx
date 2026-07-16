'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
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
import { useConfirm } from '@/components/ConfirmProvider';
import { ArrowUpFromLine, Plus, RefreshCw, Trash2, Eye, CheckCircle2, History } from 'lucide-react';
import {
  ISSUE_STATUS_LABELS,
  ISSUE_ELIGIBLE_PLAN_STATUSES,
  ISSUE_UI_STATUS_NEXT,
  ISSUE_UI_STATUS_NEXT_LABEL,
  isIssueEditable,
  type MaterialIssueStatus,
} from '@/lib/food-production/material-issue';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface PlanOpt {
  id: string;
  noDokumen: string;
  tanggal: string;
  kitchenNama?: string;
  status: string;
}

interface IssueLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qtyPlanned: number;
  qtyIssued: number;
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
  summary?: { lineCount: number; qtyIssuedTotal: number };
  lines: IssueLine[];
  history?: IssueHistoryEntry[];
  stockPostedAt?: string;
}

function FoodProductionIssuePageContent() {
  const confirm = useConfirm();
  const searchParams = useSearchParams();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<IssueRow[]>([]);
  const [plans, setPlans] = useState<PlanOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [detail, setDetail] = useState<IssueRow | null>(null);
  const [planId, setPlanId] = useState('');
  const [mrpId, setMrpId] = useState('');
  const [saving, setSaving] = useState(false);
  const [editLines, setEditLines] = useState<IssueLine[]>([]);
  const [filterTanggal, setFilterTanggal] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<IssueRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filterStatus) qs.set('status', filterStatus);
      if (filterTanggal) qs.set('tanggal', filterTanggal);
      const issueUrl = qs.toString() ? `/api/material-issues?${qs}` : '/api/material-issues';
      const [iRes, pRes] = await Promise.all([
        fetch(issueUrl, { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
        fetch('/api/production-plans', { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
      ]);
      const iData = await iRes.json();
      const pData = await pRes.json();
      if (!iRes.ok) throw new Error(iData?.error || 'Gagal memuat');
      setRows(Array.isArray(iData) ? iData : []);
      setPlans((Array.isArray(pData) ? pData : []).filter((p: PlanOpt) =>
        ISSUE_ELIGIBLE_PLAN_STATUSES.has(p.status),
      ));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
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
    const fromPlan = searchParams.get('productionPlanId');
    const fromMrp = searchParams.get('materialRequirementId');
    if (fromPlan) {
      setPlanId(fromPlan);
      setOpenCreate(true);
    }
    if (fromMrp) setMrpId(fromMrp);
  }, [searchParams]);

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
  }

  async function createIssue() {
    if (!planId) {
      toast.error('Pilih rencana produksi');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/material-issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders(), ...actingKitchenHeaders() },
        body: JSON.stringify({
          productionPlanId: planId,
          ...(mrpId ? { materialRequirementId: mrpId } : {}),
        }),
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
      const res = await fetch(`/api/material-issues/${detail.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders(), ...actingKitchenHeaders() },
        body: JSON.stringify({ lines: editLines }),
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

  async function changeStatus(row: IssueRow, status: MaterialIssueStatus) {
    if (status === 'COMPLETED') {
      const okConfirm = await confirm({
        title: 'Selesai & post stok keluar?',
        description: `${row.noDokumen} akan mengurangi stok gudang dapur. Tidak bisa dibatalkan.`,
        confirmText: 'Post Stok',
      });
      if (!okConfirm) return;
    }
    try {
      const res = await fetch(`/api/material-issues/${row.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders(), ...actingKitchenHeaders() },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal ubah status');
      toast.success(`Status → ${ISSUE_STATUS_LABELS[status]}`);
      await load();
      if (detail?.id === row.id) {
        setDetail(data as IssueRow);
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
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ArrowUpFromLine className="h-5 w-5" />
            Pengambilan Bahan
          </h1>
          <p className="text-sm text-muted-foreground">
            Ambil bahan dari gudang dapur — stok keluar saat Selesai
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
              <th className="text-left p-3">Dapur / Gudang</th>
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
                    <div className="text-[11px] text-muted-foreground">{row.warehouseKode}</div>
                  </td>
                  <td className="p-3">{row.summary?.lineCount ?? row.lines?.length ?? 0}</td>
                  <td className="p-3">{ISSUE_STATUS_LABELS[row.status]}</td>
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
                          {ISSUE_UI_STATUS_NEXT_LABEL[row.status]}
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
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.noDokumen} · {p.tanggal} · {p.kitchenNama || 'Dapur'}
                </option>
              ))}
            </select>
            {mrpId && (
              <p className="text-xs text-muted-foreground">
                Dari MRP terpilih (seed qtyGross).
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenCreate(false)}>Batal</Button>
            <Button onClick={() => void createIssue()} disabled={saving || !planId}>
              {saving ? 'Memproses…' : 'Buat'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
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
                {' · '}{detail.tanggal} · {detail.kitchenNama} · {detail.warehouseKode}
              </div>
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="text-left p-2">Produk</th>
                      <th className="text-right p-2">Rencana</th>
                      <th className="text-right p-2">Keluar</th>
                      <th className="text-left p-2">Satuan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(isIssueEditable(detail.status) ? editLines : detail.lines || []).map((l, idx) => (
                      <tr key={l.productId} className="border-t">
                        <td className="p-2">
                          <div>{l.productNama || l.productKode}</div>
                          <div className="text-[11px] font-mono text-muted-foreground">{l.productKode}</div>
                        </td>
                        <td className="p-2 text-right">{l.qtyPlanned}</td>
                        <td className="p-2 text-right">
                          {isIssueEditable(detail.status) && canManage ? (
                            <Input
                              type="number"
                              className="h-8 w-24 ml-auto text-right"
                              value={l.qtyIssued}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                setEditLines((prev) => prev.map((x, i) =>
                                  i === idx ? { ...x, qtyIssued: v } : x,
                                ));
                              }}
                            />
                          ) : l.qtyIssued}
                        </td>
                        <td className="p-2">{l.satuan || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canManage && isIssueEditable(detail.status) && (
                <Button size="sm" onClick={() => void saveLines()} disabled={saving}>
                  Simpan qty
                </Button>
              )}
              {(detail.status === 'APPROVED' || detail.status === 'PROCESSING') && canManage && (
                <Button size="sm" onClick={() => void changeStatus(detail, 'COMPLETED')}>
                  <CheckCircle2 className="h-4 w-4 mr-1" /> Selesai + Post Stok
                </Button>
              )}
              {canManage && ISSUE_UI_STATUS_NEXT[detail.status] && detail.status !== 'APPROVED' && detail.status !== 'PROCESSING' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void changeStatus(detail, ISSUE_UI_STATUS_NEXT[detail.status]!)}
                >
                  {ISSUE_UI_STATUS_NEXT_LABEL[detail.status]}
                </Button>
              )}
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

export default function FoodProductionIssuePage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Memuat pengambilan bahan…</div>}>
      <FoodProductionIssuePageContent />
    </Suspense>
  );
}
