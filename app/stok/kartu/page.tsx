'use client';

import { str, num, asObject, asArray, type JsonObject } from '@/types/json';
import { useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Receipt, Search, ArrowDown, ArrowUp, Package } from 'lucide-react';
import ListSummaryCards from '@/components/ListSummaryCards';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { formatIDR, formatDate, formatDateTime, formatNumber } from '@/lib/format';
import ListExportMenu from '@/components/ListExportMenu';
import { runListExport, type ListExportFormat } from '@/lib/run-list-export';
import { toast } from 'sonner';
import ProductPickerSearch from '@/components/ProductPickerSearch';

export default function KartuStokPage() {
  const [selectedProduct, setSelectedProduct] = useState<JsonObject | null>(null);
  const [data, setData] = useState<{ rows: JsonObject[]; product: JsonObject | null; ledgerSaldo: number | null }>({
    rows: [], product: null, ledgerSaldo: null,
  });
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reconciling, setReconciling] = useState(false);

  const load = async (productId: string) => {
    if (!productId) return;
    setLoading(true);
    const params = new URLSearchParams({ productId });
    if (from) params.append('from', from);
    if (to) params.append('to', to);
    const res = await fetch(`/api/stok/kartu?${params}`);
    const json = asObject(await res.json());
    setData({
      rows: asArray(json.rows) as JsonObject[],
      product: json.product ? asObject(json.product) : null,
      ledgerSaldo: json.ledgerSaldo != null ? num(json.ledgerSaldo) : null,
    });
    setLoading(false);
  };

  const pick = (p: JsonObject) => {
    setSelectedProduct(p);
    setShowPicker(false);
    load(str(p.id));
  };

  const totalMasuk = data.rows.reduce((s, r) => s + num(r.masuk), 0);
  const totalKeluar = data.rows.reduce((s, r) => s + num(r.keluar), 0);
  const saldoKartu = data.rows.length
    ? num(data.rows[data.rows.length - 1].saldo)
    : (data.ledgerSaldo ?? num(data.product?.stok));
  const stokMismatch = data.product
    && data.ledgerSaldo != null
    && Math.abs(num(data.product.stok) - data.ledgerSaldo) > 1e-9;

  const reconcile = async () => {
    if (!selectedProduct) return;
    setReconciling(true);
    try {
      const res = await fetch('/api/stok/kartu/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: str(selectedProduct.id) }),
      });
      const json = asObject(await res.json());
      if (!res.ok) throw new Error(str(json.error, 'Gagal sinkronisasi'));
      toast.success(`Stok master disamakan ke ${formatNumber(num(json.ledgerSaldo))} ${str(selectedProduct.satuan)}`);
      load(str(selectedProduct.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setReconciling(false);
  };

  const exportData = async (format: ListExportFormat) => {
    try {
      const rows = data.rows;
      if (!rows.length) { toast.error('Tidak ada data'); return; }
      const stamp = new Date().toISOString().slice(0, 10);
      const productLabel = selectedProduct ? str(selectedProduct.kode) : 'produk';
      await runListExport(format, {
        baseName: `kartu-stok-${productLabel}-${stamp}`,
        title: `Kartu Stok${selectedProduct ? ` — ${str(selectedProduct.kode)} ${str(selectedProduct.nama)}` : ''}`,
        columns: [
          { key: 'tanggal', label: 'Tanggal', value: (r) => formatDateTime(str(r.tanggal)) },
          { key: 'noTransaksi', label: 'No. Transaksi' },
          { key: 'keterangan', label: 'Keterangan' },
          { key: 'sourceType', label: 'Sumber' },
          { key: 'masuk', label: 'Masuk', value: (r) => (num(r.masuk) > 0 ? formatNumber(num(r.masuk)) : '-') },
          { key: 'keluar', label: 'Keluar', value: (r) => (num(r.keluar) > 0 ? formatNumber(num(r.keluar)) : '-') },
          { key: 'saldo', label: 'Saldo', value: (r) => formatNumber(num(r.saldo)) },
          { key: 'hargaSatuan', label: 'Harga', value: (r) => formatIDR(num(r.hargaSatuan)) },
        ],
        rows,
      });
      toast.success(`${rows.length} baris diekspor`);
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
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
              {selectedProduct ? `${str(selectedProduct.kode)} - ${str(selectedProduct.nama)}` : 'Pilih produk...'}
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
          <Button onClick={() => selectedProduct && load(str(selectedProduct.id))} disabled={!selectedProduct} className="bg-orange-500 hover:bg-orange-600">
            Tampilkan
          </Button>
        </div>

        {data.product && (
          <>
            {stokMismatch && (
              <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                <span>
                  Stok master ({formatNumber(num(data.product.stok))}) tidak sama dengan saldo kartu ({formatNumber(data.ledgerSaldo)}).
                  Biasanya terjadi jika penyesuaian tercatat di gudang yang salah.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-amber-300 shrink-0"
                  onClick={reconcile}
                  disabled={reconciling}
                >
                  {reconciling ? 'Menyinkronkan...' : 'Samakan stok master'}
                </Button>
              </div>
            )}
            <ListSummaryCards
              items={[
                {
                  label: 'Saldo Kartu Stok',
                  value: `${formatNumber(saldoKartu)} ${str(data.product.satuan)}`,
                },
                { label: 'Harga Beli', value: formatIDR(num(data.product.hargaBeli)) },
                { label: 'Total Masuk', value: formatNumber(totalMasuk), valueClassName: 'text-green-600', icon: ArrowDown },
                { label: 'Total Keluar', value: formatNumber(totalKeluar), valueClassName: 'text-red-600', icon: ArrowUp },
              ]}
            />
          </>
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
                    <td className="px-3 py-2 text-xs">{formatDateTime(str(r.tanggal))}</td>
                    <td className="px-3 py-2 font-mono text-xs">{str(r.noTransaksi)}</td>
                    <td className="px-3 py-2">{str(r.keterangan)}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                        str(r.sourceType) === 'PENJUALAN' ? 'bg-red-50 text-red-700' :
                        str(r.sourceType) === 'PENYESUAIAN' ? 'bg-yellow-50 text-yellow-700' :
                        str(r.sourceType) === 'PRODUKSI' ? 'bg-blue-50 text-blue-700' :
                        'bg-slate-100 text-slate-700'
                      }`}>{str(r.sourceType)}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-green-600 font-mono">{num(r.masuk) > 0 ? formatNumber(num(r.masuk)) : '-'}</td>
                    <td className="px-3 py-2 text-right text-red-600 font-mono">{num(r.keluar) > 0 ? formatNumber(num(r.keluar)) : '-'}</td>
                    <td className="px-3 py-2 text-right font-semibold font-mono">{formatNumber(num(r.saldo))}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{formatIDR(num(r.hargaSatuan))}</td>
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
          <ProductPickerSearch open={showPicker} onSelect={pick} />
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
