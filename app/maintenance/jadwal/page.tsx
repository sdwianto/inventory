'use client';

import type { JsonObject } from '@/types/json';
import { str, num } from '@/types/json';
import type { SessionUser } from '@/types/auth';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatDate } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import { fetchJson } from '@/lib/fetch-json';
import {
  useAssets,
  useMaintenanceSchedules,
  useInvalidateMaintenance,
} from '@/lib/hooks/use-maintenance';
import {
  EMPTY_PM_SCHEDULE,
  PM_INTERVAL_LABELS,
  PM_MANAGE_ROLES,
  PM_STATUS_LABELS,
  PM_STATUS_STYLE,
  WR_PRIORITY_LABELS,
} from '@/lib/maintenance/constants';
import { CalendarClock, Plus, Pencil, RefreshCw, Play, Pause, Archive } from 'lucide-react';
import Link from 'next/link';

export default function MaintenanceJadwalPage() {
  const invalidate = useInvalidateMaintenance();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [statusFilter, setStatusFilter] = useState('ACTIVE');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<JsonObject | null>(null);
  const [form, setForm] = useState<JsonObject>(EMPTY_PM_SCHEDULE);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const { data: list = [], isLoading, refetch } = useMaintenanceSchedules({
    status: statusFilter === 'ALL' ? '' : statusFilter,
  });
  const { data: assets = [] } = useAssets({ enabled: showForm || list.length > 0 });

  const canManage = PM_MANAGE_ROLES.includes(String(user?.role || '') as typeof PM_MANAGE_ROLES[number])
    || user?.role === 'MASTER';

  useEffect(() => {
    setUser(getUser());
  }, []);

  const activeAssets = assets.filter((a) => str(a.status) !== 'DISPOSED');

  const openNew = () => {
    setEditing(null);
    const defaultDue = new Date();
    defaultDue.setDate(defaultDue.getDate() + 30);
    setForm({
      ...EMPTY_PM_SCHEDULE,
      nextDueDate: defaultDue.toISOString().slice(0, 10),
    });
    setShowForm(true);
  };

  const openEdit = (row: JsonObject) => {
    setEditing(row);
    setForm({
      ...row,
      nextDueDate: row.nextDueDate ? String(row.nextDueDate).slice(0, 10) : '',
    });
    setShowForm(true);
  };

  const save = async () => {
    if (!form.assetId) {
      toast.error('Pilih aset');
      return;
    }
    if (!str(form.judul).trim()) {
      toast.error('Judul jadwal wajib diisi');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        assetId: str(form.assetId),
        judul: str(form.judul),
        deskripsi: str(form.deskripsi),
        checklist: str(form.checklist),
        priority: str(form.priority, 'MEDIUM'),
        intervalUnit: str(form.intervalUnit, 'MONTHS'),
        intervalValue: num(form.intervalValue, 1),
        leadDays: num(form.leadDays, 7),
        nextDueDate: str(form.nextDueDate),
        status: str(form.status, 'ACTIVE'),
      };
      if (editing) {
        await fetchJson(`/api/maintenance-schedules/${str(editing.id)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        toast.success('Jadwal diperbarui');
      } else {
        await fetchJson('/api/maintenance-schedules', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast.success('Jadwal PM dibuat');
      }
      setShowForm(false);
      invalidate();
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  };

  const runDue = async () => {
    setRunning(true);
    try {
      const result = await fetchJson<{ generated?: number; skipped?: number; errors?: unknown[] }>(
        '/api/maintenance-schedules/run-due',
        { method: 'POST', body: '{}' },
      );
      const n = result?.generated ?? 0;
      if (n > 0) {
        toast.success(`${n} permintaan preventif dibuat`);
      } else {
        toast.info('Tidak ada jadwal jatuh tempo yang perlu diproses');
      }
      invalidate();
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memproses jadwal');
    } finally {
      setRunning(false);
    }
  };

  const setStatus = async (row: JsonObject, status: string) => {
    try {
      await fetchJson(`/api/maintenance-schedules/${str(row.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      toast.success(status === 'PAUSED' ? 'Jadwal dijeda' : status === 'ACTIVE' ? 'Jadwal diaktifkan' : 'Jadwal diarsipkan');
      invalidate();
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal mengubah status');
    }
  };

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <OperationalScopeBar />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <CalendarClock className="w-6 h-6" /> Jadwal Preventive Maintenance
            </h1>
            <p className="text-sm text-slate-500">
              Perawatan rutin per aset — otomatis buat WR draft saat jatuh tempo.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
            {canManage && (
              <>
                <Button variant="outline" size="sm" onClick={() => void runDue()} disabled={running}>
                  <Play className="w-4 h-4 mr-1" /> Proses Jatuh Tempo
                </Button>
                <Button onClick={openNew} className="bg-orange-500 hover:bg-orange-600" disabled={!activeAssets.length}>
                  <Plus className="w-4 h-4 mr-1" /> Jadwal Baru
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <Label className="text-sm text-slate-600">Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">Aktif</SelectItem>
              <SelectItem value="PAUSED">Dijeda</SelectItem>
              <SelectItem value="ARCHIVED">Arsip</SelectItem>
              <SelectItem value="ALL">Semua</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading && !list.length ? (
          <div className="text-sm text-slate-500 py-8 text-center">Memuat jadwal…</div>
        ) : !list.length ? (
          <div className="border rounded-lg bg-white p-8 text-center text-slate-500">
            Belum ada jadwal PM. {canManage && 'Buat jadwal untuk aset kritis (AC, mesin, kendaraan).'}
          </div>
        ) : (
          <div className="space-y-3">
            {list.map((row) => {
              const st = str(row.status, 'ACTIVE');
              const overdue = row.isOverdue === true;
              const dueSoon = row.isDueSoon === true;
              return (
                <div
                  key={str(row.id)}
                  className={`rounded-lg border bg-white p-4 space-y-2 ${overdue ? 'border-red-300 bg-red-50/30' : dueSoon ? 'border-amber-300' : ''}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-slate-500">{str(row.noPM)}</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${PM_STATUS_STYLE[st] || PM_STATUS_STYLE.ACTIVE}`}>
                          {PM_STATUS_LABELS[st] || st}
                        </span>
                        {overdue && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                            Jatuh tempo
                          </span>
                        )}
                        {dueSoon && !overdue && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                            Segera jatuh tempo
                          </span>
                        )}
                      </div>
                      <h3 className="font-semibold">{str(row.judul)}</h3>
                      <p className="text-sm text-slate-600">
                        Aset: <strong>{str(row.assetKode)}</strong> — {str(row.assetNama)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {str(row.intervalLabel)} · Prioritas {WR_PRIORITY_LABELS[str(row.priority, 'MEDIUM') as keyof typeof WR_PRIORITY_LABELS] || str(row.priority)}
                        · Reminder {num(row.leadDays, 0)} hari sebelumnya
                      </p>
                      <p className="text-sm">
                        Jatuh tempo berikutnya:{' '}
                        <strong>{row.nextDueDate ? formatDate(String(row.nextDueDate)) : '—'}</strong>
                      </p>
                      {str(row.lastWrNo) && (
                        <p className="text-xs text-slate-500">
                          WR terakhir:{' '}
                          <Link href="/maintenance/permintaan" className="text-orange-600 hover:underline font-mono">
                            {str(row.lastWrNo)}
                          </Link>
                        </p>
                      )}
                    </div>
                    {canManage && (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" className="h-8" onClick={() => openEdit(row)}>
                          <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                        </Button>
                        {st === 'ACTIVE' && (
                          <Button size="sm" variant="outline" className="h-8" onClick={() => void setStatus(row, 'PAUSED')}>
                            <Pause className="w-3.5 h-3.5 mr-1" /> Jeda
                          </Button>
                        )}
                        {st === 'PAUSED' && (
                          <Button size="sm" variant="outline" className="h-8" onClick={() => void setStatus(row, 'ACTIVE')}>
                            <Play className="w-3.5 h-3.5 mr-1" /> Aktifkan
                          </Button>
                        )}
                        {st !== 'ARCHIVED' && (
                          <Button size="sm" variant="outline" className="h-8 text-red-600" onClick={() => void setStatus(row, 'ARCHIVED')}>
                            <Archive className="w-3.5 h-3.5 mr-1" /> Arsip
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {str(row.deskripsi) && (
                    <p className="text-sm text-slate-500 border-t pt-2">{str(row.deskripsi)}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <Dialog open={showForm} onOpenChange={setShowForm}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editing ? 'Edit Jadwal PM' : 'Jadwal PM Baru'}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 py-2">
              <div>
                <Label>Aset *</Label>
                <Select value={str(form.assetId)} onValueChange={(v) => setForm({ ...form, assetId: v })}>
                  <SelectTrigger><SelectValue placeholder="Pilih aset" /></SelectTrigger>
                  <SelectContent>
                    {activeAssets.map((a) => (
                      <SelectItem key={str(a.id)} value={str(a.id)}>
                        {str(a.kode)} — {str(a.nama)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Judul pekerjaan *</Label>
                <Input
                  value={str(form.judul)}
                  onChange={(e) => setForm({ ...form, judul: e.target.value })}
                  placeholder="Contoh: Service AC bulanan"
                />
              </div>
              <div>
                <Label>Deskripsi</Label>
                <Textarea
                  value={str(form.deskripsi)}
                  onChange={(e) => setForm({ ...form, deskripsi: e.target.value })}
                  rows={2}
                />
              </div>
              <div>
                <Label>Checklist (opsional)</Label>
                <Textarea
                  value={str(form.checklist)}
                  onChange={(e) => setForm({ ...form, checklist: e.target.value })}
                  rows={3}
                  placeholder="Satu item per baris"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Interval</Label>
                  <Select value={str(form.intervalUnit, 'MONTHS')} onValueChange={(v) => setForm({ ...form, intervalUnit: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(PM_INTERVAL_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Nilai interval</Label>
                  <Input
                    type="number"
                    min={1}
                    value={num(form.intervalValue, 1)}
                    onChange={(e) => setForm({ ...form, intervalValue: parseInt(e.target.value, 10) || 1 })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Prioritas WR</Label>
                  <Select value={str(form.priority, 'MEDIUM')} onValueChange={(v) => setForm({ ...form, priority: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(WR_PRIORITY_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Reminder (hari sebelum)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={num(form.leadDays, 7)}
                    onChange={(e) => setForm({ ...form, leadDays: parseInt(e.target.value, 10) || 0 })}
                  />
                </div>
              </div>
              <div>
                <Label>Jatuh tempo berikutnya *</Label>
                <Input
                  type="date"
                  value={str(form.nextDueDate)}
                  onChange={(e) => setForm({ ...form, nextDueDate: e.target.value })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button>
              <Button onClick={() => void save()} disabled={saving} className="bg-orange-500 hover:bg-orange-600">
                {saving ? 'Menyimpan…' : 'Simpan'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  );
}
