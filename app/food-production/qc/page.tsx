'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import { BadgeCheck, Plus, RefreshCw, Eye, Trash2 } from 'lucide-react';
import {
  QC_STATUS_LABELS,
  QC_CATEGORY_LABELS,
  QC_ITEM_RESULT_LABELS,
  isQcEditable,
  type QcResultStatus,
  type QcItemResult,
} from '@/lib/food-production/qc';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);
const OPS_WRITE = new Set(['GUDANG', 'ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface Template {
  id: string;
  kode: string;
  nama: string;
  category: keyof typeof QC_CATEGORY_LABELS;
  items: Array<{ key: string; label: string; required?: boolean }>;
}

interface QcItemEdit {
  key: string;
  label: string;
  result: QcItemResult;
  note?: string;
  evidenceUrls?: string[];
}

interface QcRow {
  id: string;
  noDokumen: string;
  templateId?: string;
  templateKode?: string;
  templateNama?: string;
  category: keyof typeof QC_CATEGORY_LABELS;
  productionPlanNo?: string;
  tanggal: string;
  status: QcResultStatus;
  summary?: { passCount: number; failCount: number; naCount: number; photoCount?: number };
  items: QcItemEdit[];
  catatan?: string;
  recordedAt?: string;
  recordedByName?: string;
  createdByName?: string;
}

interface PlanOpt {
  id: string;
  noDokumen: string;
  tanggal: string;
  status: string;
}

function formatRecordedAt(raw?: string): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  return d.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function itemsFromTemplate(t: Template): QcItemEdit[] {
  return (t.items || []).map((it) => ({
    key: it.key,
    label: it.label,
    result: 'NA' as QcItemResult,
    note: '',
    evidenceUrls: [],
  }));
}

export default function QcPage() {
  const confirm = useConfirm();
  const role = useMemo(() => String((getUser() as { role?: string } | null)?.role || ''), []);
  const canManage = MANAGE_ROLES.has(role);
  const canLog = OPS_WRITE.has(role);

  const [rows, setRows] = useState<QcRow[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [plans, setPlans] = useState<PlanOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [noDokumen, setNoDokumen] = useState('');
  const [status, setStatus] = useState<QcResultStatus>('DRAFT');
  const [templateId, setTemplateId] = useState('');
  const [planId, setPlanId] = useState('');
  const [editItems, setEditItems] = useState<QcItemEdit[]>([]);
  const [catatan, setCatatan] = useState('');
  const [recordedAt, setRecordedAt] = useState<string | undefined>();
  const [recordedByName, setRecordedByName] = useState<string | undefined>();
  const [metaLine, setMetaLine] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [qRes, tRes, pRes] = await Promise.all([
        fetch('/api/qc-results', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/qc-templates?aktif=1', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/production-plans', { headers: { ...actingTenantHeaders() } }),
      ]);
      const qData = await qRes.json();
      const tData = await tRes.json();
      const pData = await pRes.json();
      if (!qRes.ok) throw new Error(qData?.error || 'Gagal memuat QC');
      setRows(Array.isArray(qData) ? qData : []);
      setTemplates(Array.isArray(tData) ? tData : []);
      setPlans(Array.isArray(pData) ? pData : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openNew() {
    setEditingId(null);
    setNoDokumen('');
    setStatus('DRAFT');
    setTemplateId('');
    setPlanId('');
    setEditItems([]);
    setCatatan('');
    setRecordedAt(undefined);
    setRecordedByName(undefined);
    setMetaLine('');
    setFormOpen(true);
  }

  function applyTemplate(tid: string) {
    setTemplateId(tid);
    const t = templates.find((x) => x.id === tid);
    if (t) {
      setEditItems(itemsFromTemplate(t));
      setMetaLine(`${t.nama} · ${QC_CATEGORY_LABELS[t.category]}`);
    } else {
      setEditItems([]);
      setMetaLine('');
    }
  }

  async function openDetail(row: QcRow) {
    const res = await fetch(`/api/qc-results/${row.id}`, { headers: { ...actingTenantHeaders() } });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal detail');
      return;
    }
    const doc = data as QcRow;
    setEditingId(doc.id);
    setNoDokumen(doc.noDokumen);
    setStatus(doc.status);
    setTemplateId(doc.templateId || '');
    setPlanId('');
    setEditItems((doc.items || []).map((it) => ({
      ...it,
      note: it.note || '',
      evidenceUrls: it.evidenceUrls || [],
    })));
    setCatatan(doc.catatan || '');
    setRecordedAt(doc.recordedAt);
    setRecordedByName(doc.recordedByName || doc.createdByName);
    setMetaLine(
      `${doc.templateNama || doc.templateKode || 'QC'} · ${QC_CATEGORY_LABELS[doc.category]}`
      + (doc.productionPlanNo ? ` · ${doc.productionPlanNo}` : ''),
    );
    setFormOpen(true);
  }

  async function saveChecklist() {
    if (!canLog) return;
    if (!editingId && !templateId) {
      toast.error('Pilih template dulu');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        items: editItems,
        catatan,
        save: true,
        record: true,
        ...(planId ? { productionPlanId: planId } : {}),
        ...(!editingId ? { templateId } : {}),
      };
      const res = await fetch(
        editingId ? `/api/qc-results/${editingId}` : '/api/qc-results',
        {
          method: editingId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal simpan');
      const saved = data as QcRow;
      toast.success(`Checklist ${saved.noDokumen} tersimpan`);
      setFormOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function cancelQc(row: QcRow) {
    const okConfirm = await confirm({
      title: 'Batalkan QC?',
      description: row.noDokumen,
      confirmText: 'Batalkan',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    const res = await fetch(`/api/qc-results/${row.id}`, {
      method: 'DELETE',
      headers: { ...actingTenantHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal');
      return;
    }
    toast.success('Dibatalkan');
    if (editingId === row.id) setFormOpen(false);
    await load();
  }

  const editable = canLog && (editingId ? isQcEditable(status) : true);
  const selectedTemplateLocked = Boolean(editingId);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <BadgeCheck className="h-5 w-5" />
            Quality Control
          </h1>
          <p className="text-sm text-muted-foreground">
            Catat finding lapangan (bukan approval PASS-all) — foto & remark per item
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat ulang
          </Button>
          {canLog && (
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4 mr-1" /> Baru
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">No QCR</th>
              <th className="text-left p-3">Template</th>
              <th className="text-left p-3">Rencana</th>
              <th className="text-left p-3">Temuan</th>
              <th className="text-left p-3">Dicatat</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Belum ada QC</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                <td className="p-3">
                  <div>{row.templateNama || row.templateKode}</div>
                  <div className="text-[11px] text-muted-foreground">{QC_CATEGORY_LABELS[row.category]}</div>
                </td>
                <td className="p-3 font-mono text-xs">{row.productionPlanNo || '—'}</td>
                <td className="p-3 text-xs">
                  {row.summary?.failCount ?? 0} temuan · {row.summary?.photoCount ?? 0} foto
                </td>
                <td className="p-3 text-xs text-muted-foreground">
                  <div>{row.recordedByName || row.createdByName || '—'}</div>
                  <div>{formatRecordedAt(row.recordedAt)}</div>
                </td>
                <td className="p-3">{QC_STATUS_LABELS[row.status]}</td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-1 justify-end">
                    <Button variant="ghost" size="sm" onClick={() => void openDetail(row)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    {canManage && row.status !== 'CANCELLED' && (
                      <Button variant="ghost" size="sm" onClick={() => void cancelQc(row)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={formOpen} onOpenChange={(o) => { if (!o) setFormOpen(false); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {noDokumen ? `${noDokumen} — ${QC_STATUS_LABELS[status]}` : 'Catat QC / Finding'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm py-1">
            {metaLine && (
              <p className="text-muted-foreground">{metaLine}</p>
            )}

            {!selectedTemplateLocked && (
              <div className="space-y-2 rounded-md border p-3 bg-muted/20">
                <div className="space-y-1">
                  <Label>Template</Label>
                  <select
                    className="w-full h-10 border rounded-md px-2 text-sm bg-background"
                    value={templateId}
                    onChange={(e) => applyTemplate(e.target.value)}
                    disabled={!editable}
                  >
                    <option value="">— Pilih —</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.kode} · {t.nama} ({QC_CATEGORY_LABELS[t.category]})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>Rencana (opsional)</Label>
                  <select
                    className="w-full h-10 border rounded-md px-2 text-sm bg-background"
                    value={planId}
                    onChange={(e) => setPlanId(e.target.value)}
                    disabled={!editable}
                  >
                    <option value="">— Tanpa rencana —</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>{p.noDokumen} · {p.tanggal}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {editItems.map((item, idx) => (
              <div key={item.key} className="border rounded-md p-3 space-y-2">
                <div className="font-medium text-xs">{item.label}</div>
                {editable ? (
                  <>
                    <select
                      className="h-9 border rounded-md px-2 text-sm w-full bg-background"
                      value={item.result}
                      onChange={(e) => {
                        const v = e.target.value as QcItemResult;
                        setEditItems((prev) => prev.map((x, i) => (i === idx ? { ...x, result: v } : x)));
                      }}
                    >
                      <option value="NA">{QC_ITEM_RESULT_LABELS.NA}</option>
                      <option value="PASS">{QC_ITEM_RESULT_LABELS.PASS}</option>
                      <option value="FAIL">{QC_ITEM_RESULT_LABELS.FAIL}</option>
                    </select>
                    <Textarea
                      placeholder="Catatan / deskripsi finding…"
                      className="min-h-[60px] text-sm"
                      value={item.note || ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setEditItems((prev) => prev.map((x, i) => (i === idx ? { ...x, note: v } : x)));
                      }}
                    />
                    <PhotoUploadField
                      label="Foto evidence"
                      hint="Maks. 3 foto per item"
                      photos={item.evidenceUrls || []}
                      maxPhotos={3}
                      onChange={(photos) => {
                        setEditItems((prev) => prev.map((x, i) => (
                          i === idx ? { ...x, evidenceUrls: photos } : x
                        )));
                      }}
                    />
                  </>
                ) : (
                  <>
                    <div className="text-xs">{QC_ITEM_RESULT_LABELS[item.result] || item.result}</div>
                    {item.note && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{item.note}</p>}
                    {(item.evidenceUrls || []).length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {(item.evidenceUrls || []).map((src) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={src} src={src} alt="" className="h-16 w-16 rounded object-cover border" />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}

            {editItems.length > 0 && (
              <div className="space-y-1">
                <Label>Remark (sebelum simpan)</Label>
                <Textarea
                  placeholder="Ringkasan / catatan umum inspeksi…"
                  className="min-h-[72px] text-sm"
                  value={catatan}
                  disabled={!editable}
                  onChange={(e) => setCatatan(e.target.value)}
                />
              </div>
            )}

            {(recordedAt || recordedByName) && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Dicatat oleh <span className="font-medium text-foreground">{recordedByName || '—'}</span>
                {' · '}
                {formatRecordedAt(recordedAt)}
              </div>
            )}
          </div>
          {editable && editItems.length > 0 && (
            <DialogFooter>
              <Button
                className="w-full sm:w-auto"
                onClick={() => void saveChecklist()}
                disabled={saving || (!editingId && !templateId)}
              >
                {saving ? 'Menyimpan…' : 'Simpan checklist'}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
