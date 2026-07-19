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
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import { BookOpen, Download, Pencil, Plus, Power, RefreshCw } from 'lucide-react';

const MANAGE = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface SupplierOpt { id: string; kode?: string; nama?: string; name?: string }
interface ProductOpt { id: string; kode?: string; nama?: string; satuan?: string; hargaBeli?: number }
interface BookRow {
  id: string;
  supplierId: string;
  supplierNama?: string;
  productId: string;
  productNama?: string;
  productKode?: string;
  satuan?: string;
  harga: number;
  effectiveFrom?: string;
  effectiveTo?: string;
  aktif: boolean;
  catatan?: string;
}

const emptyForm = {
  supplierId: '',
  productId: '',
  harga: '',
  effectiveFrom: '',
  effectiveTo: '',
  aktif: true,
};

export default function PriceBookPage() {
  const confirm = useConfirm();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE.has(role);
  }, []);

  const [rows, setRows] = useState<BookRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOpt[]>([]);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hdr = { ...actingTenantHeaders() };
      const listQs = new URLSearchParams();
      if (q.trim()) listQs.set('q', q.trim());
      const optQs = new URLSearchParams();
      if (q.trim()) optQs.set('q', q.trim());
      const bookUrl = listQs.toString() ? `/api/supplier-price-book?${listQs}` : '/api/supplier-price-book';
      const optUrl = optQs.toString() ? `/api/supplier-price-book/options?${optQs}` : '/api/supplier-price-book/options';
      const [bRes, oRes] = await Promise.all([
        fetch(bookUrl, { headers: hdr }),
        fetch(optUrl, { headers: hdr }),
      ]);
      const bData = await bRes.json();
      const oData = await oRes.json();
      if (!bRes.ok) throw new Error(bData?.error || 'Gagal memuat price book');
      if (!oRes.ok) throw new Error(oData?.error || 'Gagal memuat opsi');
      setRows(Array.isArray(bData) ? bData : []);
      setSuppliers(Array.isArray(oData?.suppliers) ? oData.suppliers : []);
      setProducts(Array.isArray(oData?.products) ? oData.products : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { void load(); }, [load]);

  function openCreate() {
    setEditId(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function openEdit(row: BookRow) {
    setEditId(row.id);
    setForm({
      supplierId: row.supplierId,
      productId: row.productId,
      harga: String(row.harga),
      effectiveFrom: row.effectiveFrom || '',
      effectiveTo: row.effectiveTo || '',
      aktif: row.aktif !== false,
    });
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      if (editId) {
        const res = await fetch(`/api/supplier-price-book/${editId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
          body: JSON.stringify({
            harga: Number(form.harga),
            effectiveFrom: form.effectiveFrom || '',
            effectiveTo: form.effectiveTo || '',
            aktif: form.aktif,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Gagal update');
        toast.success('Harga supplier diperbarui');
      } else {
        const res = await fetch('/api/supplier-price-book', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
          body: JSON.stringify({
            supplierId: form.supplierId,
            productId: form.productId,
            harga: Number(form.harga),
            effectiveFrom: form.effectiveFrom || undefined,
            effectiveTo: form.effectiveTo || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Gagal simpan');
        toast.success('Harga supplier ditambahkan');
      }
      setOpen(false);
      setEditId(null);
      setForm(emptyForm);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function syncFromInvoices() {
    setSyncing(true);
    try {
      const res = await fetch('/api/supplier-price-book/sync-from-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal sinkron');
      toast.success(
        `Sinkron ${data.invoices || 0} invoice → ${data.upserted || 0} harga`
        + (data.skipped ? ` (${data.skipped} dilewati)` : ''),
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal sinkron');
    } finally {
      setSyncing(false);
    }
  }

  async function deactivate(row: BookRow) {
    const okConfirm = await confirm({
      title: 'Nonaktifkan harga?',
      description: `${row.productNama} · ${row.supplierNama}`,
      confirmText: 'Nonaktifkan',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    const res = await fetch(`/api/supplier-price-book/${row.id}`, {
      method: 'DELETE',
      headers: { ...actingTenantHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal');
      return;
    }
    toast.success('Dinonaktifkan');
    await load();
  }

  async function reactivate(row: BookRow) {
    const res = await fetch(`/api/supplier-price-book/${row.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
      body: JSON.stringify({ aktif: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal aktifkan');
      return;
    }
    toast.success('Diaktifkan kembali');
    await load();
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Supplier Price Book
          </h1>
          <p className="text-sm text-muted-foreground">
            Harga beli dari invoice vendor (GRN diterima) — feed CHEAPER_SUPPLY
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Cari produk / supplier…"
            className="h-9 w-48 md:w-64"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
          />
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void syncFromInvoices()}
              disabled={syncing || loading}
            >
              <Download className="h-4 w-4 mr-1" />
              {syncing ? 'Sinkron…' : 'Dari invoice'}
            </Button>
          )}
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
              <th className="text-left p-3">Produk</th>
              <th className="text-left p-3">Supplier</th>
              <th className="text-right p-3">Harga</th>
              <th className="text-left p-3">Efektif</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-muted-foreground">
                  Belum ada entri — klik <span className="font-medium">Dari invoice</span> untuk ambil harga beli dari tagihan vendor
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3">
                  <div className="font-medium">{row.productNama || row.productId}</div>
                  <div className="text-[11px] font-mono text-muted-foreground">{row.productKode}</div>
                </td>
                <td className="p-3">{row.supplierNama || row.supplierId}</td>
                <td className="p-3 text-right font-mono">{row.harga}</td>
                <td className="p-3 text-xs text-muted-foreground">
                  {(row.effectiveFrom || '—')} → {(row.effectiveTo || '—')}
                </td>
                <td className="p-3">{row.aktif ? 'Aktif' : 'Nonaktif'}</td>
                <td className="p-3 text-right space-x-1">
                  {canManage && (
                    <Button variant="ghost" size="sm" onClick={() => openEdit(row)} title="Edit">
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  {canManage && row.aktif && (
                    <Button variant="ghost" size="sm" onClick={() => void deactivate(row)} title="Nonaktifkan">
                      <Power className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                  {canManage && !row.aktif && (
                    <Button variant="ghost" size="sm" onClick={() => void reactivate(row)} title="Aktifkan">
                      <Power className="h-4 w-4 text-green-600" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? 'Edit harga supplier' : 'Tambah harga supplier'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Supplier</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={form.supplierId}
                disabled={!!editId}
                onChange={(e) => setForm((f) => ({ ...f, supplierId: e.target.value }))}
              >
                <option value="">—</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.nama || s.name || s.kode || s.id}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Produk</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={form.productId}
                disabled={!!editId}
                onChange={(e) => setForm((f) => ({ ...f, productId: e.target.value }))}
              >
                <option value="">—</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.kode} — {p.nama}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Harga</Label>
              <Input type="number" step="0.01" value={form.harga} onChange={(e) => setForm((f) => ({ ...f, harga: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>Dari</Label>
                <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Sampai</Label>
                <Input type="date" value={form.effectiveTo} onChange={(e) => setForm((f) => ({ ...f, effectiveTo: e.target.value }))} />
              </div>
            </div>
            {editId && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.aktif}
                  onChange={(e) => setForm((f) => ({ ...f, aktif: e.target.checked }))}
                />
                Aktif
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button
              onClick={() => void save()}
              disabled={saving || (!editId && (!form.supplierId || !form.productId)) || !form.harga}
            >
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
