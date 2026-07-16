'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { BookOpen, Plus, Pencil, RefreshCw, Trash2 } from 'lucide-react';

interface ProductOpt {
  id: string;
  kode: string;
  nama: string;
  satuan?: string;
  itemRole?: string;
  aktif?: boolean;
}

interface RecipeLineForm {
  productId: string;
  qty: string;
  satuan: string;
  notes: string;
}

interface RecipeRow {
  id: string;
  kode: string;
  nama: string;
  finishedGoodProductId: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  version: number;
  effectiveDate: string;
  yieldQty: number;
  wastePct?: number;
  catatan?: string;
  lines: Array<{ productId: string; qty: number; satuan?: string; notes?: string; productNama?: string }>;
  aktif: boolean;
}

const emptyLine = (): RecipeLineForm => ({ productId: '', qty: '1', satuan: '', notes: '' });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function FoodProductionRecipePage() {
  const [rows, setRows] = useState<RecipeRow[]>([]);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RecipeRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    kode: '',
    nama: '',
    finishedGoodProductId: '',
    version: '1',
    effectiveDate: today(),
    yieldQty: '100',
    wastePct: '',
    catatan: '',
    aktif: true,
  });
  const [lines, setLines] = useState<RecipeLineForm[]>([emptyLine()]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rRes, pRes] = await Promise.all([
        fetch('/api/recipes', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/products?limit=200&enrichUom=0', { headers: { ...actingTenantHeaders() } }),
      ]);
      const rData = await rRes.json();
      const pData = await pRes.json();
      if (!rRes.ok) throw new Error(rData?.error || 'Gagal memuat resep');
      setRows(Array.isArray(rData) ? rData : []);
      const list = Array.isArray(pData)
        ? pData
        : (Array.isArray(pData?.items) ? pData.items : (Array.isArray(pData?.data) ? pData.data : []));
      setProducts(list.map((p: ProductOpt) => ({
        id: String(p.id),
        kode: String(p.kode || ''),
        nama: String(p.nama || ''),
        satuan: p.satuan ? String(p.satuan) : '',
        itemRole: p.itemRole ? String(p.itemRole) : undefined,
        aktif: p.aktif !== false,
      })));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat resep');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeProducts = useMemo(() => products.filter((p) => p.aktif !== false), [products]);
  const fgOptions = useMemo(
    () => activeProducts.filter((p) => !p.itemRole || p.itemRole === 'FINISHED_GOOD' || p.itemRole === 'SEMI_FINISHED'),
    [activeProducts],
  );
  const ingredientOptions = useMemo(
    () => activeProducts.filter((p) => !p.itemRole || p.itemRole === 'INGREDIENT' || p.itemRole === 'PACKAGING' || p.itemRole === 'CONSUMABLE' || p.itemRole === 'SEMI_FINISHED'),
    [activeProducts],
  );

  function openCreate() {
    setEditing(null);
    setForm({
      kode: '',
      nama: '',
      finishedGoodProductId: '',
      version: '1',
      effectiveDate: today(),
      yieldQty: '100',
      wastePct: '',
      catatan: '',
      aktif: true,
    });
    setLines([emptyLine()]);
    setOpen(true);
  }

  function openEdit(row: RecipeRow) {
    setEditing(row);
    setForm({
      kode: row.kode,
      nama: row.nama,
      finishedGoodProductId: row.finishedGoodProductId,
      version: String(row.version || 1),
      effectiveDate: row.effectiveDate || today(),
      yieldQty: String(row.yieldQty || 1),
      wastePct: row.wastePct != null ? String(row.wastePct) : '',
      catatan: row.catatan || '',
      aktif: row.aktif !== false,
    });
    setLines(
      (row.lines || []).length
        ? row.lines.map((l) => ({
          productId: l.productId,
          qty: String(l.qty),
          satuan: l.satuan || '',
          notes: l.notes || '',
        }))
        : [emptyLine()],
    );
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const payload = {
        kode: form.kode.trim() || undefined,
        nama: form.nama.trim(),
        finishedGoodProductId: form.finishedGoodProductId,
        version: Number(form.version) || 1,
        effectiveDate: form.effectiveDate,
        yieldQty: Number(form.yieldQty),
        wastePct: form.wastePct === '' ? null : Number(form.wastePct),
        catatan: form.catatan.trim() || undefined,
        aktif: form.aktif,
        lines: lines
          .filter((l) => l.productId)
          .map((l) => ({
            productId: l.productId,
            qty: Number(l.qty),
            satuan: l.satuan || undefined,
            notes: l.notes.trim() || undefined,
          })),
      };
      const url = editing ? `/api/recipes/${editing.id}` : '/api/recipes';
      const method = editing ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      toast.success(editing ? 'Resep diperbarui' : 'Resep ditambahkan');
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(row: RecipeRow) {
    try {
      const res = await fetch(`/api/recipes/${row.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menonaktifkan');
      toast.success('Resep dinonaktifkan');
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
            <BookOpen className="h-5 w-5" />
            Resep
          </h1>
          <p className="text-sm text-muted-foreground">
            Food BOM — barang jadi, yield porsi, bahan, versi &amp; tanggal efektif
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Muat ulang
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />
            Tambah Resep
          </Button>
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">Kode</th>
              <th className="text-left p-3 font-medium">Nama</th>
              <th className="text-left p-3 font-medium">Barang jadi</th>
              <th className="text-left p-3 font-medium">Yield</th>
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
                  Belum ada resep. Buat resep sebelum Menu / Rencana Produksi.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.kode}</td>
                <td className="p-3 font-medium">{row.nama}</td>
                <td className="p-3">
                  {row.finishedGoodNama || row.finishedGoodKode || row.finishedGoodProductId}
                </td>
                <td className="p-3">{row.yieldQty} porsi</td>
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
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Ubah Resep' : 'Tambah Resep'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Nama *</Label>
              <Input
                value={form.nama}
                onChange={(e) => setForm((f) => ({ ...f, nama: e.target.value }))}
                placeholder="Nasi Ayam 100 porsi"
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
            <div className="space-y-1 sm:col-span-2">
              <Label>Barang jadi *</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm bg-white"
                value={form.finishedGoodProductId}
                onChange={(e) => setForm((f) => ({ ...f, finishedGoodProductId: e.target.value }))}
              >
                <option value="">— Pilih produk —</option>
                {(fgOptions.length ? fgOptions : activeProducts).map((p) => (
                  <option key={p.id} value={p.id}>{p.kode} — {p.nama}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Yield (porsi) *</Label>
              <Input
                type="number"
                min={1}
                value={form.yieldQty}
                onChange={(e) => setForm((f) => ({ ...f, yieldQty: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Waste % (opsional)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={form.wastePct}
                onChange={(e) => setForm((f) => ({ ...f, wastePct: e.target.value }))}
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
              <Label>Bahan</Label>
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
                <div className="sm:col-span-6 space-y-1">
                  <Label className="text-xs">Produk</Label>
                  <select
                    className="w-full border rounded-md px-2 py-1.5 text-sm bg-white"
                    value={line.productId}
                    onChange={(e) => {
                      const id = e.target.value;
                      const p = products.find((x) => x.id === id);
                      setLines((prev) => prev.map((l, i) => (
                        i === idx
                          ? { ...l, productId: id, satuan: p?.satuan || l.satuan }
                          : l
                      )));
                    }}
                  >
                    <option value="">— Bahan —</option>
                    {(ingredientOptions.length ? ingredientOptions : activeProducts).map((p) => (
                      <option key={p.id} value={p.id}>{p.kode} — {p.nama}</option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <Label className="text-xs">Qty</Label>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={line.qty}
                    onChange={(e) => setLines((prev) => prev.map((l, i) => (
                      i === idx ? { ...l, qty: e.target.value } : l
                    )))}
                  />
                </div>
                <div className="sm:col-span-2 space-y-1">
                  <Label className="text-xs">Satuan</Label>
                  <Input
                    value={line.satuan}
                    onChange={(e) => setLines((prev) => prev.map((l, i) => (
                      i === idx ? { ...l, satuan: e.target.value } : l
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
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button
              onClick={() => void save()}
              disabled={saving || !form.nama.trim() || !form.finishedGoodProductId}
            >
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
