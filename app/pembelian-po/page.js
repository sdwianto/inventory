'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { startOfMonth } from 'date-fns';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import PoCalendar from '@/components/PoCalendar';
import ProductSearchSelect from '@/components/ProductSearchSelect';
import ProductStockReminder from '@/components/ProductStockReminder';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { fetchJson } from '@/lib/fetch-json';
import {
  CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Package, Pencil, Plus, RefreshCw, Send, ShoppingBag, Trash2, XCircle,
} from 'lucide-react';
import { formatDate, formatDateTime, formatIDR, formatNumber } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import { poEstimasiFromProduct, parseEstimasiHargaInput, getEstimasiHargaHint, formatBeliDeltaSign } from '@/lib/po-estimasi-harga';
import { cn } from '@/lib/utils';
import { vendorDisplayName } from '@/lib/vendor-display';
import {
  dateKey, formatArrivalLabel, getPoArrivalDate, PO_STATUS_STYLE,
} from '@/lib/po-calendar';

function toDateInputValue(d) {
  if (!d) return '';
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function poCreatorLabel(po) {
  return po?.createdBy?.userName
    || po?.createdBy?.name
    || po?.createdBy?.email
    || po?.requestedBy?.userName
    || 'Tidak tercatat';
}

function mergeFormLinesFromPo(items, emptyLine) {
  if (!items?.length) return [emptyLine()];
  const map = new Map();
  for (const it of items) {
    const id = it.localStokId;
    if (!id) continue;
    const prev = map.get(id);
    if (prev) {
      prev.qty = (parseFloat(prev.qty) || 0) + (parseFloat(it.qty) || 0);
    } else {
      map.set(id, {
        localStokId: id,
        qty: it.qty,
        estimasiHarga: it.estimasiHarga || '',
        estimasiManual: true,
      });
    }
  }
  const merged = [...map.values()];
  return merged.length ? merged : [emptyLine()];
}

const CAN_CREATE = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER'];
const CAN_REQUEST = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER'];
const CAN_DIRECT_SUBMIT = ['ADMIN', 'MASTER'];
const CAN_APPROVE = ['ADMIN', 'MASTER'];
const AUTO_VENDOR_SYNC_MS = 45_000;

export default function CustomerPoPage() {
  const [user, setUser] = useState(null);
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPo, setEditingPo] = useState(null);
  const [createDate, setCreateDate] = useState(null);
  const emptyLine = () => ({ localStokId: '', qty: 1, estimasiHarga: '', estimasiManual: false });
  const [lines, setLines] = useState([emptyLine()]);
  const [catatan, setCatatan] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const autoSyncBusy = useRef(false);
  const [vendorTierMap, setVendorTierMap] = useState({});
  const [defaultTier, setDefaultTier] = useState('ECER');

  const loadProducts = useCallback(() => {
    fetchJson('/api/products?limit=500&withWarehouseStock=1')
      .then((data) => setProducts(Array.isArray(data) ? data : []))
      .catch((e) => toast.error(e.message || 'Gagal memuat produk'));
  }, []);

  const loadVendorTiers = useCallback(() => {
    fetchJson('/api/integrations/vendor-tiers')
      .then((data) => {
        setVendorTierMap(data.tierMap || {});
        setDefaultTier(data.tierHargaDefault || 'ECER');
      })
      .catch((e) => toast.error(e.message || 'Gagal memuat tier vendor'));
  }, []);

  const load = () => fetchJson('/api/customer-purchase-orders')
    .then((data) => setList(Array.isArray(data) ? data : []))
    .catch((e) => {
      toast.error(e.message || 'Gagal memuat PO');
      setList([]);
    });
  useEffect(() => {
    setUser(getUser());
    load();
    loadProducts();
    loadVendorTiers();
    const onCatalogSynced = () => {
      loadProducts();
      loadVendorTiers();
    };
    window.addEventListener('vendor-catalog-synced', onCatalogSynced);
    return () => window.removeEventListener('vendor-catalog-synced', onCatalogSynced);
  }, [loadProducts, loadVendorTiers]);

  const canCreate = CAN_CREATE.includes(user?.role);
  const canRequest = CAN_REQUEST.includes(user?.role);
  const canDirectSubmit = CAN_DIRECT_SUBMIT.includes(user?.role);
  const canApprove = CAN_APPROVE.includes(user?.role);

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
        await load();
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
  }, []);

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

  const openCreate = (date) => {
    const d = date || selectedDate || new Date();
    setEditingPo(null);
    setCreateDate(d);
    setLines([emptyLine()]);
    setCatatan('');
    setCreateOpen(true);
  };

  const openEdit = (po) => {
    setEditingPo(po);
    setCreateDate(getPoArrivalDate(po) || new Date());
    setLines(mergeFormLinesFromPo(po.items, emptyLine));
    setCatatan(po.catatan || '');
    setCreateOpen(true);
  };

  const canEditPo = (po) => {
    if (!po || !['DRAFT', 'PENDING_APPROVAL'].includes(po.status)) return false;
    if (canApprove) return true;
    if (po.status === 'DRAFT' && ['SUPERVISOR', 'GUDANG'].includes(user?.role)) {
      return po.createdBy?.userId === user?.id;
    }
    return false;
  };

  const buildItemsPayload = () => {
    const map = new Map();
    for (const l of lines) {
      const p = products.find((x) => x.id === l.localStokId);
      if (!p || !l.qty) continue;
      if (!p.vendorStokId && p.syncSource !== 'sales.app') continue;
      const qty = parseFloat(l.qty) || 0;
      const estimasiHarga = parseEstimasiHargaInput(l.estimasiHarga);
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
          hargaBeliReferensi: parseInt(p.hargaBeli || 0, 10),
        });
      }
    }
    return [...map.values()];
  };

  const handleSelectDate = (date) => {
    setSelectedDate(date);
    setShowAll(false);
    setMonth(startOfMonth(date));
  };

  const addLine = () => setLines([...lines, emptyLine()]);

  const selectProduct = (i, id) => {
    if (!id) {
      updateLine(i, { localStokId: '', estimasiHarga: '', estimasiManual: false });
      return;
    }
    const existingIdx = lines.findIndex((l, idx) => idx !== i && l.localStokId === id);
    const p = synced.find((x) => x.id === id);
    if (existingIdx >= 0) {
      const addQty = parseFloat(lines[i].qty) || 1;
      const mergedQty = (parseFloat(lines[existingIdx].qty) || 0) + addQty;
      const next = lines
        .map((l, idx) => (idx === existingIdx ? { ...l, qty: mergedQty } : l))
        .filter((_, idx) => idx !== i);
      setLines(next.length ? next : [emptyLine()]);
      toast.info(`${p?.nama || 'Produk'} digabung — total qty ${mergedQty}`);
      return;
    }
    updateLine(i, {
      localStokId: id,
      estimasiHarga: poEstimasiFromProduct(p, vendorTierMap, defaultTier) || '',
      estimasiManual: false,
    });
  };
  const removeLine = (i) => setLines(lines.length > 1 ? lines.filter((_, idx) => idx !== i) : lines);
  const updateLine = (i, patch) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const lineDetails = useMemo(() => lines.map((l) => {
    const p = synced.find((x) => x.id === l.localStokId);
    return { ...l, product: p || null };
  }), [lines, synced]);

  const lineSummary = useMemo(() => {
    const filled = lineDetails.filter((l) => l.product && l.qty);
    const totalQty = filled.reduce((s, l) => s + (parseFloat(l.qty) || 0), 0);
    const totalEstimasi = filled.reduce(
      (s, l) => s + (parseFloat(l.qty) || 0) * parseEstimasiHargaInput(l.estimasiHarga),
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
      setSelectedDate(createDate);
      setShowAll(false);
      setExpandedId(data.id);
      load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const saveEditPo = async () => {
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
      const res = await fetch(`/api/customer-purchase-orders/${editingPo.id}`, {
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
      load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const requestApproval = async (id) => {
    setSubmitting(id);
    const res = await fetch(`/api/customer-purchase-orders/${id}/request-approval`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) toast.error(data.error || 'Gagal mengajukan');
    else toast.success('PO diajukan — menunggu persetujuan Admin');
    load();
    setSubmitting('');
  };

  const approvePo = async (id) => {
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
      load();
    } catch {
      toast.error('Gagal menyetujui — tidak dapat menghubungi server');
    }
    setSubmitting('');
  };

  const syncVendorPo = async (id) => {
    setSubmitting(id);
    try {
      const res = await fetch(`/api/customer-purchase-orders/${id}/sync-vendor`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Gagal kirim ke sales.app');
        return;
      }
      toast.success(`Dikirim ke vendor → SO ${data.vendorNoSO || data.vendorSoId || ''}`);
      load();
    } catch {
      toast.error('Gagal kirim — tidak dapat menghubungi server');
    }
    setSubmitting('');
  };

  const rejectPo = async (id) => {
    setSubmitting(id);
    const res = await fetch(`/api/customer-purchase-orders/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Ditolak admin' }),
    });
    const data = await res.json();
    if (!res.ok) toast.error(data.error || 'Gagal menolak');
    else toast.success('PO ditolak');
    load();
    setSubmitting('');
  };

  const submitPo = async (id) => {
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
      load();
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
              pos={list}
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
                {filteredList.map((po) => {
                  const open = expandedId === po.id;
                  const arrival = getPoArrivalDate(po);
                  return (
                    <div key={po.id} className="border rounded-lg overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-slate-50">
                        <button
                          type="button"
                          className="flex flex-1 items-center gap-2 min-w-0 text-left"
                          onClick={() => setExpandedId(open ? null : po.id)}
                        >
                          {open ? <ChevronDown className="w-4 h-4 shrink-0 text-slate-400" /> : <ChevronRight className="w-4 h-4 shrink-0 text-slate-400" />}
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs font-semibold">{po.noPO}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${PO_STATUS_STYLE[po.status] || PO_STATUS_STYLE.DRAFT}`}>
                                {po.status}
                              </span>
                            </div>
                            <div className="text-xs text-slate-500 mt-0.5">
                              Kedatangan: {formatDate(arrival)} · Dibuat: {formatDateTime(po.tanggal)}
                              {poCreatorLabel(po) !== 'Tidak tercatat' && ` · oleh ${poCreatorLabel(po)}`}
                              {po.vendorNoSO && ` · SO: ${po.vendorNoSO}`}
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
                        {po.status === 'DRAFT' && canRequest && (
                          ['SUPERVISOR', 'GUDANG'].includes(user?.role)
                            ? po.createdBy?.userId === user?.id
                            : true
                        ) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => requestApproval(po.id)}
                            disabled={submitting === po.id}
                          >
                            <Send className="w-3 h-3 mr-1" />
                            {submitting === po.id ? '...' : 'Ajukan'}
                          </Button>
                        )}
                        {po.status === 'DRAFT' && canDirectSubmit && (
                          <Button
                            size="sm"
                            className="shrink-0"
                            onClick={() => submitPo(po.id)}
                            disabled={submitting === po.id}
                          >
                            <Send className="w-3 h-3 mr-1" />
                            {submitting === po.id ? '...' : 'Kirim'}
                          </Button>
                        )}
                        {po.status === 'APPROVED' && canApprove && po.vendorSyncPending && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 border-emerald-300 text-emerald-800 hover:bg-emerald-50"
                            onClick={() => syncVendorPo(po.id)}
                            disabled={submitting === po.id}
                          >
                            <RefreshCw className={`w-3 h-3 mr-1 ${submitting === po.id ? 'animate-spin' : ''}`} />
                            {submitting === po.id ? '...' : 'Kirim ke vendor'}
                          </Button>
                        )}
                        {po.status === 'PENDING_APPROVAL' && canApprove && (
                          <>
                            <Button
                              size="sm"
                              className="shrink-0 bg-green-600 hover:bg-green-700"
                              onClick={() => approvePo(po.id)}
                              disabled={submitting === po.id}
                            >
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              {submitting === po.id ? '...' : 'Setujui'}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="shrink-0"
                              onClick={() => rejectPo(po.id)}
                              disabled={submitting === po.id}
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
                              {formatDateTime(po.createdAt || po.tanggal)}
                            </span>
                            {po.requestedAt && (
                              <span>
                                <span className="font-medium text-slate-700">Diajukan:</span>{' '}
                                {formatDateTime(po.requestedAt)}
                              </span>
                            )}
                            {po.approvedBy?.userName && (
                              <span>
                                <span className="font-medium text-slate-700">Disetujui:</span>{' '}
                                {po.approvedBy.userName}
                                {po.approvedAt && ` · ${formatDateTime(po.approvedAt)}`}
                              </span>
                            )}
                            {po.lastEditedBy?.userName && (
                              <span>
                                <span className="font-medium text-slate-700">Terakhir diedit:</span>{' '}
                                {po.lastEditedBy.userName}
                                {po.lastEditedAt && ` · ${formatDateTime(po.lastEditedAt)}`}
                              </span>
                            )}
                          </div>
                          {po.vendorSyncError && po.status === 'APPROVED' && (
                            <p className="text-xs text-amber-700 mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
                              <span className="font-medium">Antrian kirim ke vendor:</span> {po.vendorSyncError}
                              <span className="block text-[10px] text-amber-600 mt-0.5">
                                Akan dikirim otomatis saat sales.app online (atau klik Kirim ke vendor)
                              </span>
                            </p>
                          )}
                          {po.catatan && (
                            <p className="text-xs text-slate-600 mb-2"><span className="font-medium">Catatan:</span> {po.catatan}</p>
                          )}
                          {po.rejectReason && (
                            <p className="text-xs text-red-600 mb-2"><span className="font-medium">Alasan ditolak:</span> {po.rejectReason}</p>
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
                              {(po.items || []).map((it) => (
                                <tr key={it.lineId || it.kode} className="border-b border-slate-100 last:border-0">
                                  <td className="py-1.5 pr-2 font-mono">{it.kode}</td>
                                  <td className="py-1.5 pr-2">{it.nama}</td>
                                  <td className="py-1.5 text-right whitespace-nowrap text-slate-600">
                                    {it.estimasiHarga ? formatIDR(it.estimasiHarga) : '—'}
                                  </td>
                                  <td className="py-1.5 text-right whitespace-nowrap">{formatNumber(it.qty)}</td>
                                  <td className="py-1.5 text-center text-slate-600">{it.satuan || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {(po.vendorNoDO || po.vendorNoInvoice) && (
                            <div className="mt-2 text-xs text-slate-600">
                              {po.vendorNoDO && <span className="mr-3">DO: {po.vendorNoDO}</span>}
                              {po.vendorNoInvoice && <span>Invoice: {po.vendorNoInvoice}</span>}
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

      <Dialog open={createOpen} onOpenChange={(open) => {
        setCreateOpen(open);
        if (!open) setEditingPo(null);
      }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5 text-orange-500" />
              {editingPo ? `Edit PO ${editingPo.noPO}` : 'Buat PO Baru'}
            </DialogTitle>
            <DialogDescription>
              {editingPo
                ? `Perbarui detail PO sebelum ${editingPo.status === 'PENDING_APPROVAL' ? 'disetujui' : 'diajukan/dikirim'}`
                : `Permintaan kedatangan barang: ${createDate ? formatArrivalLabel(createDate) : '—'}`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="rounded-lg border bg-slate-50/80 p-3">
              <Label className="text-xs text-slate-500 uppercase tracking-wide">Tanggal kedatangan</Label>
              <Input
                type="date"
                className="mt-1 bg-white max-w-xs"
                value={toDateInputValue(createDate)}
                onChange={(e) => setCreateDate(e.target.value ? new Date(`${e.target.value}T12:00:00`) : null)}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold">Detail barang</Label>
                <Button variant="outline" size="sm" type="button" onClick={addLine}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Tambah baris
                </Button>
              </div>

              <div className="border rounded-lg overflow-hidden">
                <div className="hidden sm:grid sm:grid-cols-[2rem_minmax(0,1fr)_8.5rem_5.5rem_4.5rem_2.5rem] gap-x-3 gap-y-0 px-3 py-2 bg-slate-100 text-[11px] uppercase tracking-wide text-slate-600 font-medium items-end">
                  <span>#</span>
                  <span>Produk</span>
                  <span className="text-right">Estimasi harga</span>
                  <span className="text-right">Qty</span>
                  <span className="text-center">Satuan</span>
                  <span aria-hidden="true" />
                </div>
                <div className="divide-y">
                  {lineDetails.map((l, i) => {
                    const hint = l.product
                      ? getEstimasiHargaHint(l.product, vendorTierMap, defaultTier, l.estimasiManual, l.estimasiHarga)
                      : null;
                    return (
                    <div key={i} className="flex flex-col sm:grid sm:grid-cols-[2rem_minmax(0,1fr)_8.5rem_5.5rem_4.5rem_2.5rem] gap-x-3 gap-y-2 px-3 py-3 items-start">
                      <span className="text-xs text-slate-400 pt-2 hidden sm:inline">{i + 1}</span>
                      <div className="w-full min-w-0 sm:col-span-1">
                        <span className="text-xs text-slate-400 sm:hidden mb-1 block">Baris {i + 1}</span>
                        <ProductSearchSelect
                          products={synced}
                          value={l.localStokId}
                          onChange={(id) => selectProduct(i, id)}
                          placeholder="Cari / pilih produk…"
                        />
                        {l.product && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{l.product.kode}</span>
                            {l.product.grup && (
                              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">{l.product.grup}</span>
                            )}
                            {vendorDisplayName(l.product) && (
                              <span className="rounded bg-orange-50 px-1.5 py-0.5 text-orange-700">{vendorDisplayName(l.product)}</span>
                            )}
                            <ProductStockReminder product={l.product} className="contents" />
                          </div>
                        )}
                      </div>
                      <div className="w-full sm:w-auto shrink-0">
                        <Label className="text-[10px] text-slate-500 uppercase sm:sr-only mb-1 block">Estimasi harga</Label>
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          disabled={!l.product}
                          placeholder="Rp / satuan"
                          className="text-right h-9 tabular-nums"
                          value={l.estimasiHarga}
                          onChange={(e) => updateLine(i, {
                            estimasiHarga: e.target.value,
                            estimasiManual: true,
                          })}
                        />
                        {hint && (
                          <p className="mt-1 text-[10px] text-slate-500 text-right leading-snug">
                            {hint.kind === 'local' && hint.beli > 0 && (
                              <>
                                {formatIDR(hint.beli)}
                                <span className="text-orange-600 font-medium"> +10%</span>
                                {' → '}
                                <span className="font-medium text-slate-700">{formatIDR(hint.withBuffer)}</span>
                              </>
                            )}
                            {(hint.kind === 'vendor' || hint.kind === 'manual') && (
                              hint.beli > 0 && hint.deltaPct != null ? (
                                <span>
                                  <span className={cn(
                                    'font-medium',
                                    hint.deltaPct > 0 ? 'text-orange-600' : hint.deltaPct < 0 ? 'text-green-700' : 'text-slate-600',
                                  )}
                                  >
                                    {formatBeliDeltaSign(hint.deltaPct)}
                                  </span>
                                  {' dari harga beli di gudang '}
                                  <span className="font-medium text-slate-700">{formatIDR(hint.beli)}</span>
                                </span>
                              ) : (
                                <span className="text-slate-400">Belum ada harga beli di gudang</span>
                              )
                            )}
                            {hint.kind === 'local' && hint.beli <= 0 && hint.label}
                          </p>
                        )}
                      </div>
                      <div className="w-full sm:w-auto shrink-0">
                        <Label className="text-[10px] text-slate-500 uppercase sm:sr-only mb-1 block">Qty</Label>
                        <Input
                          type="number"
                          min={0.01}
                          step="any"
                          className="text-right h-9 w-full sm:w-full tabular-nums"
                          value={l.qty}
                          onChange={(e) => updateLine(i, { qty: e.target.value })}
                        />
                      </div>
                      <div className="w-full sm:w-auto shrink-0 flex flex-col">
                        <Label className="text-[10px] text-slate-500 uppercase sm:sr-only mb-1 block">Satuan</Label>
                        <span className={cn(
                          'inline-flex h-9 w-full items-center justify-center rounded-md border px-2 text-xs font-semibold',
                          l.product?.satuan
                            ? 'bg-white text-slate-700 border-slate-200'
                            : 'bg-slate-50 text-slate-400 border-dashed',
                        )}
                        >
                          {l.product?.satuan || '—'}
                        </span>
                      </div>
                      <div className="flex justify-end sm:justify-center sm:pt-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 text-slate-400 hover:text-red-600"
                          onClick={() => removeLine(i)}
                          disabled={lines.length <= 1}
                          title="Hapus baris"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>

              {lineSummary.rows > 0 && (
                <p className="text-xs text-slate-500 text-right">
                  {lineSummary.rows} baris · total {formatNumber(lineSummary.totalQty)} unit
                  {lineSummary.totalEstimasi > 0 && (
                    <> · estimasi {formatIDR(lineSummary.totalEstimasi)}</>
                  )}
                </p>
              )}
            </div>

            <div>
              <Label>Catatan PO</Label>
              <Input
                value={catatan}
                onChange={(e) => setCatatan(e.target.value)}
                placeholder="Instruksi khusus untuk vendor (opsional)"
                className="mt-1"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" type="button" onClick={() => { setCreateOpen(false); setEditingPo(null); }}>Batal</Button>
            <Button
              onClick={editingPo ? saveEditPo : createPo}
              disabled={saving}
              className="bg-orange-500 hover:bg-orange-600"
            >
              {saving ? 'Menyimpan...' : editingPo ? 'Simpan Perubahan' : 'Simpan PO (DRAFT)'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
