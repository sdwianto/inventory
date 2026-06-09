'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { FileEdit, Plus, Search, Trash2, Save, X, Eye } from 'lucide-react';
import { formatNumber, formatDateTime } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import ListExportMenu from '@/components/ListExportMenu';
import { runListExport } from '@/lib/run-list-export';

export default function PenyesuaianPage() {
  const [list, setList] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState(null);
  const [products, setProducts] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerQ, setPickerQ] = useState('');
  const [keterangan, setKeterangan] = useState('');
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const res = await fetch('/api/stok/penyesuaian');
    setList(await res.json());
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (showPicker) fetch('/api/products?limit=500').then(r => r.json()).then(setProducts);
  }, [showPicker]);

  const openNew = () => {
    setItems([]); setKeterangan(''); setShowForm(true);
  };

  const addProduct = (p) => {
    if (items.find(it => it.stokId === p.id)) {
      toast.error('Produk sudah ada di daftar');
      return;
    }
    setItems([...items, {
      stokId: p.id, kode: p.kode, nama: p.nama, satuan: p.satuan,
      qtySistem: p.stok || 0, qtyAktual: p.stok || 0,
    }]);
    setShowPicker(false);
  };

  const updateAktual = (idx, val) => {
    setItems(items.map((it, i) => i === idx ? { ...it, qtyAktual: parseFloat(val || 0) } : it));
  };
  const removeItem = (idx) => setItems(items.filter((_, i) => i !== idx));

  const save = async () => {
    if (items.length === 0) { toast.error('Belum ada item'); return; }
    const user = getUser();
    setSaving(true);
    try {
      const res = await fetch('/api/stok/penyesuaian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keterangan,
          userId: user?.id, userName: user?.name,
          items: items.map(it => ({ stokId: it.stokId, kode: it.kode, qtyAktual: it.qtyAktual })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      toast.success(`Penyesuaian ${data.noPenyesuaian} berhasil`);
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
        baseName: `penyesuaian-stok-${stamp}`,
        title: 'Penyesuaian Stok',
        columns: [
          { key: 'tanggal', label: 'Tanggal', value: (r) => formatDateTime(r.tanggal) },
          { key: 'noPenyesuaian', label: 'No.' },
          { key: 'keterangan', label: 'Keterangan', value: (r) => r.keterangan || '-' },
          { key: 'userName', label: 'User', value: (r) => r.userName || '-' },
          { key: 'jumlahItem', label: 'Jml Item', value: (r) => (r.items || []).length },
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
            <h1 className="text-2xl font-bold flex items-center gap-2"><FileEdit className="w-6 h-6" /> Penyesuaian Stok</h1>
            <p className="text-sm text-slate-500">Stock opname: sinkronkan stok sistem dengan jumlah fisik</p>
          </div>
          <div className="flex items-center gap-2">
            <ListExportMenu onExport={exportData} disabled={list.length === 0} />
            <Button onClick={openNew} className="bg-orange-500 hover:bg-orange-600">
              <Plus className="w-4 h-4 mr-2" /> Penyesuaian Baru
            </Button>
          </div>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-left">No.</th>
                <th className="px-3 py-2 text-left">Keterangan</th>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-right">Jml Item</th>
                <th className="px-3 py-2 text-center w-20">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={6} className="text-center py-10 text-slate-400">Belum ada penyesuaian</td></tr>}
              {list.map(d => (
                <tr key={d.id} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2 text-xs">{formatDateTime(d.tanggal)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d.noPenyesuaian}</td>
                  <td className="px-3 py-2">{d.keterangan || '-'}</td>
                  <td className="px-3 py-2 text-xs">{d.userName || '-'}</td>
                  <td className="px-3 py-2 text-right">{(d.items || []).length}</td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => setDetail(d)} className="p-1.5 hover:bg-blue-50 text-blue-600 rounded"><Eye className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Form dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
          <DialogHeader><DialogTitle>Penyesuaian Stok Baru</DialogTitle></DialogHeader>
          <div className="space-y-3 overflow-y-auto">
            <div>
              <label className="text-xs text-slate-500">Keterangan</label>
              <Textarea value={keterangan} onChange={e => setKeterangan(e.target.value)} placeholder="Misal: Stock opname akhir bulan..." />
            </div>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Daftar Item ({items.length})</div>
              <Button variant="outline" size="sm" onClick={() => setShowPicker(true)}><Plus className="w-4 h-4 mr-1" /> Tambah Produk</Button>
            </div>
            <div className="border rounded">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-xs">
                  <tr>
                    <th className="px-2 py-2 text-left">Kode</th>
                    <th className="px-2 py-2 text-left">Nama</th>
                    <th className="px-2 py-2 text-right">Qty Sistem</th>
                    <th className="px-2 py-2 text-right">Qty Aktual</th>
                    <th className="px-2 py-2 text-right">Selisih</th>
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && <tr><td colSpan={6} className="text-center py-6 text-slate-400 text-xs">Belum ada item</td></tr>}
                  {items.map((it, i) => {
                    const selisih = (it.qtyAktual || 0) - (it.qtySistem || 0);
                    return (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-2 font-mono text-xs">{it.kode}</td>
                        <td className="px-2 py-2">{it.nama}</td>
                        <td className="px-2 py-2 text-right font-mono">{formatNumber(it.qtySistem)} {it.satuan}</td>
                        <td className="px-2 py-2 text-right">
                          <input type="number" value={it.qtyAktual} onChange={e => updateAktual(i, e.target.value)} className="w-24 border rounded px-2 py-1 text-right" step="0.01" />
                        </td>
                        <td className={`px-2 py-2 text-right font-semibold ${selisih > 0 ? 'text-green-600' : selisih < 0 ? 'text-red-600' : 'text-slate-500'}`}>
                          {selisih > 0 ? '+' : ''}{formatNumber(selisih)}
                        </td>
                        <td className="px-2 py-2"><button onClick={() => removeItem(i)} className="text-red-500 hover:bg-red-50 p-1 rounded"><Trash2 className="w-4 h-4" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}><X className="w-4 h-4 mr-1" /> Batal</Button>
            <Button onClick={save} disabled={saving || items.length === 0} className="bg-orange-500 hover:bg-orange-600">
              <Save className="w-4 h-4 mr-1" /> {saving ? 'Menyimpan...' : 'Simpan Penyesuaian'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Product picker */}
      <Dialog open={showPicker} onOpenChange={setShowPicker}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader><DialogTitle>Pilih Produk</DialogTitle></DialogHeader>
          <Input placeholder="Cari kode atau nama..." value={pickerQ} onChange={e => setPickerQ(e.target.value)} autoFocus />
          <div className="flex-1 overflow-auto border rounded">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs sticky top-0">
                <tr><th className="px-2 py-2 text-left">Kode</th><th className="px-2 py-2 text-left">Nama</th><th className="px-2 py-2 text-right">Stok Sistem</th></tr>
              </thead>
              <tbody>
                {filteredProducts.map(p => (
                  <tr key={p.id} onClick={() => addProduct(p)} className="border-t cursor-pointer hover:bg-orange-50">
                    <td className="px-2 py-2 font-mono text-xs">{p.kode}</td>
                    <td className="px-2 py-2">{p.nama}</td>
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
          <DialogHeader><DialogTitle>Detail Penyesuaian {detail?.noPenyesuaian}</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="bg-slate-50 rounded p-3 text-sm">
                <div>Tanggal: {formatDateTime(detail.tanggal)}</div>
                <div>Keterangan: {detail.keterangan || '-'}</div>
                <div>Oleh: {detail.userName || '-'}</div>
              </div>
              <table className="w-full text-sm border">
                <thead className="bg-slate-100 text-xs">
                  <tr>
                    <th className="px-2 py-2 text-left">Kode</th>
                    <th className="px-2 py-2 text-left">Nama</th>
                    <th className="px-2 py-2 text-right">Sistem</th>
                    <th className="px-2 py-2 text-right">Aktual</th>
                    <th className="px-2 py-2 text-right">Selisih</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.items || []).map((it, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-2 font-mono text-xs">{it.kode}</td>
                      <td className="px-2 py-2">{it.nama}</td>
                      <td className="px-2 py-2 text-right">{formatNumber(it.qtySistem)}</td>
                      <td className="px-2 py-2 text-right">{formatNumber(it.qtyAktual)}</td>
                      <td className={`px-2 py-2 text-right font-semibold ${it.selisih > 0 ? 'text-green-600' : it.selisih < 0 ? 'text-red-600' : ''}`}>
                        {it.selisih > 0 ? '+' : ''}{formatNumber(it.selisih)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
