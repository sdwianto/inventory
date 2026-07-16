'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { Thermometer, Plus, RefreshCw, Check, Settings2 } from 'lucide-react';
import {
  TEMP_STAGE_LABELS,
  TEMP_ALERT_LABELS,
  type TempStage,
  type TempAlertStatus,
} from '@/lib/food-production/temperature-log';

const OPS_WRITE_ROLES = new Set(['GUDANG', 'ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);
const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface KitchenOpt { id: string; nama: string }

interface TempRow {
  id: string;
  stage: TempStage;
  suhuC: number;
  tanggal: string;
  recordedAt?: string;
  kitchenNama?: string;
  alertStatus: TempAlertStatus;
  thresholdMinC?: number;
  thresholdMaxC?: number;
  productionPlanNo?: string;
  batchNo?: string;
  qcResultNo?: string;
  servicePointNama?: string;
  catatan?: string;
  acknowledgedAt?: string;
  createdByName?: string;
}

interface ThresholdRow {
  stage: TempStage;
  label: string;
  minC?: number;
  maxC?: number;
  warnBandC?: number;
  criticalMarginC?: number;
  isDefault?: boolean;
  catatan?: string;
}

interface AlertSummary {
  counts: { WARN: number; OUT_OF_RANGE: number; CRITICAL: number; total: number };
  truncated?: boolean;
  items: TempRow[];
}

const emptyForm = {
  stage: 'HOLDING' as TempStage,
  suhuC: '',
  kitchenId: '',
  catatan: '',
};

function alertClass(status: TempAlertStatus): string {
  if (status === 'CRITICAL') return 'text-red-700 font-semibold';
  if (status === 'OUT_OF_RANGE') return 'text-orange-700 font-medium';
  if (status === 'WARN') return 'text-amber-700';
  return 'text-emerald-700';
}

export default function ColdChainPage() {
  const role = useMemo(
    () => String((getUser() as { role?: string } | null)?.role || ''),
    [],
  );
  const canLog = OPS_WRITE_ROLES.has(role);
  const canManage = MANAGE_ROLES.has(role);

  const [rows, setRows] = useState<TempRow[]>([]);
  const [alerts, setAlerts] = useState<AlertSummary | null>(null);
  const [thresholds, setThresholds] = useState<ThresholdRow[]>([]);
  const [kitchens, setKitchens] = useState<KitchenOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [openThr, setOpenThr] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [thrForm, setThrForm] = useState({
    stage: 'HOLDING' as TempStage,
    minC: '',
    maxC: '',
    warnBandC: '',
    criticalMarginC: '',
  });
  const [saving, setSaving] = useState(false);
  const [filterStage, setFilterStage] = useState('');
  const [filterAlert, setFilterAlert] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filterStage) qs.set('stage', filterStage);
      if (filterAlert) qs.set('alertStatus', filterAlert);
      const q = qs.toString();
      const [lRes, aRes, tRes, kRes] = await Promise.all([
        fetch(`/api/temperature-logs${q ? `?${q}` : ''}`, {
          headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
        }),
        fetch('/api/temperature-logs/alerts', {
          headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
        }),
        fetch('/api/temperature-thresholds', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/kitchens?aktif=1', { headers: { ...actingTenantHeaders() } }),
      ]);
      const lData = await lRes.json();
      const aData = await aRes.json();
      const tData = await tRes.json();
      const kData = await kRes.json();
      if (!lRes.ok) throw new Error(lData?.error || 'Gagal memuat log');
      if (!aRes.ok) throw new Error(aData?.error || 'Gagal memuat alert');
      setRows(Array.isArray(lData) ? lData : []);
      setAlerts(aData && typeof aData === 'object' ? aData as AlertSummary : null);
      setThresholds(Array.isArray(tData) ? tData : []);
      setKitchens(Array.isArray(kData) ? kData : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, [filterStage, filterAlert]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  function openCreate() {
    setForm(emptyForm);
    setOpen(true);
  }

  function openThresholdEditor(row: ThresholdRow) {
    setThrForm({
      stage: row.stage,
      minC: row.minC != null ? String(row.minC) : '',
      maxC: row.maxC != null ? String(row.maxC) : '',
      warnBandC: row.warnBandC != null ? String(row.warnBandC) : '',
      criticalMarginC: row.criticalMarginC != null ? String(row.criticalMarginC) : '',
    });
    setOpenThr(true);
  }

  async function saveLog() {
    setSaving(true);
    try {
      const res = await fetch('/api/temperature-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders(), ...actingKitchenHeaders() },
        body: JSON.stringify({
          stage: form.stage,
          suhuC: Number(form.suhuC),
          kitchenId: form.kitchenId || undefined,
          catatan: form.catatan || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      const status = String(data.alertStatus || 'OK');
      if (status === 'OK' || status === 'WARN') {
        toast.success(`Log tersimpan — ${TEMP_ALERT_LABELS[status as TempAlertStatus] || status}`);
      } else {
        toast.error(`Alert: ${TEMP_ALERT_LABELS[status as TempAlertStatus] || status} (${data.suhuC}°C)`);
      }
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function saveThreshold() {
    setSaving(true);
    try {
      const res = await fetch('/api/temperature-thresholds', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          stage: thrForm.stage,
          minC: thrForm.minC === '' ? null : Number(thrForm.minC),
          maxC: thrForm.maxC === '' ? null : Number(thrForm.maxC),
          warnBandC: thrForm.warnBandC === '' ? null : Number(thrForm.warnBandC),
          criticalMarginC: thrForm.criticalMarginC === '' ? null : Number(thrForm.criticalMarginC),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan threshold');
      toast.success('Threshold diperbarui');
      setOpenThr(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function ack(row: TempRow) {
    const res = await fetch(`/api/temperature-logs/${row.id}/ack`, {
      method: 'PUT',
      headers: { ...actingTenantHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal acknowledge');
      return;
    }
    toast.success('Alert di-acknowledge');
    await load();
  }

  const openAlertCount = alerts?.counts.total ?? 0;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Thermometer className="h-5 w-5" />
            Cold Chain
          </h1>
          <p className="text-sm text-muted-foreground">
            Log suhu receiving / cooking / holding + alert threshold
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
          {canLog && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" /> Catat Suhu
            </Button>
          )}
        </div>
      </div>

      {openAlertCount > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <strong>{openAlertCount} alert terbuka</strong>
          {alerts?.truncated ? ' (daftar dipotong ke 100 terbaru)' : ''}
          {' — '}
          kritis {alerts?.counts.CRITICAL ?? 0}, luar ambang {alerts?.counts.OUT_OF_RANGE ?? 0}, peringatan {alerts?.counts.WARN ?? 0}.
          Acknowledge setelah tindakan korektif.
        </div>
      )}

      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1">
          <Label>Stage</Label>
          <select
            className="h-10 border rounded-md px-2 text-sm min-w-[10rem]"
            value={filterStage}
            onChange={(e) => setFilterStage(e.target.value)}
          >
            <option value="">Semua</option>
            {(Object.keys(TEMP_STAGE_LABELS) as TempStage[]).map((s) => (
              <option key={s} value={s}>{TEMP_STAGE_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Status alert</Label>
          <select
            className="h-10 border rounded-md px-2 text-sm min-w-[10rem]"
            value={filterAlert}
            onChange={(e) => setFilterAlert(e.target.value)}
          >
            <option value="">Semua</option>
            {(Object.keys(TEMP_ALERT_LABELS) as TempAlertStatus[]).map((s) => (
              <option key={s} value={s}>{TEMP_ALERT_LABELS[s]}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Waktu</th>
              <th className="text-left p-3">Stage</th>
              <th className="text-right p-3">°C</th>
              <th className="text-left p-3">Ambang</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Dapur</th>
              <th className="text-left p-3">Tautan</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">Belum ada log suhu</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 whitespace-nowrap text-xs">
                  {row.tanggal}
                  {row.recordedAt ? (
                    <div className="text-muted-foreground">
                      {new Date(row.recordedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  ) : null}
                </td>
                <td className="p-3">{TEMP_STAGE_LABELS[row.stage] || row.stage}</td>
                <td className="p-3 text-right font-mono font-medium">{row.suhuC}</td>
                <td className="p-3 text-xs text-muted-foreground">
                  {row.thresholdMinC != null || row.thresholdMaxC != null
                    ? `${row.thresholdMinC ?? '—'}…${row.thresholdMaxC ?? '—'}`
                    : '—'}
                </td>
                <td className={`p-3 ${alertClass(row.alertStatus)}`}>
                  {TEMP_ALERT_LABELS[row.alertStatus] || row.alertStatus}
                  {row.acknowledgedAt ? (
                    <div className="text-xs text-muted-foreground font-normal">acked</div>
                  ) : null}
                </td>
                <td className="p-3">{row.kitchenNama || '—'}</td>
                <td className="p-3 text-xs text-muted-foreground">
                  {[row.productionPlanNo, row.batchNo, row.qcResultNo, row.servicePointNama]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </td>
                <td className="p-3 text-right">
                  {canLog
                    && row.alertStatus !== 'OK'
                    && !row.acknowledgedAt && (
                    <Button variant="ghost" size="sm" onClick={() => void ack(row)} title="Acknowledge">
                      <Check className="h-4 w-4" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Settings2 className="h-4 w-4" />
          Threshold per stage
        </h2>
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3">Stage</th>
                <th className="text-right p-3">Min °C</th>
                <th className="text-right p-3">Max °C</th>
                <th className="text-right p-3">Warn band</th>
                <th className="text-left p-3">Sumber</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {thresholds.map((t) => (
                <tr key={t.stage} className="border-t">
                  <td className="p-3">{t.label}</td>
                  <td className="p-3 text-right font-mono">{t.minC ?? '—'}</td>
                  <td className="p-3 text-right font-mono">{t.maxC ?? '—'}</td>
                  <td className="p-3 text-right font-mono">{t.warnBandC ?? '—'}</td>
                  <td className="p-3 text-xs text-muted-foreground">{t.isDefault ? 'Default' : 'Tenant'}</td>
                  <td className="p-3 text-right">
                    {canManage && (
                      <Button variant="ghost" size="sm" onClick={() => openThresholdEditor(t)}>
                        Ubah
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Catat Suhu</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Stage</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={form.stage}
                onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value as TempStage }))}
              >
                {(Object.keys(TEMP_STAGE_LABELS) as TempStage[]).map((s) => (
                  <option key={s} value={s}>{TEMP_STAGE_LABELS[s]}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Suhu (°C)</Label>
              <Input
                type="number"
                step="0.1"
                value={form.suhuC}
                onChange={(e) => setForm((f) => ({ ...f, suhuC: e.target.value }))}
                placeholder="74"
              />
            </div>
            <div className="space-y-1">
              <Label>Dapur</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={form.kitchenId}
                onChange={(e) => setForm((f) => ({ ...f, kitchenId: e.target.value }))}
              >
                <option value="">— (scope dapur)</option>
                {kitchens.map((k) => <option key={k.id} value={k.id}>{k.nama}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label>Catatan</Label>
              <Input
                value={form.catatan}
                onChange={(e) => setForm((f) => ({ ...f, catatan: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button
              onClick={() => void saveLog()}
              disabled={saving || form.suhuC === '' || Number.isNaN(Number(form.suhuC))}
            >
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={openThr} onOpenChange={setOpenThr}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Threshold — {TEMP_STAGE_LABELS[thrForm.stage]}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Min °C</Label>
                <Input type="number" step="0.1" value={thrForm.minC} onChange={(e) => setThrForm((f) => ({ ...f, minC: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Max °C</Label>
                <Input type="number" step="0.1" value={thrForm.maxC} onChange={(e) => setThrForm((f) => ({ ...f, maxC: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Warn band</Label>
                <Input type="number" step="0.1" value={thrForm.warnBandC} onChange={(e) => setThrForm((f) => ({ ...f, warnBandC: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>Critical margin</Label>
                <Input type="number" step="0.1" value={thrForm.criticalMarginC} onChange={(e) => setThrForm((f) => ({ ...f, criticalMarginC: e.target.value }))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenThr(false)}>Batal</Button>
            <Button onClick={() => void saveThreshold()} disabled={saving}>
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
