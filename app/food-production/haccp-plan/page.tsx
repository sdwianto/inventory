'use client';

import { useCallback, useEffect, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { ClipboardList, Plus, RefreshCw, Save, Sprout } from 'lucide-react';
import {
  CRITICAL_LIMIT_OPERATOR_LABELS,
  EXAMPLE_HACCP_PLAN_COOK,
  HACCP_HAZARD_TYPE_LABELS,
  HACCP_PLAN_STATUS_LABELS,
  formatCriticalLimit,
  type HaccpPlanDoc,
  type HaccpPlanStatus,
} from '@/lib/food-production/haccp-plan';

type PlanRow = Pick<
  HaccpPlanDoc,
  | 'id'
  | 'kode'
  | 'nama'
  | 'status'
  | 'version'
  | 'isExample'
  | 'noDokumen'
  | 'processSteps'
  | 'hazards'
  | 'ccps'
  | 'criticalLimits'
  | 'monitoringPlans'
  | 'description'
  | 'recipeIds'
  | 'menuIds'
>;

const NEXT_STATUS: Partial<Record<HaccpPlanStatus, HaccpPlanStatus>> = {
  DRAFT: 'UNDER_REVIEW',
  UNDER_REVIEW: 'APPROVED',
  APPROVED: 'ACTIVE',
};

function idsToCsv(ids?: string[]): string {
  return (ids || []).join(', ');
}

function csvToIds(raw: string): string[] {
  return [...new Set(raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
}

export default function HaccpPlanPage() {
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanRow | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createKode, setCreateKode] = useState('');
  const [createNama, setCreateNama] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [editNama, setEditNama] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editRecipeIds, setEditRecipeIds] = useState('');
  const [editMenuIds, setEditMenuIds] = useState('');
  const [editStudyJson, setEditStudyJson] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);

  const editable = detail?.status === 'DRAFT' || detail?.status === 'UNDER_REVIEW';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/haccp-plans', { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat HACCP plan');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const syncEditForm = (plan: PlanRow) => {
    setEditNama(plan.nama || '');
    setEditDescription(plan.description || '');
    setEditRecipeIds(idsToCsv(plan.recipeIds));
    setEditMenuIds(idsToCsv(plan.menuIds));
    setEditStudyJson(JSON.stringify({
      processSteps: plan.processSteps || [],
      hazards: plan.hazards || [],
      ccps: plan.ccps || [],
      criticalLimits: plan.criticalLimits || [],
      monitoringPlans: plan.monitoringPlans || [],
    }, null, 2));
  };

  const openDetail = async (id: string) => {
    setSelectedId(id);
    try {
      const res = await fetch(`/api/haccp-plans/${id}`, { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat detail');
      setDetail(data);
      syncEditForm(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
      setDetail(null);
    }
  };

  const createPlan = async () => {
    const kode = createKode.trim().toUpperCase();
    const nama = createNama.trim();
    if (!kode || !nama) {
      toast.error('kode dan nama wajib');
      return;
    }
    setCreateBusy(true);
    try {
      const res = await fetch('/api/haccp-plans', {
        method: 'POST',
        headers: { ...actingTenantHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ kode, nama }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal membuat plan');
      toast.success(`Plan ${data.kode} dibuat`);
      setShowCreate(false);
      setCreateKode('');
      setCreateNama('');
      await load();
      if (data?.id) void openDetail(data.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setCreateBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!detail || !editable) return;
    let study: Record<string, unknown>;
    try {
      study = JSON.parse(editStudyJson) as Record<string, unknown>;
    } catch {
      toast.error('JSON study tidak valid');
      return;
    }
    setSaveBusy(true);
    try {
      const res = await fetch(`/api/haccp-plans/${detail.id}`, {
        method: 'PUT',
        headers: { ...actingTenantHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nama: editNama.trim(),
          description: editDescription,
          recipeIds: csvToIds(editRecipeIds),
          menuIds: csvToIds(editMenuIds),
          processSteps: study.processSteps,
          hazards: study.hazards,
          ccps: study.ccps,
          criticalLimits: study.criticalLimits,
          monitoringPlans: study.monitoringPlans,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
      toast.success('Plan disimpan');
      setDetail(data);
      syncEditForm(data);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaveBusy(false);
    }
  };

  const fillExampleStructure = () => {
    const ex = EXAMPLE_HACCP_PLAN_COOK;
    setEditStudyJson(JSON.stringify({
      processSteps: ex.processSteps,
      hazards: ex.hazards,
      ccps: ex.ccps,
      criticalLimits: ex.criticalLimits,
      monitoringPlans: ex.monitoringPlans,
    }, null, 2));
    toast.message('Struktur contoh dimasukkan — validasi ahli tetap wajib');
  };

  const seedExample = async () => {
    setSeeding(true);
    try {
      const res = await fetch('/api/haccp-plans/seed-example', {
        method: 'POST',
        headers: { ...actingTenantHeaders(), 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal seed contoh');
      toast.success('Contoh plan tersedia (bukan acuan hukum)');
      await load();
      if (data?.id) void openDetail(data.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSeeding(false);
    }
  };

  const advanceStatus = async () => {
    if (!detail) return;
    const next = NEXT_STATUS[detail.status];
    if (!next) {
      toast.message('Tidak ada transisi status berikutnya dari sini');
      return;
    }
    setStatusBusy(true);
    try {
      const res = await fetch(`/api/haccp-plans/${detail.id}/status`, {
        method: 'POST',
        headers: { ...actingTenantHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal ubah status');
      toast.success(`Status → ${HACCP_PLAN_STATUS_LABELS[next]}`);
      setDetail(data);
      syncEditForm(data);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setStatusBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ClipboardList className="h-5 w-5" />
            HACCP Study Plan
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Hazard analysis, CCP, critical limit terstruktur, dan monitoring plan.
            Konten contoh wajib divalidasi ahli sebelum operasional.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Muat ulang
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowCreate((v) => !v)}>
            <Plus className="mr-1 h-4 w-4" />
            Buat plan
          </Button>
          <Button size="sm" onClick={() => void seedExample()} disabled={seeding}>
            <Sprout className="mr-1 h-4 w-4" />
            Seed contoh
          </Button>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-lg border p-4 space-y-3 max-w-xl">
          <h2 className="text-sm font-semibold">Plan baru (DRAFT)</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">Kode</span>
              <input
                className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
                value={createKode}
                onChange={(e) => setCreateKode(e.target.value)}
                placeholder="HPL-COOK-01"
              />
            </label>
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">Nama</span>
              <input
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={createNama}
                onChange={(e) => setCreateNama(e.target.value)}
                placeholder="HACCP Plan Memasak"
              />
            </label>
          </div>
          <Button size="sm" disabled={createBusy} onClick={() => void createPlan()}>
            Simpan draft
          </Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2 font-medium">Kode</th>
                <th className="p-2 font-medium">Plan</th>
                <th className="p-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={`cursor-pointer border-t hover:bg-muted/30 ${
                    selectedId === row.id ? 'bg-muted/40' : ''
                  }`}
                  onClick={() => void openDetail(row.id)}
                >
                  <td className="p-2 font-mono text-xs">{row.kode}</td>
                  <td className="p-2">
                    <div className="font-medium">{row.nama}</div>
                    <div className="text-xs text-muted-foreground">
                      v{row.version}
                      {row.isExample ? ' · contoh' : ''}
                      {row.noDokumen ? ` · ${row.noDokumen}` : ''}
                    </div>
                  </td>
                  <td className="p-2 text-xs">
                    {HACCP_PLAN_STATUS_LABELS[row.status] || row.status}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-muted-foreground">
                    Belum ada HACCP plan — buat baru atau seed contoh
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border p-4 space-y-4">
          {!detail ? (
            <p className="text-sm text-muted-foreground">Pilih plan di kiri untuk melihat detail.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{detail.nama}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {detail.kode} · {HACCP_PLAN_STATUS_LABELS[detail.status]}
                    {detail.isExample ? ' · contoh (bukan acuan hukum)' : ''}
                  </p>
                </div>
                {NEXT_STATUS[detail.status] && (
                  <Button size="sm" variant="secondary" disabled={statusBusy} onClick={() => void advanceStatus()}>
                    → {HACCP_PLAN_STATUS_LABELS[NEXT_STATUS[detail.status]!]}
                  </Button>
                )}
              </div>

              {editable && (
                <div className="space-y-3 rounded-md border border-dashed p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Edit (DRAFT / review)
                  </h3>
                  <label className="block text-xs space-y-1">
                    <span className="text-muted-foreground">Nama</span>
                    <input
                      className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                      value={editNama}
                      onChange={(e) => setEditNama(e.target.value)}
                    />
                  </label>
                  <label className="block text-xs space-y-1">
                    <span className="text-muted-foreground">Deskripsi</span>
                    <textarea
                      className="w-full rounded border bg-background px-2 py-1.5 text-sm min-h-[60px]"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                    />
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="text-xs space-y-1">
                      <span className="text-muted-foreground">recipeIds (csv)</span>
                      <input
                        className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
                        value={editRecipeIds}
                        onChange={(e) => setEditRecipeIds(e.target.value)}
                      />
                    </label>
                    <label className="text-xs space-y-1">
                      <span className="text-muted-foreground">menuIds (csv)</span>
                      <input
                        className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
                        value={editMenuIds}
                        onChange={(e) => setEditMenuIds(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={fillExampleStructure}>
                      Isi struktur contoh
                    </Button>
                    <Button size="sm" disabled={saveBusy} onClick={() => void saveEdit()}>
                      <Save className="mr-1 h-3.5 w-3.5" />
                      Simpan
                    </Button>
                  </div>
                  <label className="block text-xs space-y-1">
                    <span className="text-muted-foreground">
                      Study JSON (steps / hazards / ccps / limits / monitoring)
                    </span>
                    <textarea
                      className="w-full rounded border bg-background px-2 py-1.5 text-xs font-mono min-h-[180px]"
                      value={editStudyJson}
                      onChange={(e) => setEditStudyJson(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                </div>
              )}

              {!editable && (
                <>
                  {(detail.recipeIds?.length || detail.menuIds?.length) ? (
                    <p className="text-xs text-muted-foreground">
                      recipeIds: {(detail.recipeIds || []).join(', ') || '—'}
                      {' · '}
                      menuIds: {(detail.menuIds || []).join(', ') || '—'}
                    </p>
                  ) : null}
                  {detail.description && (
                    <p className="text-sm text-muted-foreground">{detail.description}</p>
                  )}
                </>
              )}

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Process steps ({detail.processSteps?.length || 0})
                </h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {(detail.processSteps || []).map((s) => (
                    <li key={s.key}>
                      <span className="font-mono text-xs text-muted-foreground">{s.sequence}.</span>{' '}
                      {s.nama}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Hazards ({detail.hazards?.length || 0})
                </h3>
                <ul className="mt-1 space-y-2 text-sm">
                  {(detail.hazards || []).map((h) => (
                    <li key={h.key} className="border-t pt-2 first:border-0 first:pt-0">
                      <div className="font-medium">
                        {h.description}
                        {h.isCcp && (
                          <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-400">
                            CCP
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {HACCP_HAZARD_TYPE_LABELS[h.hazardType]} · step {h.processStepKey}
                      </div>
                      {h.ccpJustification && (
                        <p className="mt-1 text-xs">{h.ccpJustification}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  CCP ({detail.ccps?.length || 0})
                </h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {(detail.ccps || []).map((c) => (
                    <li key={c.key}>
                      <span className="font-medium">{c.nama}</span>
                      {c.category ? (
                        <span className="text-xs text-muted-foreground"> · {c.category}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Critical limits ({detail.criticalLimits?.length || 0})
                </h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {(detail.criticalLimits || []).map((cl) => (
                    <li key={cl.key}>
                      <span className="font-medium">{cl.label}</span>
                      <span className="text-muted-foreground">
                        {' '}
                        ({CRITICAL_LIMIT_OPERATOR_LABELS[cl.operator]}){' '}
                        {formatCriticalLimit(cl)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Monitoring ({detail.monitoringPlans?.length || 0})
                </h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {(detail.monitoringPlans || []).map((m) => (
                    <li key={m.key}>
                      <span className="font-medium">{m.method}</span>
                      <span className="text-xs text-muted-foreground">
                        {' '}
                        · {m.frequency}
                        {m.templateKodeHint ? ` · tpl ${m.templateKodeHint}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
