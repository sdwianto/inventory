'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import { BadgeCheck, Plus, RefreshCw, Eye, Trash2 } from 'lucide-react';
import {
  QC_STATUS_LABELS,
  QC_CATEGORY_LABELS,
  QC_UI_STATUS_NEXT,
  QC_UI_STATUS_NEXT_LABEL,
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

interface QcRow {
  id: string;
  noDokumen: string;
  templateKode?: string;
  templateNama?: string;
  category: keyof typeof QC_CATEGORY_LABELS;
  productionPlanNo?: string;
  tanggal: string;
  status: QcResultStatus;
  summary?: { passCount: number; failCount: number; naCount: number };
  items: Array<{ key: string; label: string; result: QcItemResult; note?: string }>;
}

interface PlanOpt {
  id: string;
  noDokumen: string;
  tanggal: string;
  status: string;
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
  const [openCreate, setOpenCreate] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [planId, setPlanId] = useState('');
  const [detail, setDetail] = useState<QcRow | null>(null);
  const [editItems, setEditItems] = useState<QcRow['items']>([]);
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

  async function createQc() {
    if (!templateId) {
      toast.error('Pilih template');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/qc-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          templateId,
          ...(planId ? { productionPlanId: planId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membuat');
      toast.success(`QC ${data.noDokumen} dibuat`);
      setOpenCreate(false);
      setTemplateId('');
      setPlanId('');
      await load();
      setDetail(data as QcRow);
      setEditItems(data.items || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(row: QcRow) {
    const res = await fetch(`/api/qc-results/${row.id}`, { headers: { ...actingTenantHeaders() } });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal detail');
      return;
    }
    setDetail(data as QcRow);
    setEditItems(data.items || []);
  }

  async function saveItems() {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/qc-results/${detail.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ items: editItems }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal simpan');
      toast.success('Checklist tersimpan');
      setDetail(data as QcRow);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(row: QcRow, status: QcResultStatus) {
    try {
      const res = await fetch(`/api/qc-results/${row.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal status');
      toast.success(`Status → ${QC_STATUS_LABELS[status]}`);
      await load();
      if (detail?.id === row.id) {
        setDetail(data as QcRow);
        setEditItems(data.items || []);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
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
    if (detail?.id === row.id) setDetail(null);
    await load();
  }

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
            Checklist produksi / kebersihan / distribusi — sederhana untuk dapur
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat ulang
          </Button>
          {canLog && (
            <Button size="sm" onClick={() => setOpenCreate(true)}>
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
              <th className="text-left p-3">Hasil</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Belum ada QC</td></tr>
            )}
            {rows.map((row) => {
              const next = QC_UI_STATUS_NEXT[row.status];
              return (
                <tr key={row.id} className="border-t">
                  <td className="p-3 font-mono text-xs">{row.noDokumen}</td>
                  <td className="p-3">
                    <div>{row.templateNama || row.templateKode}</div>
                    <div className="text-[11px] text-muted-foreground">{QC_CATEGORY_LABELS[row.category]}</div>
                  </td>
                  <td className="p-3 font-mono text-xs">{row.productionPlanNo || '—'}</td>
                  <td className="p-3 text-xs">
                    ✓{row.summary?.passCount ?? 0} · ✗{row.summary?.failCount ?? 0} · —{row.summary?.naCount ?? 0}
                  </td>
                  <td className="p-3">{QC_STATUS_LABELS[row.status]}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1 justify-end">
                      <Button variant="ghost" size="sm" onClick={() => void openDetail(row)}>
                        <Eye className="h-4 w-4" />
                      </Button>
                      {canLog && next === 'SUBMITTED' && (
                        <Button variant="outline" size="sm" onClick={() => void changeStatus(row, next)}>
                          {QC_UI_STATUS_NEXT_LABEL[row.status]}
                        </Button>
                      )}
                      {canManage && next && next !== 'SUBMITTED' && (
                        <Button variant="outline" size="sm" onClick={() => void changeStatus(row, next)}>
                          {QC_UI_STATUS_NEXT_LABEL[row.status]}
                        </Button>
                      )}
                      {canManage && row.status !== 'CANCELLED' && row.status !== 'COMPLETED' && (
                        <Button variant="ghost" size="sm" onClick={() => void cancelQc(row)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Buat Checklist QC</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Template</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
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
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
              >
                <option value="">— Tanpa rencana —</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.noDokumen} · {p.tanggal}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenCreate(false)}>Batal</Button>
            <Button onClick={() => void createQc()} disabled={saving || !templateId}>
              {saving ? 'Memproses…' : 'Buat'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detail?.noDokumen} — {detail ? QC_STATUS_LABELS[detail.status] : ''}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="text-muted-foreground">
                {detail.templateNama} · {QC_CATEGORY_LABELS[detail.category]}
                {detail.productionPlanNo ? ` · ${detail.productionPlanNo}` : ''}
              </div>
              <div className="space-y-2">
                {(isQcEditable(detail.status) ? editItems : detail.items).map((item, idx) => (
                  <div key={item.key} className="border rounded p-2 space-y-1">
                    <div className="font-medium text-xs">{item.label}</div>
                    {isQcEditable(detail.status) && canLog ? (
                      <select
                        className="h-8 border rounded px-2 text-sm w-full"
                        value={item.result}
                        onChange={(e) => {
                          const v = e.target.value as QcItemResult;
                          setEditItems((prev) => prev.map((x, i) => (i === idx ? { ...x, result: v } : x)));
                        }}
                      >
                        <option value="NA">Belum</option>
                        <option value="PASS">Lulus</option>
                        <option value="FAIL">Gagal</option>
                      </select>
                    ) : (
                      <div className="text-xs">{item.result}</div>
                    )}
                  </div>
                ))}
              </div>
              {canLog && isQcEditable(detail.status) && (
                <Button size="sm" onClick={() => void saveItems()} disabled={saving}>Simpan checklist</Button>
              )}
              {canLog && detail.status === 'DRAFT' && (
                <Button size="sm" variant="outline" onClick={() => void changeStatus(detail, 'SUBMITTED')}>
                  Ajukan
                </Button>
              )}
              {canManage && detail.status === 'SUBMITTED' && (
                <Button size="sm" variant="outline" onClick={() => void changeStatus(detail, 'APPROVED')}>
                  Setujui
                </Button>
              )}
              {canManage && detail.status === 'APPROVED' && (
                <Button size="sm" variant="outline" onClick={() => void changeStatus(detail, 'COMPLETED')}>
                  Selesai
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
