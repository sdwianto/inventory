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
import { Car, Plus, Pencil, RefreshCw, Power } from 'lucide-react';
import { nextArmadaKode } from '@/lib/logistics/armada';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface KitchenOpt { id: string; nama: string }
interface ArmadaRow {
  id: string;
  kode: string;
  nama: string;
  platNomor?: string;
  kapasitasPorsi?: number;
  kitchenId?: string;
  kitchenNama?: string;
  aktif: boolean;
}

const emptyForm = {
  kode: '',
  nama: '',
  platNomor: '',
  kapasitasPorsi: '',
  kitchenId: '',
};

export default function ArmadaPage() {
  const confirm = useConfirm();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<ArmadaRow[]>([]);
  const [kitchens, setKitchens] = useState<KitchenOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ArmadaRow | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [aRes, kRes] = await Promise.all([
        fetch('/api/armadas', { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
        fetch('/api/kitchens?aktif=1', { headers: { ...actingTenantHeaders() } }),
      ]);
      const aData = await aRes.json();
      const kData = await kRes.json();
      if (!aRes.ok) throw new Error(aData?.error || 'Gagal memuat');
      setRows(Array.isArray(aData) ? aData : []);
      setKitchens(Array.isArray(kData) ? kData : []);
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

  function openCreate() {
    setEditing(null);
    setForm({ ...emptyForm, kode: nextArmadaKode(rows) });
    setOpen(true);
  }

  function openEdit(row: ArmadaRow) {
    setEditing(row);
    setForm({
      kode: row.kode || '',
      nama: row.nama,
      platNomor: row.platNomor || '',
      kapasitasPorsi: row.kapasitasPorsi != null ? String(row.kapasitasPorsi) : '',
      kitchenId: row.kitchenId || '',
    });
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const url = editing ? `/api/armadas/${editing.id}` : '/api/armadas';
      const method = editing ? 'PUT' : 'POST';
      const kap = Number(form.kapasitasPorsi);
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          kode: form.kode || undefined,
          nama: form.nama,
          platNomor: form.platNomor || undefined,
          kapasitasPorsi: Number.isFinite(kap) && kap > 0 ? Math.round(kap) : undefined,
          kitchenId: form.kitchenId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      toast.success(editing ? 'Armada diperbarui' : 'Armada ditambahkan');
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function toggleAktif(row: ArmadaRow) {
    const ok = await confirm({
      title: row.aktif ? 'Nonaktifkan armada?' : 'Aktifkan armada?',
      description: row.nama,
    });
    if (!ok) return;
    const res = await fetch(`/api/armadas/${row.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
      body: JSON.stringify({ aktif: !row.aktif }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal');
      return;
    }
    toast.success(row.aktif ? 'Armada dinonaktifkan' : 'Armada diaktifkan');
    await load();
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Car className="h-5 w-5" />
            Armada Kendaraan
          </h1>
          <p className="text-sm text-muted-foreground">
            Master kendaraan untuk packing / rute distribusi MBG
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
          {canManage && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" /> Tambah
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Kode</th>
              <th className="text-left p-3">Nama</th>
              <th className="text-left p-3">Plat</th>
              <th className="text-right p-3">Kapasitas</th>
              <th className="text-left p-3">Dapur</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Belum ada armada</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.kode}</td>
                <td className="p-3 font-medium">{row.nama}</td>
                <td className="p-3 font-mono text-xs">{row.platNomor || '—'}</td>
                <td className="p-3 text-right tabular-nums">{row.kapasitasPorsi ?? '—'}</td>
                <td className="p-3">{row.kitchenNama || '—'}</td>
                <td className="p-3">{row.aktif ? 'Aktif' : 'Nonaktif'}</td>
                <td className="p-3 text-right space-x-1">
                  {canManage && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(row)} title="Ubah">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void toggleAktif(row)}
                        title={row.aktif ? 'Nonaktifkan' : 'Aktifkan'}
                      >
                        <Power className={`h-4 w-4 ${row.aktif ? 'text-destructive' : 'text-emerald-600'}`} />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Ubah Armada' : 'Tambah Armada'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Kode</Label>
                <Input
                  value={form.kode}
                  onChange={(e) => setForm((f) => ({ ...f, kode: e.target.value }))}
                  placeholder="ARM-01"
                />
              </div>
              <div className="space-y-1">
                <Label>Plat nomor</Label>
                <Input
                  value={form.platNomor}
                  onChange={(e) => setForm((f) => ({ ...f, platNomor: e.target.value }))}
                  placeholder="N 1234 AB"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Nama</Label>
              <Input
                value={form.nama}
                onChange={(e) => setForm((f) => ({ ...f, nama: e.target.value }))}
                placeholder="Mobil Box 1"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Kapasitas (porsi)</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.kapasitasPorsi}
                  onChange={(e) => setForm((f) => ({ ...f, kapasitasPorsi: e.target.value }))}
                  placeholder="opsional"
                />
              </div>
              <div className="space-y-1">
                <Label>Dapur</Label>
                <select
                  className="w-full h-10 border rounded-md px-2 text-sm"
                  value={form.kitchenId}
                  onChange={(e) => setForm((f) => ({ ...f, kitchenId: e.target.value }))}
                >
                  <option value="">—</option>
                  {kitchens.map((k) => <option key={k.id} value={k.id}>{k.nama}</option>)}
                </select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button onClick={() => void save()} disabled={saving || !form.nama.trim()}>
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
