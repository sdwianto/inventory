'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import { ShieldCheck, Plus, RefreshCw, Eye, ArrowRight } from 'lucide-react';
import FoodSafetyBreadcrumb from '@/components/food-safety/FoodSafetyBreadcrumb';
import {
  HACCP_STATUS_LABELS,
  HACCP_CATEGORY_LABELS,
  HACCP_DISPOSITION_LABELS,
  HACCP_UI_STATUS_NEXT,
  effectiveHaccpDisposition,
  isHaccpEditable,
  type HaccpDisposition,
  type HaccpResultStatus,
  type HaccpItemResult,
} from '@/lib/food-production/haccp';
import { isNumericAutoEvalLimit } from '@/lib/food-production/haccp-critical-limit-eval';
import { normalizeHaccpTemplateKodeHint } from '@/lib/food-production/haccp-plan';
import { buildHaccpHoldRepairHrefs } from '@/lib/food-safety/hold-repair-href';

type FoodSafetyHoldResult = {
  held?: boolean;
  skipped?: string;
  foodSafetyStatus?: string;
  error?: string;
  kaIssue?: {
    id?: string;
    noDokumen?: string;
    created?: boolean;
    temuanHref?: string;
    followUpHref?: string;
  };
};

function toastFoodSafetyHold(hold: FoodSafetyHoldResult | undefined) {
  if (!hold) return;
  if (hold.error) {
    toast.warning(`Checklist tersimpan, tetapi penahanan batch gagal: ${hold.error}`);
    return;
  }
  const href = hold.kaIssue?.followUpHref
    || (hold.kaIssue?.id
      ? buildHaccpHoldRepairHrefs({ caseId: hold.kaIssue.id }).followUpHref
      : hold.kaIssue?.temuanHref || '/kitchen-assurance/temuan');
  const action = {
    label: 'Lanjut ke perbaikan',
    onClick: () => {
      window.location.href = href;
    },
  };
  if (hold.held) {
    const ka = hold.kaIssue?.noDokumen ? ` · Issue ${hold.kaIssue.noDokumen}` : '';
    toast.warning(`Batch ditahan (food safety)${ka}`, {
      action,
      duration: 14_000,
    });
    return;
  }
  if (hold.skipped === 'already_hold') {
    toast.message('Batch sudah berstatus HOLD (food safety)', {
      action,
      duration: 10_000,
    });
  }
}

const OPS_WRITE = new Set(['GUDANG', 'ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);
const MANAGE = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface Template {
  id: string;
  kode: string;
  nama: string;
  category: keyof typeof HACCP_CATEGORY_LABELS;
  items: Array<{
    key: string;
    label: string;
    required?: boolean;
    needsPhoto?: boolean;
    criticalLimitNote?: string;
    criticalLimit?: { operator?: string; value?: number; valueMax?: number; unit?: string; label?: string };
  }>;
}

interface BatchOpt {
  id: string;
  batchNo: string;
  finishedGoodNama?: string;
  kitchenNama?: string;
}

interface HaccpItemEdit {
  key: string;
  label: string;
  result: HaccpItemResult;
  note?: string;
  measuredValue?: number;
  operatorId?: string;
  instrumentId?: string;
  autoEvaluated?: boolean;
}

interface HaccpRow {
  id: string;
  noDokumen: string;
  templateId?: string;
  templateKode?: string;
  templateNama?: string;
  category: keyof typeof HACCP_CATEGORY_LABELS;
  productionBatchId: string;
  batchNo?: string;
  tanggal: string;
  status: HaccpResultStatus;
  disposition?: HaccpDisposition;
  summary?: {
    passCount: number;
    failCount: number;
    requiredFailCount: number;
    photoCount: number;
  };
  items: HaccpItemEdit[];
  evidenceUrls?: string[];
}

export default function HaccpPage() {
  const role = useMemo(
    () => String((getUser() as { role?: string } | null)?.role || ''),
    [],
  );
  const canLog = OPS_WRITE.has(role);
  const canManage = MANAGE.has(role);

  const [rows, setRows] = useState<HaccpRow[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [batches, setBatches] = useState<BatchOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [haccpPlanId, setHaccpPlanId] = useState('');
  const [ccpKey, setCcpKey] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [detail, setDetail] = useState<HaccpRow | null>(null);
  const [editItems, setEditItems] = useState<HaccpItemEdit[]>([]);
  const [detailPhotos, setDetailPhotos] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const detailTemplate = useMemo(
    () => templates.find((t) => t.id === detail?.templateId),
    [templates, detail?.templateId],
  );

  const operatorId = useMemo(
    () => String((getUser() as { id?: string } | null)?.id || '').trim(),
    [],
  );

  const itemsForSave = () => editItems.map((item) => ({
    ...item,
    operatorId: item.measuredValue != null
      ? (item.operatorId || operatorId)
      : item.operatorId,
  }));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hdr = { ...actingTenantHeaders(), ...actingKitchenHeaders() };
      const [hRes, tRes, bRes] = await Promise.all([
        fetch('/api/haccp-results', { headers: hdr }),
        fetch('/api/haccp-templates?aktif=1', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/production-batches', { headers: hdr }),
      ]);
      const hData = await hRes.json();
      const tData = await tRes.json();
      const bData = await bRes.json();
      if (!hRes.ok) throw new Error(hData?.error || 'Gagal memuat HACCP');
      setRows(Array.isArray(hData) ? hData : []);
      setTemplates(Array.isArray(tData) ? tData : []);
      setBatches(Array.isArray(bData) ? bData : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  // Deep-link dari Operasi: ?create=1&planId=&ccpKey=&templateKode=&batch=
  useEffect(() => {
    if (typeof window === 'undefined' || !templates.length) return;
    const q = new URLSearchParams(window.location.search);
    const plan = q.get('planId') || '';
    const ccp = q.get('ccpKey') || '';
    const kode = normalizeHaccpTemplateKodeHint(q.get('templateKode') || '');
    const batch = q.get('batch') || '';
    if (plan) setHaccpPlanId(plan);
    if (ccp) setCcpKey(ccp);
    if (batch) setBatchId(batch);
    if (kode) {
      const match = templates.find((t) => normalizeHaccpTemplateKodeHint(t.kode) === kode);
      if (match) setTemplateId(match.id);
    }
    if (q.get('create') === '1' && canLog) {
      setOpenCreate(true);
    }
  }, [templates, canLog]);

  async function createHaccp() {
    if (!templateId || !batchId) {
      toast.error('Pilih template dan batch');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/haccp-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          templateId,
          productionBatchId: batchId,
          evidenceBase64: photos,
          ...(haccpPlanId ? { haccpPlanId } : {}),
          ...(ccpKey ? { ccpKey } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membuat');
      toast.success(`HACCP ${data.noDokumen} dibuat`);
      // P0D: create boleh membawa FAIL (API) → HOLD di DRAFT; UI default NA.
      toastFoodSafetyHold(data?.foodSafetyHold as FoodSafetyHoldResult | undefined);
      setOpenCreate(false);
      setTemplateId('');
      setBatchId('');
      setHaccpPlanId('');
      setCcpKey('');
      setPhotos([]);
      await load();
      setDetail(data as HaccpRow);
      setEditItems(data.items || []);
      setDetailPhotos(data.evidenceUrls || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(row: HaccpRow) {
    const res = await fetch(`/api/haccp-results/${row.id}`, {
      headers: { ...actingTenantHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal detail');
      return;
    }
    setDetail(data as HaccpRow);
    setEditItems(data.items || []);
    setDetailPhotos(data.evidenceUrls || []);
  }

  async function saveItems() {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/haccp-results/${detail.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          items: itemsForSave(),
          evidenceUrls: detailPhotos,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal simpan');
      toast.success('Checklist disimpan');
      toastFoodSafetyHold(data?.foodSafetyHold as FoodSafetyHoldResult | undefined);
      setDetail(data as HaccpRow);
      setEditItems((data as HaccpRow).items || editItems);
      setDetailPhotos((data as HaccpRow).evidenceUrls || detailPhotos);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function advance() {
    if (!detail) return;
    const next = HACCP_UI_STATUS_NEXT[detail.status];
    if (!next) return;
    setSaving(true);
    try {
      // Persist checklist before status gate (COMPLETED validates DB items, not local UI).
      if (canLog && isHaccpEditable(detail.status)) {
        const saveRes = await fetch(`/api/haccp-results/${detail.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
          body: JSON.stringify({
            items: itemsForSave(),
            evidenceUrls: detailPhotos,
          }),
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) throw new Error(saveData?.error || 'Gagal simpan checklist');
        toastFoodSafetyHold(saveData?.foodSafetyHold as FoodSafetyHoldResult | undefined);
        setDetail(saveData as HaccpRow);
        setEditItems((saveData as HaccpRow).items || editItems);
        setDetailPhotos((saveData as HaccpRow).evidenceUrls || detailPhotos);
      }
      const res = await fetch(`/api/haccp-results/${detail.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal status');
      toast.success(`Status → ${HACCP_STATUS_LABELS[next]}`);
      toastFoodSafetyHold(data?.foodSafetyHold as FoodSafetyHoldResult | undefined);
      if (next === 'COMPLETED' || next === 'CANCELLED') {
        setDetail(null);
      } else {
        setDetail(data as HaccpRow);
        setEditItems((data as HaccpRow).items || editItems);
        setDetailPhotos((data as HaccpRow).evidenceUrls || detailPhotos);
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <FoodSafetyBreadcrumb
            items={[
              { href: '/kitchen-assurance/operasi', label: 'Operasi harian' },
              { label: 'Catat CCP' },
            ]}
          />
          <h1 className="mt-1 text-xl font-semibold flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Catat CCP
          </h1>
          <p className="text-sm text-muted-foreground">
            Checklist titik kritis + foto bukti per batch. Jika gagal kritis, batch ditahan dan lanjut ke Temuan & perbaikan.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
          {canLog && (
            <Button size="sm" onClick={() => setOpenCreate(true)}>
              <Plus className="h-4 w-4 mr-1" /> Catat CCP
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Dokumen</th>
              <th className="text-left p-3">Template</th>
              <th className="text-left p-3">Batch</th>
              <th className="text-left p-3">Status</th>
              <th className="text-right p-3">Foto</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Belum ada evidence HACCP</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                <td className="p-3">
                  <div>{row.templateNama || row.templateKode}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {HACCP_CATEGORY_LABELS[row.category] || row.category}
                  </div>
                </td>
                <td className="p-3 font-mono text-xs">{row.batchNo || row.productionBatchId}</td>
                <td className="p-3">
                  <div>{HACCP_STATUS_LABELS[row.status] || row.status}</div>
                  {effectiveHaccpDisposition(row) === 'FAIL' && (
                    <div className="text-[11px] font-medium text-destructive">CCP gagal</div>
                  )}
                </td>
                <td className="p-3 text-right">{row.summary?.photoCount ?? 0}</td>
                <td className="p-3 text-right space-x-1">
                  {effectiveHaccpDisposition(row) === 'FAIL' && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/kitchen-assurance/temuan?batch=${encodeURIComponent(row.productionBatchId)}`}>
                        Lanjut ke perbaikan
                        <ArrowRight className="ml-1 h-3 w-3" />
                      </Link>
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void openDetail(row)}>
                    <Eye className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Catat CCP</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {(haccpPlanId || ccpKey) && (
              <p className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-950">
                Dari rencana aktif
                {ccpKey ? <> · CCP <code>{ccpKey}</code></> : null}
                . Template sudah dipilih dari rencana pemantauan bila tersedia.
              </p>
            )}
            <div className="space-y-1">
              <Label>Template</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                disabled={Boolean(haccpPlanId && templateId)}
              >
                <option value="">—</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.kode} — {t.nama}</option>
                ))}
              </select>
              {haccpPlanId && templateId ? (
                <p className="text-[11px] text-muted-foreground">
                  Template dikunci dari rencana aktif — bukan pilihan acak.
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label>Batch</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={batchId}
                onChange={(e) => setBatchId(e.target.value)}
              >
                <option value="">—</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.batchNo} · {b.finishedGoodNama || 'FG'} · {b.kitchenNama || '—'}
                  </option>
                ))}
              </select>
            </div>
            <PhotoUploadField
              label="Evidence foto"
              hint="Disimpan ke media storage (bukan base64 di DB)"
              photos={photos}
              onChange={setPhotos}
              maxPhotos={5}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenCreate(false)}>Batal</Button>
            <Button onClick={() => void createHaccp()} disabled={saving || !templateId || !batchId}>
              {saving ? 'Menyimpan…' : 'Buat'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail?.noDokumen}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                {detail.templateNama} · batch {detail.batchNo} · {HACCP_STATUS_LABELS[detail.status]}
                {' · '}
                hasil {HACCP_DISPOSITION_LABELS[effectiveHaccpDisposition(detail)]
                  || effectiveHaccpDisposition(detail)}
              </p>
              {effectiveHaccpDisposition(detail) === 'FAIL' && (
                <p className="text-xs text-destructive font-medium">
                  CCP gagal — batch terkait ditahan (HOLD) saat checklist disimpan, meski dokumen masih DRAFT.
                </p>
              )}
              {editItems.map((item, idx) => {
                const tplItem = detailTemplate?.items?.find((t) => t.key === item.key);
                const limitHint = tplItem?.criticalLimit
                  ? `${tplItem.criticalLimit.operator || ''} ${tplItem.criticalLimit.value ?? ''}${
                    tplItem.criticalLimit.valueMax != null ? `–${tplItem.criticalLimit.valueMax}` : ''
                  }${tplItem.criticalLimit.unit ? ` ${tplItem.criticalLimit.unit}` : ''}`.trim()
                  : tplItem?.criticalLimitNote || '';
                const numericAuto = tplItem
                  ? isNumericAutoEvalLimit(tplItem)
                  : Boolean(item.autoEvaluated);
                const hasLimit = Boolean(tplItem?.criticalLimit || tplItem?.criticalLimitNote);
                return (
                  <div key={item.key} className="space-y-1 border-b pb-2">
                    <Label>{item.label}</Label>
                    {hasLimit && (
                      <p className="text-xs text-muted-foreground">
                        Limit: {limitHint || 'terstruktur'}
                        {numericAuto
                          ? ' · isi nilai terukur → PASS/FAIL otomatis'
                          : ' · limit teks — PASS/FAIL tetap manual'}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="number"
                        step="any"
                        placeholder="Nilai terukur"
                        className="h-9 w-28 border rounded-md px-2 text-sm"
                        value={item.measuredValue ?? ''}
                        disabled={!canLog || !isHaccpEditable(detail.status)}
                        onChange={(e) => {
                          const next = [...editItems];
                          const raw = e.target.value;
                          next[idx] = {
                            ...item,
                            measuredValue: raw === '' ? undefined : Number(raw),
                          };
                          setEditItems(next);
                        }}
                      />
                      <input
                        type="text"
                        placeholder="Instrumen (opsional)"
                        className="h-9 w-36 border rounded-md px-2 text-sm"
                        value={item.instrumentId || ''}
                        disabled={!canLog || !isHaccpEditable(detail.status)}
                        onChange={(e) => {
                          const next = [...editItems];
                          next[idx] = {
                            ...item,
                            instrumentId: e.target.value.trim() || undefined,
                          };
                          setEditItems(next);
                        }}
                      />
                      <select
                        className="flex-1 min-w-[7rem] h-9 border rounded-md px-2 text-sm"
                        value={item.result}
                        disabled={
                          !canLog
                          || !isHaccpEditable(detail.status)
                          || (numericAuto && item.measuredValue != null)
                        }
                        onChange={(e) => {
                          const next = [...editItems];
                          next[idx] = { ...item, result: e.target.value as HaccpItemResult };
                          setEditItems(next);
                        }}
                      >
                        <option value="PASS">PASS</option>
                        <option value="FAIL">FAIL</option>
                        <option value="NA">N/A</option>
                      </select>
                    </div>
                    {item.autoEvaluated && (
                      <p className="text-xs text-muted-foreground">
                        Dievaluasi otomatis dari critical limit
                        {item.measuredValue != null ? ` (${item.measuredValue})` : ''}
                      </p>
                    )}
                  </div>
                );
              })}
              <PhotoUploadField
                label="Evidence"
                photos={detailPhotos}
                onChange={setDetailPhotos}
                maxPhotos={10}
                disabled={!canLog || !isHaccpEditable(detail.status)}
              />
              <div className="flex flex-wrap gap-2 pt-2">
                {canLog && isHaccpEditable(detail.status) && (
                  <Button size="sm" onClick={() => void saveItems()} disabled={saving}>
                    Simpan checklist
                  </Button>
                )}
                {canManage && HACCP_UI_STATUS_NEXT[detail.status] && (
                  <Button size="sm" variant="secondary" onClick={() => void advance()} disabled={saving}>
                    → {HACCP_STATUS_LABELS[HACCP_UI_STATUS_NEXT[detail.status]!]}
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
