'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asObject, asArray } from '@/types/json';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import VirtualTableBody from '@/components/VirtualTableBody';
import { TableSkeleton } from '@/components/TableSkeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatDateTime, formatIDR, formatNumber } from '@/lib/format';
import { PackageCheck, FileText, Truck, Eye, RefreshCw, Loader2 } from 'lucide-react';
import { warehouseName } from '@/lib/warehouses-client';
import {
  useGoodsReceipts,
  useGrnInvoiceStatus,
  useInvalidateGrn,
  GRN_QUERY_KEY,
} from '@/lib/hooks/use-goods-receipts';

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

const isUnresolvedGrn = (status: string) => status === 'UNKNOWN_PRODUCT' || status === 'NEEDS_MAPPING';

function supplierLabel(row: JsonObject | null | undefined) {
  return str(row?.supplierName) || str(row?.vendorTenantName) || str(row?.vendorName) || '—';
}

function itemRowKey(it: JsonObject | undefined, idx: number) {
  return `${it?.lineId || 'line'}-${idx}`;
}

function invoiceSyncLabel(row: JsonObject) {
  if (row?.invoiceSyncStatus === 'PENDING' || row?.invoiceSyncStatus === 'SYNCING') {
    return <span className="inline-flex items-center gap-1 text-blue-600 text-xs"><Loader2 className="w-3 h-3 animate-spin" /> Sync faktur…</span>;
  }
  if (row?.invoiceSyncStatus === 'FAILED') {
    return <span className="text-red-600 text-xs" title={str(row.invoiceSyncError)}>Gagal faktur</span>;
  }
  return str(row?.noInvoice) || '—';
}

const needsInvoiceReplay = (row: JsonObject): boolean => Boolean(
  row?.status === 'POSTED' && row?.noDO && (
    !row?.noInvoice
    || row?.invoiceSyncStatus === 'FAILED'
    || row?.invoiceSyncStatus === 'PENDING'
  ),
);

export default function PenerimaanPage() {
  const queryClient = useQueryClient();
  const invalidateGrn = useInvalidateGrn();
  const { data: list = [], isLoading } = useGoodsReceipts();
  const [posting, setPosting] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [detail, setDetail] = useState<JsonObject | null>(null);
  const [qtyMap, setQtyMap] = useState<JsonObject>({});
  const [gudangMap, setGudangMap] = useState<JsonObject>({});
  const [doView, setDoView] = useState<JsonObject | null>(null);
  const [loadingDo, setLoadingDo] = useState('');
  const [replayingInvoice, setReplayingInvoice] = useState('');
  const [pollInvoiceGrnId, setPollInvoiceGrnId] = useState<string | null>(null);

  const { data: invoicePoll } = useGrnInvoiceStatus(pollInvoiceGrnId, !!pollInvoiceGrnId);

  useEffect(() => {
    if (!invoicePoll || !pollInvoiceGrnId) return;
    const poll = invoicePoll as JsonObject;
    const s = str(poll.invoiceSyncStatus);
    if (s === 'DONE') {
      toast.success(`Faktur ${str(poll.noInvoice)} siap — cek Tagihan Vendor`);
      setPollInvoiceGrnId(null);
      invalidateGrn();
      window.dispatchEvent(new CustomEvent('erp-hutang-change'));
    } else if (s === 'FAILED') {
      toast.warning(`Faktur gagal: ${str(poll.invoiceSyncError, 'cek sales.app')}`);
      setPollInvoiceGrnId(null);
      invalidateGrn();
    } else if (s === 'SKIPPED') {
      setPollInvoiceGrnId(null);
      invalidateGrn();
    }
  }, [invoicePoll, pollInvoiceGrnId, invalidateGrn]);

  const replayInvoice = async (id: string, noGRN?: unknown) => {
    setReplayingInvoice(id);
    try {
      const res = await fetch(`/api/goods-receipts/${id}/replay-invoice`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal buat faktur');
      toast.success(`Faktur ${noGRN} — diproses di background`);
      setPollInvoiceGrnId(id);
      invalidateGrn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setReplayingInvoice('');
  };

  const syncFromSales = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/goods-receipts/sync-shipped', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal sync');
      toast.success(`Sync DO: ${data.created} GRN baru, ${data.existing} sudah ada`);
      await queryClient.fetchQuery({
        queryKey: [...GRN_QUERY_KEY, { refreshProducts: true }],
        queryFn: () => fetch(`/api/goods-receipts?refreshProducts=1`).then((r) => r.json()),
      });
      queryClient.setQueryData([...GRN_QUERY_KEY, { refreshProducts: false }], (old) => {
        const fresh = queryClient.getQueryData([...GRN_QUERY_KEY, { refreshProducts: true }]);
        return Array.isArray(fresh) ? fresh : old;
      });
      invalidateGrn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setSyncing(false);
  };

  const openDoView = async (id: string) => {
    setLoadingDo(id);
    try {
      const res = await fetch(`/api/goods-receipts/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat DO');
      setDoView(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setLoadingDo('');
  };

  const doTotal = (g: JsonObject | null | undefined) => (asArray(g?.items) as JsonObject[]).reduce(
    (s, it) => s + num(it.qtyOrdered) * (parseInt(str(it.harga), 10) || 0),
    0,
  );

  const openPost = async (id: string) => {
    const res = await fetch(`/api/goods-receipts/${id}`);
    const data = await res.json();
    if (!res.ok) { toast.error(data.error || 'Gagal'); return; }
    setDetail(data);
    const prodRes = await fetch('/api/products?limit=5000');
    const products = await prodRes.json();
    const gudangByStok = Object.fromEntries(
      (Array.isArray(products) ? products : []).map((p) => [p.id, p.gudangKode || 'GKERING']),
    );
    const initQty: JsonObject = {};
    const initGudang: JsonObject = {};
    const detailItems = asArray(data.items) as JsonObject[];
    for (const [idx, it] of detailItems.entries()) {
      const key = itemRowKey(it, idx);
      initQty[key] = it.qtyOrdered ?? 0;
      initGudang[key] = gudangByStok[str(it.localStokId)] || 'GKERING';
    }
    setQtyMap(initQty);
    setGudangMap(initGudang);
  };

  const postGrn = async () => {
    if (!detail) return;
    const grnId = str(detail.id);
    setPosting(grnId);
    const detailItems = asArray(detail.items) as JsonObject[];
    const items = detailItems.map((it, idx) => ({
      lineId: it.lineId,
      lineIndex: idx,
      qty: num(qtyMap[itemRowKey(it, idx)]),
      lokasiKode: str(gudangMap[itemRowKey(it, idx)], 'GKERING'),
    })).filter((it) => it.qty > 0);

    queryClient.setQueryData([...GRN_QUERY_KEY, { refreshProducts: false }], (old) => (
      Array.isArray(old)
        ? old.map((r) => (r.id === grnId ? { ...r, status: 'POSTED', invoiceSyncStatus: 'PENDING' } : r))
        : old
    ));

    const res = await fetch(`/api/goods-receipts/${grnId}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error || 'Gagal');
      invalidateGrn();
    } else {
      const from = supplierLabel(data);
      toast.success(`Barang diterima dari ${from} — stok diperbarui`);
      if (data.invoiceSync?.async || data.invoiceSyncStatus === 'PENDING') {
        toast.info('Faktur vendor diproses di background…');
        setPollInvoiceGrnId(grnId);
      } else if (data.noInvoice) {
        toast.success(`Faktur ${data.noInvoice} siap`);
        window.dispatchEvent(new CustomEvent('erp-hutang-change'));
      } else if (data.invoiceSync?.error || data.invoiceSyncStatus === 'FAILED') {
        toast.warning(`Faktur gagal: ${data.invoiceSync?.error || data.invoiceSyncError || 'cek sales.app'}`);
      }
      setDetail(null);
      invalidateGrn();
    }
    setPosting('');
  };

  const renderGrnRow = (r: JsonObject) => {
    const rStatus = str(r.status);
    return (
    <tr
      key={str(r.id)}
      className="border-t cursor-pointer hover:bg-slate-50 transition-colors"
      onClick={() => openDoView(str(r.id))}
      title="Klik untuk lihat DO"
    >
      <td className="px-3 py-2 font-mono text-xs">{str(r.noGRN)}</td>
      <td className="px-3 py-2 font-mono text-xs">
        <span className="inline-flex items-center gap-1 text-blue-700 underline-offset-2 group-hover:underline">
          <FileText className="w-3.5 h-3.5 shrink-0" />
          {str(r.noDO)}
        </span>
      </td>
      <td className="px-3 py-2 text-xs max-w-[140px] truncate" title={supplierLabel(r)}>
        {supplierLabel(r)}
      </td>
      <td className="px-3 py-2 font-mono text-xs">{invoiceSyncLabel(r)}</td>
      <td className="px-3 py-2 text-xs">{formatDateTime(str(r.tanggal))}</td>
      <td className="px-3 py-2 text-xs">{str(r.lokasi) || (rStatus === 'POSTED' ? '—' : '')}</td>
      <td className="px-3 py-2 text-center">
        <span className={`px-2 py-0.5 rounded text-xs ${STATUS_STYLE[rStatus as keyof typeof STATUS_STYLE] || 'bg-slate-100'}`}>
          {STATUS_LABEL[rStatus as keyof typeof STATUS_LABEL] || rStatus}
        </span>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => openDoView(str(r.id))}
            disabled={loadingDo === str(r.id)}
            title="Lihat DO"
            aria-label="Lihat DO"
            className="p-1.5 rounded text-slate-500 hover:bg-slate-100 hover:text-blue-700 disabled:opacity-50"
          >
            <Eye className="w-4 h-4" />
          </button>
          {rStatus === 'DRAFT' && (
            <Button size="sm" onClick={() => openPost(str(r.id))} disabled={posting === str(r.id)}>
              Terima Barang
            </Button>
          )}
          {needsInvoiceReplay(r) && (
            <Button
              size="sm"
              variant="outline"
              className="text-orange-700 border-orange-300 hover:bg-orange-50"
              disabled={replayingInvoice === str(r.id)}
              title="Buat ulang faktur di sales.app"
              onClick={() => replayInvoice(str(r.id), r.noGRN)}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${replayingInvoice === str(r.id) ? 'animate-spin' : ''}`} />
              Buat faktur
            </Button>
          )}
          {isUnresolvedGrn(rStatus) && (
            <Link href="/produk" className="text-amber-700 text-xs underline">Daftar di Master Produk</Link>
          )}
        </div>
      </td>
    </tr>
  );
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
        {list.some((r) => isUnresolvedGrn(str(r.status))) && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
            <strong>{list.filter((r) => isUnresolvedGrn(str(r.status))).length} GRN</strong>
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
              {isLoading && <TableSkeleton rows={8} cols={8} />}
              {!isLoading && !list.length && (
                <tr><td colSpan={8} className="text-center py-10 text-slate-400">Belum ada GRN</td></tr>
              )}
              {!isLoading && list.length > 0 && (
                <VirtualTableBody
                  rows={list}
                  maxRows={520}
                  emptyRow={null}
                  renderRow={(r: JsonObject) => renderGrnRow(r)}
                />
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Terima Barang — {str(detail?.noGRN)}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-slate-500">
            DO: {str(detail?.noDO)}
            {supplierLabel(detail) !== '—' ? ` · Supplier: ${supplierLabel(detail)}` : ''}
            {' · '}Gudang mengikuti master produk (Kering/Basah tidak bisa dicampur)
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {(asArray(detail?.items) as JsonObject[]).map((it, idx) => {
              const rowKey = itemRowKey(it, idx);
              return (
              <div key={rowKey} className="flex flex-wrap items-end gap-2 text-sm border rounded p-2">
                <div className="flex-1 min-w-[140px]">
                  <div className="font-medium truncate">{str(it.localNama) || str(it.vendorNama) || str(it.nama)}</div>
                  <div className="text-xs text-slate-500">{str(it.vendorKode)} · kirim: {str(it.qtyOrdered)} {str(it.satuan)}</div>
                </div>
                <div className="w-36">
                  <Label className="text-xs">Gudang</Label>
                  <div className={`h-9 px-3 flex items-center rounded-md border text-xs font-medium ${
                    str(gudangMap[rowKey], 'GKERING') === 'GBASAH'
                      ? 'bg-blue-50 text-blue-800 border-blue-200'
                      : 'bg-amber-50 text-amber-800 border-amber-200'
                  }`}>
                    {warehouseName(str(gudangMap[rowKey], 'GKERING'))}
                  </div>
                </div>
                <div className="w-24">
                  <Label className="text-xs">Qty terima</Label>
                  <Input
                    type="number"
                    min={0}
                    max={num(it.qtyOrdered)}
                    step="any"
                    value={str(qtyMap[rowKey])}
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
              {posting ? 'Menyimpan stok…' : 'Konfirmasi Terima'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!doView} onOpenChange={(o) => !o && setDoView(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="w-5 h-5 text-orange-500" />
              Surat Jalan / DO — {str(doView?.noDO)}
            </DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-slate-50/70 p-3 text-sm">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">No. DO</p>
              <p className="font-mono font-medium">{str(doView?.noDO) || '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">No. SO (sales.app)</p>
              <p className="font-mono font-medium">{str(doView?.noSO) || '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">No. PO</p>
              <p className="font-mono font-medium">{str(doView?.noPO) || '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Supplier (tenant vendor)</p>
              <p className="font-medium">{supplierLabel(doView)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">No. Invoice</p>
              <p className="font-mono font-medium">{str(doView?.noInvoice) || '—'}</p>
              {!str(doView?.noInvoice) && str(doView?.status) === 'DRAFT' && (
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Dibuat otomatis setelah klik Terima Barang (GRN POSTED).
                </p>
              )}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Tanggal kirim</p>
              <p className="font-medium">{doView?.tanggal ? formatDateTime(str(doView.tanggal)) : '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Status</p>
              <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_STYLE[str(doView?.status) as keyof typeof STATUS_STYLE] || 'bg-slate-100'}`}>
                {STATUS_LABEL[str(doView?.status) as keyof typeof STATUS_LABEL] || str(doView?.status)}
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
                {(asArray(doView?.items) as JsonObject[]).map((it, idx) => (
                  <tr
                    key={itemRowKey(it, idx)}
                    className={`border-t border-slate-100 ${!it.localStokId ? 'bg-amber-50' : ''}`}
                  >
                    <td className="px-2 py-1.5 font-mono">{str(it.vendorKode) || str(it.localKode) || '—'}</td>
                    <td className="px-2 py-1.5">{str(it.localNama) || str(it.vendorNama) || str(it.nama)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(num(it.qtyOrdered))}</td>
                    <td className="px-2 py-1.5 text-center text-slate-500">{str(it.satuan) || '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{it.harga ? formatIDR(num(it.harga)) : '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {it.harga ? formatIDR(num(it.qtyOrdered) * (parseInt(str(it.harga), 10) || 0)) : '—'}
                    </td>
                  </tr>
                ))}
                {!asArray(doView?.items).length && (
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
            {str(doView?.status) === 'POSTED' && !!doView?.noDO && (
              <Button
                variant="outline"
                className="text-orange-700 border-orange-300"
                disabled={replayingInvoice === str(doView.id)}
                onClick={() => replayInvoice(str(doView.id), doView.noGRN)}
              >
                <RefreshCw className={`w-4 h-4 mr-1 ${replayingInvoice === str(doView.id) ? 'animate-spin' : ''}`} />
                {doView.noInvoice ? 'Sinkron ulang faktur' : 'Buat faktur vendor'}
              </Button>
            )}
            {doView?.status === 'DRAFT' && (
              <Button
                className="bg-orange-500 hover:bg-orange-600"
                onClick={() => {
                  const id = str(doView.id);
                  setDoView(null);
                  openPost(id);
                }}
              >
                <PackageCheck className="w-4 h-4 mr-1" />
                Terima Barang
              </Button>
            )}
            {isUnresolvedGrn(str(doView?.status)) && (
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
