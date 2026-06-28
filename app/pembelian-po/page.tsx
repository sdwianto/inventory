'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asObject, asArray } from '@/types/json';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { startOfMonth } from 'date-fns';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import PoCalendar from '@/components/PoCalendar';
import PoFormDialog from '@/components/pembelian-po/PoFormDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { fetchJson } from '@/lib/fetch-json';
import {
  CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Package, Pencil, Plus, RefreshCw, Send, ShoppingBag, XCircle,
} from 'lucide-react';
import { formatDate, formatDateTime, formatIDR, formatNumber } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import { poEstimasiFromProduct, parseEstimasiHargaInput } from '@/lib/po-estimasi-harga';
import {
  dateKey, formatArrivalLabel, getPoArrivalDate, PO_STATUS_STYLE,
} from '@/lib/po-calendar';
import {
  PO_CAN_APPROVE,
  PO_CAN_CREATE,
  PO_CAN_DIRECT_SUBMIT,
  PO_CAN_REQUEST,
  AUTO_VENDOR_SYNC_MS,
} from '@/lib/pembelian-po/constants';
import {
  toDateInputValue,
  poCreatorLabel,
  mergeFormLinesFromPo,
  emptyPoLine,
} from '@/lib/pembelian-po/helpers';
import { useCustomerPoList, useCustomerPoProducts } from '@/hooks/useCustomerPoData';

export default function CustomerPoPage() {
  const [user, setUser] = useState<JsonObject | null>(null);
  const { list, reload: reloadList, setList } = useCustomerPoList();
  const { products, reloadProducts } = useCustomerPoProducts();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPo, setEditingPo] = useState<JsonObject | null>(null);
  const [createDate, setCreateDate] = useState<Date | null>(null);
  const [lines, setLines] = useState<JsonObject[]>([emptyPoLine()]);
  const [catatan, setCatatan] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const autoSyncBusy = useRef(false);
  const [vendorTierMap, setVendorTierMap] = useState<JsonObject>({});
  const [defaultTier, setDefaultTier] = useState('ECER');

  const loadVendorTiers = useCallback(() => {
    fetchJson('/api/integrations/vendor-tiers')
      .then((data) => {
        const row = data as JsonObject;
        setVendorTierMap((row.tierMap || {}) as JsonObject);
        setDefaultTier(String(row.tierHargaDefault || 'ECER'));
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Gagal memuat tier vendor'));
  }, []);

  useEffect(() => {
    setUser(getUser() as JsonObject | null);
    void reloadList();
    void reloadProducts();
    loadVendorTiers();
    const onCatalogSynced = () => {
      void reloadProducts();
      loadVendorTiers();
    };
    window.addEventListener('vendor-catalog-synced', onCatalogSynced);
    return () => window.removeEventListener('vendor-catalog-synced', onCatalogSynced);
  }, [reloadList, reloadProducts, loadVendorTiers]);

  const canCreate = (PO_CAN_CREATE as readonly string[]).includes(String(user?.role || ''));
  const canRequest = (PO_CAN_REQUEST as readonly string[]).includes(String(user?.role || ''));
  const canDirectSubmit = (PO_CAN_DIRECT_SUBMIT as readonly string[]).includes(String(user?.role || ''));
  const canApprove = (PO_CAN_APPROVE as readonly string[]).includes(String(user?.role || ''));

  const synced = products.filter((p) => p.syncSource === 'sales.app');

  const pendingVendorSyncCount = useMemo(
    () => (Array.isArray(list) ? list : []).filter((p) => p.status === 'APPROVED' && p.vendorSyncPending !== false).length,
    [list],
  );

  const runAutoVendorSync = useCallback(async () => {
    if (autoSyncBusy.current) return;
    autoSyncBusy.current = true;
    try {
      const res = await fetch('/api/customer-purchase-orders/sync-pending', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) return;
      if (data.synced?.length > 0) {
        await reloadList();
        const labels = data.synced.map((s) => s.noPO).join(', ');
        toast.success(`${data.synced.length} PO terkirim otomatis ke vendor`, {
          description: labels,
        });
      }
    } catch {
      /* sales.app belum online — coba lagi nanti */
    } finally {
      autoSyncBusy.current = false;
    }
  }, [reloadList]);

  useEffect(() => {
    if (!user || pendingVendorSyncCount === 0) return undefined;
    runAutoVendorSync();
    const timer = setInterval(runAutoVendorSync, AUTO_VENDOR_SYNC_MS);
    return () => clearInterval(timer);
  }, [user, pendingVendorSyncCount, runAutoVendorSync]);

  const filteredList = useMemo(() => {
    const rows = Array.isArray(list) ? list : [];
    if (showAll || !selectedDate) return rows;
    const key = dateKey(selectedDate);
    return rows.filter((po) => dateKey(getPoArrivalDate(po)) === key);
  }, [list, selectedDate, showAll]);

  const openCreate = (date?: Date | string | null) => {
    const d = date ? new Date(date) : selectedDate ? new Date(selectedDate) : new Date();
    setEditingPo(null);
    setCreateDate(d);
    setLines([emptyPoLine()]);
    setCatatan('');
    setCreateOpen(true);
  };

  const openEdit = (po: JsonObject) => {
    setEditingPo(po);
    setCreateDate(getPoArrivalDate(po) || new Date());
    setLines(mergeFormLinesFromPo(asArray(po.items) as JsonObject[], emptyPoLine));
    setCatatan(str(po.catatan));
    setCreateOpen(true);
  };

  const canEditPo = (po: JsonObject) => {
    const status = str(po.status);
    if (!po || !['DRAFT', 'PENDING_APPROVAL'].includes(status)) return false;
    if (canApprove) return true;
    const createdBy = asObject(po.createdBy);
    if (status === 'DRAFT' && ['SUPERVISOR', 'GUDANG'].includes(String(user?.role || ''))) {
      return str(createdBy.userId) === str(user?.id);
    }
    return false;
  };

  const buildItemsPayload = () => {
    const map = new Map();
    for (const l of lines) {
      const p = products.find((x) => x.id === l.localStokId);
      if (!p || !l.qty) continue;
      if (!p.vendorStokId && p.syncSource !== 'sales.app') continue;
      const qty = num(l.qty);
      const estimasiHarga = parseEstimasiHargaInput(l.estimasiHarga as string | number | null | undefined);
      const prev = map.get(p.id);
      if (prev) {
        prev.qty += qty;
        if (l.estimasiManual && estimasiHarga) prev.estimasiHarga = estimasiHarga;
      } else {
        map.set(p.id, {
          localStokId: p.id,
          vendorStokId: p.vendorStokId,
          vendorTenantId: p.vendorTenantId,
          vendorKode: p.kode,
          kode: p.kode,
          nama: p.nama,
          satuan: p.satuan,
          qty,
          estimasiHarga,
          hargaBeliReferensi: parseInt(str(p.hargaBeli), 10),
        });
      }
    }
    return [...map.values()];
  };

  const handleSelectDate = (date: Date) => {
    setSelectedDate(dateKey(date));
    setShowAll(false);
    setMonth(startOfMonth(date));
  };

  const addLine = () => setLines([...lines, emptyPoLine()]);

  const selectProduct = (i: number, id: string) => {
    if (!id) {
      updateLine(i, { localStokId: '', estimasiHarga: '', estimasiManual: false });
      return;
    }
    const existingIdx = lines.findIndex((l, idx) => idx !== i && l.localStokId === id);
    const p = synced.find((x) => x.id === id);
    if (existingIdx >= 0) {
      const addQty = num(lines[i].qty, 1);
      const mergedQty = num(lines[existingIdx].qty) + addQty;
      const next = lines
        .map((l, idx) => (idx === existingIdx ? { ...l, qty: mergedQty } : l))
        .filter((_, idx) => idx !== i);
      setLines(next.length ? next : [emptyPoLine()]);
      toast.info(`${p?.nama || 'Produk'} digabung — total qty ${mergedQty}`);
      return;
    }
    updateLine(i, {
      localStokId: id,
      estimasiHarga: poEstimasiFromProduct(p, vendorTierMap as Record<string, string>, defaultTier) || '',
      estimasiManual: false,
    });
  };
  const removeLine = (i: number) => setLines(lines.length > 1 ? lines.filter((_, idx) => idx !== i) : lines);
  const updateLine = (i: number, patch: JsonObject) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const lineDetails = useMemo(() => lines.map((l): JsonObject & { product: JsonObject | null } => {
    const p = synced.find((x) => x.id === l.localStokId);
    return { ...l, product: p || null };
  }), [lines, synced]);

  const lineSummary = useMemo(() => {
    const filled = lineDetails.filter((l) => l.product && l.qty);
    const totalQty = filled.reduce((s, l) => s + num(l.qty), 0);
    const totalEstimasi = filled.reduce(
      (s, l) => s + num(l.qty) * parseEstimasiHargaInput(l.estimasiHarga as string | number | null | undefined),
      0,
    );
    return { rows: filled.length, totalQty, totalEstimasi };
  }, [lineDetails]);

  const createPo = async () => {
    const items = buildItemsPayload();
    if (!items.length) {
      toast.error('Pilih produk yang sudah di-sync dari sales.app');
      return;
    }
    if (!createDate) {
      toast.error('Tanggal kedatangan wajib');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/customer-purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          catatan,
          tanggalKedatangan: toDateInputValue(createDate),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      toast.success(`PO ${data.noPO} dibuat untuk ${formatDate(createDate)}`);
      setCreateOpen(false);
      setEditingPo(null);
      setSelectedDate(createDate ? toDateInputValue(createDate) : null);
      setShowAll(false);
      setExpandedId(data.id);
      reloadList();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    setSaving(false);
  };

  const saveEditPo = async () => {
    if (!editingPo) return;
    const items = buildItemsPayload();
    if (!items.length) {
      toast.error('Pilih produk yang sudah di-sync dari sales.app');
      return;
    }
    if (!createDate) {
      toast.error('Tanggal kedatangan wajib');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/customer-purchase-orders/${str(editingPo.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          catatan,
          tanggalKedatangan: toDateInputValue(createDate),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
      toast.success(`PO ${data.noPO} diperbarui`);
      setCreateOpen(false);
      setEditingPo(null);
      setExpandedId(data.id);
      reloadList();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    setSaving(false);
  };

  const requestApproval = async (id: string) => {
    setSubmitting(id);
    const res = await fetch(`/api/customer-purchase-orders/${id}/request-approval`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) toast.error(data.error || 'Gagal mengajukan');
    else toast.success('PO diajukan — menunggu persetujuan Admin');
    reloadList();
    setSubmitting('');
  };

  const approvePo = async (id: string) => {
    setSubmitting(id);
    try {
      const res = await fetch(`/api/customer-purchase-orders/${id}/approve`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Gagal menyetujui PO');
        return;
      }
      if (data.vendorSynced === false || data.status === 'APPROVED') {
        toast.success('PO disetujui', {
          description: data.vendorSyncError
            ? `Kirim ke vendor ditunda: ${data.vendorSyncError}`
            : 'Menunggu pengiriman ke sales.app',
        });
      } else if (data.vendorSubmissions?.length > 1) {
        toast.success(`Disetujui → ${data.vendorSubmissions.length} SO vendor: ${data.vendorSubmissions.map((s) => s.vendorNoSO).join(', ')}`);
      } else {
        toast.success(`Disetujui & dikirim → SO vendor ${data.vendorNoSO || data.vendorSoId || ''}`);
      }
      reloadList();
    } catch {
      toast.error('Gagal menyetujui — tidak dapat menghubungi server');
    }
    setSubmitting('');
  };

  const syncVendorPo = async (id: string) => {
    setSubmitting(id);
    try {
      const res = await fetch(`/api/customer-purchase-orders/${id}/sync-vendor`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Gagal kirim ke sales.app');
        return;
      }
      toast.success(`Dikirim ke vendor → SO ${data.vendorNoSO || data.vendorSoId || ''}`);
      reloadList();
    } catch {
      toast.error('Gagal kirim — tidak dapat menghubungi server');
    }
    setSubmitting('');
  };

  const rejectPo = async (id: string) => {
    setSubmitting(id);
    const res = await fetch(`/api/customer-purchase-orders/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Ditolak admin' }),
    });
    const data = await res.json();
    if (!res.ok) toast.error(data.error || 'Gagal menolak');
    else toast.success('PO ditolak');
    reloadList();
    setSubmitting('');
  };

  const submitPo = async (id: string) => {
    setSubmitting(id);
    try {
      const res = await fetch(`/api/customer-purchase-orders/${id}/submit`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Gagal kirim ke sales.app');
        return;
      }
      if (data.vendorSynced === false || data.status === 'APPROVED') {
        toast.success('PO dikirim (disetujui)', {
          description: data.vendorSyncError
            ? `Sinkron vendor ditunda: ${data.vendorSyncError}`
            : 'Menunggu sales.app',
        });
      } else if (data.vendorSubmissions?.length > 1) {
        toast.success(`Dikirim → ${data.vendorSubmissions.length} SO vendor: ${data.vendorSubmissions.map((s) => s.vendorNoSO).join(', ')}`);
      } else {
        toast.success(`Dikirim → SO vendor ${data.vendorNoSO || data.vendorSoId || ''}`);
      }
      reloadList();
    } catch {
      toast.error('Gagal kirim — tidak dapat menghubungi server');
    }
    setSubmitting('');
  };

  const listTitle = showAll || !selectedDate
    ? 'Semua PO'
    : `PO kedatangan ${formatDate(selectedDate)}`;

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ShoppingBag className="w-6 h-6" /> PO ke Vendor
            </h1>
            <p className="text-sm text-slate-500">
              Staff gudang / supervisor buat PO → admin setujui → kirim ke vendor otomatis saat sales.app online
            </p>
            {pendingVendorSyncCount > 0 && (
              <p className="text-xs text-emerald-700 mt-1 flex items-center gap-1">
                <RefreshCw className="w-3 h-3" />
                {pendingVendorSyncCount} PO menunggu — sinkron otomatis setiap ±{Math.round(AUTO_VENDOR_SYNC_MS / 1000)} detik
              </p>
            )}
          </div>
          {canCreate && (
            <Button onClick={() => openCreate(selectedDate || new Date())} className="bg-orange-500 hover:bg-orange-600">
              <Plus className="w-4 h-4 mr-1" /> Buat PO
            </Button>
          )}
        </div>
        <OperationalScopeBar />

        <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <div className="bg-white border rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <CalendarDays className="w-5 h-5 text-orange-500" />
              <h2 className="font-semibold">Kalender Kedatangan</h2>
            </div>
            <PoCalendar
              pos={list as unknown as never[]}
              month={month}
              onMonthChange={setMonth}
              selectedDate={selectedDate}
              onSelectDate={handleSelectDate}
              onCreateForDate={openCreate}
            />
          </div>

          <div className="bg-white border rounded-xl p-4 shadow-sm flex flex-col min-h-[320px]">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <h2 className="font-semibold">{listTitle}</h2>
                {selectedDate && !showAll && (
                  <p className="text-xs text-slate-500">{formatArrivalLabel(selectedDate)}</p>
                )}
              </div>
              <div className="flex gap-2">
                {selectedDate && (
                  <Button variant="outline" size="sm" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Filter tanggal' : 'Lihat semua'}
                  </Button>
                )}
                {selectedDate && canCreate && (
                  <Button size="sm" onClick={() => openCreate(selectedDate)} className="bg-orange-500 hover:bg-orange-600">
                    <Plus className="w-3 h-3 mr-1" /> PO baru
                  </Button>
                )}
              </div>
            </div>

            {!filteredList.length ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 py-12 text-sm">
                <CalendarDays className="w-10 h-10 mb-2 opacity-40" />
                {selectedDate && !showAll
                  ? 'Belum ada PO untuk tanggal ini — klik + di kalender untuk buat'
                  : 'Belum ada PO — pilih tanggal di kalender'}
              </div>
            ) : (
              <div className="space-y-2 overflow-y-auto max-h-[520px] pr-1">
                {filteredList.map((po: JsonObject) => {
                  const open = expandedId === str(po.id);
                  const arrival = getPoArrivalDate(po);
                  const poStatus = str(po.status);
                  const createdBy = asObject(po.createdBy);
                  const approvedBy = asObject(po.approvedBy);
                  const lastEditedBy = asObject(po.lastEditedBy);
                  const poItems = asArray(po.items) as JsonObject[];
                  return (
                    <div key={str(po.id)} className="border rounded-lg overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-slate-50">
                        <button
                          type="button"
                          className="flex flex-1 items-center gap-2 min-w-0 text-left"
                          onClick={() => setExpandedId(open ? null : str(po.id))}
                        >
                          {open ? <ChevronDown className="w-4 h-4 shrink-0 text-slate-400" /> : <ChevronRight className="w-4 h-4 shrink-0 text-slate-400" />}
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs font-semibold">{str(po.noPO)}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${PO_STATUS_STYLE[poStatus as keyof typeof PO_STATUS_STYLE] || PO_STATUS_STYLE.DRAFT}`}>
                                {poStatus}
                              </span>
                            </div>
                            <div className="text-xs text-slate-500 mt-0.5">
                              Kedatangan: {formatDate(arrival)} · Dibuat: {formatDateTime(str(po.tanggal))}
                              {poCreatorLabel(po) !== 'Tidak tercatat' && ` · oleh ${poCreatorLabel(po)}`}
                              {!!po.vendorNoSO && ` · SO: ${str(po.vendorNoSO)}`}
                            </div>
                          </div>
                        </button>
                        {canEditPo(po) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => openEdit(po)}
                          >
                            <Pencil className="w-3 h-3 mr-1" />
                            Edit
                          </Button>
                        )}
                        {poStatus === 'DRAFT' && canRequest && (
                          ['SUPERVISOR', 'GUDANG'].includes(String(user?.role || ''))
                            ? str(createdBy.userId) === str(user?.id)
                            : true
                        ) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => requestApproval(str(po.id))}
                            disabled={submitting === str(po.id)}
                          >
                            <Send className="w-3 h-3 mr-1" />
                            {submitting === str(po.id) ? '...' : 'Ajukan'}
                          </Button>
                        )}
                        {poStatus === 'DRAFT' && canDirectSubmit && (
                          <Button
                            size="sm"
                            className="shrink-0"
                            onClick={() => submitPo(str(po.id))}
                            disabled={submitting === str(po.id)}
                          >
                            <Send className="w-3 h-3 mr-1" />
                            {submitting === str(po.id) ? '...' : 'Kirim'}
                          </Button>
                        )}
                        {poStatus === 'APPROVED' && canApprove && !!po.vendorSyncPending && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 border-emerald-300 text-emerald-800 hover:bg-emerald-50"
                            onClick={() => syncVendorPo(str(po.id))}
                            disabled={submitting === str(po.id)}
                          >
                            <RefreshCw className={`w-3 h-3 mr-1 ${submitting === str(po.id) ? 'animate-spin' : ''}`} />
                            {submitting === str(po.id) ? '...' : 'Kirim ke vendor'}
                          </Button>
                        )}
                        {poStatus === 'PENDING_APPROVAL' && canApprove && (
                          <>
                            <Button
                              size="sm"
                              className="shrink-0 bg-green-600 hover:bg-green-700"
                              onClick={() => approvePo(str(po.id))}
                              disabled={submitting === str(po.id)}
                            >
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              {submitting === str(po.id) ? '...' : 'Setujui'}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="shrink-0"
                              onClick={() => rejectPo(str(po.id))}
                              disabled={submitting === str(po.id)}
                            >
                              <XCircle className="w-3 h-3" />
                            </Button>
                          </>
                        )}
                      </div>
                      {open && (
                        <div className="border-t bg-slate-50/50 px-3 py-2 text-sm">
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 mb-2 pb-2 border-b border-slate-100">
                            <span>
                              <span className="font-medium text-slate-700">Dibuat oleh:</span>{' '}
                              {poCreatorLabel(po)}
                            </span>
                            <span>
                              <span className="font-medium text-slate-700">Waktu buat:</span>{' '}
                              {formatDateTime(str(po.createdAt || po.tanggal))}
                            </span>
                            {!!po.requestedAt && (
                              <span>
                                <span className="font-medium text-slate-700">Diajukan:</span>{' '}
                                {formatDateTime(str(po.requestedAt))}
                              </span>
                            )}
                            {!!approvedBy.userName && (
                              <span>
                                <span className="font-medium text-slate-700">Disetujui:</span>{' '}
                                {str(approvedBy.userName)}
                                {!!po.approvedAt && ` · ${formatDateTime(str(po.approvedAt))}`}
                              </span>
                            )}
                            {!!lastEditedBy.userName && (
                              <span>
                                <span className="font-medium text-slate-700">Terakhir diedit:</span>{' '}
                                {str(lastEditedBy.userName)}
                                {!!po.lastEditedAt && ` · ${formatDateTime(str(po.lastEditedAt))}`}
                              </span>
                            )}
                          </div>
                          {!!po.vendorSyncError && poStatus === 'APPROVED' && (
                            <p className="text-xs text-amber-700 mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
                              <span className="font-medium">Antrian kirim ke vendor:</span> {str(po.vendorSyncError)}
                              <span className="block text-[10px] text-amber-600 mt-0.5">
                                Akan dikirim otomatis saat sales.app online (atau klik Kirim ke vendor)
                              </span>
                            </p>
                          )}
                          {!!po.catatan && (
                            <p className="text-xs text-slate-600 mb-2"><span className="font-medium">Catatan:</span> {str(po.catatan)}</p>
                          )}
                          {!!po.rejectReason && (
                            <p className="text-xs text-red-600 mb-2"><span className="font-medium">Alasan ditolak:</span> {str(po.rejectReason)}</p>
                          )}
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-slate-500 border-b">
                                <th className="text-left py-1 pr-2">Kode</th>
                                <th className="text-left py-1 pr-2">Produk</th>
                                <th className="text-right py-1 pr-2">Estimasi</th>
                                <th className="text-right py-1 pr-2">Qty</th>
                                <th className="text-center py-1">Satuan</th>
                              </tr>
                            </thead>
                            <tbody>
                              {poItems.map((it: JsonObject) => (
                                <tr key={str(it.lineId || it.kode)} className="border-b border-slate-100 last:border-0">
                                  <td className="py-1.5 pr-2 font-mono">{str(it.kode)}</td>
                                  <td className="py-1.5 pr-2">{str(it.nama)}</td>
                                  <td className="py-1.5 text-right whitespace-nowrap text-slate-600">
                                    {it.estimasiHarga ? formatIDR(num(it.estimasiHarga)) : '—'}
                                  </td>
                                  <td className="py-1.5 text-right whitespace-nowrap">{formatNumber(num(it.qty))}</td>
                                  <td className="py-1.5 text-center text-slate-600">{str(it.satuan) || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {(!!po.vendorNoDO || !!po.vendorNoInvoice) && (
                            <div className="mt-2 text-xs text-slate-600">
                              {!!po.vendorNoDO && <span className="mr-3">DO: {str(po.vendorNoDO)}</span>}
                              {!!po.vendorNoInvoice && <span>Invoice: {str(po.vendorNoInvoice)}</span>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <PoFormDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setEditingPo(null);
        }}
        editingPo={editingPo}
        createDate={createDate}
        onCreateDateChange={setCreateDate}
        lines={lines}
        lineDetails={lineDetails}
        lineSummary={lineSummary}
        catatan={catatan}
        onCatatanChange={setCatatan}
        saving={saving}
        synced={synced}
        vendorTierMap={vendorTierMap}
        defaultTier={defaultTier}
        onAddLine={addLine}
        onRemoveLine={removeLine}
        onSelectProduct={selectProduct}
        onUpdateLine={updateLine}
        onSave={editingPo ? saveEditPo : createPo}
        onCancel={() => { setCreateOpen(false); setEditingPo(null); }}
      />
    </AppShell>
  );
}
