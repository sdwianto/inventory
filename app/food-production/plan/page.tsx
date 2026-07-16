'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useRouter } from 'next/navigation';
import {
  CalendarClock, Plus, Pencil, RefreshCw, Trash2, History, Calculator, ArrowUpFromLine, Factory, ClipboardList, Truck,
} from 'lucide-react';
import { ISSUE_ELIGIBLE_PLAN_STATUSES } from '@/lib/food-production/material-issue';
import {
  PLAN_STATUS_LABELS,
  isPlanEditable,
  summarizePlanLines,
  type ProductionPlanStatus,
} from '@/lib/food-production/production-plan';
import { MRP_ELIGIBLE_PLAN_STATUSES } from '@/lib/food-production/material-requirement';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface KitchenOpt {
  id: string;
  nama: string;
  aktif?: boolean;
}

interface MenuOpt {
  id: string;
  kode: string;
  nama: string;
  aktif?: boolean;
}

interface PlanLineForm {
  menuId: string;
  targetPorsi: string;
}

interface PlanHistoryEntry {
  at?: string;
  fromStatus?: string | null;
  toStatus?: string;
  userName?: string;
  note?: string;
}

interface PlanRow {
  id: string;
  noDokumen: string;
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  kitchenWarehouseKode?: string;
  status: ProductionPlanStatus;
  totalTargetPorsi?: number;
  catatan?: string;
  history?: PlanHistoryEntry[];
  lines: Array<{ menuId: string; targetPorsi: number; menuKode?: string; menuNama?: string }>;
}

const emptyLine = (): PlanLineForm => ({ menuId: '', targetPorsi: '100' });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const STATUS_NEXT: Partial<Record<ProductionPlanStatus, ProductionPlanStatus>> = {
  DRAFT: 'SUBMITTED',
  SUBMITTED: 'APPROVED',
  APPROVED: 'PROCESSING',
  PROCESSING: 'COMPLETED',
};

const STATUS_NEXT_LABEL: Partial<Record<ProductionPlanStatus, string>> = {
  DRAFT: 'Ajukan',
  SUBMITTED: 'Setujui',
  APPROVED: 'Mulai proses',
  PROCESSING: 'Selesai',
};

export default function FoodProductionPlanPage() {
  const confirm = useConfirm();
  const router = useRouter();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [kitchens, setKitchens] = useState<KitchenOpt[]>([]);
  const [menus, setMenus] = useState<MenuOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<PlanRow | null>(null);
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [filterTanggal, setFilterTanggal] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [form, setForm] = useState({
    tanggal: today(),
    kitchenId: '',
    catatan: '',
  });
  const [lines, setLines] = useState<PlanLineForm[]>([emptyLine()]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterTanggal) params.set('tanggal', filterTanggal);
      if (filterStatus) params.set('status', filterStatus);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const [pRes, kRes, mRes] = await Promise.all([
        fetch(`/api/production-plans${qs}`, { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
        fetch('/api/kitchens?aktif=1', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/menus', { headers: { ...actingTenantHeaders() } }),
      ]);
      const pData = await pRes.json();
      const kData = await kRes.json();
      const mData = await mRes.json();
      if (!pRes.ok) throw new Error(pData?.error || 'Gagal memuat rencana');
      setRows(Array.isArray(pData) ? pData : []);
      setKitchens(Array.isArray(kData) ? kData : []);
      setMenus(Array.isArray(mData) ? mData : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat rencana');
    } finally {
      setLoading(false);
    }
  }, [filterTanggal, filterStatus]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  const activeMenus = useMemo(
    () => menus.filter((m) => m.aktif !== false),
    [menus],
  );

  function openCreate() {
    setEditing(null);
    setForm({
      tanggal: today(),
      kitchenId: kitchens[0]?.id || '',
      catatan: '',
    });
    setLines([emptyLine()]);
    setOpen(true);
  }

  function openEdit(row: PlanRow) {
    if (!isPlanEditable(row.status)) {
      toast.error(`Status ${PLAN_STATUS_LABELS[row.status]} tidak dapat diubah`);
      return;
    }
    setEditing(row);
    setForm({
      tanggal: row.tanggal || today(),
      kitchenId: row.kitchenId,
      catatan: row.catatan || '',
    });
    setLines(
      (row.lines || []).length
        ? row.lines.map((l) => ({ menuId: l.menuId, targetPorsi: String(l.targetPorsi) }))
        : [emptyLine()],
    );
    setOpen(true);
  }

  async function save() {
    const validLines = lines.filter((l) => l.menuId);
    if (!validLines.length) {
      toast.error('Minimal satu baris menu');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        tanggal: form.tanggal,
        kitchenId: form.kitchenId,
        catatan: form.catatan.trim() || undefined,
        lines: validLines.map((l) => ({
          menuId: l.menuId,
          targetPorsi: Number(l.targetPorsi) || 0,
        })),
      };
      const url = editing ? `/api/production-plans/${editing.id}` : '/api/production-plans';
      const method = editing ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      toast.success(editing ? 'Rencana diperbarui' : `Rencana ${data.noDokumen || ''} dibuat`);
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(row: PlanRow, status: ProductionPlanStatus) {
    try {
      const res = await fetch(`/api/production-plans/${row.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal ubah status');
      toast.success(`Status → ${PLAN_STATUS_LABELS[status]}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal ubah status');
    }
  }

  async function cancelPlan(row: PlanRow) {
    const okConfirm = await confirm({
      title: 'Batalkan rencana?',
      description: `${row.noDokumen} (${row.tanggal}) akan dibatalkan.`,
      confirmText: 'Batalkan',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    try {
      const res = await fetch(`/api/production-plans/${row.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membatalkan');
      toast.success('Rencana dibatalkan');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal membatalkan');
    }
  }

  function openHistory(row: PlanRow) {
    setHistoryRow(row);
    setHistoryOpen(true);
  }

  async function runMrp(row: PlanRow) {
    if (!MRP_ELIGIBLE_PLAN_STATUSES.has(row.status)) {
      toast.error('Rencana minimal status Diajukan untuk dihitung MRP');
      return;
    }
    try {
      const res = await fetch('/api/material-requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ productionPlanId: row.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal hitung MRP');
      toast.success(`MRP ${data.noDokumen} — kekurangan ${data.summary?.shortageCount ?? 0} item`);
      router.push('/food-production/mrp');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal hitung MRP');
    }
  }

  const canSave = Boolean(form.tanggal && form.kitchenId && lines.some((l) => l.menuId));

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            Rencana Produksi
          </h1>
          <p className="text-sm text-muted-foreground">
            Aggregate root — dapur × tanggal × menu × porsi (Sprint 3)
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
              {(Object.keys(PLAN_STATUS_LABELS) as ProductionPlanStatus[]).map((s) => (
                <option key={s} value={s}>{PLAN_STATUS_LABELS[s]}</option>
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
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" />
              Buat Rencana
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">No</th>
              <th className="text-left p-3 font-medium">Tanggal</th>
              <th className="text-left p-3 font-medium">Dapur</th>
              <th className="text-left p-3 font-medium">Menu</th>
              <th className="text-left p-3 font-medium">Porsi</th>
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
                  Belum ada rencana. Pastikan Dapur &amp; Menu sudah ada, lalu buat rencana.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const next = STATUS_NEXT[row.status];
              return (
                <tr key={row.id} className="border-t">
                  <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                  <td className="p-3 whitespace-nowrap">{row.tanggal}</td>
                  <td className="p-3">
                    <div>{row.kitchenNama || row.kitchenId}</div>
                    {row.kitchenWarehouseKode && (
                      <div className="text-[11px] text-muted-foreground">{row.kitchenWarehouseKode}</div>
                    )}
                  </td>
                  <td className="p-3 max-w-[16rem]" title={summarizePlanLines(row.lines, 10)}>
                    {summarizePlanLines(row.lines)}
                  </td>
                  <td className="p-3 font-medium">{row.totalTargetPorsi ?? '—'}</td>
                  <td className="p-3">{PLAN_STATUS_LABELS[row.status] || row.status}</td>
                  <td className="p-3 text-right whitespace-nowrap space-x-1">
                    <Button variant="ghost" size="sm" onClick={() => openHistory(row)} title="Riwayat">
                      <History className="h-4 w-4" />
                    </Button>
                    {canManage && MRP_ELIGIBLE_PLAN_STATUSES.has(row.status) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void runMrp(row)}
                        title="Hitung kebutuhan bahan"
                      >
                        <Calculator className="h-4 w-4" />
                      </Button>
                    )}
                    {(ISSUE_ELIGIBLE_PLAN_STATUSES.has(row.status) || row.status === 'COMPLETED') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Laporan produksi"
                        onClick={() => router.push('/food-production/report')}
                      >
                        <ClipboardList className="h-4 w-4" />
                      </Button>
                    )}
                    {ISSUE_ELIGIBLE_PLAN_STATUSES.has(row.status) && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Pengambilan bahan"
                          onClick={() => router.push(`/food-production/issue?productionPlanId=${row.id}`)}
                        >
                          <ArrowUpFromLine className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Hasil produksi"
                          onClick={() => router.push(`/food-production/result?productionPlanId=${row.id}`)}
                        >
                          <Factory className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Distribusi / packing"
                          onClick={() => router.push(`/food-production/distribution?productionPlanId=${row.id}`)}
                        >
                          <Truck className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                    {canManage && isPlanEditable(row.status) && (
                      <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {canManage && next && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void changeStatus(row, next)}
                      >
                        {STATUS_NEXT_LABEL[row.status] || 'Lanjut'}
                      </Button>
                    )}
                    {canManage && row.status === 'SUBMITTED' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void changeStatus(row, 'DRAFT')}
                      >
                        Kembalikan
                      </Button>
                    )}
                    {canManage && row.status !== 'CANCELLED' && row.status !== 'COMPLETED' && (
                      <Button variant="ghost" size="sm" onClick={() => void cancelPlan(row)}>
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Ubah Rencana' : 'Buat Rencana Produksi'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Tanggal masak *</Label>
              <Input
                type="date"
                value={form.tanggal}
                onChange={(e) => setForm((f) => ({ ...f, tanggal: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Dapur *</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm bg-white"
                value={form.kitchenId}
                onChange={(e) => setForm((f) => ({ ...f, kitchenId: e.target.value }))}
              >
                <option value="">— Pilih dapur —</option>
                {kitchens.map((k) => (
                  <option key={k.id} value={k.id}>{k.nama}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Catatan</Label>
              <Input
                value={form.catatan}
                onChange={(e) => setForm((f) => ({ ...f, catatan: e.target.value }))}
                placeholder="Opsional"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Menu × porsi</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setLines((prev) => [...prev, emptyLine()])}
              >
                <Plus className="h-3 w-3 mr-1" />
                Baris
              </Button>
            </div>
            {lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 sm:grid-cols-12 items-end border rounded-md p-2">
                <div className="sm:col-span-8 space-y-1">
                  <Label className="text-xs">Menu</Label>
                  <select
                    className="w-full border rounded-md px-2 py-1.5 text-sm bg-white"
                    value={line.menuId}
                    onChange={(e) => setLines((prev) => prev.map((l, i) => (
                      i === idx ? { ...l, menuId: e.target.value } : l
                    )))}
                  >
                    <option value="">— Pilih menu —</option>
                    {(activeMenus.length ? activeMenus : menus)
                      .filter((m) => m.aktif !== false || m.id === line.menuId)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.kode} — {m.nama}{m.aktif === false ? ' (nonaktif)' : ''}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <Label className="text-xs">Porsi</Label>
                  <Input
                    type="number"
                    min={1}
                    value={line.targetPorsi}
                    onChange={(e) => setLines((prev) => prev.map((l, i) => (
                      i === idx ? { ...l, targetPorsi: e.target.value } : l
                    )))}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={lines.length <= 1}
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
            {activeMenus.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Belum ada menu aktif. Buat di Food Production → Menu.
              </p>
            )}
            {kitchens.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Belum ada dapur aktif. Buat di Food Production → Dapur.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button
              onClick={() => void save()}
              disabled={saving || !canSave}
            >
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Riwayat {historyRow?.noDokumen || ''}
            </DialogTitle>
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
