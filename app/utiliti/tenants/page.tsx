'use client';
import type { ChangeEvent } from 'react';
import { str, num, asObject, type JsonObject } from '@/types/json';
import type { SessionUser } from '@/types/auth';
import { useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { Building2, Plus, Users, ImageIcon, Upload, X, Save, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { getUser } from '@/lib/auth-client';
import { invalidateTenantCache } from '@/lib/tenant-client';

const emptyForm = {
  tenantId: '', companyName: '', companyAddress: '', companyPhone: '', companyNPWP: '',
  receiptFooterText: 'Terima Kasih', showLogoOnReceipt: true, showLogoOnInvoice: true,
  logoBase64: '', ppnPercent: 11,
};

export default function TenantsListPage() {
  const [list, setList] = useState<JsonObject[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editTenant, setEditTenant] = useState<JsonObject | null>(null);
  const [deleteTenant, setDeleteTenant] = useState<JsonObject | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteForce, setDeleteForce] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenantIdManual, setTenantIdManual] = useState(false);
  const [seedDemoProducts, setSeedDemoProducts] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const slugFromCompanyName = (name: string) =>
    name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 40);

  const findTenantConflict = (tenantId: string) =>
    list.find((t) => str(t.tenantId) === tenantId);

  useEffect(() => { setUser(getUser()); load(); }, []);

  const load = async () => {
    const res = await fetch('/api/tenants');
    const data = await res.json();
    setList(Array.isArray(data) ? data : []);
  };

  // Open Edit dialog: fetch full tenant settings
  const openEdit = async (t: JsonObject) => {
    const res = await fetch(`/api/tenant/settings?tenantId=${encodeURIComponent(str(t.tenantId))}`);
    const settings = await res.json();
    setForm({ ...emptyForm, ...asObject(settings), tenantId: str(t.tenantId) });
    setEditTenant(t);
  };

  // Open Create dialog
  const openCreate = () => {
    setForm({ ...emptyForm });
    setTenantIdManual(false);
    setShowCreate(true);
  };

  // Open Delete confirmation dialog
  const openDelete = (t: JsonObject) => {
    setDeleteTenant(t);
    setDeleteConfirmText('');
    setDeleteForce(false);
  };

  // Execute delete
  const confirmDelete = async () => {
    if (!deleteTenant) return;
    const expected = str(deleteTenant.companyName) || str(deleteTenant.tenantName) || str(deleteTenant.tenantId);
    if (deleteConfirmText.trim() !== expected) {
      toast.error('Nama konfirmasi tidak sesuai');
      return;
    }
    setDeleting(true);
    try {
      const qs = deleteForce ? '?force=true' : '';
      const res = await fetch(`/api/tenants/${encodeURIComponent(str(deleteTenant.tenantId))}${qs}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        // If has users and not forced yet, offer force option
        if (res.status === 400 && /user/i.test(data.error || '') && !deleteForce) {
          toast.error(data.error || 'Tenant masih punya user');
          setDeleteForce(true); // surface checkbox so user can opt-in
          setDeleting(false);
          return;
        }
        throw new Error(data.error || 'Gagal menghapus tenant');
      }
      toast.success(`Tenant ${expected} berhasil dihapus${data.usersDeleted ? ` (${data.usersDeleted} user ikut dihapus)` : ''}`);
      setDeleteTenant(null);
      setDeleteConfirmText('');
      setDeleteForce(false);
      invalidateTenantCache();
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setDeleting(false);
  };

  // Logo upload handler (reused for both create & edit)
  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('File harus gambar'); return; }
    if (file.size > 500 * 1024) { toast.error('Logo maks 500KB'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 400;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = (height * maxDim) / width; width = maxDim; }
          else { width = (width * maxDim) / height; height = maxDim; }
        }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/png', 0.92);
        setForm(f => ({ ...f, logoBase64: dataUrl }));
        toast.success('Logo dimuat. Klik Simpan.');
      };
      img.src = String(ev.target?.result ?? '');
    };
    reader.readAsDataURL(file);
  };

  // Save create
  const saveCreate = async () => {
    if (!form.tenantId || !form.companyName) { toast.error('Tenant ID dan Nama wajib'); return; }
    const conflict = findTenantConflict(form.tenantId);
    if (conflict) {
      toast.error(
        `Tenant ID "${form.tenantId}" sudah dipakai oleh "${str(conflict.companyName) || str(conflict.tenantName)}". Pilih ID lain (mis. puspita-buah).`,
      );
      return;
    }
    setSaving(true);
    try {
      // First create tenant (basic)
      const res1 = await fetch('/api/tenants', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: form.tenantId, tenantName: form.companyName,
          companyAddress: form.companyAddress, companyPhone: form.companyPhone,
          companyNPWP: form.companyNPWP, logoBase64: form.logoBase64,
          seedDemoProducts,
        }),
      });
      const d1 = await res1.json();
      if (!res1.ok) throw new Error(d1.error || 'Gagal');
      // Then update full settings (footer, ppn, toggles)
      await fetch('/api/tenant/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      toast.success(`Tenant ${form.companyName} dibuat`);
      setShowCreate(false);
      invalidateTenantCache();
      load();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    setSaving(false);
  };

  // Save edit
  const saveEdit = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/tenant/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Gagal');
      toast.success('Tenant diperbarui');
      setEditTenant(null);
      invalidateTenantCache();
      load();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    setSaving(false);
  };

  if (user && user.role !== 'MASTER') {
    return <AppShell><div className="p-6"><Card><CardContent className="p-6 text-center"><Building2 className="w-12 h-12 mx-auto text-slate-400 mb-2" /><div className="font-semibold">Akses Terbatas</div><div className="text-sm text-slate-500">Hanya role MASTER yang bisa melihat daftar tenant.</div></CardContent></Card></div></AppShell>;
  }

  // Reusable form fields renderer (NOT a component — defining a component inside
  // the parent causes React to unmount/remount on every keystroke, which makes
  // inputs lose focus and the dialog scroll back to top).
  const renderFormFields = () => (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="space-y-3">
        <div className="aspect-square bg-slate-100 rounded-lg flex items-center justify-center overflow-hidden border-2 border-dashed">
          {form.logoBase64 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={form.logoBase64} alt="logo" className="max-w-full max-h-full object-contain" />
          ) : (
            <div className="text-center text-slate-400"><ImageIcon className="w-10 h-10 mx-auto mb-1" /><div className="text-xs">Belum ada logo</div></div>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
        <Button variant="outline" onClick={() => fileRef.current?.click()} className="w-full" size="sm"><Upload className="w-4 h-4 mr-1" /> Pilih Logo</Button>
        {form.logoBase64 && <Button variant="outline" onClick={() => setForm(f => ({...f, logoBase64: ''}))} className="w-full text-red-600" size="sm"><X className="w-4 h-4 mr-1" /> Hapus</Button>}
        <div className="text-[10px] text-slate-500">PNG/JPG, max 500KB. Auto-resize 400px.</div>
      </div>
      <div className="lg:col-span-2 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Tenant ID *</Label>
            <Input
              value={form.tenantId}
              onChange={(e) => {
                setTenantIdManual(true);
                setForm({ ...form, tenantId: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') });
              }}
              disabled={!!editTenant}
              className="font-mono"
              placeholder="contoh: puspita-buah"
            />
            {!editTenant && (
              <p className="text-[10px] text-slate-500 mt-1">
                ID unik (bukan nama toko). Tidak boleh sama dengan tenant lain — lihat label kecil di kartu daftar.
              </p>
            )}
            {!editTenant && form.tenantId && (() => {
              const conflict = findTenantConflict(form.tenantId);
              return conflict ? (
              <p className="text-[10px] text-red-600 mt-1">
                Sudah dipakai: {str(conflict.companyName) || str(conflict.tenantName)}
              </p>
              ) : null;
            })()}
          </div>
          <div>
            <Label>Nama Perusahaan *</Label>
            <Input
              value={form.companyName}
              onChange={(e) => {
                const companyName = e.target.value;
                setForm((f) => {
                  const next = { ...f, companyName };
                  if (!editTenant && !tenantIdManual) {
                    next.tenantId = slugFromCompanyName(companyName);
                  }
                  return next;
                });
              }}
            />
          </div>
        </div>
        <div><Label>Alamat</Label><Textarea value={form.companyAddress} onChange={e => setForm({...form, companyAddress: e.target.value})} rows={2} /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>Telepon</Label><Input value={form.companyPhone} onChange={e => setForm({...form, companyPhone: e.target.value})} /></div>
          <div><Label>NPWP</Label><Input value={form.companyNPWP} onChange={e => setForm({...form, companyNPWP: e.target.value})} /></div>
        </div>
        {!editTenant && (
          <label className="flex items-center gap-2 text-sm bg-orange-50 border border-orange-100 rounded-lg px-3 py-2 cursor-pointer">
            <input
              type="checkbox"
              checked={seedDemoProducts}
              onChange={(e) => setSeedDemoProducts(e.target.checked)}
            />
            Sertakan 12 produk demo (katalog awal untuk tenant baru)
          </label>
        )}
        <div><Label>Footer Struk</Label><Input value={form.receiptFooterText} onChange={e => setForm({...form, receiptFooterText: e.target.value})} placeholder="Terima Kasih" /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>PPN (%)</Label><Input type="number" value={form.ppnPercent} onChange={e => setForm({...form, ppnPercent: parseInt(e.target.value || '0')})} /></div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-1 text-xs bg-slate-50 px-2 py-2 rounded cursor-pointer flex-1"><input type="checkbox" checked={form.showLogoOnReceipt !== false} onChange={e => setForm({...form, showLogoOnReceipt: e.target.checked})} /> Logo di struk</label>
            <label className="flex items-center gap-1 text-xs bg-slate-50 px-2 py-2 rounded cursor-pointer flex-1"><input type="checkbox" checked={form.showLogoOnInvoice !== false} onChange={e => setForm({...form, showLogoOnInvoice: e.target.checked})} /> Logo di laporan</label>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><Building2 className="w-6 h-6" /> Daftar Tenant</h1>
            <p className="text-sm text-slate-500">Klik kartu untuk edit. Khusus MASTER role.</p>
          </div>
          <Button onClick={openCreate} className="bg-orange-500 hover:bg-orange-600"><Plus className="w-4 h-4 mr-2" /> Tenant Baru</Button>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {list.length === 0 && <div className="col-span-3 text-center py-10 text-slate-400">Belum ada tenant</div>}
          {list.map(t => (
            <Card key={str(t.tenantId)} onClick={() => openEdit(t)} className="cursor-pointer hover:shadow-md hover:border-orange-300 transition group">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-16 h-16 bg-slate-100 rounded-lg flex items-center justify-center overflow-hidden border">
                    {t.logoBase64 ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={str(t.logoBase64)} alt="logo" className="max-w-full max-h-full object-contain" />
                    ) : (
                      <ImageIcon className="w-7 h-7 text-slate-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold truncate group-hover:text-orange-600">{str(t.companyName) || str(t.tenantName)}</div>
                    <div className="text-xs text-slate-500 font-mono truncate">{str(t.tenantId)}</div>
                    <div className="text-[11px] text-slate-400 truncate">{str(t.companyAddress) || '— alamat belum diisi —'}</div>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t">
                  <span className="text-xs text-slate-500 flex items-center gap-1"><Users className="w-3 h-3" /> {str(t.userCount)} user</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-orange-500 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition"><Pencil className="w-3 h-3" /> Edit</span>
                    {str(t.tenantId) !== 'master' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => { e.stopPropagation(); openDelete(t); }}
                        className="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50"
                        title="Hapus tenant"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                {!!str(t.companyPhone) && <div className="text-[11px] text-slate-500">📞 {str(t.companyPhone)}</div>}
                {!!str(t.companyNPWP) && <div className="text-[11px] text-slate-500">NPWP: {str(t.companyNPWP)}</div>}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Plus className="w-5 h-5" /> Tenant Baru</DialogTitle></DialogHeader>
          {renderFormFields()}
          <DialogFooter><Button variant="outline" onClick={() => setShowCreate(false)}>Batal</Button><Button onClick={saveCreate} disabled={saving} className="bg-orange-500 hover:bg-orange-600"><Save className="w-4 h-4 mr-1" /> {saving ? 'Menyimpan...' : 'Simpan Tenant Baru'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editTenant} onOpenChange={(o) => !o && setEditTenant(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Pencil className="w-5 h-5" /> Edit Tenant: {str(editTenant?.tenantId)}</DialogTitle></DialogHeader>
          {renderFormFields()}
          <DialogFooter><Button variant="outline" onClick={() => setEditTenant(null)}>Batal</Button><Button onClick={saveEdit} disabled={saving} className="bg-orange-500 hover:bg-orange-600"><Save className="w-4 h-4 mr-1" /> {saving ? 'Menyimpan...' : 'Simpan Perubahan'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTenant} onOpenChange={(o) => { if (!o) { setDeleteTenant(null); setDeleteConfirmText(''); setDeleteForce(false); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" /> Hapus Tenant
            </DialogTitle>
          </DialogHeader>
          {deleteTenant && (
            <div className="space-y-3">
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
                <div className="font-semibold mb-1">⚠ Tindakan ini tidak bisa dibatalkan!</div>
                <div className="text-xs">
                  Tenant <span className="font-bold">{str(deleteTenant.companyName) || str(deleteTenant.tenantName)}</span>
                  {' '}(<span className="font-mono">{str(deleteTenant.tenantId)}</span>) akan dihapus permanen
                  beserta pengaturan dan logonya.
                </div>
              </div>

              {num(deleteTenant.userCount) > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs space-y-2">
                  <div className="font-semibold text-amber-800 flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" /> Tenant ini punya {str(deleteTenant.userCount)} user aktif
                  </div>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deleteForce}
                      onChange={(e) => setDeleteForce(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-amber-900">
                      Saya mengerti — hapus juga <b>{str(deleteTenant.userCount)} user</b> milik tenant ini (force delete).
                    </span>
                  </label>
                </div>
              )}

              <div>
                <Label className="text-xs">
                  Ketik ulang nama tenant untuk konfirmasi:
                  {' '}<span className="font-mono font-bold text-red-600">{str(deleteTenant.companyName) || str(deleteTenant.tenantName)}</span>
                </Label>
                <Input
                  autoFocus
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder={str(deleteTenant.companyName) || str(deleteTenant.tenantName)}
                  className="mt-1"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteTenant(null); setDeleteConfirmText(''); setDeleteForce(false); }}>
              Batal
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={
                deleting ||
                !deleteTenant ||
                deleteConfirmText.trim() !== (str(deleteTenant?.companyName) || str(deleteTenant?.tenantName) || str(deleteTenant?.tenantId)) ||
                (num(deleteTenant?.userCount) > 0 && !deleteForce)
              }
              className="bg-red-600 hover:bg-red-700"
            >
              <Trash2 className="w-4 h-4 mr-1" />
              {deleting ? 'Menghapus...' : 'Hapus Permanen'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
