'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { ShoppingBag, Send } from 'lucide-react';
import { formatDateTime } from '@/lib/format';

export default function CustomerPoPage() {
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [lines, setLines] = useState([{ localStokId: '', qty: 1 }]);
  const [catatan, setCatatan] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState('');

  const load = () => fetch('/api/customer-purchase-orders').then((r) => r.json()).then(setList);
  useEffect(() => {
    load();
    fetch('/api/products?limit=500').then((r) => r.json()).then(setProducts);
  }, []);

  const addLine = () => setLines([...lines, { localStokId: '', qty: 1 }]);
  const updateLine = (i, patch) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const createPo = async () => {
    const items = lines.map((l) => {
      const p = products.find((x) => x.id === l.localStokId);
      if (!p || !l.qty) return null;
      return {
        localStokId: p.id,
        vendorStokId: p.vendorStokId,
        vendorKode: p.kode,
        kode: p.kode,
        nama: p.nama,
        satuan: p.satuan,
        qty: parseFloat(l.qty) || 0,
      };
    }).filter(Boolean);
    if (!items.length) { toast.error('Pilih minimal satu produk'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/customer-purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, catatan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      toast.success(`PO ${data.noPO} dibuat`);
      setLines([{ localStokId: '', qty: 1 }]);
      setCatatan('');
      load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const submitPo = async (id) => {
    setSubmitting(id);
    const res = await fetch(`/api/customer-purchase-orders/${id}/submit`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) toast.error(data.error || 'Gagal kirim ke sales.app');
    else toast.success(`Dikirim → SO vendor ${data.vendorNoSO || data.vendorSoId || ''}`);
    load();
    setSubmitting('');
  };

  const synced = products.filter((p) => p.syncSource === 'sales.app');

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ShoppingBag className="w-6 h-6" /> PO ke Vendor</h1>
          <p className="text-sm text-slate-500">Buat PO customer → kirim ke sales.app sebagai Sales Order DRAFT</p>
        </div>
        <OperationalScopeBar />

        <div className="bg-white border rounded-lg p-4 space-y-3">
          <h2 className="font-semibold">PO Baru</h2>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2 items-end flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <Label>Produk (sync sales.app)</Label>
                <select
                  className="w-full border rounded h-9 px-2 text-sm"
                  value={l.localStokId}
                  onChange={(e) => updateLine(i, { localStokId: e.target.value })}
                >
                  <option value="">— pilih —</option>
                  {synced.map((p) => (
                    <option key={p.id} value={p.id}>{p.kode} — {p.nama}</option>
                  ))}
                </select>
              </div>
              <div className="w-24">
                <Label>Qty</Label>
                <Input type="number" min={1} value={l.qty} onChange={(e) => updateLine(i, { qty: e.target.value })} />
              </div>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addLine}>+ Baris</Button>
          <div>
            <Label>Catatan</Label>
            <Input value={catatan} onChange={(e) => setCatatan(e.target.value)} />
          </div>
          <Button onClick={createPo} disabled={saving} className="bg-orange-500 hover:bg-orange-600">
            {saving ? 'Menyimpan...' : 'Simpan PO (DRAFT)'}
          </Button>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">No. PO</th>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-left">SO Vendor</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {!list?.length && <tr><td colSpan={5} className="text-center py-10 text-slate-400">Belum ada PO</td></tr>}
              {(Array.isArray(list) ? list : []).map((po) => (
                <tr key={po.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{po.noPO}</td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(po.tanggal)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{po.vendorNoSO || '—'}</td>
                  <td className="px-3 py-2 text-center text-xs">{po.status}</td>
                  <td className="px-3 py-2 text-center">
                    {po.status === 'DRAFT' && (
                      <Button size="sm" onClick={() => submitPo(po.id)} disabled={submitting === po.id}>
                        <Send className="w-3 h-3 mr-1" />
                        {submitting === po.id ? '...' : 'Kirim ke sales.app'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
