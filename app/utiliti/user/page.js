'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/PasswordInput';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { UserCog, Plus, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import ListExportMenu from '@/components/ListExportMenu';
import BulkSelectionBar from '@/components/BulkSelectionBar';
import { useListSelection } from '@/hooks/useListSelection';
import { runListExport } from '@/lib/run-list-export';
import { postBulkDelete } from '@/lib/bulk-delete-client';

const empty = { email: '', password: '', name: '', role: 'GUDANG', tenantId: 'default' };

const ROLE_BADGE = {
  MASTER: 'bg-orange-100 text-orange-700',
  ADMIN: 'bg-blue-100 text-blue-700',
  SUPERVISOR: 'bg-amber-100 text-amber-800',
  GUDANG: 'bg-slate-100 text-slate-700',
  OWNER: 'bg-purple-100 text-purple-700',
};

export default function UserManagementPage() {
  const confirm = useConfirm();
  const [list, setList] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(empty);
  const [currentUser, setCurrentUser] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null); // user to delete
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const selection = useListSelection();

  useEffect(() => {
    const u = getUser();
    setCurrentUser(u);
    load();
    // Load tenants list for dropdown (visible only to MASTER, but always fetch)
    if (u?.role === 'MASTER') loadTenants();
  }, []);

  const load = async () => {
    const res = await fetch('/api/users');
    setList(await res.json());
    selection.clear();
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

  const openNew = () => {
    const u = getUser();
    setEditing(null);
    setForm({ ...empty, tenantId: u?.tenantId || 'default', tenantName: u?.tenantName });
    setShowForm(true);
  };
  const openEdit = (p) => { setEditing(p); setForm({ ...p, password: '' }); setShowForm(true); };

  const save = async () => {
    if (!form.email || !form.name) { toast.error('Email dan nama wajib'); return; }
    if (!editing && !form.password) { toast.error('Password wajib untuk user baru'); return; }
    setSaving(true);
    try {
      // Attach tenantName from selected tenant for nicer display
      const selectedTenant = tenants.find(t => t.tenantId === form.tenantId);
      const payload = {
        ...form,
        tenantName: selectedTenant?.companyName || selectedTenant?.tenantName || form.tenantName || form.tenantId,
      };
      const url = editing ? `/api/users/${editing.id}` : '/api/users';
      const res = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      toast.success(editing ? 'User diperbarui' : 'User baru ditambahkan');
      setShowForm(false);
      load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  // Open delete confirmation (replaces window.confirm which is often blocked)
  const askDelete = (u) => {
    if (u.id === currentUser?.id) { toast.error('Tidak bisa hapus akun sendiri'); return; }
    setDeleteTarget(u);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/users/${deleteTarget.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Gagal menghapus user');
      toast.success(`User ${deleteTarget.name} dihapus`);
      setDeleteTarget(null);
      load();
    } catch (e) {
      toast.error(e.message);
    }
    setDeleting(false);
  };

  // For non-MASTER users, allow only their own tenant
  const tenantOptions = currentUser?.role === 'MASTER'
    ? tenants
    : (currentUser ? [{ tenantId: currentUser.tenantId || 'default', companyName: currentUser.tenantName || 'Default' }] : []);

  const selectableList = list.filter((u) => u.id !== currentUser?.id);

  const getExportColumns = () => [
    { key: 'email', label: 'Email' },
    { key: 'name', label: 'Nama' },
    { key: 'role', label: 'Role' },
    { key: 'tenantId', label: 'Tenant ID' },
    { key: 'tenantName', label: 'Tenant' },
    { key: 'createdAt', label: 'Dibuat', value: (r) => formatDateTime(r.createdAt) },
  ];

  const exportData = async (format) => {
    try {
      const rows = [...list];
      const stamp = new Date().toISOString().slice(0, 10);
      await runListExport(format, {
        baseName: `users-${stamp}`,
        title: 'User Management',
        columns: getExportColumns(),
        rows,
      });
      toast.success(`${rows.length} user diekspor`);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const bulkDelete = async () => {
    const ids = selection.ids().filter((id) => id !== currentUser?.id);
    if (ids.length === 0) return;
    if (!(await confirm({
      title: `Hapus ${ids.length} user?`,
      description: 'User terpilih akan dihapus permanen.',
      confirmText: 'Hapus semua',
    }))) return;
    setBulkDeleting(true);
    try {
      const data = await postBulkDelete('/api/users/bulk-delete', ids);
      toast.success(`${data.deleted ?? ids.length} user dihapus`);
      selection.clear();
      load();
    } catch (e) {
      toast.error(e.message);
    }
    setBulkDeleting(false);
  };

  const allSelected = selectableList.length > 0 && selection.count === selectableList.length;

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><UserCog className="w-6 h-6" /> User Management</h1>
            <p className="text-sm text-slate-500">Kelola akun pengguna untuk akses sistem</p>
          </div>
          <ListExportMenu onExport={exportData} disabled={list.length === 0} />
          <Button onClick={openNew} className="bg-orange-500 hover:bg-orange-600"><Plus className="w-4 h-4 mr-2" /> User Baru</Button>
        </div>

        <BulkSelectionBar
          count={selection.count}
          entityLabel="user"
          onDelete={bulkDelete}
          onClear={selection.clear}
          deleting={bulkDeleting}
        />

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => selection.toggleAll(selectableList)}
                    disabled={selectableList.length === 0}
                    aria-label="Pilih semua"
                  />
                </th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Nama</th>
                <th className="px-3 py-2 text-center">Role</th>
                <th className="px-3 py-2 text-left">Tenant</th>
                <th className="px-3 py-2 text-left">Dibuat</th>
                <th className="px-3 py-2 text-center w-24">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={7} className="text-center py-10 text-slate-400">Tidak ada user</td></tr>}
              {list.map(u => (
                <tr key={u.id} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2">
                    {u.id !== currentUser?.id ? (
                      <input
                        type="checkbox"
                        checked={selection.isSelected(u.id)}
                        onChange={() => selection.toggle(u.id)}
                        aria-label={`Pilih ${u.name}`}
                      />
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{u.email}</td>
                  <td className="px-3 py-2 font-medium">{u.name}</td>
                  <td className="px-3 py-2 text-center"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${ROLE_BADGE[u.role] || 'bg-slate-100'}`}>{u.role}</span></td>
                  <td className="px-3 py-2"><div className="text-xs"><div className="font-medium">{u.tenantName || u.tenantId}</div><div className="text-slate-400 font-mono">{u.tenantId}</div></div></td>
                  <td className="px-3 py-2 text-xs text-slate-500">{formatDateTime(u.createdAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-center gap-1">
                      <button
                        onClick={() => openEdit(u)}
                        className="p-1.5 hover:bg-blue-50 text-blue-600 rounded"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => askDelete(u)}
                        disabled={u.id === currentUser?.id}
                        className="p-1.5 hover:bg-red-50 text-red-600 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                        title={u.id === currentUser?.id ? 'Tidak bisa hapus akun sendiri' : 'Hapus user'}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create/Edit Form Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editing ? 'Edit User' : 'User Baru'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Email *</Label><Input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} disabled={!!editing} placeholder="user@perusahaan.com" /></div>
            <div><Label>Nama *</Label><Input value={form.name} onChange={e => setForm({...form, name: e.target.value})} /></div>
            <div>
              <Label>Password {editing ? '(kosongkan jika tidak diubah)' : '*'}</Label>
              <PasswordInput value={form.password} onChange={e => setForm({...form, password: e.target.value})} placeholder={editing ? '••••••••' : ''} />
            </div>
            <div>
              <Label>Role</Label>
              <select value={form.role} onChange={e => setForm({...form, role: e.target.value})} className="w-full border rounded px-3 py-2 text-sm">
                <option value="GUDANG">GUDANG (staff gudang — terima barang, release, buat PO)</option>
                <option value="SUPERVISOR">SUPERVISOR (supervisor — approve release & ajukan PO)</option>
                <option value="ADMIN">ADMIN (akses penuh dalam tenant)</option>
                {currentUser?.role === 'MASTER' && <option value="MASTER">MASTER (lintas tenant)</option>}
              </select>
            </div>
            <div>
              <Label>Tenant {currentUser?.role !== 'MASTER' && <span className="text-xs text-slate-400">(otomatis)</span>}</Label>
              <select
                value={form.tenantId}
                onChange={e => setForm({...form, tenantId: e.target.value})}
                disabled={currentUser?.role !== 'MASTER'}
                className="w-full border rounded px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500"
              >
                {tenantOptions.length === 0 && <option value="default">default — Default</option>}
                {tenantOptions.map(t => (
                  <option key={t.tenantId} value={t.tenantId}>
                    {t.tenantId} — {t.companyName || t.tenantName || t.tenantId}
                  </option>
                ))}
                {/* If editing and the user's tenantId is not in current list (e.g., orphan), still show it */}
                {editing && form.tenantId && !tenantOptions.some(t => t.tenantId === form.tenantId) && (
                  <option value={form.tenantId}>{form.tenantId} — (tidak terdaftar)</option>
                )}
              </select>
              {currentUser?.role === 'MASTER' && (
                <p className="text-[11px] text-slate-500 mt-1">Pilih tenant yang tersedia. Buat tenant baru di menu Daftar Tenant.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button>
            <Button onClick={save} disabled={saving} className="bg-orange-500 hover:bg-orange-600">{saving ? 'Menyimpan...' : 'Simpan'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog (replaces window.confirm) */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" /> Hapus User
            </DialogTitle>
            <DialogDescription>
              Tindakan ini tidak bisa dibatalkan.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm">
              <div className="font-semibold text-red-800">{deleteTarget.name}</div>
              <div className="text-xs text-red-700 font-mono">{deleteTarget.email}</div>
              <div className="text-xs text-red-600 mt-1">
                Role: <b>{deleteTarget.role}</b> · Tenant: <b>{deleteTarget.tenantId}</b>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>Batal</Button>
            <Button onClick={confirmDelete} disabled={deleting} className="bg-red-600 hover:bg-red-700">
              <Trash2 className="w-4 h-4 mr-1" />
              {deleting ? 'Menghapus...' : 'Hapus User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
