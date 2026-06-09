'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Search, Package, Settings2, RefreshCw } from 'lucide-react';
import ListExportMenu from '@/components/ListExportMenu';
import BulkSelectionBar from '@/components/BulkSelectionBar';
import { useListSelection } from '@/hooks/useListSelection';
import { runListExport } from '@/lib/run-list-export';
import { postBulkDelete } from '@/lib/bulk-delete-client';
import { formatIDR } from '@/lib/format';
import { useConfirm } from '@/components/ConfirmProvider';
import { getUser } from '@/lib/auth-client';
import TenantScopeField, { tenantLabel } from '@/components/TenantScopeField';
import { withActingTenantQuery } from '@/lib/tenant-api';

const emptyProduct = {
  kode: '', barcode: '', nama: '', grup: 'Umum', satuan: 'PCS',
  hargaBeli: 0, hargaSpesial: 0, hargaGrosir: 0, hargaEcer: 0, stok: 0, minStok: 0, aktif: true,
  tenantId: '',
};

function marginPct(hargaBeli, hargaJual) {
  const beli = Number(hargaBeli) || 0;
  const jual = Number(hargaJual) || 0;
  if (beli <= 0) return null;
  return Math.round(((jual - beli) / beli) * 1000) / 10;
}

function hargaFromMarginPct(hargaBeli, pct) {
  const beli = Number(hargaBeli) || 0;
  if (beli <= 0) return 0;
  const p = Number(pct);
  if (!Number.isFinite(p)) return 0;
  return Math.round(beli * (1 + p / 100));
}

function PriceWithMargin({ label, required, hargaBeli, value, onChange }) {
  const pct = marginPct(hargaBeli, value);
  const canCalc = Number(hargaBeli) > 0;

  return (
    <div>
      <Label>
        {label}
        {required ? ' *' : ''}
        {canCalc && pct !== null && (
          <span className="ml-2 text-xs font-normal text-orange-600">({pct > 0 ? '+' : ''}{pct}%)</span>
        )}
      </Label>
      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <Input
            type="number"
            min={0}
            value={value}
            onChange={(e) => onChange(parseInt(e.target.value || '0', 10))}
            placeholder="Rp"
          />
        </div>
        <div className="flex items-center gap-1 w-[7.5rem] shrink-0">
          <Input
            type="number"
            step="0.1"
            className="text-right"
            value={canCalc && pct !== null ? pct : ''}
            placeholder="%"
            disabled={!canCalc}
            title={canCalc ? 'Margin % dari harga beli' : 'Isi harga beli dulu'}
            onChange={(e) => {
              if (!canCalc) return;
              onChange(hargaFromMarginPct(hargaBeli, e.target.value));
            }}
          />
          <span className="text-xs text-slate-500">%</span>
        </div>
      </div>
      {canCalc && value > 0 && (
        <p className="text-[11px] text-slate-500 mt-1">
          {formatIDR(value)} · margin {pct > 0 ? '+' : ''}{pct}% dari beli {formatIDR(hargaBeli)}
        </p>
      )}
      {!canCalc && (
        <p className="text-[11px] text-amber-600 mt-1">Isi harga beli untuk menghitung %</p>
      )}
    </div>
  );
}

export default function ProdukPage() {
  const confirm = useConfirm();
  const [user, setUser] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [filterTenantId, setFilterTenantId] = useState('');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyProduct);
  const [grupList, setGrupList] = useState([]);
  const [satuanList, setSatuanList] = useState([]);
  const [showMeta, setShowMeta] = useState(false);
  const [newGrup, setNewGrup] = useState('');
  const [newSatuan, setNewSatuan] = useState('');
  const [metaTenantId, setMetaTenantId] = useState('');
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const selection = useListSelection();

  const isMaster = user?.role === 'MASTER';

  const effectiveTenantForForm = () => {
    if (isMaster) return form.tenantId || filterTenantId || '';
    return user?.tenantId || '';
  };

  const loadMeta = async (tenantId) => {
    const tid = tenantId || effectiveTenantForForm();
    if (isMaster && !tid) {
      setGrupList([]);
      setSatuanList([]);
      return;
    }
    try {
      const qs = isMaster && tid ? `?tenantId=${encodeURIComponent(tid)}` : '';
      const [gRes, sRes] = await Promise.all([
        fetch(`/api/produk-grup${qs}`),
        fetch(`/api/produk-satuan${qs}`),
      ]);
      const gData = await gRes.json();
      const sData = await sRes.json();
      if (!gRes.ok) throw new Error(gData.error || 'Gagal memuat grup');
      if (!sRes.ok) throw new Error(sData.error || 'Gagal memuat satuan');
      setGrupList(Array.isArray(gData) ? gData : []);
      setSatuanList(Array.isArray(sData) ? sData : []);
    } catch (e) {
      toast.error(e.message);
      setGrupList([]);
      setSatuanList([]);
    }
  };

  const loadTenants = async () => {
    try {
      const res = await fetch('/api/tenants');
      const data = await res.json();
      setTenants(Array.isArray(data) ? data : []);
    } catch {
      setTenants([]);
    }
  };

  const load = async (query = '', tenantId = filterTenantId) => {
    setLoading(true);
    try {
      let url = `/api/products?q=${encodeURIComponent(query)}`;
      url = withActingTenantQuery(url, tenantId, isMaster);
      const res = await fetch(url);
      const data = await res.json();
      setProducts(Array.isArray(data) ? data : []);
      selection.clear();
    } catch {
      toast.error('Gagal memuat');
    }
    setLoading(false);
  };

  useEffect(() => {
    const u = getUser();
    setUser(u);
    if (u?.role === 'MASTER') loadTenants();
    else setFilterTenantId(u?.tenantId || 'default');
  }, []);

  useEffect(() => {
    if (!user) return;
    if (isMaster && !filterTenantId) {
      load(q, '');
      return;
    }
    if (!isMaster || filterTenantId) load(q, filterTenantId);
  }, [user, filterTenantId]);

  const openNew = () => {
    setEditing(null);
    const defaultTenant = isMaster ? (filterTenantId || '') : (user?.tenantId || 'default');
    const nextForm = {
      ...emptyProduct,
      kode: `B${String(Date.now()).slice(-6)}`,
      tenantId: defaultTenant,
    };
    setForm(nextForm);
    setShowForm(true);
    loadMeta(defaultTenant);
  };

  const openEdit = (p) => {
    setEditing(p);
    const tid = p.tenantId || 'default';
    setForm({ ...p, tenantId: tid });
    setShowForm(true);
    loadMeta(tid);
  };

  const openMetaDialog = () => {
    const tid = effectiveTenantForForm() || filterTenantId;
    if (isMaster && !tid) {
      toast.error('Pilih tenant filter atau tenant produk terlebih dahulu');
      return;
    }
    setMetaTenantId(tid);
    setNewGrup('');
    setNewSatuan('');
    setShowMeta(true);
    loadMeta(tid);
  };

  const addGrup = async () => {
    const nama = newGrup.trim();
    if (!nama) return;
    const payload = { nama };
    if (isMaster && metaTenantId) payload.tenantId = metaTenantId;
    const res = await fetch('/api/produk-grup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) return toast.error(data.error || 'Gagal menambah grup');
    setNewGrup('');
    loadMeta(metaTenantId);
    toast.success('Grup ditambahkan');
  };

  const addSatuan = async () => {
    const nama = newSatuan.trim().toUpperCase();
    if (!nama) return;
    const payload = { nama };
    if (isMaster && metaTenantId) payload.tenantId = metaTenantId;
    const res = await fetch('/api/produk-satuan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) return toast.error(data.error || 'Gagal menambah satuan');
    setNewSatuan('');
    loadMeta(metaTenantId);
    toast.success('Satuan ditambahkan');
  };

  const removeGrup = async (id) => {
    if (!(await confirm({ title: 'Hapus grup?', description: 'Grup yang masih dipakai produk tidak bisa dihapus.', confirmText: 'Hapus' }))) return;
    const res = await fetch(`/api/produk-grup/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return toast.error(data.error || 'Gagal hapus');
    loadMeta(metaTenantId);
    toast.success('Grup dihapus');
  };

  const removeSatuan = async (id) => {
    if (!(await confirm({ title: 'Hapus satuan?', description: 'Satuan yang masih dipakai produk tidak bisa dihapus.', confirmText: 'Hapus' }))) return;
    const res = await fetch(`/api/produk-satuan/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return toast.error(data.error || 'Gagal hapus');
    loadMeta(metaTenantId);
    toast.success('Satuan dihapus');
  };

  const save = async () => {
    if (isMaster && !editing && !form.tenantId) {
      toast.error('Pilih tenant untuk produk baru');
      return;
    }
    if (!form.grup || !form.satuan) {
      toast.error('Pilih grup dan satuan dari daftar master');
      return;
    }
    try {
      const url = editing ? `/api/products/${editing.id}` : '/api/products';
      const method = editing ? 'PUT' : 'POST';
      const payload = { ...form };
      if (!isMaster) delete payload.tenantId;
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      toast.success(editing ? 'Produk diperbarui' : 'Produk ditambahkan');
      setShowForm(false);
      load(q);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const remove = async (id) => {
    if (!(await confirm({ title: 'Hapus Produk?', description: 'Produk ini akan dihapus dari master data.', confirmText: 'Hapus' }))) return;
    const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return toast.error(data.error || 'Gagal hapus');
    toast.success('Produk dihapus');
    load(q);
  };

  const bulkDelete = async () => {
    const ids = selection.ids();
    if (ids.length === 0) return;
    if (!(await confirm({
      title: `Hapus ${ids.length} produk?`,
      description: 'Produk terpilih akan dihapus permanen dari master data.',
      confirmText: 'Hapus semua',
    }))) return;
    setBulkDeleting(true);
    try {
      const data = await postBulkDelete('/api/products/bulk-delete', ids);
      toast.success(`${data.deleted ?? ids.length} produk dihapus`);
      selection.clear();
      load(q);
    } catch (e) {
      toast.error(e.message);
    }
    setBulkDeleting(false);
  };

  const getExportColumns = () => [
    ...(isMaster ? [{ key: 'tenantId', label: 'Tenant', value: (r) => tenantLabel(tenants, r.tenantId) }] : []),
    { key: 'kode', label: 'Kode' },
    { key: 'barcode', label: 'Barcode' },
    { key: 'nama', label: 'Nama' },
    { key: 'grup', label: 'Grup' },
    { key: 'satuan', label: 'Satuan' },
    { key: 'hargaBeli', label: 'Harga Beli' },
    { key: 'hargaSpesial', label: 'Harga Spesial' },
    { key: 'hargaGrosir', label: 'Harga Grosir' },
    { key: 'hargaEcer', label: 'Harga Ecer' },
    { key: 'stok', label: 'Stok' },
    { key: 'minStok', label: 'Stok Minimum' },
    { key: 'aktif', label: 'Aktif', value: (r) => (r.aktif !== false ? 'Ya' : 'Tidak') },
  ];

  const fetchExportRows = async () => {
    let url = `/api/products?q=${encodeURIComponent(q)}&limit=5000`;
    url = withActingTenantQuery(url, filterTenantId, isMaster);
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal memuat data');
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) throw new Error('Tidak ada data untuk diekspor');
    return rows;
  };

  const exportData = async (format) => {
    try {
      const rows = await fetchExportRows();
      const stamp = new Date().toISOString().slice(0, 10);
      const tenantPart = filterTenantId ? `-${filterTenantId}` : '';
      await runListExport(format, {
        baseName: `produk${tenantPart}-${stamp}`,
        title: 'Master Produk',
        columns: getExportColumns(),
        rows,
      });
      toast.success(`${rows.length} produk diekspor`);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const colSpan = isMaster ? 12 : 11;
  const allSelected = products.length > 0 && selection.count === products.length;
  const isVendorSynced = (p) => p?.syncSource === 'sales.app';
  const [syncing, setSyncing] = useState(false);

  const syncFromVendor = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/sync/vendor-catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal sync');
      const total = data.total ?? 0;
      if (total === 0) throw new Error('Katalog kosong — cek SALES_VENDOR_TENANT_ID di .env.local (produk sales.app mungkin di tenant lain)');
      toast.success(`Sync OK: ${data.created || 0} baru, ${data.updated || 0} diperbarui (${total} dari sales.app)`);
      load(q);
    } catch (e) { toast.error(e.message); }
    setSyncing(false);
  };

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><Package className="w-6 h-6" /> Master Produk</h1>
            <p className="text-sm text-slate-500">Nama &amp; satuan disinkron dari sales.app — stok/harga dikelola di sini</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={syncFromVendor} disabled={syncing}>
              <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Sync...' : 'Sync dari sales.app'}
            </Button>
            <ListExportMenu onExport={exportData} disabled={loading} />
            <Button variant="outline" onClick={openMetaDialog}>
              <Settings2 className="w-4 h-4 mr-2" /> Grup &amp; Satuan
            </Button>
            <Button onClick={openNew} className="bg-orange-500 hover:bg-orange-600">
              <Plus className="w-4 h-4 mr-2" /> Produk Baru
            </Button>
          </div>
        </div>

        <BulkSelectionBar
          count={selection.count}
          entityLabel="produk"
          onDelete={bulkDelete}
          onClear={selection.clear}
          deleting={bulkDeleting}
        />

        <div className="flex gap-2 flex-wrap items-end">
          {isMaster && (
            <TenantScopeField
              user={user}
              tenants={tenants}
              value={filterTenantId}
              onChange={(tid) => {
                setFilterTenantId(tid);
              }}
              label="Filter tenant"
              className="w-full max-w-xs"
            />
          )}
          <div className="relative flex-1 max-w-md min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Cari kode, nama, atau barcode..."
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                load(e.target.value);
              }}
              className="pl-9"
            />
          </div>
          <div className="text-sm text-slate-500 self-center pb-2">
            Total: <span className="font-semibold text-slate-800">{products.length}</span> produk
            {isMaster && !filterTenantId && (
              <span className="text-xs text-slate-400 ml-1">(semua tenant)</span>
            )}
          </div>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                <tr>
                  <th className="px-3 py-2 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => selection.toggleAll(products)}
                      disabled={products.length === 0}
                      aria-label="Pilih semua"
                    />
                  </th>
                  {isMaster && <th className="px-3 py-2 text-left">Tenant</th>}
                  <th className="px-3 py-2 text-left">Kode</th>
                  <th className="px-3 py-2 text-left">Barcode</th>
                  <th className="px-3 py-2 text-left">Nama</th>
                  <th className="px-3 py-2 text-left">Grup</th>
                  <th className="px-3 py-2 text-center">Sat</th>
                  <th className="px-3 py-2 text-right">Hrg Beli</th>
                  <th className="px-3 py-2 text-right">Hrg Grosir</th>
                  <th className="px-3 py-2 text-right">Hrg Ecer</th>
                  <th className="px-3 py-2 text-right">Stok</th>
                  <th className="px-3 py-2 text-center w-24">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={colSpan} className="text-center py-10 text-slate-400">Memuat...</td></tr>
                )}
                {!loading && products.length === 0 && (
                  <tr><td colSpan={colSpan} className="text-center py-10 text-slate-400">Tidak ada produk</td></tr>
                )}
                {products.map((p) => (
                  <tr key={p.id} className={`border-t hover:bg-slate-50 ${selection.isSelected(p.id) ? 'bg-orange-50/50' : ''}`}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selection.isSelected(p.id)}
                        onChange={() => selection.toggle(p.id)}
                        aria-label={`Pilih ${p.nama}`}
                      />
                    </td>
                    {isMaster && (
                      <td className="px-3 py-2 text-xs">
                        <span className="px-2 py-0.5 bg-orange-50 text-orange-800 rounded font-mono">
                          {tenantLabel(tenants, p.tenantId || 'default')}
                        </span>
                      </td>
                    )}
                    <td className="px-3 py-2 font-mono text-xs">{p.kode}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{p.barcode}</td>
                    <td className="px-3 py-2 font-medium">
                      {p.nama}
                      {isVendorSynced(p) && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded align-middle">sales.app</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs"><span className="px-2 py-0.5 bg-slate-100 rounded">{p.grup}</span></td>
                    <td className="px-3 py-2 text-center text-xs uppercase">{p.satuan}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{formatIDR(p.hargaBeli)}</td>
                    <td className="px-3 py-2 text-right">{formatIDR(p.hargaGrosir)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{formatIDR(p.hargaEcer)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={`font-semibold ${p.stok <= (p.minStok || 0) ? 'text-red-600' : ''}`}>{p.stok}</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-center gap-1">
                        <button type="button" onClick={() => openEdit(p)} className="p-1.5 hover:bg-blue-50 text-blue-600 rounded"><Pencil className="w-4 h-4" /></button>
                        {!isVendorSynced(p) && (
                          <button type="button" onClick={() => remove(p.id)} className="p-1.5 hover:bg-red-50 text-red-600 rounded"><Trash2 className="w-4 h-4" /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-2xl">
          {editing && isVendorSynced(editing) && (
            <p className="text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2 mb-2">
              Kode, nama, dan satuan dikelola di sales.app. Di inventory hanya stok &amp; harga yang bisa diubah.
            </p>
          )}
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Produk' : 'Produk Baru'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {isMaster && !editing && (
              <div className="col-span-2">
                <TenantScopeField
                  user={user}
                  tenants={tenants}
                  value={form.tenantId}
                  onChange={(tid) => {
                    setForm({ ...form, tenantId: tid });
                    loadMeta(tid);
                  }}
                  required
                  label="Tenant pemilik produk"
                />
              </div>
            )}
            {isMaster && editing && (
              <div className="col-span-2">
                <Label>Tenant</Label>
                <Input
                  readOnly
                  disabled
                  value={tenantLabel(tenants, form.tenantId)}
                  className="bg-slate-50"
                />
              </div>
            )}
            <div><Label>Kode *</Label><Input value={form.kode} onChange={(e) => setForm({ ...form, kode: e.target.value })} disabled={!!editing || (editing && isVendorSynced(editing))} /></div>
            <div><Label>Barcode</Label><Input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} disabled={editing && isVendorSynced(editing)} /></div>
            <div className="col-span-2"><Label>Nama Produk *</Label><Input value={form.nama} onChange={(e) => setForm({ ...form, nama: e.target.value })} disabled={editing && isVendorSynced(editing)} /></div>
            <div>
              <Label>Grup *</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm bg-white"
                value={form.grup}
                onChange={(e) => setForm({ ...form, grup: e.target.value })}
                disabled={grupList.length === 0 || (editing && isVendorSynced(editing))}
              >
                <option value="">{grupList.length ? '— Pilih grup —' : '— Belum ada grup —'}</option>
                {grupList.map((g) => (
                  <option key={g.id} value={g.nama}>{g.nama}</option>
                ))}
                {form.grup && !grupList.some((g) => g.nama === form.grup) && (
                  <option value={form.grup}>{form.grup} (legacy)</option>
                )}
              </select>
            </div>
            <div>
              <Label>Satuan *</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm bg-white"
                value={form.satuan}
                onChange={(e) => setForm({ ...form, satuan: e.target.value })}
                disabled={satuanList.length === 0 || (editing && isVendorSynced(editing))}
              >
                <option value="">{satuanList.length ? '— Pilih satuan —' : '— Belum ada satuan —'}</option>
                {satuanList.map((s) => (
                  <option key={s.id} value={s.nama}>{s.nama}</option>
                ))}
                {form.satuan && !satuanList.some((s) => s.nama === form.satuan) && (
                  <option value={form.satuan}>{form.satuan} (legacy)</option>
                )}
              </select>
            </div>
            <div className="col-span-2 md:col-span-1"><Label>Harga Beli</Label><Input type="number" min={0} value={form.hargaBeli} onChange={(e) => setForm({ ...form, hargaBeli: parseInt(e.target.value || '0', 10) })} /></div>
            <PriceWithMargin
              label="Harga Spesial"
              hargaBeli={form.hargaBeli}
              value={form.hargaSpesial}
              onChange={(v) => setForm({ ...form, hargaSpesial: v })}
            />
            <PriceWithMargin
              label="Harga Grosir"
              hargaBeli={form.hargaBeli}
              value={form.hargaGrosir}
              onChange={(v) => setForm({ ...form, hargaGrosir: v })}
            />
            <PriceWithMargin
              label="Harga Ecer"
              required
              hargaBeli={form.hargaBeli}
              value={form.hargaEcer}
              onChange={(v) => setForm({ ...form, hargaEcer: v })}
            />
            <div><Label>Stok</Label><Input type="number" value={form.stok} onChange={(e) => setForm({ ...form, stok: parseFloat(e.target.value || '0') })} /></div>
            <div><Label>Stok Minimum</Label><Input type="number" value={form.minStok} onChange={(e) => setForm({ ...form, minStok: parseFloat(e.target.value || '0') })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button>
            <Button onClick={save} className="bg-orange-500 hover:bg-orange-600">Simpan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showMeta} onOpenChange={setShowMeta}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Kelola Grup &amp; Satuan Produk</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500 -mt-2">
            Definisikan grup dan satuan di sini. Saat membuat produk baru, pilih dari dropdown — tidak perlu mengetik manual.
            {isMaster && metaTenantId && (
              <span className="block mt-1 font-mono text-xs text-orange-700">Tenant: {tenantLabel(tenants, metaTenantId)}</span>
            )}
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Grup Produk</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="Nama grup baru..."
                  value={newGrup}
                  onChange={(e) => setNewGrup(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addGrup()}
                />
                <Button type="button" onClick={addGrup} className="shrink-0">Tambah</Button>
              </div>
              <ul className="border rounded-md divide-y max-h-48 overflow-auto text-sm">
                {grupList.length === 0 && (
                  <li className="px-3 py-2 text-slate-400">Belum ada grup</li>
                )}
                {grupList.map((g) => (
                  <li key={g.id} className="px-3 py-2 flex items-center justify-between">
                    <span>{g.nama}</span>
                    <button type="button" onClick={() => removeGrup(g.id)} className="text-red-600 hover:bg-red-50 p-1 rounded">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-2">
              <Label>Satuan</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="PCS, KG, BOX..."
                  value={newSatuan}
                  onChange={(e) => setNewSatuan(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addSatuan()}
                />
                <Button type="button" onClick={addSatuan} className="shrink-0">Tambah</Button>
              </div>
              <ul className="border rounded-md divide-y max-h-48 overflow-auto text-sm">
                {satuanList.length === 0 && (
                  <li className="px-3 py-2 text-slate-400">Belum ada satuan</li>
                )}
                {satuanList.map((s) => (
                  <li key={s.id} className="px-3 py-2 flex items-center justify-between">
                    <span className="font-mono">{s.nama}</span>
                    <button type="button" onClick={() => removeSatuan(s.id)} className="text-red-600 hover:bg-red-50 p-1 rounded">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMeta(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
