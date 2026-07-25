'use client';

import { str, num, asArray, asObject, type JsonObject } from '@/types/json';
import type { SessionUser } from '@/types/auth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { FileEdit, Plus, Search, Trash2, Save, X, Eye } from 'lucide-react';
import { formatNumber, formatDateTime } from '@/lib/format';
import { useSessionUser } from '@/lib/hooks/use-session-user';
import ListExportMenu from '@/components/ListExportMenu';
import ProductPickerSearch from '@/components/ProductPickerSearch';
import LineUomSelect from '@/components/uom/LineUomSelect';
import { fetchDefaultProductUom } from '@/lib/hooks/use-product-uoms';
import { usePrimeLineItemUoms } from '@/lib/hooks/use-prime-line-uoms';
import { lineUomKey, qtyInUom } from '@/lib/uom/line-ui';
import type { ProductUom } from '@/lib/uom/types';
import { runListExport, type ListExportFormat } from '@/lib/run-list-export';
import { flattenPenyesuaianDocLines } from '@/lib/export/flatten-doc-lines';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { queryKeys } from '@/lib/query-keys';

const STOCK_ADJUST_ROLES = ['SUPERVISOR', 'ADMIN', 'MASTER'];

export default function PenyesuaianPage() {
  const user = useSessionUser();
  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState<JsonObject | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [keterangan, setKeterangan] = useState('');
  const [items, setItems] = useState<JsonObject[]>([]);
  const [saving, setSaving] = useState(false);

  usePrimeLineItemUoms(showForm, items.map((it) => str(it.stokId)));

  const { data: listData = [] } = useApiQuery<JsonObject[]>(
    queryKeys.penyesuaian.list,
    '/api/stok/penyesuaian',
  );

  const list = Array.isArray(listData) ? listData : [];

  const saveMutation = useApiMutation<
    { keterangan: string; userId?: string; userName?: string; items: { stokId: string; kode: string; qtyAktual: number }[] },
    { noPenyesuaian?: string; error?: string }
  >([queryKeys.penyesuaian.all, queryKeys.products.all]);

  const openNew = () => {
    setItems([]); setKeterangan(''); setShowForm(true);
  };

  const addProduct = async (p: JsonObject) => {
    const id = str(p.id);
    const defaultUom = await fetchDefaultProductUom(id);
    const uomId = defaultUom?.id || '';
    if (items.find((it) => lineUomKey(str(it.stokId), str(it.uomId)) === lineUomKey(id, uomId))) {
      toast.error('Produk sudah ada di daftar');
      return;
    }
    const gudangKode = str(p.gudangKode, 'GKERING').toUpperCase();
    const stokByWarehouse = asObject(p.stokByWarehouse);
    const qtySistemBase = num(stokByWarehouse[gudangKode] ?? 0);
    const qtyDisplay = qtyInUom(qtySistemBase, defaultUom);
    setItems([...items, {
      stokId: p.id, kode: p.kode, nama: p.nama,
      uomId, satuan: defaultUom?.satuan || p.satuan,
      gudangKode, qtySistemBase, qtySistem: qtyDisplay, qtyAktual: qtyDisplay,
    }]);
    setShowPicker(false);
  };

  const updateItemUom = (idx: number, uom: ProductUom) => {
    setItems(items.map((it, i) => {
      if (i !== idx) return it;
      const base = num(it.qtySistemBase ?? it.qtySistem);
      const display = qtyInUom(base, uom);
      return { ...it, uomId: uom.id, satuan: uom.satuan, qtySistem: display, qtyAktual: display };
    }));
  };

  const updateAktual = (idx: number, val: string) => {
    setItems(items.map((it, i) => i === idx ? { ...it, qtyAktual: parseFloat(val || '0') } : it));
  };
  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  const save = async () => {
    if (items.length === 0) { toast.error('Belum ada item'); return; }
    setSaving(true);
    try {
      const data = await saveMutation.mutateAsync({
        url: '/api/stok/penyesuaian',
        body: {
          keterangan,
          userId: user?.id,
          userName: user?.name,
          items: items.map(it => ({
            stokId: str(it.stokId),
            kode: str(it.kode),
            qtyAktual: num(it.qtyAktual),
            uomId: str(it.uomId),
            satuan: str(it.satuan),
          })),
        },
      });
      toast.success(`Penyesuaian ${str(data.noPenyesuaian)} berhasil`);
      setShowForm(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    setSaving(false);
  };

  const exportData = async (format: ListExportFormat) => {
    try {
      const rows = list;
      if (!rows.length) { toast.error('Tidak ada data'); return; }
      const flat = flattenPenyesuaianDocLines(rows);
      const stamp = new Date().toISOString().slice(0, 10);
      await runListExport(format, {
        baseName: `penyesuaian-stok-${stamp}`,
        title: 'Penyesuaian Stok',
        columns: [
          { key: 'tanggal', label: 'Tanggal', value: (r) => formatDateTime(str(r.tanggal)) },
          { key: 'noPenyesuaian', label: 'No.' },
          { key: 'keterangan', label: 'Keterangan', value: (r) => str(r.keterangan) || '-' },
          { key: 'userName', label: 'User', value: (r) => str(r.userName) || '-' },
          { key: 'itemKode', label: 'Kode' },
          { key: 'itemNama', label: 'Nama' },
          { key: 'itemSatuan', label: 'Satuan' },
          { key: 'itemQtySistem', label: 'Qty Sistem' },
          { key: 'itemQtyAktual', label: 'Qty Aktual' },
          { key: 'itemSelisih', label: 'Selisih (base)' },
        ],
        rows: flat,
      });
      toast.success(`${flat.length} baris diekspor`);
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const canAdjust = STOCK_ADJUST_ROLES.includes(str(user?.role));

  if (user && !canAdjust) {
    return (
      <div className="p-8 text-center text-slate-500">
          <FileEdit className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium text-slate-700">Akses ditolak</p>
          <p className="text-sm mt-1">Penyesuaian stok hanya untuk Supervisor dan Admin.</p>
        </div>
    );
  }

  return (
    <>
    <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><FileEdit className="w-6 h-6" /> Penyesuaian Stok</h1>
            <p className="text-sm text-slate-500">Stock opname: sinkronkan stok + FG batch (W2-4) + ingredient lots (W2-8)</p>
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
                <tr key={str(d.id)} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2 text-xs">{formatDateTime(str(d.tanggal))}</td>
                  <td className="px-3 py-2 font-mono text-xs">{str(d.noPenyesuaian)}</td>
                  <td className="px-3 py-2">{str(d.keterangan) || '-'}</td>
                  <td className="px-3 py-2 text-xs">{str(d.userName) || '-'}</td>
                  <td className="px-3 py-2 text-right">{asArray(d.items).length}</td>
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
                    <th className="px-2 py-2 text-left">Gudang</th>
                    <th className="px-2 py-2 text-right">Qty Sistem</th>
                    <th className="px-2 py-2 text-right">Qty Aktual</th>
                    <th className="px-2 py-2 text-center">Satuan</th>
                    <th className="px-2 py-2 text-right">Selisih</th>
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && <tr><td colSpan={8} className="text-center py-6 text-slate-400 text-xs">Belum ada item</td></tr>}
                  {items.map((it, i) => {
                    const selisih = num(it.qtyAktual) - num(it.qtySistem);
                    return (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-2 font-mono text-xs">{str(it.kode)}</td>
                        <td className="px-2 py-2">{str(it.nama)}</td>
                        <td className="px-2 py-2 text-xs text-slate-600">{str(it.gudangKode) || '-'}</td>
                        <td className="px-2 py-2 text-right font-mono">{formatNumber(num(it.qtySistem))} {str(it.satuan)}</td>
                        <td className="px-2 py-2 text-right">
                          <input type="number" value={num(it.qtyAktual)} onChange={e => updateAktual(i, e.target.value)} className="w-24 border rounded px-2 py-1 text-right" step="0.01" />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <LineUomSelect stokId={str(it.stokId)} uomId={str(it.uomId)} onChange={(uom) => updateItemUom(i, uom)} />
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
          <ProductPickerSearch open={showPicker} withWarehouseStock onSelect={addProduct} />
        </DialogContent>
      </Dialog>

      {/* Detail */}
      <Dialog open={!!detail} onOpenChange={() => setDetail(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Detail Penyesuaian {str(detail?.noPenyesuaian)}</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="bg-slate-50 rounded p-3 text-sm">
                <div>Tanggal: {formatDateTime(str(detail.tanggal))}</div>
                <div>Keterangan: {str(detail.keterangan) || '-'}</div>
                <div>Oleh: {str(detail.userName) || '-'}</div>
              </div>
              <table className="w-full text-sm border">
                <thead className="bg-slate-100 text-xs">
                  <tr>
                    <th className="px-2 py-2 text-left">Kode</th>
                    <th className="px-2 py-2 text-left">Nama</th>
                    <th className="px-2 py-2 text-center">Sat</th>
                    <th className="px-2 py-2 text-right">Sistem</th>
                    <th className="px-2 py-2 text-right">Aktual</th>
                    <th className="px-2 py-2 text-right">Selisih (base)</th>
                  </tr>
                </thead>
                <tbody>
                  {asArray(detail.items).map((raw, i) => {
                    const it = asObject(raw);
                    const itemSelisih = num(it.selisih);
                    return (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-2 font-mono text-xs">{str(it.kode)}</td>
                      <td className="px-2 py-2">{str(it.nama)}</td>
                      <td className="px-2 py-2 text-center text-xs uppercase">{str(it.satuan) || '—'}</td>
                      <td className="px-2 py-2 text-right">{formatNumber(num(it.qtySistem))}</td>
                      <td className="px-2 py-2 text-right">{formatNumber(num(it.qtyEntered ?? it.qtyAktual))}</td>
                      <td className={`px-2 py-2 text-right font-semibold ${itemSelisih > 0 ? 'text-green-600' : itemSelisih < 0 ? 'text-red-600' : ''}`}>
                        {itemSelisih > 0 ? '+' : ''}{formatNumber(itemSelisih)}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
