'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { ArrowLeftRight, Plus, Trash2, Save, ArrowRight } from 'lucide-react';
import { formatNumber, formatDateTime } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import ListExportMenu from '@/components/ListExportMenu';
import ListSummaryCards from '@/components/ListSummaryCards';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { runListExport } from '@/lib/run-list-export';

export default function TransferPage() {
  const [list, setList] = useState([]);
  const [lokasi, setLokasi] = useState([]);
  const [products, setProducts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerQ, setPickerQ] = useState('');
  const [form, setForm] = useState({ lokasiAsal: '', lokasiTujuan: '', keterangan: '', items: [] });
  const [saving, setSaving] = useState(false);

  const load = async () => { const r = await fetch('/api/stok/transfer'); setList(await r.json()); };
  useEffect(() => { load(); fetch('/api/lokasi').then(r => r.json()).then(d => setLokasi(Array.isArray(d) ? d : [])); }, []);
  useEffect(() => { if (showPicker) fetch('/api/products?limit=500').then(r => r.json()).then(setProducts); }, [showPicker]);

  const addItem = (p) => {
    if (form.items.find(it => it.stokId === p.id)) { toast.error('Sudah ada'); return; }
    setForm({...form, items: [...form.items, { stokId: p.id, kode: p.kode, nama: p.nama, satuan: p.satuan, qty: 1, hargaBeli: p.hargaBeli, stokSistem: p.stok }]});
    setShowPicker(false);
  };
  const updateQty = (i, v) => setForm({...form, items: form.items.map((it, idx) => idx === i ? { ...it, qty: parseFloat(v || 0) } : it)});
  const removeItem = (i) => setForm({...form, items: form.items.filter((_, idx) => idx !== i)});

  const save = async () => {
    if (!form.lokasiAsal || !form.lokasiTujuan) { toast.error('Pilih lokasi'); return; }
    if (form.items.length === 0) { toast.error('Belum ada item'); return; }
    setSaving(true);
    try {
      const asal = lokasi.find(l => l.id === form.lokasiAsal || l.kode === form.lokasiAsal);
      const tujuan = lokasi.find(l => l.id === form.lokasiTujuan || l.kode === form.lokasiTujuan);
      const user = getUser();
      const res = await fetch('/api/stok/transfer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, lokasiAsalNama: asal?.nama, lokasiTujuanNama: tujuan?.nama, userName: user?.name }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Gagal');
      toast.success(`Transfer ${d.noTransfer} berhasil`);
      setShowForm(false); setForm({ lokasiAsal: '', lokasiTujuan: '', keterangan: '', items: [] });
      load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const filtered = products.filter(p => !pickerQ || p.nama.toLowerCase().includes(pickerQ.toLowerCase()) || p.kode.toLowerCase().includes(pickerQ.toLowerCase()));

  const exportData = async (format) => {
    try {
      const rows = list;
      if (!rows.length) { toast.error('Tidak ada data'); return; }
      const stamp = new Date().toISOString().slice(0, 10);
      await runListExport(format, {
        baseName: `transfer-stok-${stamp}`,
        title: 'Transfer Stok',
        columns: [
          { key: 'tanggal', label: 'Tanggal', value: (r) => formatDateTime(r.tanggal) },
          { key: 'noTransfer', label: 'No.' },
          { key: 'lokasiAsalNama', label: 'Dari' },
          { key: 'lokasiTujuanNama', label: 'Ke' },
          { key: 'jumlahItem', label: 'Item', value: (r) => (r.items || []).length },
          { key: 'keterangan', label: 'Catatan', value: (r) => r.keterangan || '-' },
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
          <div><h1 className="text-2xl font-bold flex items-center gap-2"><ArrowLeftRight className="w-6 h-6" /> Transfer Stok</h1><p className="text-sm text-slate-500">Pindahkan stok antar lokasi/cabang</p></div>
          <div className="flex items-center gap-2">
            <ListExportMenu onExport={exportData} disabled={list.length === 0} />
            <Button onClick={() => setShowForm(true)} className="bg-orange-500 hover:bg-orange-600"><Plus className="w-4 h-4 mr-2" /> Transfer Baru</Button>
          </div>
        </div>

        <OperationalScopeBar />

        <ListSummaryCards
          items={[
            { label: 'Jumlah Transfer', value: list.length },
            { label: 'Total Item Dipindah', value: list.reduce((s, d) => s + (d.items || []).length, 0), colSpan: 2 },
          ]}
        />

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600"><tr><th className="px-3 py-2 text-left">Tanggal</th><th className="px-3 py-2 text-left">No.</th><th className="px-3 py-2 text-left">Dari</th><th className="px-3 py-2 text-left">Ke</th><th className="px-3 py-2 text-right">Item</th><th className="px-3 py-2 text-left">Catatan</th></tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={6} className="text-center py-10 text-slate-400">Belum ada transfer</td></tr>}
              {list.map(d => (
                <tr key={d.id} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2 text-xs">{formatDateTime(d.tanggal)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d.noTransfer}</td>
                  <td className="px-3 py-2">{d.lokasiAsalNama}</td>
                  <td className="px-3 py-2">{d.lokasiTujuanNama}</td>
                  <td className="px-3 py-2 text-right">{(d.items || []).length}</td>
                  <td className="px-3 py-2 text-xs">{d.keterangan || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader><DialogTitle>Transfer Stok Baru</DialogTitle></DialogHeader>
          <div className="space-y-3 overflow-y-auto">
            <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
              <div><Label>Dari Lokasi *</Label><select value={form.lokasiAsal} onChange={e => setForm({...form, lokasiAsal: e.target.value})} className="w-full border rounded px-3 py-2 text-sm"><option value="">-- pilih --</option>{lokasi.map(l => <option key={l.id} value={l.kode}>{l.kode} - {l.nama}</option>)}</select></div>
              <ArrowRight className="w-5 h-5 text-orange-500 mb-2" />
              <div><Label>Ke Lokasi *</Label><select value={form.lokasiTujuan} onChange={e => setForm({...form, lokasiTujuan: e.target.value})} className="w-full border rounded px-3 py-2 text-sm"><option value="">-- pilih --</option>{lokasi.map(l => <option key={l.id} value={l.kode}>{l.kode} - {l.nama}</option>)}</select></div>
            </div>
            <div><Label>Keterangan</Label><Input value={form.keterangan} onChange={e => setForm({...form, keterangan: e.target.value})} /></div>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Item ({form.items.length})</div>
              <Button size="sm" variant="outline" onClick={() => setShowPicker(true)}><Plus className="w-3 h-3 mr-1" /> Tambah</Button>
            </div>
            <table className="w-full text-sm border">
              <thead className="bg-slate-100 text-xs"><tr><th className="px-2 py-2 text-left">Kode</th><th className="px-2 py-2 text-left">Nama</th><th className="px-2 py-2 text-right">Stok Tersedia</th><th className="px-2 py-2 text-right">Qty Transfer</th><th></th></tr></thead>
              <tbody>
                {form.items.length === 0 && <tr><td colSpan={5} className="text-center py-4 text-slate-400 text-xs">Belum ada</td></tr>}
                {form.items.map((it, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1 font-mono text-xs">{it.kode}</td>
                    <td className="px-2 py-1">{it.nama}</td>
                    <td className="px-2 py-1 text-right">{formatNumber(it.stokSistem)} {it.satuan}</td>
                    <td className="px-2 py-1 text-right"><input type="number" value={it.qty} onChange={e => updateQty(i, e.target.value)} className="w-20 border rounded px-1 py-0.5 text-right" step="0.01" /></td>
                    <td className="px-2 py-1"><button onClick={() => removeItem(i)} className="text-red-500"><Trash2 className="w-3 h-3" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button><Button onClick={save} disabled={saving} className="bg-orange-500 hover:bg-orange-600"><Save className="w-4 h-4 mr-1" /> {saving ? 'Menyimpan...' : 'Simpan Transfer'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showPicker} onOpenChange={setShowPicker}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader><DialogTitle>Pilih Produk</DialogTitle></DialogHeader>
          <Input placeholder="Cari..." value={pickerQ} onChange={e => setPickerQ(e.target.value)} autoFocus />
          <div className="flex-1 overflow-auto border rounded">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs sticky top-0"><tr><th className="px-2 py-2 text-left">Kode</th><th className="px-2 py-2 text-left">Nama</th><th className="px-2 py-2 text-right">Stok</th></tr></thead>
              <tbody>{filtered.map(p => (<tr key={p.id} onClick={() => addItem(p)} className="border-t cursor-pointer hover:bg-orange-50"><td className="px-2 py-2 font-mono text-xs">{p.kode}</td><td className="px-2 py-2">{p.nama}</td><td className="px-2 py-2 text-right">{p.stok}</td></tr>))}</tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
