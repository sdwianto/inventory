'use client';

import { useEffect, useMemo, useState } from 'react';
import { startOfMonth } from 'date-fns';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import PoCalendar from '@/components/PoCalendar';
import ProductSearchSelect from '@/components/ProductSearchSelect';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  CalendarDays, ChevronDown, ChevronRight, Package, Plus, Send, ShoppingBag, Trash2,
} from 'lucide-react';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
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

export default function CustomerPoPage() {
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDate, setCreateDate] = useState(null);
  const [lines, setLines] = useState([{ localStokId: '', qty: 1 }]);
  const [catatan, setCatatan] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const load = () => fetch('/api/customer-purchase-orders').then((r) => r.json()).then(setList);
  useEffect(() => {
    load();
    fetch('/api/products?limit=500').then((r) => r.json()).then(setProducts);
  }, []);

  const synced = products.filter((p) => p.syncSource === 'sales.app');

  const filteredList = useMemo(() => {
    const rows = Array.isArray(list) ? list : [];
    if (showAll || !selectedDate) return rows;
    const key = dateKey(selectedDate);
    return rows.filter((po) => dateKey(getPoArrivalDate(po)) === key);
  }, [list, selectedDate, showAll]);

  const openCreate = (date) => {
    const d = date || selectedDate || new Date();
    setCreateDate(d);
    setLines([{ localStokId: '', qty: 1 }]);
    setCatatan('');
    setCreateOpen(true);
  };

  const handleSelectDate = (date) => {
    setSelectedDate(date);
    setShowAll(false);
    setMonth(startOfMonth(date));
  };

  const addLine = () => setLines([...lines, { localStokId: '', qty: 1 }]);
  const removeLine = (i) => setLines(lines.length > 1 ? lines.filter((_, idx) => idx !== i) : lines);
  const updateLine = (i, patch) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const lineDetails = useMemo(() => lines.map((l) => {
    const p = synced.find((x) => x.id === l.localStokId);
    return { ...l, product: p || null };
  }), [lines, synced]);

  const lineSummary = useMemo(() => {
    const filled = lineDetails.filter((l) => l.product && l.qty);
    const totalQty = filled.reduce((s, l) => s + (parseFloat(l.qty) || 0), 0);
    return { rows: filled.length, totalQty };
  }, [lineDetails]);

  const createPo = async () => {
    const items = lines.map((l) => {
      const p = products.find((x) => x.id === l.localStokId);
      if (!p || !l.qty) return null;
      if (!p.vendorStokId && p.syncSource !== 'sales.app') return null;
      return {
        localStokId: p.id,
        vendorStokId: p.vendorStokId,
        vendorTenantId: p.vendorTenantId,
        vendorKode: p.kode,
        kode: p.kode,
        nama: p.nama,
        satuan: p.satuan,
        qty: parseFloat(l.qty) || 0,
      };
    }).filter(Boolean);
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
      setSelectedDate(createDate);
      setShowAll(false);
      setExpandedId(data.id);
      load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const submitPo = async (id) => {
    setSubmitting(id);
    const res = await fetch(`/api/customer-purchase-orders/${id}/submit`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) toast.error(data.error || 'Gagal kirim ke sales.app');
    else if (data.vendorSubmissions?.length > 1) {
      toast.success(`Dikirim → ${data.vendorSubmissions.length} SO vendor: ${data.vendorSubmissions.map((s) => s.vendorNoSO).join(', ')}`);
    } else {
      toast.success(`Dikirim → SO vendor ${data.vendorNoSO || data.vendorSoId || ''}`);
    }
    load();
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
              Jadwalkan permintaan kedatangan barang per tanggal → kirim ke sales.app
            </p>
          </div>
          <Button onClick={() => openCreate(selectedDate || new Date())} className="bg-orange-500 hover:bg-orange-600">
            <Plus className="w-4 h-4 mr-1" /> Buat PO
          </Button>
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
                {selectedDate && (
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
                              {po.vendorNoSO && ` · SO: ${po.vendorNoSO}`}
                            </div>
                          </div>
                        </button>
                        {po.status === 'DRAFT' && (
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
                      </div>
                      {open && (
                        <div className="border-t bg-slate-50/50 px-3 py-2 text-sm">
                          {po.catatan && (
                            <p className="text-xs text-slate-600 mb-2"><span className="font-medium">Catatan:</span> {po.catatan}</p>
                          )}
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-slate-500 border-b">
                                <th className="text-left py-1 pr-2">Kode</th>
                                <th className="text-left py-1 pr-2">Produk</th>
                                <th className="text-right py-1 pr-2">Qty</th>
                                <th className="text-center py-1">Satuan</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(po.items || []).map((it) => (
                                <tr key={it.lineId || it.kode} className="border-b border-slate-100 last:border-0">
                                  <td className="py-1.5 pr-2 font-mono">{it.kode}</td>
                                  <td className="py-1.5 pr-2">{it.nama}</td>
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5 text-orange-500" />
              Buat PO Baru
            </DialogTitle>
            <DialogDescription>
              Permintaan kedatangan barang: {createDate ? formatArrivalLabel(createDate) : '—'}
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
                <div className="hidden sm:grid sm:grid-cols-[2rem_1fr_auto] gap-2 px-3 py-2 bg-slate-100 text-xs uppercase text-slate-600 font-medium">
                  <span>#</span>
                  <span>Produk</span>
                  <span className="text-right pr-1">Qty · Satuan</span>
                </div>
                <div className="divide-y">
                  {lineDetails.map((l, i) => (
                    <div key={i} className="flex flex-col sm:grid sm:grid-cols-[2rem_1fr_auto] gap-2 sm:gap-3 px-3 py-3 items-start">
                      <span className="text-xs text-slate-400 pt-2">{i + 1}</span>
                      <div className="w-full min-w-0">
                        <ProductSearchSelect
                          products={synced}
                          value={l.localStokId}
                          onChange={(id) => updateLine(i, { localStokId: id })}
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
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0 self-start sm:pt-0.5 w-full sm:w-auto justify-end">
                        <div className="flex flex-col gap-0.5">
                          <Label className="text-[10px] text-slate-400 uppercase sm:sr-only">Qty</Label>
                          <Input
                            type="number"
                            min={0.01}
                            step="any"
                            className="text-right h-9 w-28 min-w-[7rem] tabular-nums"
                            value={l.qty}
                            onChange={(e) => updateLine(i, { qty: e.target.value })}
                          />
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <Label className="text-[10px] text-slate-400 uppercase sm:sr-only">Satuan</Label>
                          <span className={cn(
                            'inline-flex h-9 min-w-[4.5rem] items-center justify-center rounded-md border px-3 text-xs font-semibold',
                            l.product?.satuan
                              ? 'bg-white text-slate-700 border-slate-200'
                              : 'bg-slate-50 text-slate-400 border-dashed',
                          )}
                          >
                            {l.product?.satuan || '—'}
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 text-slate-400 hover:text-red-600 self-end sm:self-center"
                          onClick={() => removeLine(i)}
                          disabled={lines.length <= 1}
                          title="Hapus baris"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {lineSummary.rows > 0 && (
                <p className="text-xs text-slate-500 text-right">
                  {lineSummary.rows} baris · total {formatNumber(lineSummary.totalQty)} unit
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
            <Button variant="outline" type="button" onClick={() => setCreateOpen(false)}>Batal</Button>
            <Button onClick={createPo} disabled={saving} className="bg-orange-500 hover:bg-orange-600">
              {saving ? 'Menyimpan...' : 'Simpan PO (DRAFT)'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
