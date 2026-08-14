'use client';

import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import HaccpStudyForm, { studyChecklist, type HaccpStudyValue } from '@/components/food-production/HaccpStudyForm';
import HaccpWizardStepper, {
  HACCP_WIZARD_STEPS,
  type HaccpWizardStepId,
} from '@/components/food-safety/HaccpWizardStepper';
import {
  emptyPreamble,
  preambleChecklist,
  HaccpWizardStepA,
  HaccpWizardStepB,
  HaccpWizardStepC,
  type HaccpPreambleValue,
} from '@/components/food-safety/HaccpPreamblePanels';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';
import { ClipboardList, Plus, RefreshCw, Save, Sprout } from 'lucide-react';
import { HACCP_CATEGORY_LABELS } from '@/lib/food-production/haccp';
import {
  CRITICAL_LIMIT_OPERATOR_LABELS,
  EXAMPLE_HACCP_PLAN_COOK,
  HACCP_HAZARD_TYPE_LABELS,
  HACCP_PLAN_STATUS_LABELS,
  formatCriticalLimit,
  haccpPlanAllowsCloseoutEdit,
  haccpPlanAllowsStudyEdit,
  hasHaccpPlanValidation,
  hasHaccpTrainingEvidence,
  type HaccpPlanDoc,
  type HaccpPlanStatus,
} from '@/lib/food-production/haccp-plan';
import HaccpWizardStepE, { type HaccpCloseoutValue } from '@/components/food-safety/HaccpWizardStepE';

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
  | 'team'
  | 'scope'
  | 'productDescription'
  | 'intendedUse'
  | 'flowDiagramNote'
  | 'flowDiagramUrls'
  | 'flowVerifiedAt'
  | 'flowVerifiedByName'
  | 'flowVerifiedNote'
  | 'validationNote'
  | 'validationEvidenceUrls'
  | 'validatedAt'
  | 'validatedByName'
  | 'trainingNote'
  | 'trainingEvidenceUrls'
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

function closeoutFromPlan(plan: PlanRow): HaccpCloseoutValue {
  return {
    validationNote: plan.validationNote || '',
    validationEvidenceUrls: plan.validationEvidenceUrls || [],
    validatedAtLabel: plan.validatedAt
      ? new Date(plan.validatedAt as unknown as string).toLocaleString('id-ID')
      : null,
    validatedByName: plan.validatedByName || '',
    trainingNote: plan.trainingNote || '',
    trainingEvidenceUrls: plan.trainingEvidenceUrls || [],
  };
}

function emptyCloseout(): HaccpCloseoutValue {
  return {
    validationNote: '',
    validationEvidenceUrls: [],
    validatedAtLabel: null,
    validatedByName: '',
    trainingNote: '',
    trainingEvidenceUrls: [],
  };
}

function csvToIds(raw: string): string[] {
  return [...new Set(raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
}

function idsToCsv(ids?: string[] | null): string {
  return (ids || []).map((s) => String(s || '').trim()).filter(Boolean).join(', ');
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

function estimateStudyProgress(
  study: HaccpStudyValue,
  preamble: HaccpPreambleValue,
  meta: { nama?: string },
  closeout?: HaccpCloseoutValue,
): number {
  let score = 0;
  const total = 14;
  if (meta.nama?.trim()) score += 1;
  if (preamble.team.some((m) => m.name.trim() && m.role.trim())) score += 1;
  if (preamble.scope.trim()) score += 1;
  if (preamble.productDescription.trim()) score += 1;
  if (preamble.intendedUse.trim()) score += 1;
  if (study.processSteps.length) score += 1;
  if (preamble.flowVerified) score += 1;
  if (study.hazards.length) score += 1;
  if (study.ccps.length) score += 1;
  if (study.criticalLimits.length) score += 1;
  if (study.monitoringPlans.length) score += 1;
  if (study.ccps.some((c) => c.correctiveAction?.trim())) score += 1;
  if (closeout && (closeout.validationNote.trim() || closeout.validationEvidenceUrls.length)) score += 1;
  if (closeout && (closeout.trainingNote.trim() || closeout.trainingEvidenceUrls.length)) score += 1;
  return Math.round((score / total) * 100);
}

function preambleFromPlan(plan: PlanRow): HaccpPreambleValue {
  const team = (plan.team || []).map((m) => ({
    name: m.name || '',
    role: m.role || '',
    unit: m.unit || '',
  }));
  return {
    team: team.length ? team : [{ name: '', role: '', unit: '' }],
    scope: plan.scope || '',
    productDescription: plan.productDescription || '',
    intendedUse: plan.intendedUse || '',
    recipeIdsCsv: idsToCsv(plan.recipeIds),
    menuIdsCsv: idsToCsv(plan.menuIds),
    flowDiagramNote: plan.flowDiagramNote || '',
    flowDiagramUrls: plan.flowDiagramUrls || [],
    flowVerified: Boolean(plan.flowVerifiedAt),
    flowVerifiedByName: plan.flowVerifiedByName || '',
    flowVerifiedNote: plan.flowVerifiedNote || '',
  };
}

function stepLabel(plan: PlanRow, key: string): string {
  return plan.processSteps?.find((s) => s.key === key)?.nama || key;
}

export default function HaccpPlanPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Memuat rencana HACCP…</div>}>
      <HaccpPlanPageInner />
    </Suspense>
  );
}

function HaccpPlanPageInner() {
  const searchParams = useSearchParams();
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
  const [editStudy, setEditStudy] = useState<HaccpStudyValue>(EMPTY_STUDY);
  const [editPreamble, setEditPreamble] = useState<HaccpPreambleValue>(emptyPreamble());
  const [editCloseout, setEditCloseout] = useState<HaccpCloseoutValue>(emptyCloseout());
  const [saveBusy, setSaveBusy] = useState(false);
  const [validationBusy, setValidationBusy] = useState(false);
  const [wizardStep, setWizardStep] = useState<HaccpWizardStepId>('A');
  const wizardMode = searchParams.get('wizard') === '1'
    || Boolean(searchParams.get('planId'));

  const editable = Boolean(detail && haccpPlanAllowsStudyEdit(detail.status));
  const closeoutEditable = Boolean(detail && haccpPlanAllowsCloseoutEdit(detail.status));

  const progressPct = useMemo(
    () => estimateStudyProgress(editStudy, editPreamble, { nama: editNama }, editCloseout),
    [editStudy, editPreamble, editNama, editCloseout],
  );

  const checklist = useMemo(
    () => [
      { id: 'nama', label: 'Nama rencana', ok: Boolean(editNama.trim()) },
      ...preambleChecklist(editPreamble, editStudy.processSteps.length),
    ],
    [editNama, editPreamble, editStudy.processSteps.length],
  );

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

  useEffect(() => {
    const planId = searchParams.get('planId');
    if (planId) void openDetail(planId);
    if (searchParams.get('wizard') === '1' && !planId) {
      setShowCreate(true);
      setWizardStep('A');
    }
    // openDetail is stable enough for deep-link boot; avoid re-fetch loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const syncEditForm = (plan: PlanRow) => {
    setEditNama(plan.nama || '');
    setEditDescription(plan.description || '');
    setEditStudy(studyFromPlan(plan));
    setEditPreamble(preambleFromPlan(plan));
    setEditCloseout(closeoutFromPlan(plan));
  };

  const openDetail = async (id: string) => {
    setSelectedId(id);
    try {
      const res = await fetch(`/api/haccp-plans/${id}`, { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat detail');
      setDetail(data);
      syncEditForm(data);
      const pre = preambleFromPlan(data);
      const incomplete = preambleChecklist(pre, (data.processSteps || []).length).some((c) => !c.ok);
      const stepQ = String(searchParams.get('step') || '').toUpperCase();
      if (stepQ === 'E' || stepQ === 'D' || stepQ === 'A' || stepQ === 'B' || stepQ === 'C') {
        setWizardStep(stepQ);
      } else {
        const studyDone = (data.ccps || []).length > 0 && (data.monitoringPlans || []).length > 0;
        const closeoutDone = hasHaccpPlanValidation(data) && hasHaccpTrainingEvidence(data);
        if (incomplete) setWizardStep('A');
        else if (!studyDone) setWizardStep('D');
        else if (!closeoutDone) setWizardStep('E');
        else setWizardStep('D');
      }
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

  const saveEdit = async (opts?: { silent?: boolean }): Promise<boolean> => {
    if (!detail || !closeoutEditable) return false;
    if (editable && !editNama.trim()) {
      toast.error('Nama plan wajib diisi');
      return false;
    }
    setSaveBusy(true);
    try {
      const closeoutBody = {
        validationNote: editCloseout.validationNote,
        validationEvidenceUrls: editCloseout.validationEvidenceUrls,
        trainingNote: editCloseout.trainingNote,
        trainingEvidenceUrls: editCloseout.trainingEvidenceUrls,
        markValidated: Boolean(editCloseout.validationNote.trim() || editCloseout.validationEvidenceUrls.length),
        validatedByName: editCloseout.validatedByName || getUser()?.name || undefined,
      };
      const res = await fetch(`/api/haccp-plans/${detail.id}`, {
        method: 'PUT',
        headers: { ...actingTenantHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(editable ? {
          nama: editNama.trim(),
          description: editDescription,
          recipeIds: csvToIds(editPreamble.recipeIdsCsv),
          menuIds: csvToIds(editPreamble.menuIdsCsv),
          team: editPreamble.team.filter((m) => m.name.trim() || m.role.trim()),
          scope: editPreamble.scope,
          productDescription: editPreamble.productDescription,
          intendedUse: editPreamble.intendedUse,
          flowDiagramNote: editPreamble.flowDiagramNote,
          flowDiagramUrls: editPreamble.flowDiagramUrls,
          flowVerified: editPreamble.flowVerified,
          flowVerifiedByName: editPreamble.flowVerifiedByName
            || getUser()?.name
            || undefined,
          flowVerifiedNote: editPreamble.flowVerifiedNote,
          processSteps: editStudy.processSteps,
          hazards: editStudy.hazards,
          ccps: editStudy.ccps,
          criticalLimits: editStudy.criticalLimits,
          monitoringPlans: editStudy.monitoringPlans,
          ...closeoutBody,
        } : closeoutBody),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
      if (!opts?.silent) toast.success(editable ? 'Plan disimpan' : 'Bukti langkah E disimpan');
      setDetail(data);
      syncEditForm(data);
      await load();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
      return false;
    } finally {
      setSaveBusy(false);
    }
  };

  const createValidation = async () => {
    if (!detail || !closeoutEditable) return;
    if (!editCloseout.validationNote.trim() && !editCloseout.validationEvidenceUrls.length) {
      toast.error('Isi catatan atau foto validasi dulu');
      return;
    }
    setValidationBusy(true);
    try {
      const saved = await saveEdit({ silent: true });
      if (!saved) return;
      const evidence = editCloseout.validationEvidenceUrls;
      const res = await fetch('/api/haccp-verifications', {
        method: 'POST',
        headers: { ...actingTenantHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verificationType: 'VALIDATION',
          haccpPlanId: detail.id,
          method: 'Uji coba / tinjau rencana di dapur',
          result: evidence.length ? 'PASS' : 'PARTIAL',
          note: editCloseout.validationNote,
          evidenceUrls: evidence,
          complete: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal mencatat validasi');
      toast.success(`Validasi ${data.noDokumen} dicatat`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setValidationBusy(false);
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
    setEditPreamble(preambleFromPlan({
      ...ex,
      id: detail?.id || '',
      noDokumen: detail?.noDokumen || '',
    } as PlanRow));
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
          <p className="text-xs text-muted-foreground">
            <Link href="/kitchen-assurance" className="text-blue-700 hover:underline">
              Keamanan Pangan
            </Link>
            <span className="mx-1">/</span>
            <Link href="/kitchen-assurance/setup" className="text-blue-700 hover:underline">
              Setup
            </Link>
            <span className="mx-1">/</span>
            Rencana HACCP
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ClipboardList className="h-5 w-5" />
            Rencana HACCP
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ikuti panduan langkah — tidak perlu hafal istilah teknis. Contoh wajib divalidasi ahli sebelum dipakai operasional.
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

      {(wizardMode || detail) && (
        <HaccpWizardStepper
          active={wizardStep}
          onSelect={setWizardStep}
          progressPct={detail ? progressPct : null}
        />
      )}

      {wizardStep === 'A' && !detail && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800">
          Buat draft rencana dulu (form di bawah / tombol Buat plan), lalu isi Tim & ruang lingkup di langkah ini.
        </div>
      )}
      {wizardStep === 'A' && detail && (
        <HaccpWizardStepA
          value={editPreamble}
          onChange={setEditPreamble}
          nama={editNama}
          onNamaChange={setEditNama}
          description={editDescription}
          onDescriptionChange={setEditDescription}
          disabled={!editable}
        />
      )}
      {wizardStep === 'B' && detail && (
        <HaccpWizardStepB
          value={editPreamble}
          onChange={setEditPreamble}
          disabled={!editable}
        />
      )}
      {wizardStep === 'C' && detail && (
        <HaccpWizardStepC
          value={editPreamble}
          onChange={setEditPreamble}
          processSteps={editStudy.processSteps}
          onProcessStepsChange={(steps) => setEditStudy((s) => ({ ...s, processSteps: steps }))}
          flowVerifiedAtLabel={
            detail.flowVerifiedAt
              ? new Date(detail.flowVerifiedAt).toLocaleString('id-ID')
              : null
          }
          disabled={!editable}
        />
      )}
      {wizardStep === 'D' && detail && (
        <HaccpStudyForm
          value={editStudy}
          onChange={setEditStudy}
          disabled={!editable}
          hideProcessSteps
        />
      )}
      {wizardStep === 'D' && !detail && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
          Buat draft rencana dulu, lalu isi bahaya dan CCP di langkah ini.
        </div>
      )}
      {wizardStep === 'E' && detail && !editable && closeoutEditable && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-800">
          Rencana sudah {HACCP_PLAN_STATUS_LABELS[detail.status]}. Studi A–D terkunci; validasi dan bukti
          pelatihan masih bisa dilengkapi di sini.
        </p>
      )}
      {wizardStep === 'E' && detail && (
        <HaccpWizardStepE
          value={editCloseout}
          onChange={setEditCloseout}
          disabled={!closeoutEditable}
          onCreateValidation={closeoutEditable ? () => void createValidation() : undefined}
          creatingValidation={validationBusy}
        />
      )}
      {wizardStep === 'E' && !detail && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          Buat draft rencana dulu (langkah A) sebelum mencatat validasi dan pelatihan.
        </div>
      )}
      {detail && (wizardStep === 'A' || wizardStep === 'B' || wizardStep === 'C') && (
        <ul className="flex flex-wrap gap-2 text-xs">
          {checklist.map((c) => (
            <li
              key={c.id}
              className={`rounded-full border px-2 py-1 ${
                c.ok
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              {c.ok ? '✓' : '○'} {c.label}
            </li>
          ))}
        </ul>
      )}
      {detail && wizardStep === 'D' && (
        <ul className="flex flex-wrap gap-2 text-xs">
          {studyChecklist(editStudy).map((c) => (
            <li
              key={c.id}
              className={`rounded-full border px-2 py-1 ${
                c.ok
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              {c.ok ? '✓' : '○'} {c.label}
            </li>
          ))}
        </ul>
      )}
      {detail && wizardStep === 'E' && (
        <ul className="flex flex-wrap gap-2 text-xs">
          {[
            {
              id: 'validation',
              ok: Boolean(editCloseout.validationNote.trim() || editCloseout.validationEvidenceUrls.length),
              label: 'Validasi dicatat',
            },
            {
              id: 'training',
              ok: Boolean(editCloseout.trainingNote.trim() || editCloseout.trainingEvidenceUrls.length),
              label: 'Bukti pelatihan',
            },
          ].map((c) => (
            <li
              key={c.id}
              className={`rounded-full border px-2 py-1 ${
                c.ok
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              {c.ok ? '✓' : '○'} {c.label}
            </li>
          ))}
        </ul>
      )}

      {(wizardMode || detail) && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const idx = HACCP_WIZARD_STEPS.findIndex((s) => s.id === wizardStep);
              if (idx <= 0) return;
              setWizardStep(HACCP_WIZARD_STEPS[idx - 1]!.id);
            }}
            disabled={wizardStep === 'A'}
          >
            Kembali
          </Button>
          <div className="flex flex-wrap gap-2">
            {detail && editable && (
              <Button type="button" variant="outline" size="sm" onClick={fillExampleStructure}>
                Isi contoh
              </Button>
            )}
            {detail && (editable || (wizardStep === 'E' && closeoutEditable)) && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={saveBusy}
                onClick={() => void saveEdit()}
              >
                <Save className="mr-1 h-4 w-4" />
                {wizardStep === 'E' && !editable ? 'Simpan bukti' : 'Simpan draft'}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const idx = HACCP_WIZARD_STEPS.findIndex((s) => s.id === wizardStep);
                if (idx < 0 || idx >= HACCP_WIZARD_STEPS.length - 1) {
                  toast.message(
                    editable
                      ? 'Ini langkah terakhir panduan. Ajukan review dari tombol status bila siap.'
                      : 'Langkah terakhir. Simpan bukti validasi dan pelatihan.',
                  );
                  return;
                }
                setWizardStep(HACCP_WIZARD_STEPS[idx + 1]!.id);
              }}
              disabled={wizardStep === 'E'}
            >
              Lanjut
            </Button>
          </div>
        </div>
      )}

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

              {!editable && (
                <>
                  {detail.description && (
                    <p className="text-sm text-muted-foreground">{detail.description}</p>
                  )}
                  <section className="space-y-2 rounded-md border bg-muted/20 p-3 text-sm">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Tim & ruang lingkup
                    </h3>
                    <ul className="space-y-1">
                      {(detail.team || []).map((m, i) => (
                        <li key={i}>
                          {m.name} — {m.role}
                          {m.unit ? ` (${m.unit})` : ''}
                        </li>
                      ))}
                      {(detail.team || []).length === 0 && (
                        <li className="text-muted-foreground">Belum ada anggota tim</li>
                      )}
                    </ul>
                    <p className="text-xs text-muted-foreground">
                      Ruang lingkup: {detail.scope || '—'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Produk: {detail.productDescription || '—'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Penggunaan: {detail.intendedUse || '—'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Alur lapangan:{' '}
                      {detail.flowVerifiedAt
                        ? `Dicek ${new Date(detail.flowVerifiedAt).toLocaleString('id-ID')}${
                          detail.flowVerifiedByName ? ` oleh ${detail.flowVerifiedByName}` : ''
                        }`
                        : 'Belum dikonfirmasi'}
                    </p>
                  </section>
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
