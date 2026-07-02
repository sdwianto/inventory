'use client';

import type { ChangeEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import { Building2, Upload, Save, ImageIcon, X, Eye } from 'lucide-react';
import { getUser } from '@/lib/auth-client';
import { fetchTenantSettings, invalidateTenantCache } from '@/lib/tenant-client';

export default function TenantSetupPage() {
  const [form, setForm] = useState({
    tenantId: 'default', companyName: '', companyAddress: '', companyPhone: '',
    companyNPWP: '', receiptFooterText: 'Terima Kasih',
    showLogoOnReceipt: true, showLogoOnInvoice: true, logoBase64: '', logoUrl: '',
    ppnPercent: 11,
  });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const user = getUser();
    const tenantId = user?.tenantId || 'default';
    fetch(`/api/tenant/settings?tenantId=${tenantId}`)
      .then(r => r.json())
      .then(d => setForm({ ...form, ...d }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('File harus gambar'); return; }
    if (file.size > 500 * 1024) {
      toast.error('Logo maksimal 500KB. Kompres dulu agar tidak memberatkan database.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      // Optionally resize using canvas to ~256x256
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
        toast.success('Logo dimuat. Klik Simpan untuk menyimpan.');
      };
      img.src = String(ev.target?.result ?? '');
    };
    reader.readAsDataURL(file);
  };

  const logoSrc = form.logoBase64 || form.logoUrl || '';

  const removeLogo = () => setForm(f => ({ ...f, logoBase64: '', logoUrl: '' }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/tenant/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      invalidateTenantCache();
      toast.success('Pengaturan tenant tersimpan. Logo akan muncul di semua dokumen.');
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    setSaving(false);
  };

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Building2 className="w-6 h-6" /> Setup Tenant & Logo</h1>
          <p className="text-sm text-slate-500">Pengaturan profil toko. Logo akan otomatis muncul di struk kasir, invoice, dan semua dokumen laporan.</p>
        </div>

        <div className="grid lg:grid-cols-3 gap-4">
          {/* Logo upload */}
          <Card className="lg:col-span-1">
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><ImageIcon className="w-4 h-4" /> Logo Perusahaan</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="aspect-square bg-slate-100 rounded-lg flex items-center justify-center overflow-hidden border-2 border-dashed border-slate-300">
                {logoSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoSrc} alt="logo" className="max-w-full max-h-full object-contain" />
                ) : (
                  <div className="text-center text-slate-400">
                    <ImageIcon className="w-12 h-12 mx-auto mb-2" />
                    <div className="text-xs">Belum ada logo</div>
                  </div>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
              <Button variant="outline" onClick={() => fileRef.current?.click()} className="w-full">
                <Upload className="w-4 h-4 mr-2" /> Pilih File Logo
              </Button>
              {logoSrc && (
                <Button variant="outline" onClick={removeLogo} className="w-full text-red-600">
                  <X className="w-4 h-4 mr-2" /> Hapus Logo
                </Button>
              )}
              <div className="text-xs text-slate-500">
                <strong>Tips:</strong> Format PNG/JPG, max 500KB.<br />
                Otomatis di-resize ke max 400x400px.
              </div>
            </CardContent>
          </Card>

          {/* Tenant info */}
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle className="text-base">Informasi Perusahaan</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Tenant ID</Label><Input value={form.tenantId} disabled className="font-mono" /></div>
                <div><Label>Nama Perusahaan *</Label><Input value={form.companyName} onChange={e => setForm({...form, companyName: e.target.value})} /></div>
                <div className="col-span-2"><Label>Alamat</Label><Textarea value={form.companyAddress} onChange={e => setForm({...form, companyAddress: e.target.value})} rows={2} /></div>
                <div><Label>Telepon</Label><Input value={form.companyPhone} onChange={e => setForm({...form, companyPhone: e.target.value})} /></div>
                <div><Label>NPWP</Label><Input value={form.companyNPWP} onChange={e => setForm({...form, companyNPWP: e.target.value})} /></div>
              </div>
              <div className="border-t pt-3 grid grid-cols-2 gap-3">
                <div className="col-span-2"><Label>Footer Struk Kasir</Label><Input value={form.receiptFooterText} onChange={e => setForm({...form, receiptFooterText: e.target.value})} placeholder="Terima Kasih" /></div>
                <div><Label>PPN (%)</Label><Input type="number" value={form.ppnPercent} onChange={e => setForm({...form, ppnPercent: parseInt(e.target.value || '0')})} /></div>
                <div className="col-span-2 grid grid-cols-2 gap-2">
                  <label className="flex items-center gap-2 text-sm bg-slate-50 px-3 py-2 rounded cursor-pointer">
                    <input type="checkbox" checked={form.showLogoOnReceipt !== false} onChange={e => setForm({...form, showLogoOnReceipt: e.target.checked})} />
                    Tampilkan logo di struk kasir
                  </label>
                  <label className="flex items-center gap-2 text-sm bg-slate-50 px-3 py-2 rounded cursor-pointer">
                    <input type="checkbox" checked={form.showLogoOnInvoice !== false} onChange={e => setForm({...form, showLogoOnInvoice: e.target.checked})} />
                    Tampilkan logo di laporan
                  </label>
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <Button variant="outline" onClick={() => setPreview(true)}><Eye className="w-4 h-4 mr-1" /> Preview Struk</Button>
                <Button onClick={save} disabled={saving} className="bg-orange-500 hover:bg-orange-600 ml-auto"><Save className="w-4 h-4 mr-1" /> {saving ? 'Menyimpan...' : 'Simpan Pengaturan'}</Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {preview && (
          <Card>
            <CardHeader><CardTitle className="text-base">Preview Struk Kasir</CardTitle></CardHeader>
            <CardContent>
              <div className="bg-slate-50 p-4 rounded">
                <div className="bg-white shadow-md mx-auto p-4 font-mono text-xs" style={{ width: '80mm' }}>
                  {form.showLogoOnReceipt && logoSrc && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoSrc} alt="" className="mx-auto mb-2" style={{ maxHeight: '15mm' }} />
                  )}
                  <div className="text-center font-bold">{form.companyName}</div>
                  <div className="text-center">{form.companyAddress}</div>
                  <div className="text-center">Telp: {form.companyPhone}</div>
                  {form.companyNPWP && <div className="text-center">NPWP: {form.companyNPWP}</div>}
                  <div className="border-t-2 border-black my-2"></div>
                  <div>Tgl  : 30/05/2026 14:30</div>
                  <div>Nota : TK260530000001</div>
                  <div>Kasir: Admin Toko</div>
                  <div className="border-t border-dashed my-2"></div>
                  <div>Indomie Goreng</div>
                  <div className="flex justify-between"><span>&nbsp;&nbsp;2 PCS x Rp 3.500</span><span>Rp 7.000</span></div>
                  <div>Aqua 600ml</div>
                  <div className="flex justify-between"><span>&nbsp;&nbsp;1 PCS x Rp 3.500</span><span>Rp 3.500</span></div>
                  <div className="border-t border-dashed my-2"></div>
                  <div className="flex justify-between font-bold"><span>TOTAL</span><span>Rp 10.500</span></div>
                  <div className="flex justify-between"><span>Bayar</span><span>Rp 15.000</span></div>
                  <div className="flex justify-between"><span>Kembali</span><span>Rp 4.500</span></div>
                  <div className="border-t-2 border-black my-2"></div>
                  <div className="text-center">&lt;&lt; {form.receiptFooterText} &gt;&gt;</div>
                </div>
              </div>
              <Button variant="outline" onClick={() => setPreview(false)} className="w-full mt-3"><X className="w-4 h-4 mr-1" /> Tutup Preview</Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
