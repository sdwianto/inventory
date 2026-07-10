'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asObject, asArray } from '@/types/json';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
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
import { useCursorQuery } from '@/lib/hooks/use-cursor-query';
import { queryKeys } from '@/lib/query-keys';
import { useGrnInvoiceStatus, useInvalidateGrn } from '@/lib/hooks/use-goods-receipts';
import { useInvalidateHutangBadges } from '@/lib/hooks/use-nav-badges';
import { useGrnMutations } from '@/lib/hooks/use-grn-mutations';
import { useBgJob } from '@/lib/hooks/use-bg-job';
import { useOnceTerminalEffect } from '@/lib/hooks/use-once-terminal-effect';
import { OfflineQueuedError } from '@/lib/offline-mutation-queue';
import { useQueryClient } from '@/lib/hooks/useApiQuery';
import { fetchJson } from '@/lib/fetch-json';
import LineUomSelect from '@/components/uom/LineUomSelect';
import { usePrimeLineItemUoms } from '@/lib/hooks/use-prime-line-uoms';
import { patchQtyLineOnUomChange } from '@/lib/uom/line-patch';
import type { ProductUom } from '@/lib/uom/types';

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
  const invalidateHutangBadges = useInvalidateHutangBadges();
  const listKey = queryKeys.pages.penerimaan();
  const {
    items: list,
    loading: isLoading,
    hasMore,
    loadMore,
    loadingMore,
    reload,
    error,
  } = useCursorQuery<JsonObject>(
    listKey,
    '/api/pages/penerimaan',
    { limit: 100, refetchInterval: 20_000 },
  );
  const { postGrn: postGrnMutation, replayInvoice: replayInvoiceMutation, syncFromSales: syncFromSalesMutation } = useGrnMutations(
    listKey,
    reload,
    invalidateGrn,
  );
  const [posting, setPosting] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [detail, setDetail] = useState<JsonObject | null>(null);
  const [qtyMap, setQtyMap] = useState<JsonObject>({});
  const [gudangMap, setGudangMap] = useState<JsonObject>({});
  const [uomMap, setUomMap] = useState<Record<string, { uomId?: string; satuan?: string; factorToBase?: number }>>({});
  const [doView, setDoView] = useState<JsonObject | null>(null);
  const [loadingDo, setLoadingDo] = useState('');
  const [replayingInvoice, setReplayingInvoice] = useState('');
  const [pollInvoiceGrnId, setPollInvoiceGrnId] = useState<string | null>(null);
  const [activeSyncJobId, setActiveSyncJobId] = useState<string | null>(null);

  const detailItems = useMemo(
    () => (detail ? asArray(detail.items) as JsonObject[] : []),
    [detail],
  );
  usePrimeLineItemUoms(
    Boolean(detail),
    detailItems.map((it) => str(it.localStokId)),
  );

  const { data: invoicePoll } = useGrnInvoiceStatus(pollInvoiceGrnId, !!pollInvoiceGrnId);
  const { data: syncJob } = useBgJob(activeSyncJobId);

  const invoicePollStatus = invoicePoll && pollInvoiceGrnId
    ? str((invoicePoll as JsonObject).invoiceSyncStatus)
    : null;
  useOnceTerminalEffect(pollInvoiceGrnId, invoicePoll as JsonObject | null, invoicePollStatus, ['DONE', 'FAILED', 'SKIPPED'], (status, poll) => {
    if (status === 'DONE') {
      toast.success(`Faktur ${str(poll.noInvoice)} siap — cek Tagihan Vendor`);
    } else if (status === 'FAILED') {
      toast.warning(`Faktur gagal: ${str(poll.invoiceSyncError, 'cek sales.app')}`);
    }
    setPollInvoiceGrnId(null);
    invalidateGrn();
    if (status === 'DONE') invalidateHutangBadges();
  });

  const syncJobStatus = syncJob && activeSyncJobId ? String(syncJob.status || '') : null;
  useOnceTerminalEffect(activeSyncJobId, syncJob, syncJobStatus, ['DONE', 'FAILED'], (status) => {
    if (status === 'DONE') {
      const result = asObject(syncJob?.result);
      toast.success(`Sync DO: ${num(result.created)} GRN baru, ${num(result.existing)} sudah ada`);
      if (num(result.grnRefreshed) > 0) {
        toast.info(`${num(result.grnRefreshed)} GRN produk diperbarui`);
      }
      invalidateGrn();
      reload();
      invalidateHutangBadges();
    } else {
      const errMsg = String(syncJob?.lastError || asObject(syncJob?.result).error || 'Gagal sync DO');
      toast.error(errMsg);
    }
    setActiveSyncJobId(null);
    setSyncing(false);
  });

  useEffect(() => {
    const onGrnChange = () => { void reload(); };
    window.addEventListener('erp-grn-change', onGrnChange);
    return () => window.removeEventListener('erp-grn-change', onGrnChange);
  }, [reload]);

  const replayInvoice = async (id: string, noGRN?: unknown) => {
    setReplayingInvoice(id);
    try {
      const data = await replayInvoiceMutation(id);
      if (data.invoiceSyncStatus === 'PENDING' || data.invoiceSync?.async) {
        toast.info(`Faktur ${noGRN} — masih diproses…`);
        setPollInvoiceGrnId(id);
      } else if (data.noInvoice) {
        toast.success(`Faktur ${data.noInvoice} siap`);
        invalidateHutangBadges();
      } else if (data.invoiceSyncStatus === 'FAILED') {
        toast.warning(`Faktur gagal: ${data.invoiceSyncError || 'cek sales.app'}`);
      } else {
        toast.success(`Faktur ${noGRN} — selesai`);
      }
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        toast.info('Replay faktur disimpan offline — akan disinkron saat online');
      } else {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }
    setReplayingInvoice('');
  };

  const syncFromSales = async () => {
    setSyncing(true);
    try {
      const { res, data } = await syncFromSalesMutation();
      if (res.status === 202 && data.jobId) {
        toast.info('Sync DO berjalan di background…');
        setActiveSyncJobId(String(data.jobId));
        return;
      }
      toast.success(`Sync DO: ${data.created} GRN baru, ${data.existing} sudah ada`);
      invalidateGrn();
      reload();
      invalidateHutangBadges();
      setSyncing(false);
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        toast.info('Sync DO disimpan offline — akan disinkron saat online');
      } else {
        toast.error(e instanceof Error ? e.message : String(e));
      }
      setSyncing(false);
    }
  };

  const openDoView = async (id: string) => {
    setLoadingDo(id);
    try {
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.goodsReceipts.detail(id),
        queryFn: () => fetchJson<JsonObject>(`/api/goods-receipts/${id}`),
      });
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
    try {
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.goodsReceipts.detail(id),
        queryFn: () => fetchJson<JsonObject>(`/api/goods-receipts/${id}`),
      });
      setDetail(data);
      const detailItems = asArray(data.items) as JsonObject[];
      const initQty: JsonObject = {};
      const initGudang: JsonObject = {};
      const initUom: Record<string, { uomId?: string; satuan?: string; factorToBase?: number }> = {};
      for (const [idx, it] of detailItems.entries()) {
        const key = itemRowKey(it, idx);
        initQty[key] = it.qtyOrdered ?? 0;
        const embedded = it.product as JsonObject | undefined;
        initGudang[key] = str(it.gudangKode || embedded?.gudangKode, 'GKERING');
        initUom[key] = {
          uomId: str(it.uomId) || undefined,
          satuan: str(it.satuan) || undefined,
        };
      }
      setQtyMap(initQty);
      setGudangMap(initGudang);
      setUomMap(initUom);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const postGrn = async () => {
    if (!detail) return;
    const grnId = str(detail.id);
    setPosting(grnId);
    const items = detailItems.map((it, idx) => {
      const key = itemRowKey(it, idx);
      const uom = uomMap[key];
      return {
        lineId: it.lineId,
        lineIndex: idx,
        qty: num(qtyMap[key]),
        lokasiKode: str(gudangMap[key], 'GKERING'),
        uomId: uom?.uomId || str(it.uomId) || undefined,
        satuan: uom?.satuan || str(it.satuan) || undefined,
      };
    }).filter((it) => it.qty > 0);

    try {
      const data = await postGrnMutation(grnId, items);
      const from = supplierLabel(data);
      toast.success(`Barang diterima dari ${from} — stok diperbarui`);
      if (data.invoiceSync?.async || data.invoiceSyncStatus === 'PENDING') {
        toast.info('Faktur vendor diproses di background…');
        setPollInvoiceGrnId(grnId);
      } else if (data.noInvoice) {
        toast.success(`Faktur ${data.noInvoice} siap`);
        invalidateHutangBadges();
      } else if (data.invoiceSync?.error || data.invoiceSyncStatus === 'FAILED') {
        toast.warning(`Faktur gagal: ${data.invoiceSync?.error || data.invoiceSyncError || 'cek sales.app'}`);
      }
      setDetail(null);
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        toast.info('Penerimaan disimpan offline — akan disinkron saat online');
        setDetail(null);
      } else {
        toast.error(e instanceof Error ? e.message : String(e));
        invalidateGrn();
        reload();
      }
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
    <>
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
        {error && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 flex flex-wrap items-center justify-between gap-2">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void reload()}>Coba lagi</Button>
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
          {hasMore && (
            <div className="p-3 border-t text-center">
              <Button variant="outline" size="sm" onClick={() => loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Memuat…' : 'Muat lebih banyak'}
              </Button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-4xl w-[min(100vw-2rem,56rem)]">
          <DialogHeader>
            <DialogTitle>Terima Barang — {str(detail?.noGRN)}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-slate-500">
            DO: {str(detail?.noDO)}
            {supplierLabel(detail) !== '—' ? ` · Supplier: ${supplierLabel(detail)}` : ''}
            {' · '}Gudang mengikuti master produk (Kering/Basah tidak bisa dicampur)
          </p>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {detailItems.map((it, idx) => {
              const rowKey = itemRowKey(it, idx);
              const localStokId = str(it.localStokId);
              const uomRow = uomMap[rowKey];
              return (
              <div
                key={rowKey}
                className="grid grid-cols-[minmax(0,1fr)_9rem_7rem_5.5rem] gap-3 items-end text-sm border rounded p-2"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{str(it.localNama) || str(it.vendorNama) || str(it.nama)}</div>
                  <div className="text-xs text-slate-500 truncate">{str(it.vendorKode)} · kirim: {formatNumber(num(it.qtyOrdered))} {str(it.satuan) || 'unit'}</div>
                </div>
                <div className="min-w-0 flex flex-col gap-1">
                  <Label className="text-xs block">Gudang</Label>
                  <div className={`h-9 px-2 flex items-center rounded-md border text-xs font-medium truncate ${
                    str(gudangMap[rowKey], 'GKERING') === 'GBASAH'
                      ? 'bg-blue-50 text-blue-800 border-blue-200'
                      : 'bg-amber-50 text-amber-800 border-amber-200'
                  }`}>
                    {warehouseName(str(gudangMap[rowKey], 'GKERING'))}
                  </div>
                </div>
                <div className="min-w-0 flex flex-col gap-1">
                  <Label className="text-xs block">Satuan</Label>
                  {localStokId ? (
                    <LineUomSelect
                      stokId={localStokId}
                      uomId={uomRow?.uomId || str(it.uomId)}
                      onChange={(uom: ProductUom) => {
                        const prev = uomMap[rowKey];
                        const patched = patchQtyLineOnUomChange(
                          { qty: qtyMap[rowKey], factorToBase: prev?.factorToBase },
                          uom,
                        );
                        setUomMap({
                          ...uomMap,
                          [rowKey]: {
                            uomId: patched.uomId,
                            satuan: patched.satuan,
                            factorToBase: patched.factorToBase,
                          },
                        });
                        setQtyMap({ ...qtyMap, [rowKey]: patched.qty });
                      }}
                    />
                  ) : (
                    <div className="h-9 px-2 flex items-center rounded-md border bg-slate-50 text-xs text-slate-500">
                      {str(it.satuan) || '—'}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex flex-col gap-1">
                  <Label className="text-xs block">Qty terima</Label>
                  <Input
                    type="number"
                    min={0}
                    max={num(it.qtyOrdered)}
                    step="any"
                    className="h-9"
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
    </>
  );
}
