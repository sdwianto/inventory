'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { KITCHEN_TYPE_LABELS, type KitchenType } from '@/lib/food-production/kitchen';
import { ChefHat, Plus, Pencil, RefreshCw } from 'lucide-react';

interface KitchenRow {
  id: string;
  kode?: string;
  nama: string;
  kitchenType?: KitchenType;
  centralKitchenId?: string;
  defaultWarehouseKode: string;
  defaultWarehouseLabel?: string;
  pic?: string;
  aktif: boolean;
}

const emptyForm = {
  kode: '',
  nama: '',
  kitchenType: 'SATELLITE' as KitchenType,
  centralKitchenId: '',
  defaultWarehouseKode: 'GKERING',
  pic: '',
};

export default function FoodProductionKitchenPage() {
  const [rows, setRows] = useState<KitchenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<KitchenRow | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const centrals = useMemo(
    () => rows.filter((r) => r.kitchenType === 'CENTRAL' && r.aktif !== false && (!editing || r.id !== editing.id)),
    [rows, editing],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/kitchens', { headers: { ...actingTenantHeaders() } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat dapur');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat dapur');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function openEdit(row: KitchenRow) {
    setEditing(row);
    setForm({
      kode: row.kode || '',
      nama: row.nama,
      kitchenType: row.kitchenType === 'CENTRAL' ? 'CENTRAL' : 'SATELLITE',
      centralKitchenId: row.centralKitchenId || '',
      defaultWarehouseKode: row.defaultWarehouseKode || 'GKERING',
      pic: row.pic || '',
    });
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const url = editing ? `/api/kitchens/${editing.id}` : '/api/kitchens';
      const method = editing ? 'PUT' : 'POST';
      const body = {
        kode: form.kode.trim() || undefined,
        nama: form.nama,
        kitchenType: form.kitchenType,
        centralKitchenId: form.kitchenType === 'SATELLITE' ? (form.centralKitchenId || undefined) : undefined,
        defaultWarehouseKode: form.defaultWarehouseKode,
        pic: form.pic,
      };
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      toast.success(editing ? 'Dapur diperbarui' : 'Dapur ditambahkan');
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ChefHat className="h-5 w-5" />
            Dapur
          </h1>
          <p className="text-sm text-muted-foreground">
            Master dapur — kode, tipe Central/Satelit, gudang default, hub
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Muat ulang
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />
            Tambah Dapur
          </Button>
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">Kode</th>
              <th className="text-left p-3 font-medium">Nama</th>
              <th className="text-left p-3 font-medium">Tipe</th>
              <th className="text-left p-3 font-medium">Gudang</th>
              <th className="text-left p-3 font-medium">PIC</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">
                  Memuat…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">
                  Belum ada dapur. Tambahkan Central Kitchen lalu satelit bila perlu.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.kode || '—'}</td>
                <td className="p-3 font-medium">{row.nama}</td>
                <td className="p-3">
                  {KITCHEN_TYPE_LABELS[row.kitchenType === 'CENTRAL' ? 'CENTRAL' : 'SATELLITE']}
                </td>
                <td className="p-3">
                  {row.defaultWarehouseLabel || row.defaultWarehouseKode}
                </td>
                <td className="p-3">{row.pic || '—'}</td>
                <td className="p-3">{row.aktif ? 'Aktif' : 'Nonaktif'}</td>
                <td className="p-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Ubah Dapur' : 'Tambah Dapur'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Kode (opsional)</Label>
              <Input
                value={form.kode}
                onChange={(e) => setForm((f) => ({ ...f, kode: e.target.value }))}
                placeholder="CK-JKT"
              />
            </div>
            <div className="space-y-1">
              <Label>Nama dapur</Label>
              <Input
                value={form.nama}
                onChange={(e) => setForm((f) => ({ ...f, nama: e.target.value }))}
                placeholder="Dapur Utama"
              />
            </div>
            <div className="space-y-1">
              <Label>Tipe</Label>
              <Select
                value={form.kitchenType}
                onValueChange={(v) => setForm((f) => ({
                  ...f,
                  kitchenType: v as KitchenType,
                  centralKitchenId: v === 'CENTRAL' ? '' : f.centralKitchenId,
                }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CENTRAL">Central Kitchen</SelectItem>
                  <SelectItem value="SATELLITE">Dapur Satelit</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.kitchenType === 'SATELLITE' && (
              <div className="space-y-1">
                <Label>Central Kitchen (opsional)</Label>
                <Select
                  value={form.centralKitchenId || '__none__'}
                  onValueChange={(v) => setForm((f) => ({
                    ...f,
                    centralKitchenId: v === '__none__' ? '' : v,
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Tidak terhubung" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Tidak terhubung</SelectItem>
                    {centrals.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.kode ? `${c.kode} — ` : ''}{c.nama}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>Gudang default</Label>
              <Select
                value={form.defaultWarehouseKode}
                onValueChange={(v) => setForm((f) => ({ ...f, defaultWarehouseKode: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GKERING">Gudang Kering (GKERING)</SelectItem>
                  <SelectItem value="GBASAH">Gudang Basah (GBASAH)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>PIC (opsional)</Label>
              <Input
                value={form.pic}
                onChange={(e) => setForm((f) => ({ ...f, pic: e.target.value }))}
                placeholder="Nama penanggung jawab"
              />
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
