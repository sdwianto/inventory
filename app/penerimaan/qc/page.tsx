'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asObject } from '@/types/json';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { TableSkeleton } from '@/components/TableSkeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { ShieldCheck, RefreshCw, Loader2, ClipboardCheck, Undo2, Trash2, AlertTriangle } from 'lucide-react';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { useApiQuery, useQueryClient } from '@/lib/hooks/useApiQuery';
import { fetchJson } from '@/lib/fetch-json';
import { warehouseName } from '@/lib/warehouses-client';
import { useSessionUser } from '@/lib/hooks/use-session-user';
import { NAV_BADGES_QUERY_KEY } from '@/lib/hooks/use-nav-badges';
import { useActingTenantId } from '@/lib/hooks/use-acting-tenant-id';
import { withActingTenantQuery } from '@/lib/tenant-api';
import { queryKeys } from '@/lib/query-keys';

type View = 'queue' | 'rejected' | 'history';

const INSPECT_ROLES = ['SUPERVISOR', 'ADMIN', 'MASTER', 'OWNER'];
const SOD_BYPASS_ROLES = ['ADMIN', 'MASTER', 'OWNER'];

const KONDISI_OPTIONS: { value: string; label: string }[] = [
  { value: 'BAIK', label: 'Baik / sesuai spesifikasi' },
  { value: 'KEMASAN_RUSAK', label: 'Kemasan rusak' },
  { value: 'BUSUK_BERJAMUR', label: 'Busuk / berjamur' },
  { value: 'SUHU_TIDAK_SESUAI', label: 'Suhu tidak sesuai' },
  { value: 'TIDAK_SESUAI_SPEK', label: 'Tidak sesuai spesifikasi' },
  { value: 'LAINNYA', label: 'Lainnya' },
];
const KONDISI_LABEL = Object.fromEntries(KONDISI_OPTIONS.map((o) => [o.value, o.label]));

const QC_STATUS_STYLE: Record<string, string> = {
  QUARANTINE: 'bg-amber-100 text-amber-800',
  RELEASED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
};
const QC_STATUS_LABEL: Record<string, string> = {
  QUARANTINE: 'Karantina',
  RELEASED: 'Lolos',
  REJECTED: 'Ditolak',
};
const HASIL_STYLE: Record<string, string> = {
  LOLOS: 'bg-green-100 text-green-800',
  DITOLAK: 'bg-red-100 text-red-800',
  SEBAGIAN: 'bg-amber-100 text-amber-800',
};

type LotQcList = {
  enabled: boolean;
  summary: { quarantineLots: number; quarantineOver24h: number; rejectedPending: number; quarantineConsumed: number };
  lots: JsonObject[];
};

function ageHours(value: unknown): number {
  const t = new Date(str(value)).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 3_600_000);
}

function roundQty(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export default function QcPenerimaanPage() {
  const router = useRouter();
  const user = useSessionUser();
  const qc = useQueryClient();
  const [view, setView] = useState<View>('queue');
  const [q, setQ] = useState('');
  const [inspectLot, setInspectLot] = useState<JsonObject | null>(null);
  const [disposeLot, setDisposeLot] = useState<JsonObject | null>(null);
  const [acting, setActing] = useState('');

  const role = str(user?.role);
  const canInspect = INSPECT_ROLES.includes(role);
  const actingTenantId = useActingTenantId();
  const isMaster = role === 'MASTER';
  const scopeReady = !isMaster || !!actingTenantId;
  const scoped = (path: string) => withActingTenantQuery(path, actingTenantId, isMaster);
  const tenantBody: Record<string, string> = isMaster && actingTenantId ? { tenantId: actingTenantId } : {};

  const listUrl = useMemo(() => {
    const p = new URLSearchParams({ view: view === 'history' ? 'queue' : view });
    if (q.trim() && view !== 'history') p.set('q', q.trim());
    return scopeReady ? withActingTenantQuery(`/api/lot-qc?${p.toString()}`, actingTenantId, isMaster) : null;
  }, [view, q, scopeReady, actingTenantId, isMaster]);
  const list = useApiQuery<LotQcList>(['lot-qc', 'list', actingTenantId, view === 'history' ? 'queue' : view, q.trim()], listUrl, {
    staleTime: 15_000,
  });
  const history = useApiQuery<JsonObject[]>(['lot-qc', 'inspections', actingTenantId], view === 'history' && scopeReady ? scoped('/api/lot-qc/inspections') : null, {
    staleTime: 15_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['lot-qc'] });
    void qc.invalidateQueries({ queryKey: NAV_BADGES_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: queryKeys.goodsReceipts.all });
  };

  const summary = list.data?.summary;
  const lots = list.data?.lots || [];
  const historyRows = useMemo(() => {
    const rows = history.data || [];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => [r.noInspeksi, r.lotNo, r.noGRN, r.productKode, r.productNama]
      .some((v) => str(v).toLowerCase().includes(needle)));
  }, [history.data, q]);

  const createRtv = async (lot: JsonObject) => {
    setActing(`rtv:${str(lot.id)}`);
    try {
      const created = await fetchJson<JsonObject>(scoped('/api/vendor-returns'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'qc-reject', lotId: str(lot.id), ...tenantBody }),
      });
      toast.success(`Draft retur ${str(created.noReturn)} dibuat — ajukan untuk approval`);
      refresh();
      router.push(`/retur-vendor?open=${encodeURIComponent(str(created.id))}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal membuat retur vendor');
    } finally {
      setActing('');
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-emerald-600" /> QC Penerimaan
          </h1>
          <p className="text-sm text-slate-500">
            Lot dari Terima Barang masuk karantina — tidak bisa dipakai (RL, FEFO, transfer) sampai diperiksa.
            Lolos → dirilis; gagal → lot ditolak, lalu retur ke vendor atau dimusnahkan.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="w-4 h-4 mr-1" /> Muat ulang
        </Button>
      </div>

      {list.data && !list.data.enabled && (
        <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          QC lot belum wajib untuk tenant ini (Utiliti → Tenant → &quot;Lot wajib QC&quot;). Lot baru dari GRN langsung tersedia;
          lot yang masih tertahan di bawah tetap harus diselesaikan.
        </div>
      )}
      {!!summary?.quarantineConsumed && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {summary.quarantineConsumed} lot karantina tercatat pernah terpakai — periksa di Utiliti → Ops.
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div className="rounded-lg border bg-white p-3">
            <p className="text-xs text-slate-500">Lot karantina</p>
            <p className="text-2xl font-semibold">{summary.quarantineLots}</p>
            {summary.quarantineOver24h > 0 && (
              <p className="text-xs text-amber-700">{summary.quarantineOver24h} lebih dari 24 jam</p>
            )}
          </div>
          <div className="rounded-lg border bg-white p-3">
            <p className="text-xs text-slate-500">Ditolak, belum ditindaklanjuti</p>
            <p className="text-2xl font-semibold">{summary.rejectedPending}</p>
          </div>
          <div className="rounded-lg border bg-white p-3">
            <p className="text-xs text-slate-500">Karantina terpakai (harus 0)</p>
            <p className={`text-2xl font-semibold ${summary.quarantineConsumed ? 'text-red-700' : ''}`}>{summary.quarantineConsumed}</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        {([
          { value: 'queue', label: 'Antrean karantina' },
          { value: 'rejected', label: 'Lot ditolak' },
          { value: 'history', label: 'Riwayat inspeksi' },
        ] as { value: View; label: string }[]).map((opt) => (
          <Button
            key={opt.value}
            size="sm"
            variant={view === opt.value ? 'default' : 'outline'}
            onClick={() => setView(opt.value)}
          >
            {opt.label}
          </Button>
        ))}
        <Input
          placeholder="Cari lot / GRN / bahan"
          className="h-8 w-64"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {view === 'history' ? (
        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left">No Inspeksi</th>
                <th className="px-3 py-2 text-left">Waktu</th>
                <th className="px-3 py-2 text-left">Lot / GRN</th>
                <th className="px-3 py-2 text-left">Bahan</th>
                <th className="px-3 py-2 text-center">Hasil</th>
                <th className="px-3 py-2 text-right">Lolos</th>
                <th className="px-3 py-2 text-right">Gagal</th>
                <th className="px-3 py-2 text-right">Suhu</th>
                <th className="px-3 py-2 text-left">Kondisi</th>
                <th className="px-3 py-2 text-left">Pemeriksa</th>
              </tr>
            </thead>
            <tbody>
              {history.isLoading && <TableSkeleton rows={6} cols={10} />}
              {!history.isLoading && historyRows.length === 0 && (
                <tr><td colSpan={10} className="text-center py-10 text-slate-400">Belum ada inspeksi</td></tr>
              )}
              {historyRows.map((r) => (
                <tr key={str(r.id)} className="border-t align-top">
                  <td className="px-3 py-2 font-mono text-xs text-emerald-700">{str(r.noInspeksi)}</td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(str(r.inspectedAt) || undefined)}</td>
                  <td className="px-3 py-2 text-xs">
                    <div className="font-mono">{str(r.lotNo)}</div>
                    {str(r.rejectedLotNo) && <div className="font-mono text-red-700">↳ {str(r.rejectedLotNo)}</div>}
                    <div className="text-slate-500">{str(r.noGRN)}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div className="font-mono">{str(r.productKode)}</div>
                    <div>{str(r.productNama)}</div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-[11px] px-2 py-0.5 rounded ${HASIL_STYLE[str(r.hasil)] || 'bg-slate-100'}`}>{str(r.hasil)}</span>
                  </td>
                  <td className="px-3 py-2 text-right text-xs">{formatNumber(num(r.qtyPassed))} {str(r.satuan)}</td>
                  <td className="px-3 py-2 text-right text-xs">{formatNumber(num(r.qtyFailed))} {str(r.satuan)}</td>
                  <td className="px-3 py-2 text-right text-xs">{r.suhuC == null ? '—' : `${formatNumber(num(r.suhuC))} °C`}</td>
                  <td className="px-3 py-2 text-xs">
                    {KONDISI_LABEL[str(r.kondisi)] || str(r.kondisi)}
                    {str(r.alasanTolak) && <div className="text-red-700">{str(r.alasanTolak)}</div>}
                    {str(r.catatan) && <div className="text-slate-500">{str(r.catatan)}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">{str(asObject(r.inspectedBy).userName) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Lot</th>
                <th className="px-3 py-2 text-left">Bahan</th>
                <th className="px-3 py-2 text-left">GRN</th>
                <th className="px-3 py-2 text-left">Gudang</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-left">Diterima</th>
                <th className="px-3 py-2 text-left">Kedaluwarsa</th>
                <th className="px-3 py-2 text-left">{view === 'rejected' ? 'Tindak lanjut' : 'Status'}</th>
                <th className="px-3 py-2 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && <TableSkeleton rows={6} cols={9} />}
              {!list.isLoading && lots.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-10 text-slate-400">
                    {view === 'rejected' ? 'Tidak ada lot ditolak' : 'Tidak ada lot di karantina'}
                  </td>
                </tr>
              )}
              {lots.map((lot) => {
                const id = str(lot.id);
                const hours = ageHours(lot.receivedAt || lot.createdAt);
                const rejectStatus = str(lot.qcRejectStatus);
                return (
                  <tr key={id} className={`border-t align-top ${view === 'queue' && hours > 24 ? 'bg-amber-50/60' : ''}`}>
                    <td className="px-3 py-2 text-xs">
                      <div className="font-mono">{str(lot.lotNo)}</div>
                      {str(lot.supplierLotNo) && <div className="text-slate-500">Pemasok: {str(lot.supplierLotNo)}</div>}
                      {str(lot.noInspeksi) && <div className="text-slate-500">{str(lot.noInspeksi)}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div className="font-mono">{str(lot.productKode)}</div>
                      <div>{str(lot.productNama)}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{str(lot.noGRN) || '—'}</td>
                    <td className="px-3 py-2 text-xs">{warehouseName(str(lot.warehouseKode))}</td>
                    <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                      {formatNumber(num(lot.qtyRemaining))} {str(lot.satuan)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {formatDateTime(str(lot.receivedAt) || undefined)}
                      {view === 'queue' && (
                        <div className={hours > 24 ? 'text-amber-700' : 'text-slate-500'}>{Math.floor(hours)} jam lalu</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{str(lot.expiryDate) ? formatDate(str(lot.expiryDate)) : '—'}</td>
                    <td className="px-3 py-2 text-xs">
                      {view === 'rejected' ? (
                        <>
                          {rejectStatus === 'RTV_CREATED' ? (
                            <Link
                              className="text-orange-700 underline"
                              href={`/retur-vendor?open=${encodeURIComponent(str(lot.qcRejectRtvId))}`}
                            >
                              Retur {str(lot.qcRejectNoReturn)}
                            </Link>
                          ) : rejectStatus === 'DISPOSED' ? (
                            <span className="text-slate-500">Dimusnahkan {str(asObject(lot.qcDisposal).noDokumen)}</span>
                          ) : (
                            <span className="text-red-700">Belum ditindaklanjuti</span>
                          )}
                          {str(lot.qcRejectReason) && <div className="text-slate-500">{str(lot.qcRejectReason)}</div>}
                        </>
                      ) : (
                        <span className={`text-[11px] px-2 py-0.5 rounded ${QC_STATUS_STYLE[str(lot.qcStatus)] || 'bg-slate-100'}`}>
                          {QC_STATUS_LABEL[str(lot.qcStatus)] || str(lot.qcStatus)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      {view === 'queue' && (
                        <Button
                          size="sm"
                          disabled={!canInspect}
                          title={canInspect ? undefined : 'Inspeksi hanya oleh Supervisor/Admin'}
                          onClick={() => setInspectLot(lot)}
                        >
                          <ClipboardCheck className="w-3.5 h-3.5 mr-1" /> Periksa
                        </Button>
                      )}
                      {view === 'rejected' && rejectStatus === 'PENDING' && num(lot.qtyRemaining) > 0 && (
                        <div className="flex gap-1 justify-center">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!acting}
                            onClick={() => void createRtv(lot)}
                          >
                            {acting === `rtv:${id}` ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Undo2 className="w-3.5 h-3.5 mr-1" />}
                            Buat RTV
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-700"
                            disabled={!canInspect || !!acting}
                            title={canInspect ? undefined : 'Pemusnahan hanya oleh Supervisor/Admin'}
                            onClick={() => setDisposeLot(lot)}
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1" /> Musnahkan
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
      )}

      {inspectLot && (
        <InspectDialog
          lot={inspectLot}
          scoped={scoped}
          tenantBody={tenantBody}
          sodBlocked={
            !!user?.id
            && str(inspectLot.receivedByUserId) === user.id
            && !SOD_BYPASS_ROLES.includes(role)
          }
          onClose={() => setInspectLot(null)}
          onDone={() => { setInspectLot(null); refresh(); }}
        />
      )}
      {disposeLot && (
        <DisposeDialog
          lot={disposeLot}
          scoped={scoped}
          tenantBody={tenantBody}
          onClose={() => setDisposeLot(null)}
          onDone={() => { setDisposeLot(null); refresh(); }}
        />
      )}
    </div>
  );
}

function InspectDialog({ lot, scoped, tenantBody, sodBlocked, onClose, onDone }: {
  lot: JsonObject;
  scoped: (path: string) => string;
  tenantBody: Record<string, string>;
  sodBlocked: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const remaining = num(lot.qtyRemaining);
  const satuan = str(lot.satuan);
  const [passed, setPassed] = useState(String(remaining));
  const [suhu, setSuhu] = useState('');
  const [kondisi, setKondisi] = useState('BAIK');
  const [alasan, setAlasan] = useState('');
  const [catatan, setCatatan] = useState('');
  const [saving, setSaving] = useState(false);

  const passedNum = Number(passed);
  const passedValid = passed.trim() !== '' && Number.isFinite(passedNum) && passedNum >= 0 && passedNum <= remaining;
  const failed = passedValid ? roundQty(remaining - passedNum) : 0;
  const tempRequired = !!lot.temperatureRequired;
  const suhuNum = suhu.trim() === '' ? null : Number(suhu.replace(',', '.'));
  const suhuValid = suhuNum === null ? !tempRequired : Number.isFinite(suhuNum) && suhuNum >= -30 && suhuNum <= 60;
  const kondisiValid = failed > 0 ? kondisi !== 'BAIK' : true;
  const alasanValid = failed > 0 ? alasan.trim().length >= 3 : true;
  const canSubmit = passedValid && suhuValid && kondisiValid && alasanValid && !sodBlocked && !saving;

  const setAll = (mode: 'pass' | 'fail') => {
    if (mode === 'pass') {
      setPassed(String(remaining));
      setKondisi('BAIK');
    } else {
      setPassed('0');
      if (kondisi === 'BAIK') setKondisi('TIDAK_SESUAI_SPEK');
    }
  };

  const submit = async () => {
    setSaving(true);
    try {
      const res = await fetchJson<JsonObject>(scoped(`/api/lot-qc/${encodeURIComponent(str(lot.id))}/inspect`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qtyPassed: roundQty(passedNum),
          qtyFailed: failed,
          suhuC: suhuNum,
          kondisi,
          alasanTolak: failed > 0 ? alasan.trim() : undefined,
          catatan: catatan.trim() || undefined,
          ...tenantBody,
        }),
      });
      const insp = asObject(res.inspection);
      const hasil = str(insp.hasil);
      toast.success(
        hasil === 'LOLOS' ? `${str(insp.noInspeksi)}: lot dirilis`
          : hasil === 'DITOLAK' ? `${str(insp.noInspeksi)}: lot ditolak — tindak lanjuti di tab Lot ditolak`
            : `${str(insp.noInspeksi)}: ${formatNumber(num(insp.qtyPassed))} dirilis, ${formatNumber(num(insp.qtyFailed))} dipisah jadi lot ditolak`,
      );
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan inspeksi');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Inspeksi lot {str(lot.lotNo)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="rounded border bg-slate-50 px-3 py-2 text-xs text-slate-600 space-y-0.5">
            <div><span className="font-mono">{str(lot.productKode)}</span> — {str(lot.productNama)}</div>
            <div>{str(lot.noGRN)} · {warehouseName(str(lot.warehouseKode))} · sisa {formatNumber(remaining)} {satuan}</div>
          </div>
          {sodBlocked && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              Anda yang menerima barang ini — inspeksi harus oleh petugas lain (pemisahan tugas).
            </div>
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setAll('pass')}>Lolos semua</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setAll('fail')}>Tolak semua</Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Qty lolos ({satuan})</Label>
              <Input type="number" min={0} max={remaining} step="any" value={passed} onChange={(e) => setPassed(e.target.value)} />
              {!passedValid && <p className="text-xs text-red-600 mt-1">Isi 0 – {formatNumber(remaining)}</p>}
            </div>
            <div>
              <Label>Qty gagal ({satuan})</Label>
              <Input value={formatNumber(failed)} disabled />
              {failed > 0 && failed < remaining && (
                <p className="text-xs text-slate-500 mt-1">Dipisah menjadi lot ditolak tersendiri.</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Suhu (°C){tempRequired ? ' *' : ''}</Label>
              <Input
                type="number"
                step="0.1"
                value={suhu}
                placeholder={tempRequired ? 'Wajib untuk gudang basah' : 'Opsional'}
                onChange={(e) => setSuhu(e.target.value)}
              />
              {!suhuValid && (
                <p className="text-xs text-red-600 mt-1">
                  {suhuNum === null ? 'Suhu wajib diisi untuk gudang basah' : 'Suhu harus antara -30 dan 60 °C'}
                </p>
              )}
            </div>
            <div>
              <Label>Kondisi</Label>
              <select
                className="h-9 w-full border rounded px-2 text-sm"
                value={kondisi}
                onChange={(e) => setKondisi(e.target.value)}
              >
                {KONDISI_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {!kondisiValid && <p className="text-xs text-red-600 mt-1">Pilih kondisi penyebab penolakan</p>}
            </div>
          </div>
          {failed > 0 && (
            <div>
              <Label>Alasan penolakan *</Label>
              <Input value={alasan} maxLength={300} onChange={(e) => setAlasan(e.target.value)} placeholder="mis. 5 kg busuk di dasar karung" />
            </div>
          )}
          <div>
            <Label>Catatan</Label>
            <Input value={catatan} maxLength={500} onChange={(e) => setCatatan(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Batal</Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Simpan inspeksi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisposeDialog({ lot, scoped, tenantBody, onClose, onDone }: {
  lot: JsonObject;
  scoped: (path: string) => string;
  tenantBody: Record<string, string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const res = await fetchJson<JsonObject>(scoped(`/api/lot-qc/${encodeURIComponent(str(lot.id))}/dispose`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim(), ...tenantBody }),
      });
      toast.success(`${str(res.noDokumen) || 'Pemusnahan'} tercatat — stok lot keluar`);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memusnahkan lot');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Musnahkan lot {str(lot.lotNo)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-slate-600">
            {formatNumber(num(lot.qtyRemaining))} {str(lot.satuan)} {str(lot.productNama)} akan dikeluarkan dari stok
            {' '}dan dicatat sebagai kerugian persediaan. Pilih ini hanya jika barang tidak bisa diretur ke vendor.
          </p>
          <div>
            <Label>Alasan pemusnahan *</Label>
            <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="mis. busuk, vendor menolak retur" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Batal</Button>
          <Button className="bg-red-600 hover:bg-red-700" onClick={() => void submit()} disabled={saving || reason.trim().length < 3}>
            {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Musnahkan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
