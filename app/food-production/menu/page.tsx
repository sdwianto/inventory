'use client';

import { useCallback, useEffect, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { UtensilsCrossed, Plus, Pencil, RefreshCw, Trash2 } from 'lucide-react';

interface RecipeOpt {
  id: string;
  kode: string;
  nama: string;
  aktif?: boolean;
}

interface MenuItemForm {
  recipeId: string;
  porsi: string;
}

interface MenuRow {
  id: string;
  kode: string;
  nama: string;
  version: number;
  effectiveDate: string;
  targetCostPerPorsi?: number;
  catatan?: string;
  items: Array<{ recipeId: string; porsi: number; recipeKode?: string; recipeNama?: string }>;
  aktif: boolean;
}

const emptyItem = (): MenuItemForm => ({ recipeId: '', porsi: '1' });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function FoodProductionMenuPage() {
  const [rows, setRows] = useState<MenuRow[]>([]);
  const [recipes, setRecipes] = useState<RecipeOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MenuRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    kode: '',
    nama: '',
    version: '1',
    effectiveDate: today(),
    targetCostPerPorsi: '',
    catatan: '',
    aktif: true,
  });
  const [items, setItems] = useState<MenuItemForm[]>([emptyItem()]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, rRes] = await Promise.all([
        fetch('/api/menus', { headers: { ...actingTenantHeaders() } }),
        // Semua resep (aktif + nonaktif) agar edit menu yang ada resep mati tetap bisa diload.
        fetch('/api/recipes', { headers: { ...actingTenantHeaders() } }),
      ]);
      const mData = await mRes.json();
      const rData = await rRes.json();
      if (!mRes.ok) throw new Error(mData?.error || 'Gagal memuat menu');
      setRows(Array.isArray(mData) ? mData : []);
      setRecipes(Array.isArray(rData) ? rData : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat menu');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm({
      kode: '',
      nama: '',
      version: '1',
      effectiveDate: today(),
      targetCostPerPorsi: '',
      catatan: '',
      aktif: true,
    });
    setItems([emptyItem()]);
    setOpen(true);
  }

  function openEdit(row: MenuRow) {
    setEditing(row);
    setForm({
      kode: row.kode,
      nama: row.nama,
      version: String(row.version || 1),
      effectiveDate: row.effectiveDate || today(),
      targetCostPerPorsi: row.targetCostPerPorsi != null ? String(row.targetCostPerPorsi) : '',
      catatan: row.catatan || '',
      aktif: row.aktif !== false,
    });
    setItems(
      (row.items || []).length
        ? row.items.map((i) => ({ recipeId: i.recipeId, porsi: String(i.porsi) }))
        : [emptyItem()],
    );
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const payload = {
        kode: form.kode.trim() || undefined,
        nama: form.nama.trim(),
        version: Number(form.version) || 1,
        effectiveDate: form.effectiveDate,
        targetCostPerPorsi: form.targetCostPerPorsi === '' ? null : Number(form.targetCostPerPorsi),
        catatan: form.catatan.trim() || undefined,
        aktif: form.aktif,
        items: items
          .filter((i) => i.recipeId)
          .map((i) => ({
            recipeId: i.recipeId,
            porsi: Number(i.porsi) || 1,
          })),
      };
      const url = editing ? `/api/menus/${editing.id}` : '/api/menus';
      const method = editing ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      toast.success(editing ? 'Menu diperbarui' : 'Menu ditambahkan');
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(row: MenuRow) {
    try {
      const res = await fetch(`/api/menus/${row.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menonaktifkan');
      toast.success('Menu dinonaktifkan');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menonaktifkan');
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <UtensilsCrossed className="h-5 w-5" />
            Menu
          </h1>
          <p className="text-sm text-muted-foreground">
            Kumpulan resep + target cost/porsi (standar sederhana)
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Muat ulang
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />
            Tambah Menu
          </Button>
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">Kode</th>
              <th className="text-left p-3 font-medium">Nama</th>
              <th className="text-left p-3 font-medium">Resep</th>
              <th className="text-left p-3 font-medium">Target cost</th>
              <th className="text-left p-3 font-medium">Efektif</th>
              <th className="text-left p-3 font-medium">Ver</th>
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
                  Belum ada menu. Buat resep dulu, lalu susun menu.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.kode}</td>
                <td className="p-3 font-medium">{row.nama}</td>
                <td className="p-3">{(row.items || []).length} resep</td>
                <td className="p-3">
                  {row.targetCostPerPorsi != null
                    ? `Rp ${Number(row.targetCostPerPorsi).toLocaleString('id-ID')}`
                    : '—'}
                </td>
                <td className="p-3 whitespace-nowrap">{row.effectiveDate || '—'}</td>
                <td className="p-3">v{row.version}</td>
                <td className="p-3">{row.aktif ? 'Aktif' : 'Nonaktif'}</td>
                <td className="p-3 text-right whitespace-nowrap">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {row.aktif && (
                    <Button variant="ghost" size="sm" onClick={() => void deactivate(row)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Ubah Menu' : 'Tambah Menu'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label>Nama *</Label>
              <Input
                value={form.nama}
                onChange={(e) => setForm((f) => ({ ...f, nama: e.target.value }))}
                placeholder="Menu Siang Sekolah"
              />
            </div>
            <div className="space-y-1">
              <Label>Kode</Label>
              <Input
                value={form.kode}
                onChange={(e) => setForm((f) => ({ ...f, kode: e.target.value }))}
                placeholder="Otomatis jika kosong"
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label>Target cost / porsi</Label>
              <Input
                type="number"
                min={0}
                value={form.targetCostPerPorsi}
                onChange={(e) => setForm((f) => ({ ...f, targetCostPerPorsi: e.target.value }))}
                placeholder="Opsional"
              />
            </div>
            <div className="space-y-1">
              <Label>Versi</Label>
              <Input
                type="number"
                min={1}
                value={form.version}
                onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Tanggal efektif</Label>
              <Input
                type="date"
                value={form.effectiveDate}
                onChange={(e) => setForm((f) => ({ ...f, effectiveDate: e.target.value }))}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Catatan</Label>
              <Input
                value={form.catatan}
                onChange={(e) => setForm((f) => ({ ...f, catatan: e.target.value }))}
                placeholder="Opsional"
              />
            </div>
            {editing && (
              <label className="sm:col-span-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.aktif}
                  onChange={(e) => setForm((f) => ({ ...f, aktif: e.target.checked }))}
                />
                Aktif
              </label>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Resep dalam menu</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setItems((prev) => [...prev, emptyItem()])}
              >
                <Plus className="h-3 w-3 mr-1" />
                Resep
              </Button>
            </div>
            {items.map((item, idx) => (
              <div key={idx} className="grid gap-2 sm:grid-cols-12 items-end border rounded-md p-2">
                <div className="sm:col-span-8 space-y-1">
                  <Label className="text-xs">Resep</Label>
                  <select
                    className="w-full border rounded-md px-2 py-1.5 text-sm bg-white"
                    value={item.recipeId}
                    onChange={(e) => setItems((prev) => prev.map((it, i) => (
                      i === idx ? { ...it, recipeId: e.target.value } : it
                    )))}
                  >
                    <option value="">— Pilih resep —</option>
                    {recipes
                      .filter((r) => r.aktif !== false || r.id === item.recipeId)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.kode} — {r.nama}{r.aktif === false ? ' (nonaktif)' : ''}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <Label className="text-xs">Porsi</Label>
                  <Input
                    type="number"
                    min={1}
                    value={item.porsi}
                    onChange={(e) => setItems((prev) => prev.map((it, i) => (
                      i === idx ? { ...it, porsi: e.target.value } : it
                    )))}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={items.length <= 1}
                    onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
            {recipes.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Belum ada resep aktif. Buat resep di menu Food Production → Resep.
              </p>
            )}
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
