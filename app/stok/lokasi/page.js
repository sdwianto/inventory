'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { MapPin, Pencil } from 'lucide-react';
import { getUser } from '@/lib/auth-client';
import TenantScopeField, { tenantLabel } from '@/components/TenantScopeField';
import { withActingTenantQuery } from '@/lib/tenant-api';
import { invalidateLokasiCache } from '@/lib/lokasi-client';
import ListExportMenu from '@/components/ListExportMenu';
import { runListExport } from '@/lib/run-list-export';

const empty = { kode: '', nama: '', keterangan: '', tenantId: '' };

export default function LokasiPage() {
  const [user, setUser] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [filterTenantId, setFilterTenantId] = useState('');
  const [list, setList] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(empty);

  const isMaster = user?.role === 'MASTER';

  const load = async (tenantId = filterTenantId) => {
    try {
      let url = '/api/lokasi';
      url = withActingTenantQuery(url, tenantId, isMaster);
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat');
      setList(Array.isArray(data) ? data : []);
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

  const save = async () => {
    if (!editing) return;
    try {
      const res = await fetch(`/api/lokasi/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keterangan: form.keterangan }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Gagal');
      toast.success('Keterangan gudang diperbarui');
      setShowForm(false);
      load();
    } catch (e) { toast.error(e.message); }
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
        title: 'Gudang Operasional',
        columns: getExportColumns(),
        rows,
      });
      toast.success(`${rows.length} lokasi diekspor`);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><MapPin className="w-6 h-6" /> Gudang Operasional</h1>
            <p className="text-sm text-slate-500">Dua gudang tetap per tenant: <b>Gudang Kering</b> (GKERING) dan <b>Gudang Basah</b> (GBASAH). Penempatan produk diatur di Master Produk.</p>
          </div>
          <div className="flex gap-2">
            <ListExportMenu onExport={exportData} disabled={list.length === 0} />
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

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                {isMaster && <th className="px-3 py-2 text-left">Tenant</th>}
                <th className="px-3 py-2 text-left">Kode</th>
                <th className="px-3 py-2 text-left">Nama</th>
                <th className="px-3 py-2 text-left">Keterangan</th>
                <th className="px-3 py-2 text-center w-20">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {isMaster && !filterTenantId && (
                <tr><td colSpan={isMaster ? 5 : 4} className="text-center py-10 text-slate-400">Pilih tenant untuk melihat gudang</td></tr>
              )}
              {(isMaster ? filterTenantId : true) && list.length === 0 && (
                <tr><td colSpan={isMaster ? 5 : 4} className="text-center py-10 text-slate-400">Memuat gudang…</td></tr>
              )}
              {list.map((l) => (
                <tr key={l.id} className="border-t hover:bg-slate-50">
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
                      <button type="button" onClick={() => { setEditing(l); setForm({ keterangan: l.keterangan || '', tenantId: l.tenantId || '' }); setShowForm(true); }} className="p-1.5 hover:bg-blue-50 text-blue-600 rounded" title="Edit keterangan"><Pencil className="w-4 h-4" /></button>
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
          <DialogHeader><DialogTitle>Edit Keterangan Gudang</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {editing && (
              <p className="text-sm text-slate-600">
                <span className="font-mono font-semibold">{editing.kode}</span> — {editing.nama}
              </p>
            )}
            <div><Label>Keterangan</Label><Input value={form.keterangan} onChange={(e) => setForm({ ...form, keterangan: e.target.value })} placeholder="Catatan tambahan gudang" /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button><Button onClick={save} className="bg-orange-500 hover:bg-orange-600">Simpan</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
