'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatDateTime, formatNumber } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import { WAREHOUSES } from '@/lib/warehouses-client';
import { ArrowUpFromLine, Plus, CheckCircle2, XCircle, Send } from 'lucide-react';

const STATUS_STYLE = {
  DRAFT: 'bg-slate-100 text-slate-700',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800',
  POSTED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-slate-100 text-slate-500',
};

const CAN_CREATE = ['GUDANG', 'ADMIN', 'MASTER'];
const CAN_APPROVE = ['SUPERVISOR', 'ADMIN', 'MASTER'];

export default function ReleaseInventoryPage() {
  const [user, setUser] = useState(null);
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    lokasiKode: 'GKERING',
    keperluan: '',
    keterangan: '',
    items: [],
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState('');

  const load = () => fetch('/api/inventory-releases').then((r) => r.json()).then((d) => setList(Array.isArray(d) ? d : []));

  useEffect(() => {
    setUser(getUser());
    load();
  }, []);

  useEffect(() => {
    if (showForm || pickerOpen) {
      fetch('/api/stok/saldo').then((r) => r.json()).then((d) => setProducts(d.rows || []));
    }
  }, [showForm, pickerOpen]);

  const canCreate = CAN_CREATE.includes(user?.role);
  const canApprove = CAN_APPROVE.includes(user?.role);

  const addItem = (p) => {
    if (form.items.find((it) => it.stokId === p.id)) {
      toast.error('Produk sudah ada');
      return;
    }
    setForm({
      ...form,
      items: [...form.items, {
        stokId: p.id,
        kode: p.kode,
        nama: p.nama,
        satuan: p.satuan,
        qty: 1,
        stokAvail: p.stokQty ?? p.stokTotal ?? 0,
      }],
    });
    setPickerOpen(false);
  };

  const save = async (submit = false) => {
    if (!form.keperluan.trim()) { toast.error('Keperluan wajib diisi'); return; }
    if (!form.items.length) { toast.error('Tambah minimal 1 item'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/inventory-releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, submit }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      toast.success(submit ? 'Pengajuan release dikirim ke supervisor' : 'Draft release disimpan');
      setShowForm(false);
      setForm({ lokasiKode: 'GKERING', keperluan: '', keterangan: '', items: [] });
      load();
    } catch (e) {
      toast.error(e.message);
    }
    setSaving(false);
  };

  const action = async (id, type, extra = {}) => {
    const paths = { submit: 'submit', approve: 'approve', reject: 'reject' };
    const res = await fetch(`/api/inventory-releases/${id}/${paths[type]}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(extra),
    });
    const data = await res.json();
    if (!res.ok) { toast.error(data.error || 'Gagal'); return; }
    toast.success(type === 'approve' ? 'Release disetujui — stok dikurangi' : type === 'reject' ? 'Ditolak' : 'Diajukan');
    load();
  };

  const filteredProducts = products.filter((p) => {
    if ((p.gudangKode || 'GKERING') !== form.lokasiKode) return false;
    if ((p.stokQty ?? p.stokTotal ?? 0) <= 0) return false;
    if (!pickerQ) return true;
    const q = pickerQ.toLowerCase();
    return p.nama?.toLowerCase().includes(q) || p.kode?.toLowerCase().includes(q);
  });

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ArrowUpFromLine className="w-6 h-6" /> Release Inventory
            </h1>
            <p className="text-sm text-slate-500">
              Staff gudang mengajukan pengeluaran barang operasional → Supervisor menyetujui & release stok.
            </p>
          </div>
          {canCreate && (
            <Button onClick={() => setShowForm(true)} className="bg-orange-500 hover:bg-orange-600">
              <Plus className="w-4 h-4 mr-1" /> Buat Release
            </Button>
          )}
        </div>
        <OperationalScopeBar />

        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">No. Release</th>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-left">Gudang</th>
                <th className="px-3 py-2 text-left">Keperluan</th>
                <th className="px-3 py-2 text-center">Item</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-left">Dibuat oleh</th>
                <th className="px-3 py-2 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {!list.length && (
                <tr><td colSpan={8} className="text-center py-10 text-slate-400">Belum ada release</td></tr>
              )}
              {list.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{r.noRelease}</td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(r.tanggal)}</td>
                  <td className="px-3 py-2 text-xs">{r.lokasiNama || r.lokasiKode}</td>
                  <td className="px-3 py-2 max-w-[200px] truncate" title={r.keperluan}>{r.keperluan}</td>
                  <td className="px-3 py-2 text-center">{(r.items || []).length}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_STYLE[r.status] || ''}`}>{r.status}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.createdBy?.userName || '—'}</td>
                  <td className="px-3 py-2 text-center space-x-1">
                    {r.status === 'DRAFT' && canCreate && r.createdBy?.userId === user?.id && (
                      <Button size="sm" variant="outline" onClick={() => action(r.id, 'submit')}>
                        <Send className="w-3 h-3 mr-1" /> Ajukan
                      </Button>
                    )}
                    {r.status === 'PENDING_APPROVAL' && canApprove && r.createdBy?.userId !== user?.id && (
                      <>
                        <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => action(r.id, 'approve')}>
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Setujui
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => action(r.id, 'reject', { reason: 'Ditolak supervisor' })}>
                          <XCircle className="w-3 h-3" />
                        </Button>
                      </>
                    )}
                    {r.status === 'PENDING_APPROVAL' && canApprove && user?.role === 'ADMIN' && (
                      <Button size="sm" className="bg-green-600 hover:bg-green-700 ml-1" onClick={() => action(r.id, 'approve')}>
                        Admin Approve
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Buat Release Inventory</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 overflow-y-auto flex-1 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Gudang asal *</Label>
                <Select
                  value={form.lokasiKode}
                  onValueChange={(v) => setForm({ ...form, lokasiKode: v, items: [] })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WAREHOUSES.map((w) => (
                      <SelectItem key={w.kode} value={w.kode}>{w.nama}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Keperluan operasional *</Label>
                <Input
                  value={form.keperluan}
                  onChange={(e) => setForm({ ...form, keperluan: e.target.value })}
                  placeholder="Contoh: Masak menu harian tanggal ..."
                />
              </div>
            </div>
            <div>
              <Label>Catatan</Label>
              <Textarea
                rows={2}
                value={form.keterangan}
                onChange={(e) => setForm({ ...form, keterangan: e.target.value })}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>Item barang</Label>
              <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                <Plus className="w-3 h-3 mr-1" /> Tambah
              </Button>
            </div>
            <div className="space-y-2">
              {form.items.map((it, i) => (
                <div key={it.stokId} className="flex items-center gap-2 border rounded p-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{it.nama}</div>
                    <div className="text-xs text-slate-500">
                      {it.kode} · tersedia: {formatNumber(it.stokAvail ?? 0)} {it.satuan}
                    </div>
                  </div>
                  <Input
                    type="number"
                    min={0}
                    max={it.stokAvail}
                    className="w-24"
                    value={it.qty}
                    onChange={(e) => {
                      const items = [...form.items];
                      items[i] = { ...it, qty: parseFloat(e.target.value) || 0 };
                      setForm({ ...form, items });
                    }}
                  />
                  <Button type="button" size="sm" variant="ghost" onClick={() => setForm({ ...form, items: form.items.filter((_, idx) => idx !== i) })}>
                    Hapus
                  </Button>
                </div>
              ))}
              {!form.items.length && (
                <p className="text-sm text-slate-400 text-center py-4">Belum ada item</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button>
            <Button variant="outline" disabled={saving} onClick={() => save(false)}>Simpan Draft</Button>
            <Button disabled={saving} className="bg-orange-500 hover:bg-orange-600" onClick={() => save(true)}>
              Ajukan ke Supervisor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader><DialogTitle>Pilih Produk — {WAREHOUSES.find((w) => w.kode === form.lokasiKode)?.nama}</DialogTitle></DialogHeader>
          <Input placeholder="Cari..." value={pickerQ} onChange={(e) => setPickerQ(e.target.value)} />
          <div className="overflow-y-auto flex-1 space-y-1">
            {filteredProducts.map((p) => {
              const avail = p.stokQty ?? p.stokTotal ?? 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={avail <= 0}
                  className="w-full text-left border rounded p-2 text-sm hover:bg-slate-50 disabled:opacity-40"
                  onClick={() => addItem(p)}
                >
                  <div className="font-medium">{p.nama}</div>
                  <div className="text-xs text-slate-500">{p.kode} · stok: {formatNumber(avail)} {p.satuan}</div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
