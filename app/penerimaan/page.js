'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatDateTime, formatIDR, formatNumber } from '@/lib/format';
import { PackageCheck, FileText, Truck, Eye, RefreshCw } from 'lucide-react';
import { warehouseName } from '@/lib/warehouses-client';

const STATUS_STYLE = {
  DRAFT: 'bg-blue-100 text-blue-800',
  UNKNOWN_PRODUCT: 'bg-amber-100 text-amber-800',
  NEEDS_MAPPING: 'bg-amber-100 text-amber-800',
  POSTED: 'bg-green-100 text-green-800',
};

const STATUS_LABEL = {
  DRAFT: 'DRAFT',
  UNKNOWN_PRODUCT: 'Produk belum terdaftar',
  NEEDS_MAPPING: 'Produk belum terdaftar',
  POSTED: 'POSTED',
};

const isUnresolvedGrn = (status) => status === 'UNKNOWN_PRODUCT' || status === 'NEEDS_MAPPING';

function supplierLabel(row) {
  return row?.supplierName || row?.vendorTenantName || row?.vendorName || '—';
}

function itemRowKey(it, idx) {
  return `${it?.lineId || 'line'}-${idx}`;
}

export default function PenerimaanPage() {
  const [list, setList] = useState([]);
  const [posting, setPosting] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [detail, setDetail] = useState(null);
  const [qtyMap, setQtyMap] = useState({});
  const [gudangMap, setGudangMap] = useState({});
  const [doView, setDoView] = useState(null);
  const [loadingDo, setLoadingDo] = useState('');
  const [replayingInvoice, setReplayingInvoice] = useState('');

  const needsInvoiceReplay = (row) => row?.status === 'POSTED' && row?.noDO && !row?.noInvoice;

  const replayInvoice = async (id, noGRN) => {
    setReplayingInvoice(id);
    try {
      const res = await fetch(`/api/goods-receipts/${id}/replay-invoice`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.invoiceSync?.error || 'Gagal buat faktur');
      const inv = data.noInvoice || data.invoiceSync?.noInvoice;
      const hutang = data.invoiceSync?.hutang;
      if (data.invoiceSync?.error) {
        toast.warning(`GRN ${noGRN}: ${data.invoiceSync.error}`);
      } else if (hutang?.hutangId || inv) {
        toast.success(`Faktur ${inv || ''} dibuat — cek Tagihan Vendor (menunggu review)`);
        window.dispatchEvent(new CustomEvent('erp-hutang-change'));
      } else {
        toast.success(`Permintaan faktur untuk ${noGRN} terkirim ke sales.app`);
      }
      load();
    } catch (e) {
      toast.error(e.message);
    }
    setReplayingInvoice('');
  };

  const load = () => fetch('/api/goods-receipts')
    .then((r) => r.json())
    .then((data) => {
      setList(Array.isArray(data) ? data : []);
      window.dispatchEvent(new CustomEvent('erp-grn-change'));
    })
    .catch(() => setList([]));
  useEffect(() => { load(); }, []);

  const openDoView = async (id) => {
    setLoadingDo(id);
    try {
      const res = await fetch(`/api/goods-receipts/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat DO');
      setDoView(data);
    } catch (e) {
      toast.error(e.message);
    }
    setLoadingDo('');
  };

  const doTotal = (g) => (g?.items || []).reduce(
    (s, it) => s + (parseFloat(it.qtyOrdered) || 0) * (parseInt(it.harga || 0, 10) || 0),
    0,
  );

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
    for (const [idx, it] of (data.items || []).entries()) {
      const key = itemRowKey(it, idx);
      initQty[key] = it.qtyOrdered ?? 0;
      initGudang[key] = gudangByStok[it.localStokId] || 'GKERING';
    }
    setQtyMap(initQty);
    setGudangMap(initGudang);
  };

  const postGrn = async () => {
    if (!detail) return;
    setPosting(detail.id);
    const items = (detail.items || []).map((it, idx) => ({
      lineId: it.lineId,
      lineIndex: idx,
      qty: parseFloat(qtyMap[itemRowKey(it, idx)]) || 0,
      lokasiKode: gudangMap[itemRowKey(it, idx)] || 'GKERING',
    })).filter((it) => it.qty > 0);

    const res = await fetch(`/api/goods-receipts/${detail.id}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) toast.error(data.error || 'Gagal');
    else {
      const from = supplierLabel(data);
      const inv = data.noInvoice || data.invoiceSync?.noInvoice;
      if (data.invoiceSync?.error) {
        toast.warning(`Barang diterima dari ${from}, tapi faktur otomatis gagal: ${data.invoiceSync.error}`);
      } else if (data.invoiceSync?.hutang?.hutangId) {
        const inv = data.noInvoice || data.invoiceSync?.noInvoice || data.invoiceSync?.hutang?.noInvoice;
        const approval = data.invoiceSync?.hutang?.approvalStatus;
        const refreshed = data.invoiceSync?.hutang?.action === 'refreshed';
        const isPending = refreshed || !approval || approval === 'PENDING_REVIEW'
          || data.invoiceSync?.hutang?.action === 'created';
        if (isPending) {
          toast.success(`Barang diterima — faktur ${inv} masuk Tagihan Vendor (menunggu review admin)`);
        } else {
          toast.success(`Barang diterima — faktur ${inv} sudah ada di Tagihan Vendor`);
        }
        window.dispatchEvent(new CustomEvent('erp-hutang-change'));
      } else if (data.invoiceSync?.hutang?.error) {
        toast.warning(`Barang diterima, faktur dibuat tapi gagal masuk Tagihan Vendor: ${data.invoiceSync.hutang.error}`);
      } else if (inv) {
        toast.success(`Barang diterima dari ${from} — faktur ${inv} otomatis diposting`);
        window.dispatchEvent(new CustomEvent('erp-hutang-change'));
      } else {
        toast.success(`Barang diterima dari ${from} — stok & harga beli diperbarui`);
      }
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
            <p className="text-xs text-slate-400 mt-0.5">Klik baris untuk lihat detail DO dari supplier sebelum menerima barang</p>
          </div>
          <Button variant="outline" onClick={syncFromSales} disabled={syncing}>
            {syncing ? 'Menarik DO…' : 'Tarik DO dari sales.app'}
          </Button>
        </div>
        <OperationalScopeBar />
        {list.some((r) => isUnresolvedGrn(r.status)) && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
            <strong>{list.filter((r) => isUnresolvedGrn(r.status)).length} GRN</strong>
            {' '}memiliki produk vendor yang belum terdaftar di master produk lokal.
            {' '}Sinkron katalog dari <Link href="/integrasi" className="underline font-medium">Integrasi</Link>
            {' '}atau daftarkan manual di{' '}
            <Link href="/produk" className="underline font-medium">Master Produk</Link>.
          </div>
        )}
        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">No. GRN</th>
                <th className="px-3 py-2 text-left">No. DO</th>
                <th className="px-3 py-2 text-left">Supplier</th>
                <th className="px-3 py-2 text-left">No. Invoice</th>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-left">Gudang</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {!list.length && <tr><td colSpan={8} className="text-center py-10 text-slate-400">Belum ada GRN</td></tr>}
              {(Array.isArray(list) ? list : []).map((r) => (
                <tr
                  key={r.id}
                  className="border-t cursor-pointer hover:bg-slate-50 transition-colors"
                  onClick={() => openDoView(r.id)}
                  title="Klik untuk lihat DO"
                >
                  <td className="px-3 py-2 font-mono text-xs">{r.noGRN}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    <span className="inline-flex items-center gap-1 text-blue-700 underline-offset-2 group-hover:underline">
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      {r.noDO}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs max-w-[140px] truncate" title={supplierLabel(r)}>
                    {supplierLabel(r)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.noInvoice || '—'}</td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(r.tanggal)}</td>
                  <td className="px-3 py-2 text-xs">{r.lokasi || (r.status === 'POSTED' ? '—' : '')}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_STYLE[r.status] || 'bg-slate-100'}`}>
                      {STATUS_LABEL[r.status] || r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => openDoView(r.id)}
                        disabled={loadingDo === r.id}
                        title="Lihat DO"
                        aria-label="Lihat DO"
                        className="p-1.5 rounded text-slate-500 hover:bg-slate-100 hover:text-blue-700 disabled:opacity-50"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      {r.status === 'DRAFT' && (
                        <Button size="sm" onClick={() => openPost(r.id)} disabled={posting === r.id}>
                          Terima Barang
                        </Button>
                      )}
                      {needsInvoiceReplay(r) && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-orange-700 border-orange-300 hover:bg-orange-50"
                          disabled={replayingInvoice === r.id}
                          title="Buat ulang faktur di sales.app dan masukkan ke Tagihan Vendor"
                          onClick={() => replayInvoice(r.id, r.noGRN)}
                        >
                          <RefreshCw className={`w-3.5 h-3.5 mr-1 ${replayingInvoice === r.id ? 'animate-spin' : ''}`} />
                          Buat faktur
                        </Button>
                      )}
                      {r.status === 'POSTED' && r.noInvoice && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-slate-600"
                          disabled={replayingInvoice === r.id}
                          title="Sinkron ulang faktur dari sales.app"
                          onClick={() => replayInvoice(r.id, r.noGRN)}
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${replayingInvoice === r.id ? 'animate-spin' : ''}`} />
                        </Button>
                      )}
                      {isUnresolvedGrn(r.status) && (
                        <Link href="/produk" className="text-amber-700 text-xs underline">Daftar di Master Produk</Link>
                      )}
                    </div>
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
          <p className="text-xs text-slate-500">
            DO: {detail?.noDO}
            {supplierLabel(detail) !== '—' ? ` · Supplier: ${supplierLabel(detail)}` : ''}
            {' · '}Gudang mengikuti master produk (Kering/Basah tidak bisa dicampur)
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {(detail?.items || []).map((it, idx) => {
              const rowKey = itemRowKey(it, idx);
              return (
              <div key={rowKey} className="flex flex-wrap items-end gap-2 text-sm border rounded p-2">
                <div className="flex-1 min-w-[140px]">
                  <div className="font-medium truncate">{it.localNama || it.vendorNama || it.nama}</div>
                  <div className="text-xs text-slate-500">{it.vendorKode} · kirim: {it.qtyOrdered} {it.satuan}</div>
                </div>
                <div className="w-36">
                  <Label className="text-xs">Gudang</Label>
                  <div className={`h-9 px-3 flex items-center rounded-md border text-xs font-medium ${
                    (gudangMap[rowKey] || 'GKERING') === 'GBASAH'
                      ? 'bg-blue-50 text-blue-800 border-blue-200'
                      : 'bg-amber-50 text-amber-800 border-amber-200'
                  }`}>
                    {warehouseName(gudangMap[rowKey] || 'GKERING')}
                  </div>
                </div>
                <div className="w-24">
                  <Label className="text-xs">Qty terima</Label>
                  <Input
                    type="number"
                    min={0}
                    max={it.qtyOrdered}
                    step="any"
                    value={qtyMap[rowKey] ?? ''}
                    onChange={(e) => setQtyMap({ ...qtyMap, [rowKey]: e.target.value })}
                  />
                </div>
              </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>Batal</Button>
            <Button onClick={postGrn} disabled={!!posting} className="bg-orange-500 hover:bg-orange-600">
              {posting ? 'Memproses...' : 'Konfirmasi Terima'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!doView} onOpenChange={(o) => !o && setDoView(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="w-5 h-5 text-orange-500" />
              Surat Jalan / DO — {doView?.noDO}
            </DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-slate-50/70 p-3 text-sm">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">No. DO</p>
              <p className="font-mono font-medium">{doView?.noDO || '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">No. SO (sales.app)</p>
              <p className="font-mono font-medium">{doView?.noSO || '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">No. PO</p>
              <p className="font-mono font-medium">{doView?.noPO || '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Supplier (tenant vendor)</p>
              <p className="font-medium">{supplierLabel(doView)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">No. Invoice</p>
              <p className="font-mono font-medium">{doView?.noInvoice || '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Tanggal kirim</p>
              <p className="font-medium">{doView?.tanggal ? formatDateTime(doView.tanggal) : '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Status</p>
              <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_STYLE[doView?.status] || 'bg-slate-100'}`}>
                {STATUS_LABEL[doView?.status] || doView?.status}
              </span>
            </div>
          </div>

          <div className="border rounded-lg overflow-hidden mt-1">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-600 uppercase">
                <tr>
                  <th className="px-2 py-1.5 text-left">Kode</th>
                  <th className="px-2 py-1.5 text-left">Produk</th>
                  <th className="px-2 py-1.5 text-right">Qty kirim</th>
                  <th className="px-2 py-1.5 text-center">Satuan</th>
                  <th className="px-2 py-1.5 text-right">Harga</th>
                  <th className="px-2 py-1.5 text-right">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {(doView?.items || []).map((it, idx) => (
                  <tr
                    key={itemRowKey(it, idx)}
                    className={`border-t border-slate-100 ${!it.localStokId ? 'bg-amber-50' : ''}`}
                  >
                    <td className="px-2 py-1.5 font-mono">{it.vendorKode || it.localKode || '—'}</td>
                    <td className="px-2 py-1.5">{it.localNama || it.vendorNama || it.nama}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(it.qtyOrdered)}</td>
                    <td className="px-2 py-1.5 text-center text-slate-500">{it.satuan || '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{it.harga ? formatIDR(it.harga) : '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {it.harga ? formatIDR((parseFloat(it.qtyOrdered) || 0) * (parseInt(it.harga || 0, 10) || 0)) : '—'}
                    </td>
                  </tr>
                ))}
                {!(doView?.items || []).length && (
                  <tr><td colSpan={6} className="text-center py-6 text-slate-400">Tidak ada item</td></tr>
                )}
              </tbody>
              {doTotal(doView) > 0 && (
                <tfoot>
                  <tr className="border-t bg-slate-50 font-semibold">
                    <td colSpan={5} className="px-2 py-1.5 text-right">Total nilai DO</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatIDR(doTotal(doView))}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDoView(null)}>Tutup</Button>
            {doView?.status === 'POSTED' && doView?.noDO && (
              <Button
                variant="outline"
                className="text-orange-700 border-orange-300"
                disabled={replayingInvoice === doView.id}
                onClick={() => replayInvoice(doView.id, doView.noGRN)}
              >
                <RefreshCw className={`w-4 h-4 mr-1 ${replayingInvoice === doView.id ? 'animate-spin' : ''}`} />
                {doView.noInvoice ? 'Sinkron ulang faktur' : 'Buat faktur vendor'}
              </Button>
            )}
            {doView?.status === 'DRAFT' && (
              <Button
                className="bg-orange-500 hover:bg-orange-600"
                onClick={() => {
                  const id = doView.id;
                  setDoView(null);
                  openPost(id);
                }}
              >
                <PackageCheck className="w-4 h-4 mr-1" />
                Terima Barang
              </Button>
            )}
            {isUnresolvedGrn(doView?.status) && (
              <Link href="/produk">
                <Button className="bg-amber-500 hover:bg-amber-600">Daftar produk di Master</Button>
              </Link>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
