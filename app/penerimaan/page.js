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

const STATUS_STYLE = {
  DRAFT: 'bg-blue-100 text-blue-800',
  NEEDS_MAPPING: 'bg-amber-100 text-amber-800',
  POSTED: 'bg-green-100 text-green-800',
};

export default function PenerimaanPage() {
  const [list, setList] = useState([]);
  const [posting, setPosting] = useState('');
  const [detail, setDetail] = useState(null);
  const [qtyMap, setQtyMap] = useState({});

  const load = () => fetch('/api/goods-receipts').then((r) => r.json()).then(setList);
  useEffect(() => { load(); }, []);

  const openPost = async (id) => {
    const res = await fetch(`/api/goods-receipts/${id}`);
    const data = await res.json();
    if (!res.ok) { toast.error(data.error || 'Gagal'); return; }
    setDetail(data);
    const init = {};
    for (const it of (data.items || [])) {
      init[it.lineId] = it.qtyOrdered ?? 0;
    }
    setQtyMap(init);
  };

  const postGrn = async () => {
    if (!detail) return;
    setPosting(detail.id);
    const items = (detail.items || []).map((it) => ({
      lineId: it.lineId,
      qty: parseFloat(qtyMap[it.lineId]) || 0,
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
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><PackageCheck className="w-6 h-6" /> Penerimaan Barang (GRN)</h1>
          <p className="text-sm text-slate-500">Webhook delivery.shipped → konfirmasi qty terima → stok masuk + weighted avg harga beli</p>
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
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {!list.length && <tr><td colSpan={6} className="text-center py-10 text-slate-400">Belum ada GRN</td></tr>}
              {(Array.isArray(list) ? list : []).map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{r.noGRN}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.noDO}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.noInvoice || '—'}</td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(r.tanggal)}</td>
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
          <p className="text-xs text-slate-500">DO: {detail?.noDO} · Sesuaikan qty jika partial receipt</p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {(detail?.items || []).map((it) => (
              <div key={it.lineId} className="flex items-center gap-2 text-sm border rounded p-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{it.nama}</div>
                  <div className="text-xs text-slate-500">{it.vendorKode} · kirim: {it.qtyOrdered} {it.satuan}</div>
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
