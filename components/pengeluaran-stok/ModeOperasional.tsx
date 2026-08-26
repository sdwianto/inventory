'use client';

import { str, num, asArray, asObject, type JsonObject } from '@/types/json';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useSessionUser } from '@/lib/hooks/use-session-user';
import { fetchJson } from '@/lib/fetch-json';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { queryKeys } from '@/lib/query-keys';
import { OfflineQueuedError } from '@/lib/offline-mutation-queue';
import { WAREHOUSES } from '@/lib/warehouses-client';
import { ArrowUpFromLine, Plus, CheckCircle2, XCircle, Send } from 'lucide-react';
import LineUomSelect from '@/components/uom/LineUomSelect';
import { fetchDefaultProductUom } from '@/lib/hooks/use-product-uoms';
import { usePrimeLineItemUoms } from '@/lib/hooks/use-prime-line-uoms';
import { lineUomKey } from '@/lib/uom/line-ui';
import type { ProductUom } from '@/lib/uom/types';

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800',
  POSTED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-slate-100 text-slate-500',
};

const CAN_CREATE = ['GUDANG', 'ADMIN', 'MASTER'];
const CAN_APPROVE = ['SUPERVISOR', 'ADMIN', 'MASTER'];

function qtyAtLokasi(p: JsonObject, lokasiKode: string): number {
  const byWh = asObject(p.stokByWarehouse);
  const kode = lokasiKode.trim().toUpperCase();
  if (kode && kode in byWh) return num(byWh[kode]);
  return num(p.stokQty ?? p.stokTotal);
}

export function ModeOperasional() {
  const user = useSessionUser();
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<{
    lokasiKode: string;
    keperluan: string;
    keterangan: string;
    maintenanceRequestId: string;
    assetId: string;
    items: JsonObject[];
  }>({
    lokasiKode: 'GKERING',
    keperluan: '',
    keterangan: '',
    maintenanceRequestId: '',
    assetId: '',
    items: [],
  });
  const searchParams = useSearchParams();
  const wrPrefillDone = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState('');
  const [detail, setDetail] = useState<JsonObject | null>(null);

  usePrimeLineItemUoms(showForm, form.items.map((it) => str(it.stokId)));

  useEffect(() => {
    if (!form.lokasiKode || form.items.length === 0) return;
    queueMicrotask(() => {
      setForm((prev) => ({
        ...prev,
        items: prev.items.map((it) => ({
          ...it,
          stokAvail: qtyAtLokasi(it, prev.lokasiKode),
        })),
      }));
    });
  }, [form.lokasiKode, form.items.length]);

  const { data: listData = [] } = useApiQuery<JsonObject[]>(
    queryKeys.inventoryReleases.list,
    '/api/inventory-releases',
  );

  const { data: saldoData } = useApiQuery<JsonObject>(
    queryKeys.stokSaldo.list,
    '/api/stok/saldo',
    { enabled: showForm || pickerOpen },
  );

  const list = Array.isArray(listData) ? listData : [];
  const products = useMemo(
    () => asArray(asObject(saldoData).rows) as JsonObject[],
    [saldoData],
  );

  const saveMutation = useApiMutation<
    typeof form & { submit?: boolean },
    JsonObject
  >([queryKeys.inventoryReleases.all, queryKeys.stokSaldo.all]);

  const actionMutation = useApiMutation<JsonObject, JsonObject>(
    [queryKeys.inventoryReleases.all, queryKeys.stokSaldo.all],
  );

  useEffect(() => {
    const wrId = searchParams.get('wrId');
    if (!wrId || wrPrefillDone.current) return;
    wrPrefillDone.current = true;
    fetchJson<JsonObject>(`/api/maintenance-requests/${wrId}/resolve-prefill`)
      .then((data) => {
        if (!data.canResolveInternal) {
          toast.error('Permintaan tidak bisa release stok');
          return;
        }
        setForm((f) => ({
          ...f,
          keperluan: str(data.releaseKeperluan),
          keterangan: `[${str(data.noWR)}] ${str(data.judul)}`.trim(),
          maintenanceRequestId: str(data.id),
          assetId: str(data.assetId),
        }));
        setShowForm(true);
        toast.info(`Release stok untuk ${str(data.noWR)}`);
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Gagal memuat WR'));
  }, [searchParams]);

  const canCreate = CAN_CREATE.includes(str(user?.role));
  const canApprove = CAN_APPROVE.includes(str(user?.role));
  const isAdminApprover = ['ADMIN', 'MASTER'].includes(str(user?.role));

  const renderPendingActions = (r: JsonObject) => {
    if (str(r.status) !== 'PENDING_APPROVAL' || !canApprove) return null;

    const createdBy = asObject(r.createdBy);
    const isOwn = str(createdBy.userId) === str(user?.id);

    if (isAdminApprover) {
      return (
        <>
          <Button
            size="sm"
            className="h-8 bg-green-600 hover:bg-green-700 whitespace-nowrap"
            onClick={() => action(str(r.id), 'approve')}
          >
            <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
            {isOwn ? 'Admin Approve' : 'Approve'}
          </Button>
          {!isOwn && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 whitespace-nowrap text-red-700 border-red-200 hover:bg-red-50"
              onClick={() => action(str(r.id), 'reject', { reason: 'Dibatalkan admin' })}
            >
              <XCircle className="w-3.5 h-3.5 mr-1" />
              Batal
            </Button>
          )}
        </>
      );
    }

    if (isOwn) return null;

    return (
      <>
        <Button
          size="sm"
          className="h-8 bg-green-600 hover:bg-green-700 whitespace-nowrap"
          onClick={() => action(str(r.id), 'approve')}
        >
          <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
          Setujui
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 whitespace-nowrap text-red-700 border-red-200 hover:bg-red-50"
          onClick={() => action(str(r.id), 'reject', { reason: 'Ditolak supervisor' })}
        >
          <XCircle className="w-3.5 h-3.5 mr-1" />
          Tolak
        </Button>
      </>
    );
  };

  const addItem = async (p: JsonObject) => {
    // addItem menunggu fetchDefaultProductUom (network) sebelum menulis state — kalau dua
    // produk diklik berdekatan, setForm({ ...form, ... }) yang menutup atas `form` lama bisa
    // saling menimpa/menghapus perubahan satu sama lain begitu keduanya resolve belakangan.
    // Pakai functional update supaya SELALU menulis di atas state TERBARU, bukan snapshot
    // yang direkam sebelum await.
    const id = str(p.id);
    const defaultUom = await fetchDefaultProductUom(id);
    const uomId = defaultUom?.id || '';
    let duplicate = false;
    setForm((prev) => {
      if (prev.items.find((it) => lineUomKey(str(it.stokId), str(it.uomId)) === lineUomKey(id, uomId))) {
        duplicate = true;
        return prev;
      }
      return {
        ...prev,
        items: [...prev.items, {
          stokId: p.id,
          kode: p.kode,
          nama: p.nama,
          uomId,
          satuan: defaultUom?.satuan || p.satuan,
          qty: 1,
          stokAvail: qtyAtLokasi(p, prev.lokasiKode),
          stokByWarehouse: p.stokByWarehouse,
        }],
      };
    });
    if (duplicate) {
      toast.error('Produk sudah ada');
      return;
    }
    setPickerOpen(false);
  };

  const updateItemUom = (i: number, uom: ProductUom) => {
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((it, idx) => idx === i ? { ...it, uomId: uom.id, satuan: uom.satuan } : it),
    }));
  };

  const save = async (submit = false) => {
    if (!form.keperluan.trim()) { toast.error('Keperluan wajib diisi'); return; }
    if (!form.items.length) { toast.error('Tambah minimal 1 item'); return; }
    setSaving(true);
    try {
      await saveMutation.mutateAsync({
        url: '/api/inventory-releases',
        body: { ...form, submit },
      });
      toast.success(submit ? 'Pengajuan release dikirim ke supervisor' : 'Draft release disimpan');
      setShowForm(false);
      setForm({
        lokasiKode: 'GKERING',
        keperluan: '',
        keterangan: '',
        maintenanceRequestId: '',
        assetId: '',
        items: [],
      });
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  };

  const action = async (id: string, type: 'submit' | 'approve' | 'reject', extra: JsonObject = {}) => {
    const paths = { submit: 'submit', approve: 'approve', reject: 'reject' } as const;
    const labels = { submit: 'Ajukan release', approve: 'Setujui release', reject: 'Tolak release' };
    try {
      await actionMutation.mutateAsync({
        url: `/api/inventory-releases/${id}/${paths[type]}`,
        body: extra,
        offlineLabel: `${labels[type]} ${id}`,
      });
      toast.success(type === 'approve' ? 'Release disetujui — stok dikurangi' : type === 'reject' ? 'Ditolak' : 'Diajukan');
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const filteredProducts = products.filter((p) => {
    if (str(p.gudangKode, 'GKERING') !== form.lokasiKode) return false;
    if (qtyAtLokasi(p, form.lokasiKode) <= 0) return false;
    if (!pickerQ) return true;
    const q = pickerQ.toLowerCase();
    return str(p.nama).toLowerCase().includes(q) || str(p.kode).toLowerCase().includes(q);
  });

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <ArrowUpFromLine className="w-5 h-5" /> Mode Operasional — Release Inventory
            </h2>
            <p className="text-sm text-slate-500">
              Staff gudang mengajukan pengeluaran barang operasional → Supervisor menyetujui & release stok.
            </p>
          </div>
          {canCreate && (
            <Button onClick={() => setShowForm(true)} className="bg-orange-500 hover:bg-orange-600">
              <Plus className="w-4 h-4 mr-1" /> Buat Release
            </Button>
          )}
        </div>
        <OperationalScopeBar />

        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">No. Release</th>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-left">Gudang</th>
                <th className="px-3 py-2 text-left">Keperluan</th>
                <th className="px-3 py-2 text-center">Item</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-left">Dibuat oleh</th>
                <th className="px-3 py-2 text-center min-w-[180px]">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {!list.length && (
                <tr><td colSpan={8} className="text-center py-10 text-slate-400">Belum ada release</td></tr>
              )}
              {list.map((r) => {
                const createdBy = asObject(r.createdBy);
                return (
                <tr
                  key={str(r.id)}
                  className="border-t cursor-pointer hover:bg-slate-50"
                  onClick={() => setDetail(r)}
                >
                  <td className="px-3 py-2 font-mono text-xs">{str(r.noRelease)}</td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(str(r.tanggal))}</td>
                  <td className="px-3 py-2 text-xs">{str(r.lokasiNama) || str(r.lokasiKode)}</td>
                  <td className="px-3 py-2 max-w-[200px] truncate" title={str(r.keperluan)}>{str(r.keperluan)}</td>
                  <td className="px-3 py-2 text-center">{asArray(r.items).length}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_STYLE[str(r.status)] || ''}`}>{str(r.status)}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">{str(createdBy.userName) || '—'}</td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-center gap-1.5 flex-nowrap">
                      {str(r.status) === 'DRAFT' && canCreate && str(createdBy.userId) === str(user?.id) && (
                        <Button size="sm" variant="outline" className="h-8 whitespace-nowrap" onClick={() => action(str(r.id), 'submit')}>
                          <Send className="w-3.5 h-3.5 mr-1" /> Ajukan
                        </Button>
                      )}
                      {renderPendingActions(r)}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Buat Release Inventory</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 overflow-y-auto flex-1 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Gudang asal *</Label>
                <Select
                  value={form.lokasiKode}
                  onValueChange={(v) => setForm((prev) => ({ ...prev, lokasiKode: v, items: [] }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WAREHOUSES.map((w) => (
                      <SelectItem key={w.kode} value={w.kode}>{w.nama}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Keperluan operasional *</Label>
                <Input
                  value={form.keperluan}
                  onChange={(e) => setForm((prev) => ({ ...prev, keperluan: e.target.value }))}
                  placeholder="Contoh: Masak menu harian tanggal ..."
                />
              </div>
            </div>
            <div>
              <Label>Catatan</Label>
              <Textarea
                rows={2}
                value={form.keterangan}
                onChange={(e) => setForm((prev) => ({ ...prev, keterangan: e.target.value }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label>Item barang</Label>
              <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                <Plus className="w-3 h-3 mr-1" /> Tambah
              </Button>
            </div>
            <div className="space-y-2">
              {form.items.map((it, i) => (
                <div key={`${str(it.stokId)}-${str(it.uomId)}`} className="flex items-center gap-2 border rounded p-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{str(it.nama) || str(it.kode) || 'Produk'}</div>
                    <div className="text-xs text-slate-500">
                      {str(it.kode)} · tersedia: {formatNumber(num(it.stokAvail))} base
                    </div>
                  </div>
                  <Input
                    type="number"
                    min={0}
                    max={num(it.stokAvail)}
                    className="w-24"
                    value={num(it.qty)}
                    onChange={(e) => {
                      const qty = parseFloat(e.target.value) || 0;
                      setForm((prev) => ({
                        ...prev,
                        items: prev.items.map((x, idx) => idx === i ? { ...x, qty } : x),
                      }));
                    }}
                  />
                  <LineUomSelect
                    stokId={str(it.stokId)}
                    uomId={str(it.uomId)}
                    onChange={(uom) => updateItemUom(i, uom)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setForm((prev) => ({ ...prev, items: prev.items.filter((_, idx) => idx !== i) }))}
                  >
                    Hapus
                  </Button>
                </div>
              ))}
              {!form.items.length && (
                <p className="text-sm text-slate-400 text-center py-4">Belum ada item</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button>
            <Button variant="outline" disabled={saving} onClick={() => save(false)}>Simpan Draft</Button>
            <Button disabled={saving} className="bg-orange-500 hover:bg-orange-600" onClick={() => save(true)}>
              Ajukan ke Supervisor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader><DialogTitle>Pilih Produk — {WAREHOUSES.find((w) => w.kode === form.lokasiKode)?.nama}</DialogTitle></DialogHeader>
          <Input placeholder="Cari..." value={pickerQ} onChange={(e) => setPickerQ(e.target.value)} />
          <div className="overflow-y-auto flex-1 space-y-1">
            {filteredProducts.map((p) => {
              const avail = qtyAtLokasi(p, form.lokasiKode);
              return (
                <button
                  key={str(p.id)}
                  type="button"
                  disabled={avail <= 0}
                  className="w-full text-left border rounded p-2 text-sm hover:bg-slate-50 disabled:opacity-40"
                  onClick={() => addItem(p)}
                >
                  <div className="font-medium">{str(p.nama) || str(p.kode) || 'Produk'}</div>
                  <div className="text-xs text-slate-500">{str(p.kode)} · stok: {formatNumber(avail)} {str(p.satuan)}</div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {str(detail?.noRelease)}{' '}
              <span className={`ml-1 px-2 py-0.5 rounded text-xs align-middle ${STATUS_STYLE[str(detail?.status)] || ''}`}>
                {str(detail?.status)}
              </span>
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                <div>Tanggal: <span className="text-slate-900">{formatDateTime(str(detail.tanggal))}</span></div>
                <div>Gudang: <span className="text-slate-900">{str(detail.lokasiNama) || str(detail.lokasiKode)}</span></div>
                <div className="col-span-2">Keperluan: <span className="text-slate-900">{str(detail.keperluan)}</span></div>
                {!!str(detail.keterangan) && (
                  <div className="col-span-2">Catatan: <span className="text-slate-900">{str(detail.keterangan)}</span></div>
                )}
                <div>Dibuat oleh: <span className="text-slate-900">{str(asObject(detail.createdBy).userName) || '—'}</span></div>
                {str(detail.status) === 'POSTED' && (
                  <div>Disetujui oleh: <span className="text-slate-900">{str(asObject(detail.approvedBy).userName) || '—'}</span></div>
                )}
                {str(detail.status) === 'REJECTED' && (
                  <>
                    <div>Ditolak oleh: <span className="text-slate-900">{str(asObject(detail.rejectedBy).userName) || '—'}</span></div>
                    <div className="col-span-2">Alasan: <span className="text-slate-900">{str(detail.rejectReason) || '—'}</span></div>
                  </>
                )}
              </div>
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                    <tr>
                      <th className="text-left px-3 py-2">Kode</th>
                      <th className="text-left px-3 py-2">Nama</th>
                      <th className="text-right px-3 py-2">Qty</th>
                      <th className="text-left px-3 py-2">Satuan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {asArray(detail.items).map((it, i) => {
                      const line = asObject(it);
                      return (
                        <tr key={i} className="border-t">
                          <td className="px-3 py-2 font-mono text-xs">{str(line.kode)}</td>
                          <td className="px-3 py-2">{str(line.nama)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatNumber(num(line.qty))}</td>
                          <td className="px-3 py-2">{str(line.satuan)}</td>
                        </tr>
                      );
                    })}
                    {!asArray(detail.items).length && (
                      <tr><td colSpan={4} className="px-3 py-4 text-center text-slate-400">Tidak ada item</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
