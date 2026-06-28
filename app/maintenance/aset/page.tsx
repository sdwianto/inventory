'use client';

import type { JsonObject } from '@/types/json';
import { str, num } from '@/types/json';
import type { SessionUser } from '@/types/auth';
import { useEffect, useMemo, useState } from 'react';
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
import { formatDate, formatIDR } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import { fetchJson } from '@/lib/fetch-json';
import { useConfirm } from '@/components/ConfirmProvider';
import { useAssets, useInvalidateMaintenance } from '@/lib/hooks/use-maintenance';
import {
  ASSET_KATEGORI,
  ASSET_MANAGE_ROLES,
  ASSET_STATUS_LABELS,
  ASSET_STATUS_STYLE,
  EMPTY_ASSET,
} from '@/lib/maintenance/constants';
import { Cog, Plus, Pencil, Trash2, Search, RefreshCw, ImageIcon } from 'lucide-react';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';

export default function MaintenanceAsetPage() {
  const confirm = useConfirm();
  const invalidate = useInvalidateMaintenance();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<JsonObject | null>(null);
  const [form, setForm] = useState<JsonObject>(EMPTY_ASSET);
  const [saving, setSaving] = useState(false);

  const { data: list = [], isLoading, refetch } = useAssets({ q, status: statusFilter });
  const canManage = ASSET_MANAGE_ROLES.includes(String(user?.role || '') as typeof ASSET_MANAGE_ROLES[number])
    || user?.role === 'MASTER';

  useEffect(() => {
    setUser(getUser());
  }, []);

  const openNew = () => {
    setEditing(null);
    setForm({ ...EMPTY_ASSET });
    setShowForm(true);
  };

  const openEdit = async (row: JsonObject) => {
    try {
      const full = await fetchJson<JsonObject>(`/api/assets/${str(row.id)}`);
      setEditing(full);
      setForm({
        ...full,
        tanggalBeli: full.tanggalBeli ? String(full.tanggalBeli).slice(0, 10) : '',
        fotoBase64: str(full.fotoBase64),
      });
      setShowForm(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat aset');
    }
  };

  const assetPhotos = str(form.fotoBase64) ? [str(form.fotoBase64)] : [];

  const setAssetPhotos = (photos: string[]) => {
    setForm({ ...form, fotoBase64: photos[0] || '' });
  };

  const save = async () => {
    if (!str(form.nama).trim()) {
      toast.error('Nama aset wajib diisi');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        nilaiPerolehan: num(form.nilaiPerolehan),
        tanggalBeli: str(form.tanggalBeli) || null,
        fotoBase64: str(form.fotoBase64) || null,
      };
      const url = editing ? `/api/assets/${str(editing.id)}` : '/api/assets';
      await fetchJson(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast.success(editing ? 'Aset diperbarui' : 'Aset ditambahkan');
      setShowForm(false);
      invalidate();
      void refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    }
    setSaving(false);
  };

  const remove = async (row: JsonObject) => {
    const ok = await confirm({
      title: 'Hapus aset?',
      description: `${str(row.kode)} — ${str(row.nama)}`,
      confirmText: 'Hapus',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await fetchJson(`/api/assets/${str(row.id)}`, { method: 'DELETE' });
      toast.success('Aset dihapus');
      invalidate();
      void refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal hapus');
    }
  };

  const filtered = useMemo(() => list, [list]);

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <OperationalScopeBar />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Cog className="w-6 h-6" /> Register Aset
            </h1>
            <p className="text-sm text-slate-500">
              Master data peralatan &amp; aset operasional untuk modul maintenance.
            </p>
          </div>
          {canManage && (
            <Button onClick={openNew} className="bg-orange-500 hover:bg-orange-600">
              <Plus className="w-4 h-4 mr-1" /> Tambah Aset
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              className="pl-9"
              placeholder="Cari kode, nama, serial..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Select value={statusFilter || 'ALL'} onValueChange={(v) => setStatusFilter(v === 'ALL' ? '' : v)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Semua status</SelectItem>
              {Object.entries(ASSET_STATUS_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => void refetch()}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        <div className="rounded-lg border bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left">
              <tr>
                <th className="p-3">Foto</th>
                <th className="p-3">Kode</th>
                <th className="p-3">Nama</th>
                <th className="p-3">Kategori</th>
                <th className="p-3">Lokasi</th>
                <th className="p-3">Status</th>
                <th className="p-3">Nilai</th>
                {canManage && <th className="p-3 w-24" />}
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={canManage ? 8 : 7} className="p-6 text-center text-slate-500">Memuat...</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={canManage ? 8 : 7} className="p-6 text-center text-slate-500">Belum ada aset</td></tr>
              )}
              {filtered.map((row) => {
                const status = str(row.status, 'ACTIVE') as keyof typeof ASSET_STATUS_STYLE;
                return (
                  <tr key={str(row.id)} className="border-t hover:bg-slate-50/80">
                    <td className="p-3">
                      {row.hasFoto ? (
                        <ImageIcon className="w-4 h-4 text-orange-500" aria-label="Ada foto" />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="p-3 font-mono text-xs">{str(row.kode)}</td>
                    <td className="p-3 font-medium">{str(row.nama)}</td>
                    <td className="p-3">{str(row.kategori)}</td>
                    <td className="p-3">{str(row.lokasi) || '—'}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ASSET_STATUS_STYLE[status] || ASSET_STATUS_STYLE.ACTIVE}`}>
                        {ASSET_STATUS_LABELS[status] || status}
                      </span>
                    </td>
                    <td className="p-3">{formatIDR(num(row.nilaiPerolehan))}</td>
                    {canManage && (
                      <td className="p-3">
                        <div className="flex gap-1">
                          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(row)}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-8 w-8 text-red-600" onClick={() => void remove(row)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Dialog open={showForm} onOpenChange={setShowForm}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editing ? 'Edit Aset' : 'Tambah Aset'}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Kode</Label>
                  <Input
                    value={str(form.kode)}
                    onChange={(e) => setForm({ ...form, kode: e.target.value })}
                    placeholder="Auto jika kosong"
                  />
                </div>
                <div>
                  <Label>Status</Label>
                  <Select value={str(form.status, 'ACTIVE')} onValueChange={(v) => setForm({ ...form, status: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(ASSET_STATUS_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Nama *</Label>
                <Input value={str(form.nama)} onChange={(e) => setForm({ ...form, nama: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Kategori</Label>
                  <Select value={str(form.kategori, 'Lainnya')} onValueChange={(v) => setForm({ ...form, kategori: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ASSET_KATEGORI.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Lokasi</Label>
                  <Input value={str(form.lokasi)} onChange={(e) => setForm({ ...form, lokasi: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Merk</Label>
                  <Input value={str(form.merk)} onChange={(e) => setForm({ ...form, merk: e.target.value })} />
                </div>
                <div>
                  <Label>Model</Label>
                  <Input value={str(form.model)} onChange={(e) => setForm({ ...form, model: e.target.value })} />
                </div>
              </div>
              <div>
                <Label>Serial Number</Label>
                <Input value={str(form.serialNumber)} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Tanggal Beli</Label>
                  <Input type="date" value={str(form.tanggalBeli)} onChange={(e) => setForm({ ...form, tanggalBeli: e.target.value })} />
                </div>
                <div>
                  <Label>Nilai Perolehan</Label>
                  <Input
                    type="number"
                    value={num(form.nilaiPerolehan)}
                    onChange={(e) => setForm({ ...form, nilaiPerolehan: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label>Vendor / Supplier Asal</Label>
                <Input value={str(form.vendorAsal)} onChange={(e) => setForm({ ...form, vendorAsal: e.target.value })} />
              </div>
              <div>
                <Label>Catatan</Label>
                <Textarea value={str(form.catatan)} onChange={(e) => setForm({ ...form, catatan: e.target.value })} rows={2} />
              </div>
              <PhotoUploadField
                label="Foto Aset"
                hint="Opsional. Maks. 1 foto, otomatis dikompres sebelum disimpan."
                photos={assetPhotos}
                onChange={setAssetPhotos}
                maxPhotos={1}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? 'Menyimpan...' : 'Simpan'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  );
}
