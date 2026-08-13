'use client';

import { useCallback, useEffect, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import HaccpStudyForm, { type HaccpStudyValue } from '@/components/food-production/HaccpStudyForm';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { ClipboardList, Plus, RefreshCw, Save, Sprout } from 'lucide-react';
import { HACCP_CATEGORY_LABELS } from '@/lib/food-production/haccp';
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

const EMPTY_STUDY: HaccpStudyValue = {
  processSteps: [],
  hazards: [],
  ccps: [],
  criticalLimits: [],
  monitoringPlans: [],
};

function idsToCsv(ids?: string[]): string {
  return (ids || []).join(', ');
}

function csvToIds(raw: string): string[] {
  return [...new Set(raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
}

function studyFromPlan(plan: PlanRow): HaccpStudyValue {
  return {
    processSteps: plan.processSteps || [],
    hazards: plan.hazards || [],
    ccps: plan.ccps || [],
    criticalLimits: plan.criticalLimits || [],
    monitoringPlans: plan.monitoringPlans || [],
  };
}

function stepLabel(plan: PlanRow, key: string): string {
  return plan.processSteps?.find((s) => s.key === key)?.nama || key;
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
  const [editStudy, setEditStudy] = useState<HaccpStudyValue>(EMPTY_STUDY);
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
    setEditStudy(studyFromPlan(plan));
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
      toast.error('Kode dan nama wajib diisi');
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
    if (!editNama.trim()) {
      toast.error('Nama plan wajib diisi');
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
          processSteps: editStudy.processSteps,
          hazards: editStudy.hazards,
          ccps: editStudy.ccps,
          criticalLimits: editStudy.criticalLimits,
          monitoringPlans: editStudy.monitoringPlans,
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
    setEditStudy({
      processSteps: ex.processSteps,
      hazards: ex.hazards,
      ccps: ex.ccps,
      criticalLimits: ex.criticalLimits,
      monitoringPlans: ex.monitoringPlans,
    });
    if (!editNama.trim()) setEditNama(ex.nama);
    if (!editDescription.trim()) setEditDescription(ex.description || '');
    toast.message('Contoh diisi ke formulir — tetap divalidasi ahli sebelum dipakai');
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
      if (!res.ok) throw new Error(data.error || 'Gagal membuat contoh');
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
      toast.message('Tidak ada langkah status berikutnya dari sini');
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
            Studi HACCP
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Susun langkah proses, bahaya, CCP, batas kritis, dan rencana pemantauan dalam bahasa biasa.
            Contoh wajib divalidasi ahli sebelum dipakai operasional.
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
            Buat contoh
          </Button>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-lg border p-4 space-y-3 max-w-xl">
          <h2 className="text-sm font-semibold">Plan baru (Draft)</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">Kode plan</span>
              <input
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={createKode}
                onChange={(e) => setCreateKode(e.target.value)}
                placeholder="Contoh: HPL-COOK-01"
              />
            </label>
            <label className="text-xs space-y-1">
              <span className="text-muted-foreground">Nama plan</span>
              <input
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                value={createNama}
                onChange={(e) => setCreateNama(e.target.value)}
                placeholder="Contoh: HACCP Plan Memasak"
              />
            </label>
          </div>
          <Button size="sm" disabled={createBusy} onClick={() => void createPlan()}>
            Simpan draft
          </Button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(280px,360px)_1fr]">
        <div className="overflow-hidden rounded-lg border self-start">
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
                  <td className="p-2 text-xs">{row.kode}</td>
                  <td className="p-2">
                    <div className="font-medium">{row.nama}</div>
                    <div className="text-xs text-muted-foreground">
                      Versi {row.version}
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
                    Belum ada plan — buat baru atau buat contoh
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border p-4 space-y-4 min-w-0">
          {!detail ? (
            <p className="text-sm text-muted-foreground">Pilih plan di kiri untuk melihat atau mengedit.</p>
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
                    Lanjut: {HACCP_PLAN_STATUS_LABELS[NEXT_STATUS[detail.status]!]}
                  </Button>
                )}
              </div>

              {editable && (
                <div className="space-y-4 rounded-md border border-dashed p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold">Edit studi</h3>
                      <p className="text-xs text-muted-foreground">
                        Isi formulir di bawah. Tidak perlu menulis kode atau JSON.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={fillExampleStructure}>
                        Isi contoh siap pakai
                      </Button>
                      <Button size="sm" disabled={saveBusy} onClick={() => void saveEdit()}>
                        <Save className="mr-1 h-3.5 w-3.5" />
                        Simpan
                      </Button>
                    </div>
                  </div>

                  <label className="block text-xs space-y-1">
                    <span className="text-muted-foreground">Nama plan</span>
                    <input
                      className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                      value={editNama}
                      onChange={(e) => setEditNama(e.target.value)}
                    />
                  </label>
                  <label className="block text-xs space-y-1">
                    <span className="text-muted-foreground">Ringkasan / tujuan plan</span>
                    <textarea
                      className="w-full rounded border bg-background px-2 py-1.5 text-sm min-h-[60px]"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder="Untuk dapur apa, menu apa, atau proses apa"
                    />
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="text-xs space-y-1">
                      <span className="text-muted-foreground">Resep terkait (opsional)</span>
                      <input
                        className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                        value={editRecipeIds}
                        onChange={(e) => setEditRecipeIds(e.target.value)}
                        placeholder="Pisahkan dengan koma jika lebih dari satu"
                      />
                    </label>
                    <label className="text-xs space-y-1">
                      <span className="text-muted-foreground">Menu terkait (opsional)</span>
                      <input
                        className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                        value={editMenuIds}
                        onChange={(e) => setEditMenuIds(e.target.value)}
                        placeholder="Pisahkan dengan koma jika lebih dari satu"
                      />
                    </label>
                  </div>

                  <HaccpStudyForm value={editStudy} onChange={setEditStudy} />
                </div>
              )}

              {!editable && (
                <>
                  {detail.description && (
                    <p className="text-sm text-muted-foreground">{detail.description}</p>
                  )}
                  {(detail.recipeIds?.length || detail.menuIds?.length) ? (
                    <p className="text-xs text-muted-foreground">
                      Resep terkait: {(detail.recipeIds || []).join(', ') || '—'}
                      {' · '}
                      Menu terkait: {(detail.menuIds || []).join(', ') || '—'}
                    </p>
                  ) : null}

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Langkah proses ({detail.processSteps?.length || 0})
                    </h3>
                    <ul className="mt-1 space-y-1 text-sm">
                      {(detail.processSteps || []).map((s) => (
                        <li key={s.key}>
                          <span className="text-xs text-muted-foreground">{s.sequence}.</span>{' '}
                          {s.nama}
                          {s.description ? (
                            <span className="text-muted-foreground"> — {s.description}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Analisis bahaya ({detail.hazards?.length || 0})
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
                            {HACCP_HAZARD_TYPE_LABELS[h.hazardType]} · langkah {stepLabel(detail, h.processStepKey)}
                          </div>
                          {h.ccpJustification && (
                            <p className="mt-1 text-xs">Alasan CCP: {h.ccpJustification}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Titik kendali kritis ({detail.ccps?.length || 0})
                    </h3>
                    <ul className="mt-1 space-y-1 text-sm">
                      {(detail.ccps || []).map((c) => (
                        <li key={c.key}>
                          <span className="font-medium">{c.nama}</span>
                          {c.category ? (
                            <span className="text-xs text-muted-foreground">
                              {' '}· {HACCP_CATEGORY_LABELS[c.category] || c.category}
                            </span>
                          ) : null}
                          <div className="text-xs text-muted-foreground">
                            Langkah {stepLabel(detail, c.processStepKey)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Batas kritis ({detail.criticalLimits?.length || 0})
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
                      Rencana pemantauan ({detail.monitoringPlans?.length || 0})
                    </h3>
                    <ul className="mt-1 space-y-1 text-sm">
                      {(detail.monitoringPlans || []).map((m) => (
                        <li key={m.key}>
                          <span className="font-medium">{m.method}</span>
                          <span className="text-xs text-muted-foreground">
                            {' '}· {m.frequency}
                            {m.responsibleRole ? ` · ${m.responsibleRole}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
