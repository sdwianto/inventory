'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Factory, Plus, Trash2, Save, X, Eye, ArrowRight } from 'lucide-react';
import { formatIDR, formatNumber, formatDateTime } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import ListExportMenu from '@/components/ListExportMenu';
import { runListExport } from '@/lib/run-list-export';

export default function ProduksiPage() {
  const [list, setList] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState(null);
  const [products, setProducts] = useState([]);
  const [showPicker, setShowPicker] = useState(null); // 'bahan' or 'hasil'
  const [pickerQ, setPickerQ] = useState('');
  const [catatan, setCatatan] = useState('');
  const [biaya, setBiaya] = useState(0);
  const [bahan, setBahan] = useState([]);
  const [hasil, setHasil] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const res = await fetch('/api/stok/produksi');
    setList(await res.json());
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (showPicker) fetch('/api/products?limit=500').then(r => r.json()).then(setProducts);
  }, [showPicker]);

  const openNew = () => {
    setBahan([]); setHasil([]); setCatatan(''); setBiaya(0); setShowForm(true);
  };

  const addToList = (p) => {
    const target = showPicker;
    const list = target === 'bahan' ? bahan : hasil;
    const setter = target === 'bahan' ? setBahan : setHasil;
    if (list.find(it => it.stokId === p.id)) {
      toast.error('Produk sudah ada di daftar');
      return;
    }
    setter([...list, { stokId: p.id, kode: p.kode, nama: p.nama, satuan: p.satuan, qty: 1, hargaBeli: p.hargaBeli, stokSistem: p.stok }]);
    setShowPicker(null);
  };

  const updateQty = (type, idx, val) => {
    const setter = type === 'bahan' ? setBahan : setHasil;
    const cur = type === 'bahan' ? bahan : hasil;
    setter(cur.map((it, i) => i === idx ? { ...it, qty: parseFloat(val || 0) } : it));
  };
  const removeItem = (type, idx) => {
    const setter = type === 'bahan' ? setBahan : setHasil;
    const cur = type === 'bahan' ? bahan : hasil;
    setter(cur.filter((_, i) => i !== idx));
  };

  // compute HPP preview
  const totalCostBahan = bahan.reduce((s, b) => s + (b.qty * (b.hargaBeli || 0)), 0);
  const totalCost = totalCostBahan + (parseInt(biaya || 0, 10));
  const totalHasil = hasil.reduce((s, h) => s + (h.qty || 0), 0);
  const hppPerUnit = totalHasil > 0 ? Math.round(totalCost / totalHasil) : 0;

  const save = async () => {
    if (bahan.length === 0 || hasil.length === 0) { toast.error('Bahan dan hasil wajib diisi'); return; }
    const user = getUser();
    setSaving(true);
    try {
      const res = await fetch('/api/stok/produksi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catatan, biayaProduksi: parseInt(biaya || 0, 10),
          userId: user?.id, userName: user?.name,
          bahan: bahan.map(b => ({ stokId: b.stokId, kode: b.kode, qty: b.qty })),
          hasil: hasil.map(h => ({ stokId: h.stokId, kode: h.kode, qty: h.qty })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      toast.success(`Produksi ${data.kodeProduksi} berhasil`);
      setShowForm(false);
      load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const filteredProducts = products.filter(p => !pickerQ || p.nama.toLowerCase().includes(pickerQ.toLowerCase()) || p.kode.toLowerCase().includes(pickerQ.toLowerCase()));

  const exportData = async (format) => {
    try {
      const rows = list;
      if (!rows.length) { toast.error('Tidak ada data'); return; }
      const stamp = new Date().toISOString().slice(0, 10);
      await runListExport(format, {
        baseName: `produksi-${stamp}`,
        title: 'Produksi (BOM)',
        columns: [
          { key: 'tanggal', label: 'Tanggal', value: (r) => formatDateTime(r.tanggal) },
          { key: 'kodeProduksi', label: 'Kode' },
          { key: 'catatan', label: 'Catatan', value: (r) => r.catatan || '-' },
          { key: 'totalCost', label: 'Total HPP', value: (r) => formatIDR(r.totalCost) },
          { key: 'hppPerUnit', label: 'HPP/Unit', value: (r) => formatIDR(r.hppPerUnit) },
        ],
        rows,
      });
      toast.success(`${rows.length} baris diekspor`);
    } catch (e) { toast.error(e.message); }
  };

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><Factory className="w-6 h-6" /> Produksi (BOM)</h1>
            <p className="text-sm text-slate-500">Konversi bahan baku menjadi produk jadi dengan perhitungan HPP otomatis</p>
          </div>
          <div className="flex items-center gap-2">
            <ListExportMenu onExport={exportData} disabled={list.length === 0} />
            <Button onClick={openNew} className="bg-orange-500 hover:bg-orange-600">
              <Plus className="w-4 h-4 mr-2" /> Produksi Baru
            </Button>
          </div>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-left">Kode</th>
                <th className="px-3 py-2 text-left">Catatan</th>
                <th className="px-3 py-2 text-right">Total HPP</th>
                <th className="px-3 py-2 text-right">HPP/Unit</th>
                <th className="px-3 py-2 text-center w-20">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={6} className="text-center py-10 text-slate-400">Belum ada produksi</td></tr>}
              {list.map(d => (
                <tr key={d.id} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2 text-xs">{formatDateTime(d.tanggal)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d.kodeProduksi}</td>
                  <td className="px-3 py-2">{d.catatan || '-'}</td>
                  <td className="px-3 py-2 text-right">{formatIDR(d.totalCost)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{formatIDR(d.hppPerUnit)}</td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => setDetail(d)} className="p-1.5 hover:bg-blue-50 text-blue-600 rounded"><Eye className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Form */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
          <DialogHeader><DialogTitle>Produksi Baru</DialogTitle></DialogHeader>
          <div className="space-y-3 overflow-y-auto">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs text-slate-500">Catatan</label><Input value={catatan} onChange={e => setCatatan(e.target.value)} /></div>
              <div><label className="text-xs text-slate-500">Biaya Produksi (tenaga, listrik, dll)</label><Input type="number" value={biaya} onChange={e => setBiaya(e.target.value)} /></div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Bahan */}
              <div className="border rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-semibold text-sm flex items-center gap-2"><span className="w-2 h-2 bg-red-500 rounded-full"></span> Bahan Baku</div>
                  <Button size="sm" variant="outline" onClick={() => { setShowPicker('bahan'); setPickerQ(''); }}><Plus className="w-3 h-3 mr-1" /> Tambah</Button>
                </div>
                <table className="w-full text-xs">
                  <thead className="bg-slate-50"><tr><th className="px-1 py-1 text-left">Nama</th><th className="px-1 py-1 text-right">Qty</th><th className="px-1 py-1 text-right">Hrg</th><th></th></tr></thead>
                  <tbody>
                    {bahan.length === 0 && <tr><td colSpan={4} className="text-center py-4 text-slate-400">Belum ada bahan</td></tr>}
                    {bahan.map((it, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-1 py-1"><div>{it.nama}</div><div className="text-[10px] text-slate-500">stok: {formatNumber(it.stokSistem)}</div></td>
                        <td className="px-1 py-1 text-right"><input type="number" value={it.qty} onChange={e => updateQty('bahan', i, e.target.value)} className="w-16 border rounded px-1 py-0.5 text-right" step="0.01" /> {it.satuan}</td>
                        <td className="px-1 py-1 text-right text-slate-500">{formatIDR(it.hargaBeli)}</td>
                        <td className="px-1 py-1"><button onClick={() => removeItem('bahan', i)} className="text-red-500"><Trash2 className="w-3 h-3" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 text-xs text-right text-slate-600">Total Bahan: <span className="font-bold">{formatIDR(totalCostBahan)}</span></div>
              </div>

              {/* Hasil */}
              <div className="border rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-semibold text-sm flex items-center gap-2"><span className="w-2 h-2 bg-green-500 rounded-full"></span> Hasil Produksi</div>
                  <Button size="sm" variant="outline" onClick={() => { setShowPicker('hasil'); setPickerQ(''); }}><Plus className="w-3 h-3 mr-1" /> Tambah</Button>
                </div>
                <table className="w-full text-xs">
                  <thead className="bg-slate-50"><tr><th className="px-1 py-1 text-left">Nama</th><th className="px-1 py-1 text-right">Qty</th><th></th></tr></thead>
                  <tbody>
                    {hasil.length === 0 && <tr><td colSpan={3} className="text-center py-4 text-slate-400">Belum ada hasil</td></tr>}
                    {hasil.map((it, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-1 py-1">{it.nama}</td>
                        <td className="px-1 py-1 text-right"><input type="number" value={it.qty} onChange={e => updateQty('hasil', i, e.target.value)} className="w-16 border rounded px-1 py-0.5 text-right" step="0.01" /> {it.satuan}</td>
                        <td className="px-1 py-1"><button onClick={() => removeItem('hasil', i)} className="text-red-500"><Trash2 className="w-3 h-3" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <Card className="bg-orange-50 border-orange-200">
              <CardContent className="p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-600">
                    <span>Total Bahan ({formatIDR(totalCostBahan)})</span>
                    <span>+</span>
                    <span>Biaya ({formatIDR(parseInt(biaya || 0, 10))})</span>
                    <ArrowRight className="w-4 h-4" />
                    <span>Total HPP <strong>{formatIDR(totalCost)}</strong></span>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-slate-500">HPP per unit hasil</div>
                    <div className="text-xl font-bold text-orange-600">{formatIDR(hppPerUnit)}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}><X className="w-4 h-4 mr-1" /> Batal</Button>
            <Button onClick={save} disabled={saving || bahan.length === 0 || hasil.length === 0} className="bg-orange-500 hover:bg-orange-600">
              <Save className="w-4 h-4 mr-1" /> {saving ? 'Menyimpan...' : 'Simpan Produksi'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Product picker */}
      <Dialog open={!!showPicker} onOpenChange={() => setShowPicker(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader><DialogTitle>Pilih {showPicker === 'bahan' ? 'Bahan Baku' : 'Hasil Produksi'}</DialogTitle></DialogHeader>
          <Input placeholder="Cari kode atau nama..." value={pickerQ} onChange={e => setPickerQ(e.target.value)} autoFocus />
          <div className="flex-1 overflow-auto border rounded">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs sticky top-0"><tr><th className="px-2 py-2 text-left">Kode</th><th className="px-2 py-2 text-left">Nama</th><th className="px-2 py-2 text-right">Hrg Beli</th><th className="px-2 py-2 text-right">Stok</th></tr></thead>
              <tbody>
                {filteredProducts.map(p => (
                  <tr key={p.id} onClick={() => addToList(p)} className="border-t cursor-pointer hover:bg-orange-50">
                    <td className="px-2 py-2 font-mono text-xs">{p.kode}</td>
                    <td className="px-2 py-2">{p.nama}</td>
                    <td className="px-2 py-2 text-right">{formatIDR(p.hargaBeli)}</td>
                    <td className="px-2 py-2 text-right">{p.stok}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Detail */}
      <Dialog open={!!detail} onOpenChange={() => setDetail(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Detail Produksi {detail?.kodeProduksi}</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="bg-slate-50 rounded p-3 grid grid-cols-3 gap-2">
                <div><span className="text-slate-500">Tanggal:</span> {formatDateTime(detail.tanggal)}</div>
                <div><span className="text-slate-500">Biaya:</span> {formatIDR(detail.biayaProduksi)}</div>
                <div><span className="text-slate-500">HPP/Unit:</span> <strong>{formatIDR(detail.hppPerUnit)}</strong></div>
              </div>
              <div>
                <div className="font-semibold mb-1 text-red-700">Bahan Baku</div>
                <table className="w-full text-xs border">
                  <thead className="bg-slate-100"><tr><th className="px-2 py-1 text-left">Kode</th><th className="px-2 py-1 text-left">Nama</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">Hrg Beli</th><th className="px-2 py-1 text-right">Subtotal</th></tr></thead>
                  <tbody>
                    {(detail.bahan || []).map((it, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1 font-mono">{it.kode}</td>
                        <td className="px-2 py-1">{it.nama}</td>
                        <td className="px-2 py-1 text-right">{formatNumber(it.qty)} {it.satuan}</td>
                        <td className="px-2 py-1 text-right">{formatIDR(it.hargaBeli)}</td>
                        <td className="px-2 py-1 text-right">{formatIDR(it.qty * it.hargaBeli)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="font-semibold mb-1 text-green-700">Hasil Produksi</div>
                <table className="w-full text-xs border">
                  <thead className="bg-slate-100"><tr><th className="px-2 py-1 text-left">Kode</th><th className="px-2 py-1 text-left">Nama</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">HPP/Unit</th></tr></thead>
                  <tbody>
                    {(detail.hasil || []).map((it, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1 font-mono">{it.kode}</td>
                        <td className="px-2 py-1">{it.nama}</td>
                        <td className="px-2 py-1 text-right">{formatNumber(it.qty)} {it.satuan}</td>
                        <td className="px-2 py-1 text-right font-semibold">{formatIDR(it.hargaBeli)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
