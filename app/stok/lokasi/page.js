'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { MapPin, Plus, Pencil, Trash2 } from 'lucide-react';
import { useConfirm } from '@/components/ConfirmProvider';
import { getUser } from '@/lib/auth-client';
import TenantScopeField, { tenantLabel } from '@/components/TenantScopeField';
import { withActingTenantQuery } from '@/lib/tenant-api';
import { invalidateLokasiCache } from '@/lib/lokasi-client';
import ListExportMenu from '@/components/ListExportMenu';
import BulkSelectionBar from '@/components/BulkSelectionBar';
import { useListSelection } from '@/hooks/useListSelection';
import { runListExport } from '@/lib/run-list-export';
import { postBulkDelete } from '@/lib/bulk-delete-client';

const empty = { kode: '', nama: '', keterangan: '', tenantId: '' };

export default function LokasiPage() {
  const confirm = useConfirm();
  const [user, setUser] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [filterTenantId, setFilterTenantId] = useState('');
  const [list, setList] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(empty);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const selection = useListSelection();

  const isMaster = user?.role === 'MASTER';

  const load = async (tenantId = filterTenantId) => {
    try {
      let url = '/api/lokasi';
      url = withActingTenantQuery(url, tenantId, isMaster);
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat');
      setList(Array.isArray(data) ? data : []);
      selection.clear();
      invalidateLokasiCache();
    } catch (e) {
      toast.error(e.message);
      setList([]);
    }
  };

  useEffect(() => {
    const u = getUser();
    setUser(u);
    if (u?.role === 'MASTER') {
      fetch('/api/tenants').then((r) => r.json()).then((d) => setTenants(Array.isArray(d) ? d : []));
    } else {
      setFilterTenantId(u?.tenantId || 'default');
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    if (isMaster && !filterTenantId) {
      setList([]);
      return;
    }
    if (!isMaster || filterTenantId) load(filterTenantId);
  }, [user, filterTenantId]);

  const openNew = () => {
    if (isMaster && !filterTenantId) {
      toast.error('Pilih tenant untuk lokasi baru');
      return;
    }
    setEditing(null);
    setForm({
      ...empty,
      tenantId: isMaster ? filterTenantId : (user?.tenantId || ''),
    });
    setShowForm(true);
  };

  const save = async () => {
    if (isMaster && !editing && !form.tenantId) {
      toast.error('Pilih tenant untuk lokasi baru');
      return;
    }
    try {
      const url = editing ? `/api/lokasi/${editing.id}` : '/api/lokasi';
      const payload = { ...form };
      if (!isMaster) delete payload.tenantId;
      const res = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Gagal');
      toast.success('Tersimpan');
      setShowForm(false);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const remove = async (id) => {
    if (!(await confirm({ title: 'Hapus Lokasi?', description: 'Lokasi ini akan dihapus dari sistem.', confirmText: 'Hapus' }))) return;
    await fetch(`/api/lokasi/${id}`, { method: 'DELETE' });
    toast.success('Dihapus');
    load();
  };

  const getExportColumns = () => [
    ...(isMaster ? [{ key: 'tenantId', label: 'Tenant', value: (r) => tenantLabel(tenants, r.tenantId) }] : []),
    { key: 'kode', label: 'Kode' },
    { key: 'nama', label: 'Nama' },
    { key: 'keterangan', label: 'Keterangan' },
  ];

  const exportData = async (format) => {
    try {
      const rows = [...list];
      const stamp = new Date().toISOString().slice(0, 10);
      const tenantPart = filterTenantId ? `-${filterTenantId}` : '';
      await runListExport(format, {
        baseName: `lokasi${tenantPart}-${stamp}`,
        title: 'Master Lokasi',
        columns: getExportColumns(),
        rows,
      });
      toast.success(`${rows.length} lokasi diekspor`);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const bulkDelete = async () => {
    const ids = selection.ids();
    if (ids.length === 0) return;
    if (!(await confirm({
      title: `Hapus ${ids.length} lokasi?`,
      description: 'Lokasi terpilih akan dihapus permanen.',
      confirmText: 'Hapus semua',
    }))) return;
    setBulkDeleting(true);
    try {
      const data = await postBulkDelete('/api/lokasi/bulk-delete', ids);
      toast.success(`${data.deleted ?? ids.length} lokasi dihapus`);
      selection.clear();
      load();
    } catch (e) {
      toast.error(e.message);
    }
    setBulkDeleting(false);
  };

  const allSelected = list.length > 0 && selection.count === list.length;
  const colSpan = isMaster ? 6 : 5;

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><MapPin className="w-6 h-6" /> Master Lokasi</h1>
            <p className="text-sm text-slate-500">Gudang/cabang per tenant — dipakai di Pembelian, Kasir, dan stok</p>
          </div>
          <div className="flex gap-2">
            <ListExportMenu onExport={exportData} disabled={list.length === 0} />
            <Button onClick={openNew} className="bg-orange-500 hover:bg-orange-600"><Plus className="w-4 h-4 mr-2" /> Lokasi Baru</Button>
          </div>
        </div>

        {isMaster && (
          <TenantScopeField
            user={user}
            tenants={tenants}
            value={filterTenantId}
            onChange={setFilterTenantId}
            label="Filter tenant"
            className="max-w-xs"
          />
        )}

        <BulkSelectionBar
          count={selection.count}
          entityLabel="lokasi"
          onDelete={bulkDelete}
          onClear={selection.clear}
          deleting={bulkDeleting}
        />

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 w-10">
                  <input type="checkbox" checked={allSelected} onChange={() => selection.toggleAll(list)} disabled={list.length === 0} aria-label="Pilih semua" />
                </th>
                {isMaster && <th className="px-3 py-2 text-left">Tenant</th>}
                <th className="px-3 py-2 text-left">Kode</th>
                <th className="px-3 py-2 text-left">Nama</th>
                <th className="px-3 py-2 text-left">Keterangan</th>
                <th className="px-3 py-2 text-center w-20">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {isMaster && !filterTenantId && (
                <tr><td colSpan={colSpan} className="text-center py-10 text-slate-400">Pilih tenant untuk melihat gudang/lokasi</td></tr>
              )}
              {(isMaster ? filterTenantId : true) && list.length === 0 && (
                <tr><td colSpan={colSpan} className="text-center py-10 text-slate-400">Belum ada lokasi</td></tr>
              )}
              {list.map((l) => (
                <tr key={l.id} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selection.isSelected(l.id)} onChange={() => selection.toggle(l.id)} aria-label={`Pilih ${l.nama}`} />
                  </td>
                  {isMaster && (
                    <td className="px-3 py-2 text-xs">
                      <span className="px-2 py-0.5 bg-orange-50 text-orange-800 rounded font-mono">
                        {tenantLabel(tenants, l.tenantId)}
                      </span>
                    </td>
                  )}
                  <td className="px-3 py-2 font-mono text-xs">{l.kode}</td>
                  <td className="px-3 py-2 font-medium">{l.nama}</td>
                  <td className="px-3 py-2 text-slate-500">{l.keterangan || '-'}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-center gap-1">
                      <button type="button" onClick={() => { setEditing(l); setForm({ ...l, tenantId: l.tenantId || '' }); setShowForm(true); }} className="p-1.5 hover:bg-blue-50 text-blue-600 rounded"><Pencil className="w-4 h-4" /></button>
                      <button type="button" onClick={() => remove(l.id)} className="p-1.5 hover:bg-red-50 text-red-600 rounded"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editing ? 'Edit Lokasi' : 'Lokasi Baru'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {isMaster && !editing && (
              <TenantScopeField
                user={user}
                tenants={tenants}
                value={form.tenantId}
                onChange={(tid) => setForm({ ...form, tenantId: tid })}
                required
                label="Tenant pemilik gudang"
              />
            )}
            <div><Label>Kode</Label><Input value={form.kode} onChange={(e) => setForm({ ...form, kode: e.target.value })} placeholder="auto" disabled={!!editing} /></div>
            <div><Label>Nama Gudang *</Label><Input value={form.nama} onChange={(e) => setForm({ ...form, nama: e.target.value })} placeholder="Gudang Utama" /></div>
            <div><Label>Keterangan</Label><Input value={form.keterangan} onChange={(e) => setForm({ ...form, keterangan: e.target.value })} placeholder="Nama toko / cabang" /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button><Button onClick={save} className="bg-orange-500 hover:bg-orange-600">Simpan</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
