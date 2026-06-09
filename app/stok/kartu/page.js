'use client';

import { useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Receipt, Search, ArrowDown, ArrowUp, Package } from 'lucide-react';
import ListSummaryCards from '@/components/ListSummaryCards';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { formatIDR, formatDate, formatDateTime, formatNumber } from '@/lib/format';
import ListExportMenu from '@/components/ListExportMenu';
import { runListExport } from '@/lib/run-list-export';
import { toast } from 'sonner';

export default function KartuStokPage() {
  const [products, setProducts] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [data, setData] = useState({ rows: [], product: null });
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    fetch('/api/products?limit=500').then(r => r.json()).then(setProducts);
  }, []);

  const load = async (productId) => {
    if (!productId) return;
    setLoading(true);
    const params = new URLSearchParams({ productId });
    if (from) params.append('from', from);
    if (to) params.append('to', to);
    const res = await fetch(`/api/stok/kartu?${params}`);
    const json = await res.json();
    setData(json);
    setLoading(false);
  };

  const pick = (p) => {
    setSelectedProduct(p);
    setShowPicker(false);
    load(p.id);
  };

  const filtered = products.filter(p =>
    !q || p.nama.toLowerCase().includes(q.toLowerCase()) || p.kode.toLowerCase().includes(q.toLowerCase())
  );

  const totalMasuk = data.rows.reduce((s, r) => s + (r.masuk || 0), 0);
  const totalKeluar = data.rows.reduce((s, r) => s + (r.keluar || 0), 0);

  const exportData = async (format) => {
    try {
      const rows = data.rows;
      if (!rows.length) { toast.error('Tidak ada data'); return; }
      const stamp = new Date().toISOString().slice(0, 10);
      const productLabel = selectedProduct ? `${selectedProduct.kode}` : 'produk';
      await runListExport(format, {
        baseName: `kartu-stok-${productLabel}-${stamp}`,
        title: `Kartu Stok${selectedProduct ? ` — ${selectedProduct.kode} ${selectedProduct.nama}` : ''}`,
        columns: [
          { key: 'tanggal', label: 'Tanggal', value: (r) => formatDateTime(r.tanggal) },
          { key: 'noTransaksi', label: 'No. Transaksi' },
          { key: 'keterangan', label: 'Keterangan' },
          { key: 'sourceType', label: 'Sumber' },
          { key: 'masuk', label: 'Masuk', value: (r) => (r.masuk > 0 ? formatNumber(r.masuk) : '-') },
          { key: 'keluar', label: 'Keluar', value: (r) => (r.keluar > 0 ? formatNumber(r.keluar) : '-') },
          { key: 'saldo', label: 'Saldo', value: (r) => formatNumber(r.saldo) },
          { key: 'hargaSatuan', label: 'Harga', value: (r) => formatIDR(r.hargaSatuan) },
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
            <h1 className="text-2xl font-bold flex items-center gap-2"><Receipt className="w-6 h-6" /> Kartu Stok</h1>
            <p className="text-sm text-slate-500">Riwayat mutasi stok per produk dengan saldo berjalan</p>
          </div>
          <ListExportMenu onExport={exportData} disabled={!selectedProduct || loading || data.rows.length === 0} />
        </div>

        <OperationalScopeBar />

        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Produk</label>
            <Button variant="outline" onClick={() => setShowPicker(true)} className="min-w-[280px] justify-start">
              <Search className="w-4 h-4 mr-2" />
              {selectedProduct ? `${selectedProduct.kode} - ${selectedProduct.nama}` : 'Pilih produk...'}
            </Button>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Dari Tanggal</label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-44" />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Sampai</label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-44" />
          </div>
          <Button onClick={() => selectedProduct && load(selectedProduct.id)} disabled={!selectedProduct} className="bg-orange-500 hover:bg-orange-600">
            Tampilkan
          </Button>
        </div>

        {data.product && (
          <ListSummaryCards
            items={[
              { label: 'Stok Saat Ini', value: `${formatNumber(data.product.stok)} ${data.product.satuan}` },
              { label: 'Harga Beli', value: formatIDR(data.product.hargaBeli) },
              { label: 'Total Masuk', value: formatNumber(totalMasuk), valueClassName: 'text-green-600', icon: ArrowDown },
              { label: 'Total Keluar', value: formatNumber(totalKeluar), valueClassName: 'text-red-600', icon: ArrowUp },
            ]}
          />
        )}

        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-600 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left">Tanggal</th>
                  <th className="px-3 py-2 text-left">No. Transaksi</th>
                  <th className="px-3 py-2 text-left">Keterangan</th>
                  <th className="px-3 py-2 text-center">Sumber</th>
                  <th className="px-3 py-2 text-right">Masuk</th>
                  <th className="px-3 py-2 text-right">Keluar</th>
                  <th className="px-3 py-2 text-right">Saldo</th>
                  <th className="px-3 py-2 text-right">Harga</th>
                </tr>
              </thead>
              <tbody>
                {!selectedProduct && (
                  <tr><td colSpan={8} className="text-center py-12 text-slate-400"><Package className="w-10 h-10 mx-auto mb-2 opacity-40" />Pilih produk untuk melihat kartu stok</td></tr>
                )}
                {selectedProduct && loading && <tr><td colSpan={8} className="text-center py-10 text-slate-400">Memuat...</td></tr>}
                {selectedProduct && !loading && data.rows.length === 0 && (
                  <tr><td colSpan={8} className="text-center py-10 text-slate-400">Tidak ada mutasi pada periode ini</td></tr>
                )}
                {data.rows.map((r, i) => (
                  <tr key={i} className="border-t hover:bg-slate-50">
                    <td className="px-3 py-2 text-xs">{formatDateTime(r.tanggal)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.noTransaksi}</td>
                    <td className="px-3 py-2">{r.keterangan}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                        r.sourceType === 'PENJUALAN' ? 'bg-red-50 text-red-700' :
                        r.sourceType === 'PENYESUAIAN' ? 'bg-yellow-50 text-yellow-700' :
                        r.sourceType === 'PRODUKSI' ? 'bg-blue-50 text-blue-700' :
                        'bg-slate-100 text-slate-700'
                      }`}>{r.sourceType}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-green-600 font-mono">{r.masuk > 0 ? formatNumber(r.masuk) : '-'}</td>
                    <td className="px-3 py-2 text-right text-red-600 font-mono">{r.keluar > 0 ? formatNumber(r.keluar) : '-'}</td>
                    <td className="px-3 py-2 text-right font-semibold font-mono">{formatNumber(r.saldo)}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{formatIDR(r.hargaSatuan)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <Dialog open={showPicker} onOpenChange={setShowPicker}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader><DialogTitle>Pilih Produk</DialogTitle></DialogHeader>
          <Input placeholder="Cari kode atau nama..." value={q} onChange={e => setQ(e.target.value)} autoFocus />
          <div className="flex-1 overflow-auto border rounded">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs sticky top-0">
                <tr><th className="px-2 py-2 text-left">Kode</th><th className="px-2 py-2 text-left">Nama</th><th className="px-2 py-2 text-right">Stok</th></tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id} onClick={() => pick(p)} className="border-t cursor-pointer hover:bg-orange-50">
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
    </AppShell>
  );
}
