'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Link2 } from 'lucide-react';

export default function MappingPage() {
  const [maps, setMaps] = useState([]);
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState({ vendorKode: '', localStokId: '', vendorTenantId: '' });

  const load = () => {
    fetch('/api/vendor-product-map').then((r) => r.json()).then(setMaps);
    fetch('/api/products').then((r) => r.json()).then(setProducts);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    const res = await fetch('/api/vendor-product-map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) { toast.error(data.error || 'Gagal'); return; }
    toast.success('Mapping disimpan — GRN terkait diperbarui');
    setForm({ vendorKode: '', localStokId: '', vendorTenantId: '' });
    load();
  };

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4 max-w-2xl">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Link2 className="w-6 h-6" /> Mapping Produk Vendor</h1>
        <p className="text-sm text-slate-500">Kode produk sales.app → produk lokal customer. Auto-match jika kode sama.</p>
        <div className="bg-slate-50 border rounded-lg p-4 space-y-3">
          <div>
            <Label>Kode Vendor (sales.app)</Label>
            <Input className="mt-1" value={form.vendorKode} onChange={(e) => setForm({ ...form, vendorKode: e.target.value })} placeholder="B00001" />
          </div>
          <div>
            <Label>Produk Lokal</Label>
            <select className="mt-1 w-full border rounded-md px-3 py-2 text-sm" value={form.localStokId} onChange={(e) => setForm({ ...form, localStokId: e.target.value })}>
              <option value="">— Pilih —</option>
              {(Array.isArray(products) ? products : []).map((p) => (
                <option key={p.id} value={p.id}>{p.kode} — {p.nama}</option>
              ))}
            </select>
          </div>
          <Button onClick={save}>Simpan Mapping</Button>
        </div>
        <div className="bg-white border rounded-lg divide-y">
          {(Array.isArray(maps) ? maps : []).map((m) => (
            <div key={m.id} className="px-4 py-2 text-sm">
              <span className="font-mono text-blue-700">{m.vendorKode}</span> → {m.localKode} {m.localNama}
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
