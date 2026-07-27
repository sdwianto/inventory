'use client';
import { str, type JsonObject } from '@/types/json';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { PackageOpen, Plus, Trash2 } from 'lucide-react';
import { useSessionUserWithTenantFilter } from '@/lib/hooks/use-session-user';
import TenantScopeField, { tenantLabel, type TenantOption } from '@/components/TenantScopeField';
import { withActingTenantQuery } from '@/lib/tenant-api';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { useMasterTenants } from '@/lib/hooks/use-master-tenants';
import { queryKeys } from '@/lib/query-keys';
import { OfflineQueuedError } from '@/lib/offline-mutation-queue';
import { formatDateTime } from '@/lib/format';

/** Client-safe warehouse options — avoid importing mongodb helpers. */
const WH_OPTIONS = [
  { kode: 'GKERING', label: 'Gudang Kering' },
  { kode: 'GBASAH', label: 'Gudang Basah' },
  { kode: 'GJANITOR', label: 'Gudang Janitor' },
] as const;

type LineForm = { stokId: string; fromBinKode: string; toBinKode: string; qty: string };

const emptyLine = (): LineForm => ({ stokId: '', fromBinKode: '', toBinKode: '', qty: '1' });

export default function PutawayPage() {
  const { user, filterTenantId, setFilterTenantId } = useSessionUserWithTenantFilter();
  const [whFilter, setWhFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [formWh, setFormWh] = useState('GKERING');
  const [tanggal, setTanggal] = useState(() => new Date().toISOString().slice(0, 10));
  const [keterangan, setKeterangan] = useState('');
  const [lines, setLines] = useState<LineForm[]>([emptyLine()]);

  const isMaster = user?.role === 'MASTER';
  const { tenants: masterTenants } = useMasterTenants(isMaster);
  const tenants = masterTenants as TenantOption[];

  const listUrl = useMemo(() => {
    if (!user) return null;
    if (isMaster && !filterTenantId) return null;
    let url = '/api/putaway-moves';
    const qs = new URLSearchParams();
    if (whFilter) qs.set('warehouseKode', whFilter);
    if (statusFilter) qs.set('status', statusFilter);
    const q = qs.toString();
    if (q) url += `?${q}`;
    return withActingTenantQuery(url, filterTenantId, isMaster);
  }, [user, filterTenantId, isMaster, whFilter, statusFilter]);

  const { data: listData = [], refetch, isLoading } = useApiQuery<JsonObject[]>(
    queryKeys.putawayMoves.list({
      tenantId: filterTenantId || undefined,
      warehouseKode: whFilter || undefined,
      status: statusFilter || undefined,
    }),
    listUrl,
    { enabled: Boolean(listUrl) },
  );
  const list = useMemo(() => (Array.isArray(listData) ? listData : []), [listData]);

  const binsUrl = useMemo(() => {
    if (!showForm) return null;
    if (isMaster && !filterTenantId) return null;
    const url = `/api/warehouse-bins?warehouseKode=${encodeURIComponent(formWh)}&aktif=1`;
    return withActingTenantQuery(url, filterTenantId, isMaster);
  }, [showForm, formWh, filterTenantId, isMaster]);

  const { data: binsData = [] } = useApiQuery<JsonObject[]>(
    queryKeys.warehouseBins.list({
      tenantId: filterTenantId || undefined,
      warehouseKode: formWh,
    }),
    binsUrl,
    { enabled: Boolean(binsUrl) },
  );
  const bins = useMemo(() => (Array.isArray(binsData) ? binsData : []), [binsData]);

  const mutation = useApiMutation([queryKeys.putawayMoves.all]);

  const openCreate = () => {
    setFormWh(whFilter || 'GKERING');
    setTanggal(new Date().toISOString().slice(0, 10));
    setKeterangan('');
    setLines([emptyLine()]);
    setShowForm(true);
  };

  const save = async () => {
    try {
      const body: Record<string, unknown> = {
        warehouseKode: formWh,
        tanggal,
        keterangan,
        lines: lines.map((l) => ({
          stokId: l.stokId.trim(),
          fromBinKode: l.fromBinKode,
          toBinKode: l.toBinKode,
          qty: parseFloat(l.qty) || 0,
          qtyBase: parseFloat(l.qty) || 0,
        })),
      };
      if (isMaster && filterTenantId) body.tenantId = filterTenantId;
      await mutation.mutateAsync({
        url: '/api/putaway-moves',
        method: 'POST',
        body,
        offlineLabel: 'Buat putaway',
      });
      toast.success('Putaway DRAFT dibuat');
      setShowForm(false);
      void refetch();
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const postDoc = async (row: JsonObject) => {
    try {
      await mutation.mutateAsync({
        url: `/api/putaway-moves/${str(row.id)}/post`,
        method: 'POST',
        body: {},
        offlineLabel: `Post putaway ${str(row.noPutaway)}`,
      });
      toast.success(`Putaway ${str(row.noPutaway)} diposting`);
      void refetch();
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const cancelDoc = async (row: JsonObject) => {
    try {
      await mutation.mutateAsync({
        url: `/api/putaway-moves/${str(row.id)}`,
        method: 'DELETE',
        offlineLabel: `Batal putaway ${str(row.noPutaway)}`,
      });
      toast.success(`Putaway ${str(row.noPutaway)} dibatalkan`);
      void refetch();
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <PackageOpen className="w-6 h-6" /> Putaway (Bin → Bin)
            </h1>
            <p className="text-sm text-slate-500">
              Pindah saldo bin dalam gudang yang sama (W2-18). Tidak mengubah stok_lokasi / kartu / lot.
            </p>
          </div>
          <Button onClick={openCreate} className="bg-orange-500 hover:bg-orange-600">
            <Plus className="w-4 h-4 mr-1" /> Putaway Baru
          </Button>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          {isMaster && (
            <TenantScopeField
              user={user}
              tenants={tenants}
              value={filterTenantId}
              onChange={setFilterTenantId}
              label="Filter tenant"
              className="max-w-xs"
            />
          )}
          <div className="max-w-xs">
            <Label>Gudang</Label>
            <select
              className="w-full border rounded-md h-9 px-2 text-sm"
              value={whFilter}
              onChange={(e) => setWhFilter(e.target.value)}
            >
              <option value="">Semua</option>
              {WH_OPTIONS.map((w) => (
                <option key={w.kode} value={w.kode}>{w.label} ({w.kode})</option>
              ))}
            </select>
          </div>
          <div className="max-w-xs">
            <Label>Status</Label>
            <select
              className="w-full border rounded-md h-9 px-2 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">Semua</option>
              <option value="DRAFT">DRAFT</option>
              <option value="POSTED">POSTED</option>
              <option value="CANCELLED">CANCELLED</option>
            </select>
          </div>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                {isMaster && <th className="px-3 py-2 text-left">Tenant</th>}
                <th className="px-3 py-2 text-left">No</th>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-left">Gudang</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Baris</th>
                <th className="px-3 py-2 text-center w-40">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {isMaster && !filterTenantId && (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-slate-400">
                    Pilih tenant untuk melihat putaway
                  </td>
                </tr>
              )}
              {(isMaster ? filterTenantId : true) && isLoading && (
                <tr>
                  <td colSpan={isMaster ? 7 : 6} className="text-center py-10 text-slate-400">
                    Memuat…
                  </td>
                </tr>
              )}
              {(isMaster ? filterTenantId : true) && !isLoading && list.length === 0 && (
                <tr>
                  <td colSpan={isMaster ? 7 : 6} className="text-center py-10 text-slate-400">
                    Belum ada putaway
                  </td>
                </tr>
              )}
              {list.map((row) => {
                const lineCount = Array.isArray(row.lines) ? row.lines.length : 0;
                const isDraft = str(row.status) === 'DRAFT';
                return (
                  <tr key={str(row.id)} className="border-t hover:bg-slate-50">
                    {isMaster && (
                      <td className="px-3 py-2 text-xs">
                        <span className="px-2 py-0.5 bg-orange-50 text-orange-800 rounded font-mono">
                          {tenantLabel(tenants, str(row.tenantId))}
                        </span>
                      </td>
                    )}
                    <td className="px-3 py-2 font-mono text-xs font-medium">{str(row.noPutaway)}</td>
                    <td className="px-3 py-2 text-xs">{formatDateTime(row.tanggal as string | number | Date | null | undefined)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{str(row.warehouseKode)}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs font-medium ${
                        isDraft ? 'text-amber-700' : str(row.status) === 'POSTED' ? 'text-green-700' : 'text-slate-500'
                      }`}>
                        {str(row.status)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">{lineCount} baris</td>
                    <td className="px-3 py-2">
                      {isDraft && (
                        <div className="flex justify-center gap-2">
                          <Button size="sm" className="h-7 text-xs bg-orange-500 hover:bg-orange-600" onClick={() => void postDoc(row)}>
                            Post
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void cancelDoc(row)}>
                            Batal
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Putaway Baru</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Gudang</Label>
                <select
                  className="w-full border rounded-md h-9 px-2 text-sm"
                  value={formWh}
                  onChange={(e) => {
                    setFormWh(e.target.value);
                    setLines((prev) => prev.map((l) => ({ ...l, fromBinKode: '', toBinKode: '' })));
                  }}
                >
                  {WH_OPTIONS.map((w) => (
                    <option key={w.kode} value={w.kode}>{w.label} ({w.kode})</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Tanggal</Label>
                <Input type="date" value={tanggal} onChange={(e) => setTanggal(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Keterangan</Label>
              <Input value={keterangan} onChange={(e) => setKeterangan(e.target.value)} placeholder="Opsional" />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Baris</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setLines((prev) => [...prev, emptyLine()])}
                >
                  <Plus className="w-3 h-3 mr-1" /> Baris
                </Button>
              </div>
              {bins.length === 0 && (
                <p className="text-xs text-amber-700">Belum ada bin aktif di gudang ini — buat di Bin / Slot dulu.</p>
              )}
              {lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-end border rounded-md p-2">
                  <div className="col-span-3">
                    <Label className="text-xs">stokId</Label>
                    <Input
                      value={line.stokId}
                      onChange={(e) => {
                        const v = e.target.value;
                        setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, stokId: v } : l)));
                      }}
                      placeholder="uuid produk"
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="col-span-3">
                    <Label className="text-xs">Dari bin</Label>
                    <select
                      className="w-full border rounded-md h-8 px-1 text-xs"
                      value={line.fromBinKode}
                      onChange={(e) => {
                        const v = e.target.value;
                        setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, fromBinKode: v } : l)));
                      }}
                    >
                      <option value="">—</option>
                      {bins.map((b) => (
                        <option key={str(b.id)} value={str(b.kode)}>{str(b.kode)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-3">
                    <Label className="text-xs">Ke bin</Label>
                    <select
                      className="w-full border rounded-md h-8 px-1 text-xs"
                      value={line.toBinKode}
                      onChange={(e) => {
                        const v = e.target.value;
                        setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, toBinKode: v } : l)));
                      }}
                    >
                      <option value="">—</option>
                      {bins.map((b) => (
                        <option key={str(b.id)} value={str(b.kode)}>{str(b.kode)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs">Qty</Label>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      value={line.qty}
                      onChange={(e) => {
                        const v = e.target.value;
                        setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, qty: v } : l)));
                      }}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="col-span-1 flex justify-end pb-0.5">
                    <button
                      type="button"
                      className="p-1.5 text-slate-400 hover:text-red-600"
                      disabled={lines.length <= 1}
                      onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                      title="Hapus baris"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Tutup</Button>
            <Button onClick={() => void save()} className="bg-orange-500 hover:bg-orange-600">
              Simpan DRAFT
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
