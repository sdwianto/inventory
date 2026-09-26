'use client';

import { str, num, asArray, asObject, type JsonObject } from '@/types/json';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { FileEdit, Plus, Trash2, Save, X, Eye, Send, Check, Ban, Pencil } from 'lucide-react';
import { formatNumber, formatDateTime } from '@/lib/format';
import { useSessionUser } from '@/lib/hooks/use-session-user';
import ListExportMenu from '@/components/ListExportMenu';
import ProductPickerSearch from '@/components/ProductPickerSearch';
import LineUomSelect from '@/components/uom/LineUomSelect';
import { fetchDefaultProductUom, fetchProductUomsForIds } from '@/lib/hooks/use-product-uoms';
import { usePrimeLineItemUoms } from '@/lib/hooks/use-prime-line-uoms';
import { findUomByIdOrSatuan, lineUomKey, qtyInUom } from '@/lib/uom/line-ui';
import type { ProductUom } from '@/lib/uom/types';
import { runListExport, type ListExportFormat } from '@/lib/run-list-export';
import { flattenPenyesuaianDocLines } from '@/lib/export/flatten-doc-lines';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { queryKeys } from '@/lib/query-keys';
import { fetchJson } from '@/lib/fetch-json';
import { StockReversalSection, PendingStockReversals } from '@/components/stok/StockReversal';

const STOCK_ADJUST_ROLES = ['SUPERVISOR', 'ADMIN', 'OWNER', 'MASTER'];
const STOCK_ADJUST_DRAFT_ROLES = ['GUDANG', ...STOCK_ADJUST_ROLES];

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'bg-slate-100 text-slate-700' },
  PENDING_APPROVAL: { label: 'Menunggu persetujuan', cls: 'bg-amber-100 text-amber-800' },
  POSTING: { label: 'Memposting', cls: 'bg-blue-100 text-blue-700' },
  POSTED: { label: 'Posted', cls: 'bg-green-100 text-green-700' },
  REJECTED: { label: 'Ditolak', cls: 'bg-red-100 text-red-700' },
  CANCELLED: { label: 'Dibatalkan', cls: 'bg-slate-200 text-slate-500' },
  REVERSED: { label: 'Dibalik', cls: 'bg-purple-100 text-purple-700' },
};

type AdjustConfig = { approvalRequired: boolean; reasonCodes: Array<{ code: string; label: string }> };

function docStatus(d: JsonObject | null | undefined): string {
  return str(d?.status) || 'POSTED';
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABEL[status] || { label: status, cls: 'bg-slate-100 text-slate-700' };
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

export default function PenyesuaianPage() {
  const user = useSessionUser();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingUpdatedAt, setEditingUpdatedAt] = useState<string | null>(null);
  const [detail, setDetail] = useState<JsonObject | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [keterangan, setKeterangan] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [items, setItems] = useState<JsonObject[]>([]);
  const [saving, setSaving] = useState(false);

  usePrimeLineItemUoms(showForm, items.map((it) => str(it.stokId)));

  const { data: listData = [], refetch: refetchList } = useApiQuery<JsonObject[]>(
    queryKeys.penyesuaian.list,
    '/api/stok/penyesuaian',
  );
  const { data: configData } = useApiQuery<AdjustConfig>(
    [...queryKeys.penyesuaian.all, 'config'],
    '/api/stok/penyesuaian/config',
  );
  const approvalRequired = configData?.approvalRequired === true;
  const reasonCodes = configData?.reasonCodes || [];
  const reasonLabel = (code: unknown) => reasonCodes.find((r) => r.code === str(code))?.label || str(code) || '-';

  const list = Array.isArray(listData) ? listData : [];

  const saveMutation = useApiMutation<Record<string, unknown>, JsonObject>([queryKeys.penyesuaian.all, queryKeys.products.all]);
  const actionMutation = useApiMutation<Record<string, unknown>, JsonObject>([queryKeys.penyesuaian.all, queryKeys.products.all]);

  const role = str(user?.role);
  const isMaster = role === 'MASTER';
  const canApproveRole = STOCK_ADJUST_ROLES.includes(role);
  const canCreate = approvalRequired ? STOCK_ADJUST_DRAFT_ROLES.includes(role) : canApproveRole;

  const openNew = () => {
    setItems([]); setKeterangan(''); setReasonCode(''); setEditingId(null); setEditingUpdatedAt(null); setShowForm(true);
  };

  const openEditDraft = async (d: JsonObject) => {
    const lines = asArray(d.items).map((raw) => asObject(raw));
    const uomsById = await fetchProductUomsForIds(lines.map((l) => str(l.stokId)));
    setItems(lines.map((l) => {
      const uom = findUomByIdOrSatuan(uomsById.get(str(l.stokId)) || [], str(l.uomId), str(l.satuan));
      const base = num(l.qtySistem);
      const counted = l.qtyAktual == null ? '' : (l.qtyEntered ?? qtyInUom(num(l.qtyAktual), uom));
      return {
        stokId: l.stokId, kode: l.kode, nama: l.nama,
        uomId: uom?.id || str(l.uomId), satuan: uom?.satuan || str(l.satuan),
        gudangKode: l.gudangKode, qtySistemBase: base, qtySistem: qtyInUom(base, uom), qtyAktual: counted,
      };
    }));
    setKeterangan(str(d.keterangan));
    setReasonCode(str(d.reasonCode));
    setEditingId(str(d.id));
    setEditingUpdatedAt(str(d.updatedAt) || null);
    setDetail(null);
    setShowForm(true);
  };

  const addProduct = async (p: JsonObject) => {
    const id = str(p.id);
    const defaultUom = await fetchDefaultProductUom(id);
    const uomId = defaultUom?.id || '';
    if (items.find((it) => str(it.stokId) === id || lineUomKey(str(it.stokId), str(it.uomId)) === lineUomKey(id, uomId))) {
      toast.error('Produk sudah ada di daftar');
      return;
    }
    const gudangKode = str(p.gudangKode, 'GKERING').toUpperCase();
    const stokByWarehouse = asObject(p.stokByWarehouse);
    const qtySistemBase = num(stokByWarehouse[gudangKode] ?? 0);
    const qtyDisplay = qtyInUom(qtySistemBase, defaultUom);
    setItems([...items, {
      stokId: p.id, kode: p.kode, nama: p.nama,
      uomId, satuan: defaultUom?.satuan || p.satuan,
      gudangKode, qtySistemBase, qtySistem: qtyDisplay, qtyAktual: approvalRequired ? '' : qtyDisplay,
    }]);
    setShowPicker(false);
  };

  const updateItemUom = (idx: number, uom: ProductUom) => {
    setItems(items.map((it, i) => {
      if (i !== idx) return it;
      const base = num(it.qtySistemBase ?? it.qtySistem);
      const display = qtyInUom(base, uom);
      return { ...it, uomId: uom.id, satuan: uom.satuan, qtySistem: display, qtyAktual: it.qtyAktual === '' ? '' : display };
    }));
  };

  const updateAktual = (idx: number, val: string) => {
    setItems(items.map((it, i) => i === idx ? { ...it, qtyAktual: val === '' ? '' : parseFloat(val) } : it));
  };
  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  const payloadItems = () => items.map((it) => ({
    stokId: str(it.stokId),
    kode: str(it.kode),
    qtyAktual: it.qtyAktual === '' || it.qtyAktual == null ? null : num(it.qtyAktual),
    uomId: str(it.uomId),
    satuan: str(it.satuan),
  }));

  const save = async (mode: 'draft' | 'submit' | 'post') => {
    if (items.length === 0) { toast.error('Belum ada item'); return; }
    if (mode !== 'draft' && !reasonCode) { toast.error('Pilih alasan penyesuaian'); return; }
    setSaving(true);
    try {
      let data: JsonObject;
      if (editingId) {
        data = await saveMutation.mutateAsync({
          url: `/api/stok/penyesuaian/${editingId}`,
          method: 'PUT',
          body: { keterangan, reasonCode: reasonCode || null, items: payloadItems(), updatedAt: editingUpdatedAt },
        });
        if (mode === 'submit') {
          data = await actionMutation.mutateAsync({ url: `/api/stok/penyesuaian/${editingId}/submit`, body: {} });
        }
      } else {
        data = await saveMutation.mutateAsync({
          url: '/api/stok/penyesuaian',
          body: { keterangan, reasonCode: reasonCode || null, items: payloadItems(), submit: mode === 'submit' },
        });
      }
      const no = str(data.noPenyesuaian);
      toast.success(mode === 'draft' ? `Draft ${no} tersimpan` : mode === 'submit' ? `Penyesuaian ${no} diajukan` : `Penyesuaian ${no} berhasil`);
      setShowForm(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    setSaving(false);
  };

  const runAction = async (action: 'submit' | 'approve' | 'reject' | 'cancel') => {
    if (!detail) return;
    if (action === 'reject' && !rejectReason.trim()) { toast.error('Isi alasan penolakan'); return; }
    try {
      const data = await actionMutation.mutateAsync({
        url: `/api/stok/penyesuaian/${str(detail.id)}/${action}`,
        body: action === 'reject' ? { reason: rejectReason.trim() } : {},
      });
      const msg = { submit: 'diajukan', approve: 'disetujui & diposting', reject: 'ditolak', cancel: 'dibatalkan' }[action];
      toast.success(`Penyesuaian ${str(data.noPenyesuaian)} ${msg}`);
      setRejectReason('');
      setDetail(data);
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const reloadAfterReversal = async () => {
    void refetchList();
    if (!detail) return;
    try {
      setDetail(await fetchJson<JsonObject>(`/api/stok/penyesuaian/${encodeURIComponent(str(detail.id))}`));
    } catch { /* detail tetap; daftar sudah dimuat ulang */ }
  };

  const exportData = async (format: ListExportFormat) => {
    try {
      const rows = list;
      if (!rows.length) { toast.error('Tidak ada data'); return; }
      const flat = flattenPenyesuaianDocLines(rows);
      const stamp = new Date().toISOString().slice(0, 10);
      await runListExport(format, {
        baseName: `penyesuaian-stok-${stamp}`,
        title: 'Penyesuaian Stok',
        columns: [
          { key: 'tanggal', label: 'Tanggal', value: (r) => formatDateTime(str(r.tanggal)) },
          { key: 'noPenyesuaian', label: 'No.' },
          { key: 'status', label: 'Status', value: (r) => STATUS_LABEL[docStatus(r)]?.label || docStatus(r) },
          { key: 'reasonCode', label: 'Alasan', value: (r) => reasonLabel(r.reasonCode) },
          { key: 'keterangan', label: 'Keterangan', value: (r) => str(r.keterangan) || '-' },
          { key: 'userName', label: 'User', value: (r) => str(r.userName) || '-' },
          { key: 'itemKode', label: 'Kode' },
          { key: 'itemNama', label: 'Nama' },
          { key: 'itemSatuan', label: 'Satuan' },
          { key: 'itemQtySistem', label: 'Qty Sistem' },
          { key: 'itemQtyAktual', label: 'Qty Aktual' },
          { key: 'itemSelisih', label: 'Selisih (base)' },
        ],
        rows: flat,
      });
      toast.success(`${flat.length} baris diekspor`);
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  if (user && !STOCK_ADJUST_DRAFT_ROLES.includes(role)) {
    return (
      <div className="p-8 text-center text-slate-500">
        <FileEdit className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="font-medium text-slate-700">Akses ditolak</p>
        <p className="text-sm mt-1">Penyesuaian stok hanya untuk Gudang, Supervisor, dan Admin.</p>
      </div>
    );
  }

  const detailStatus = docStatus(detail);
  const makers = [
    asObject(detail?.createdBy),
    asObject(detail?.submittedBy),
    ...asArray(detail?.editorIds).map((userId) => ({ userId })),
  ];
  const isMaker = !!user?.id && makers.some((m) => str(m.userId) === user.id);
  const canApproveDetail = canApproveRole && (!isMaker || isMaster);
  const canCancelDetail = isMaker || canApproveRole;

  return (
    <>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><FileEdit className="w-6 h-6" /> Penyesuaian Stok</h1>
            <p className="text-sm text-slate-500">
              {approvalRequired
                ? 'Stock opname dengan persetujuan: draft → ajukan → disetujui Supervisor/Admin lain → posting.'
                : 'Stock opname: sinkronkan stok + FG batch + lot bahan.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ListExportMenu onExport={exportData} disabled={list.length === 0} />
            {canCreate && (
              <Button onClick={openNew} className="bg-orange-500 hover:bg-orange-600">
                <Plus className="w-4 h-4 mr-2" /> Penyesuaian Baru
              </Button>
            )}
          </div>
        </div>

        <PendingStockReversals sourceType="PENYESUAIAN" refreshKey={list.length} onChanged={() => { void refetchList(); }} />

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-left">No.</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Alasan</th>
                <th className="px-3 py-2 text-left">Keterangan</th>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-right">Jml Item</th>
                <th className="px-3 py-2 text-center w-20">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={8} className="text-center py-10 text-slate-400">Belum ada penyesuaian</td></tr>}
              {list.map((d) => (
                <tr key={str(d.id)} className="border-t hover:bg-slate-50">
                  <td className="px-3 py-2 text-xs">{formatDateTime(str(d.tanggal))}</td>
                  <td className="px-3 py-2 font-mono text-xs">{str(d.noPenyesuaian)}</td>
                  <td className="px-3 py-2"><StatusBadge status={docStatus(d)} /></td>
                  <td className="px-3 py-2 text-xs">{reasonLabel(d.reasonCode)}</td>
                  <td className="px-3 py-2">{str(d.keterangan) || '-'}</td>
                  <td className="px-3 py-2 text-xs">{str(d.userName) || '-'}</td>
                  <td className="px-3 py-2 text-right">{asArray(d.items).length}</td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => { setRejectReason(''); setDetail(d); }} className="p-1.5 hover:bg-blue-50 text-blue-600 rounded"><Eye className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Form dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
          <DialogHeader><DialogTitle>{editingId ? 'Ubah Draft Penyesuaian' : 'Penyesuaian Stok Baru'}</DialogTitle></DialogHeader>
          <div className="space-y-3 overflow-y-auto">
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="text-xs text-slate-500">Alasan *</label>
                <select
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value)}
                  className="w-full border rounded px-2 py-2 text-sm bg-white"
                >
                  <option value="">— pilih alasan —</option>
                  {reasonCodes.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-slate-500">Keterangan{reasonCode === 'LAINNYA' ? ' *' : ''}</label>
                <Textarea value={keterangan} onChange={(e) => setKeterangan(e.target.value)} placeholder="Misal: Stock opname akhir bulan..." />
              </div>
            </div>
            {approvalRequired && (
              <p className="text-xs text-slate-500">
                Qty sistem dicatat saat draft pertama disimpan. Mutasi setelah itu tetap berlaku — yang diposting hanya selisih hitung terhadap qty sistem tersebut.
              </p>
            )}
            <div className="text-sm font-semibold">Daftar Item ({items.length})</div>
            <div className="border rounded">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-xs">
                  <tr>
                    <th className="px-2 py-2 text-left">Kode</th>
                    <th className="px-2 py-2 text-left">Nama</th>
                    <th className="px-2 py-2 text-left">Gudang</th>
                    <th className="px-2 py-2 text-right">Qty Sistem</th>
                    <th className="px-2 py-2 text-right">Qty Aktual</th>
                    <th className="px-2 py-2 text-center">Satuan</th>
                    <th className="px-2 py-2 text-right">Selisih</th>
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && <tr><td colSpan={8} className="text-center py-6 text-slate-400 text-xs">Belum ada item</td></tr>}
                  {items.map((it, i) => {
                    const counted = it.qtyAktual !== '' && it.qtyAktual != null;
                    const selisih = counted ? num(it.qtyAktual) - num(it.qtySistem) : 0;
                    return (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-2 font-mono text-xs">{str(it.kode)}</td>
                        <td className="px-2 py-2">{str(it.nama)}</td>
                        <td className="px-2 py-2 text-xs text-slate-600">{str(it.gudangKode) || '-'}</td>
                        <td className="px-2 py-2 text-right font-mono">{formatNumber(num(it.qtySistem))} {str(it.satuan)}</td>
                        <td className="px-2 py-2 text-right">
                          <input
                            type="number"
                            value={counted ? num(it.qtyAktual) : ''}
                            onChange={(e) => updateAktual(i, e.target.value)}
                            className="w-24 border rounded px-2 py-1 text-right"
                            step="0.01"
                            min="0"
                            placeholder="hitung"
                          />
                        </td>
                        <td className="px-2 py-2 text-center">
                          <LineUomSelect stokId={str(it.stokId)} uomId={str(it.uomId)} onChange={(uom) => updateItemUom(i, uom)} />
                        </td>
                        <td className={`px-2 py-2 text-right font-semibold ${selisih > 0 ? 'text-green-600' : selisih < 0 ? 'text-red-600' : 'text-slate-500'}`}>
                          {counted ? `${selisih > 0 ? '+' : ''}${formatNumber(selisih)}` : '—'}
                        </td>
                        <td className="px-2 py-2"><button onClick={() => removeItem(i)} className="text-red-500 hover:bg-red-50 p-1 rounded"><Trash2 className="w-4 h-4" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowPicker(true)}><Plus className="w-4 h-4 mr-1" /> Tambah Produk</Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}><X className="w-4 h-4 mr-1" /> Batal</Button>
            {approvalRequired ? (
              <>
                <Button variant="outline" onClick={() => save('draft')} disabled={saving || items.length === 0}>
                  <Save className="w-4 h-4 mr-1" /> Simpan Draft
                </Button>
                <Button onClick={() => save('submit')} disabled={saving || items.length === 0} className="bg-orange-500 hover:bg-orange-600">
                  <Send className="w-4 h-4 mr-1" /> {saving ? 'Menyimpan...' : 'Ajukan Persetujuan'}
                </Button>
              </>
            ) : (
              <Button onClick={() => save('post')} disabled={saving || items.length === 0} className="bg-orange-500 hover:bg-orange-600">
                <Save className="w-4 h-4 mr-1" /> {saving ? 'Menyimpan...' : 'Simpan Penyesuaian'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Product picker */}
      <Dialog open={showPicker} onOpenChange={setShowPicker}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader><DialogTitle>Pilih Produk</DialogTitle></DialogHeader>
          <ProductPickerSearch open={showPicker} withWarehouseStock onSelect={addProduct} />
        </DialogContent>
      </Dialog>

      {/* Detail */}
      <Dialog open={!!detail} onOpenChange={() => setDetail(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader><DialogTitle>Detail Penyesuaian {str(detail?.noPenyesuaian)}</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3 overflow-y-auto">
              <div className="bg-slate-50 rounded p-3 text-sm space-y-0.5">
                <div className="flex items-center gap-2">Status: <StatusBadge status={detailStatus} /></div>
                <div>Tanggal: {formatDateTime(str(detail.tanggal))}</div>
                <div>Alasan: {reasonLabel(detail.reasonCode)}</div>
                <div>Keterangan: {str(detail.keterangan) || '-'}</div>
                <div>Dibuat: {str(asObject(detail.createdBy).userName) || str(detail.userName) || '-'}</div>
                {str(asObject(detail.submittedBy).userName) && <div>Diajukan: {str(asObject(detail.submittedBy).userName)} · {formatDateTime(str(detail.submittedAt))}</div>}
                {str(asObject(detail.approvedBy).userName) && <div>Disetujui: {str(asObject(detail.approvedBy).userName)} · {formatDateTime(str(detail.approvedAt))}{detail.selfApprovedByMaster ? ' (MASTER, darurat)' : ''}</div>}
                {str(asObject(detail.rejectedBy).userName) && <div className="text-red-700">Ditolak: {str(asObject(detail.rejectedBy).userName)} — {str(detail.rejectReason)}</div>}
              </div>
              <StockReversalSection sourceType="PENYESUAIAN" doc={detail} eligible={detailStatus === 'POSTED' && !detail.source} onChanged={() => { void reloadAfterReversal(); }} />
              <table className="w-full text-sm border">
                <thead className="bg-slate-100 text-xs">
                  <tr>
                    <th className="px-2 py-2 text-left">Kode</th>
                    <th className="px-2 py-2 text-left">Nama</th>
                    <th className="px-2 py-2 text-center">Sat</th>
                    <th className="px-2 py-2 text-right">Sistem (base)</th>
                    <th className="px-2 py-2 text-right">Aktual</th>
                    <th className="px-2 py-2 text-right">Selisih (base)</th>
                  </tr>
                </thead>
                <tbody>
                  {asArray(detail.items).map((raw, i) => {
                    const it = asObject(raw);
                    const posted = it.selisih != null;
                    const itemSelisih = num(it.selisih);
                    return (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-2 font-mono text-xs">{str(it.kode)}</td>
                        <td className="px-2 py-2">{str(it.nama)}</td>
                        <td className="px-2 py-2 text-center text-xs uppercase">{str(it.satuan) || '—'}</td>
                        <td className="px-2 py-2 text-right">{formatNumber(num(it.qtySistem))}</td>
                        <td className="px-2 py-2 text-right">{it.qtyAktual == null ? '—' : formatNumber(num(it.qtyEntered ?? it.qtyAktual))}</td>
                        <td className={`px-2 py-2 text-right font-semibold ${itemSelisih > 0 ? 'text-green-600' : itemSelisih < 0 ? 'text-red-600' : ''}`}>
                          {posted ? `${itemSelisih > 0 ? '+' : ''}${formatNumber(itemSelisih)}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {detailStatus === 'PENDING_APPROVAL' && canApproveRole && (
                <div className="flex items-center gap-2">
                  <Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Alasan penolakan (wajib untuk tolak)" />
                </div>
              )}
              {detailStatus === 'PENDING_APPROVAL' && isMaker && !isMaster && (
                <p className="text-xs text-amber-700">Anda pembuat/pengubah/pengaju dokumen ini — persetujuan harus oleh Supervisor/Admin lain.</p>
              )}
            </div>
          )}
          {detail && (
            <DialogFooter className="flex-wrap gap-2">
              {detailStatus === 'DRAFT' && canCreate && (
                <>
                  <Button variant="outline" onClick={() => openEditDraft(detail)}><Pencil className="w-4 h-4 mr-1" /> Ubah</Button>
                  <Button onClick={() => runAction('submit')} className="bg-orange-500 hover:bg-orange-600"><Send className="w-4 h-4 mr-1" /> Ajukan</Button>
                </>
              )}
              {detailStatus === 'PENDING_APPROVAL' && canApproveRole && (
                <Button variant="outline" onClick={() => runAction('reject')} className="text-red-600"><Ban className="w-4 h-4 mr-1" /> Tolak</Button>
              )}
              {detailStatus === 'PENDING_APPROVAL' && canApproveDetail && (
                <Button onClick={() => runAction('approve')} className="bg-green-600 hover:bg-green-700"><Check className="w-4 h-4 mr-1" /> Setujui & Posting</Button>
              )}
              {(detailStatus === 'DRAFT' || detailStatus === 'PENDING_APPROVAL') && canCancelDetail && (
                <Button variant="outline" onClick={() => runAction('cancel')}><X className="w-4 h-4 mr-1" /> Batalkan Dokumen</Button>
              )}
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
