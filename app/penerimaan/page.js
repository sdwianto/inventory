'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/format';
import { PackageCheck } from 'lucide-react';
import { warehouseName } from '@/lib/warehouses-client';

const STATUS_STYLE = {
  DRAFT: 'bg-blue-100 text-blue-800',
  NEEDS_MAPPING: 'bg-amber-100 text-amber-800',
  POSTED: 'bg-green-100 text-green-800',
};

export default function PenerimaanPage() {
  const [list, setList] = useState([]);
  const [posting, setPosting] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [detail, setDetail] = useState(null);
  const [qtyMap, setQtyMap] = useState({});
  const [gudangMap, setGudangMap] = useState({});

  const load = () => fetch('/api/goods-receipts').then((r) => r.json()).then(setList);
  useEffect(() => { load(); }, []);

  const syncFromSales = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/goods-receipts/sync-shipped', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal sync');
      toast.success(`Sync DO: ${data.created} GRN baru, ${data.existing} sudah ada`);
      load();
    } catch (e) {
      toast.error(e.message);
    }
    setSyncing(false);
  };

  const openPost = async (id) => {
    const res = await fetch(`/api/goods-receipts/${id}`);
    const data = await res.json();
    if (!res.ok) { toast.error(data.error || 'Gagal'); return; }
    setDetail(data);
    const prodRes = await fetch('/api/products?limit=5000');
    const products = await prodRes.json();
    const gudangByStok = Object.fromEntries(
      (Array.isArray(products) ? products : []).map((p) => [p.id, p.gudangKode || 'GKERING']),
    );
    const initQty = {};
    const initGudang = {};
    for (const it of (data.items || [])) {
      initQty[it.lineId] = it.qtyOrdered ?? 0;
      initGudang[it.lineId] = gudangByStok[it.localStokId] || 'GKERING';
    }
    setQtyMap(initQty);
    setGudangMap(initGudang);
  };

  const postGrn = async () => {
    if (!detail) return;
    setPosting(detail.id);
    const items = (detail.items || []).map((it) => ({
      lineId: it.lineId,
      qty: parseFloat(qtyMap[it.lineId]) || 0,
      lokasiKode: gudangMap[it.lineId] || 'GKERING',
    })).filter((it) => it.qty > 0);

    const res = await fetch(`/api/goods-receipts/${detail.id}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) toast.error(data.error || 'Gagal');
    else {
      toast.success('Barang diterima — stok & harga beli diperbarui');
      setDetail(null);
      load();
    }
    setPosting('');
  };

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><PackageCheck className="w-6 h-6" /> Penerimaan Barang (GRN)</h1>
            <p className="text-sm text-slate-500">DO SHIPPED dari sales.app → GRN otomatis via webhook, atau tarik manual jika webhook terlewat</p>
          </div>
          <Button variant="outline" onClick={syncFromSales} disabled={syncing}>
            {syncing ? 'Menarik DO…' : 'Tarik DO dari sales.app'}
          </Button>
        </div>
        <OperationalScopeBar />
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">No. GRN</th>
                <th className="px-3 py-2 text-left">No. DO</th>
                <th className="px-3 py-2 text-left">No. Invoice</th>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-left">Gudang</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {!list.length && <tr><td colSpan={7} className="text-center py-10 text-slate-400">Belum ada GRN</td></tr>}
              {(Array.isArray(list) ? list : []).map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{r.noGRN}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.noDO}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.noInvoice || '—'}</td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(r.tanggal)}</td>
                  <td className="px-3 py-2 text-xs">{r.lokasi || (r.status === 'POSTED' ? '—' : '')}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_STYLE[r.status] || 'bg-slate-100'}`}>{r.status}</span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {r.status === 'DRAFT' && (
                      <Button size="sm" onClick={() => openPost(r.id)} disabled={posting === r.id}>
                        Terima Barang
                      </Button>
                    )}
                    {r.status === 'NEEDS_MAPPING' && (
                      <a href="/mapping" className="text-amber-700 text-xs underline">Mapping dulu</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Terima Barang — {detail?.noGRN}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-slate-500">DO: {detail?.noDO} · Gudang mengikuti master produk (Kering/Basah tidak bisa dicampur)</p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {(detail?.items || []).map((it) => (
              <div key={it.lineId} className="flex flex-wrap items-end gap-2 text-sm border rounded p-2">
                <div className="flex-1 min-w-[140px]">
                  <div className="font-medium truncate">{it.localNama || it.vendorNama || it.nama}</div>
                  <div className="text-xs text-slate-500">{it.vendorKode} · kirim: {it.qtyOrdered} {it.satuan}</div>
                </div>
                <div className="w-36">
                  <Label className="text-xs">Gudang</Label>
                  <div className={`h-9 px-3 flex items-center rounded-md border text-xs font-medium ${
                    (gudangMap[it.lineId] || 'GKERING') === 'GBASAH'
                      ? 'bg-blue-50 text-blue-800 border-blue-200'
                      : 'bg-amber-50 text-amber-800 border-amber-200'
                  }`}>
                    {warehouseName(gudangMap[it.lineId] || 'GKERING')}
                  </div>
                </div>
                <div className="w-24">
                  <Label className="text-xs">Qty terima</Label>
                  <Input
                    type="number"
                    min={0}
                    max={it.qtyOrdered}
                    step="any"
                    value={qtyMap[it.lineId] ?? ''}
                    onChange={(e) => setQtyMap({ ...qtyMap, [it.lineId]: e.target.value })}
                  />
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>Batal</Button>
            <Button onClick={postGrn} disabled={!!posting} className="bg-orange-500 hover:bg-orange-600">
              {posting ? 'Memproses...' : 'Konfirmasi Terima'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
