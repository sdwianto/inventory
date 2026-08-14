'use client';

import type { ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HACCP_CATEGORY_LABELS, type HaccpCategory } from '@/lib/food-production/haccp';
import {
  HACCP_HAZARD_TYPE_LABELS,
  type CriticalLimitOperator,
  type HaccpCcp,
  type HaccpCriticalLimit,
  type HaccpHazard,
  type HaccpHazardType,
  type HaccpMonitoringPlan,
  type HaccpProcessStep,
} from '@/lib/food-production/haccp-plan';

export type HaccpStudyValue = {
  processSteps: HaccpProcessStep[];
  hazards: HaccpHazard[];
  ccps: HaccpCcp[];
  criticalLimits: HaccpCriticalLimit[];
  monitoringPlans: HaccpMonitoringPlan[];
};

const OPERATOR_OPTIONS: { value: CriticalLimitOperator; label: string }[] = [
  { value: 'GTE', label: 'Minimal (≥)' },
  { value: 'GT', label: 'Lebih dari (>)' },
  { value: 'LTE', label: 'Maksimal (≤)' },
  { value: 'LT', label: 'Kurang dari (<)' },
  { value: 'EQ', label: 'Tepat sama dengan (=)' },
  { value: 'BETWEEN', label: 'Di antara dua nilai' },
  { value: 'TEXT', label: 'Catatan teks (bukan angka)' },
];

const CATEGORY_OPTIONS = (Object.keys(HACCP_CATEGORY_LABELS) as HaccpCategory[]).map((k) => ({
  value: k,
  label: HACCP_CATEGORY_LABELS[k],
}));

const HAZARD_TYPE_OPTIONS = (Object.keys(HACCP_HAZARD_TYPE_LABELS) as HaccpHazardType[]).map((k) => ({
  value: k,
  label: HACCP_HAZARD_TYPE_LABELS[k],
}));

function slugKey(raw: string, fallback: string): string {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return s || fallback;
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  let n = 2;
  while (used.has(key)) {
    key = `${base}_${n}`;
    n += 1;
  }
  used.add(key);
  return key;
}

function fieldClass() {
  return 'w-full rounded border bg-background px-2 py-1.5 text-sm';
}

function Section({
  step,
  title,
  hint,
  children,
}: {
  step: number;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div>
        <h4 className="text-sm font-semibold">
          <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-[11px] text-background">
            {step}
          </span>
          {title}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground italic">{children}</p>;
}

export function studyChecklist(value: HaccpStudyValue): Array<{ id: string; label: string; ok: boolean }> {
  return [
    { id: 'steps', label: 'Langkah proses', ok: value.processSteps.length > 0 },
    { id: 'hazards', label: 'Analisis bahaya', ok: value.hazards.length > 0 },
    { id: 'ccp', label: 'CCP', ok: value.ccps.length > 0 },
    { id: 'limit', label: 'Batas aman', ok: value.criticalLimits.length > 0 },
    { id: 'monitor', label: 'Cara pantau', ok: value.monitoringPlans.length > 0 },
    {
      id: 'ca',
      label: 'Tindakan bila gagal',
      ok: value.ccps.some((c) => Boolean(c.correctiveAction?.trim())),
    },
  ];
}

export default function HaccpStudyForm({
  value,
  onChange,
  disabled = false,
  hideProcessSteps = false,
}: {
  value: HaccpStudyValue;
  onChange: (next: HaccpStudyValue) => void;
  disabled?: boolean;
  /** Wizard D: urutan kerja sudah di langkah C. */
  hideProcessSteps?: boolean;
}) {
  const patch = (partial: Partial<HaccpStudyValue>) => onChange({ ...value, ...partial });

  const addStep = () => {
    const used = new Set(value.processSteps.map((s) => s.key));
    const seq = value.processSteps.length + 1;
    const key = uniqueKey(slugKey(`langkah_${seq}`, `step_${seq}`), used);
    patch({
      processSteps: [
        ...value.processSteps,
        { key, nama: '', sequence: seq, description: '' },
      ],
    });
  };

  const updateStep = (index: number, next: Partial<HaccpProcessStep>) => {
    const processSteps = value.processSteps.map((s, i) => (i === index ? { ...s, ...next } : s));
    patch({ processSteps });
  };

  const removeStep = (index: number) => {
    const removed = value.processSteps[index];
    if (!removed) return;
    const processSteps = value.processSteps
      .filter((_, i) => i !== index)
      .map((s, i) => ({ ...s, sequence: i + 1 }));
    patch({
      processSteps,
      hazards: value.hazards.filter((h) => h.processStepKey !== removed.key),
      ccps: value.ccps.filter((c) => c.processStepKey !== removed.key),
      criticalLimits: value.criticalLimits.map((cl) => (
        cl.processStepKey === removed.key ? { ...cl, processStepKey: undefined } : cl
      )),
    });
  };

  const addHazard = () => {
    const used = new Set(value.hazards.map((h) => h.key));
    const stepKey = value.processSteps[0]?.key || '';
    const key = uniqueKey(`hz_${value.hazards.length + 1}`, used);
    patch({
      hazards: [
        ...value.hazards,
        {
          key,
          processStepKey: stepKey,
          hazardType: 'BIOLOGICAL',
          description: '',
          isCcp: false,
          ccpJustification: '',
          controlMeasure: '',
        },
      ],
    });
  };

  const updateHazard = (index: number, next: Partial<HaccpHazard>) => {
    const hazards = value.hazards.map((h, i) => (i === index ? { ...h, ...next } : h));
    patch({ hazards });
  };

  const removeHazard = (index: number) => {
    const removed = value.hazards[index];
    if (!removed) return;
    patch({
      hazards: value.hazards.filter((_, i) => i !== index),
      ccps: value.ccps.map((c) => ({
        ...c,
        hazardKeys: (c.hazardKeys || []).filter((k) => k !== removed.key),
      })),
    });
  };

  const addCcp = () => {
    const used = new Set(value.ccps.map((c) => c.key));
    const stepKey = value.processSteps[0]?.key || '';
    const key = uniqueKey(`ccp_${value.ccps.length + 1}`, used);
    patch({
      ccps: [
        ...value.ccps,
        {
          key,
          processStepKey: stepKey,
          hazardKeys: [],
          nama: '',
          category: 'CCP_COOK',
          monitoringMethod: '',
          correctiveAction: '',
        },
      ],
    });
  };

  const updateCcp = (index: number, next: Partial<HaccpCcp>) => {
    const ccps = value.ccps.map((c, i) => (i === index ? { ...c, ...next } : c));
    patch({ ccps });
  };

  const removeCcp = (index: number) => {
    const removed = value.ccps[index];
    if (!removed) return;
    patch({
      ccps: value.ccps.filter((_, i) => i !== index),
      criticalLimits: value.criticalLimits.map((cl) => (
        cl.ccpKey === removed.key ? { ...cl, ccpKey: undefined } : cl
      )),
      monitoringPlans: value.monitoringPlans.filter((m) => m.ccpKey !== removed.key),
    });
  };

  const addLimit = () => {
    const used = new Set(value.criticalLimits.map((c) => c.key));
    const key = uniqueKey(`cl_${value.criticalLimits.length + 1}`, used);
    patch({
      criticalLimits: [
        ...value.criticalLimits,
        {
          key,
          ccpKey: value.ccps[0]?.key,
          parameter: 'suhu',
          label: '',
          operator: 'GTE',
          value: undefined,
          valueMax: undefined,
          unit: 'C',
          note: '',
        },
      ],
    });
  };

  const updateLimit = (index: number, next: Partial<HaccpCriticalLimit>) => {
    const criticalLimits = value.criticalLimits.map((c, i) => (i === index ? { ...c, ...next } : c));
    patch({ criticalLimits });
  };

  const removeLimit = (index: number) => {
    const removed = value.criticalLimits[index];
    if (!removed) return;
    patch({
      criticalLimits: value.criticalLimits.filter((_, i) => i !== index),
      monitoringPlans: value.monitoringPlans.map((m) => ({
        ...m,
        criticalLimitKeys: (m.criticalLimitKeys || []).filter((k) => k !== removed.key),
      })),
    });
  };

  const addMonitoring = () => {
    const used = new Set(value.monitoringPlans.map((m) => m.key));
    const key = uniqueKey(`mon_${value.monitoringPlans.length + 1}`, used);
    patch({
      monitoringPlans: [
        ...value.monitoringPlans,
        {
          key,
          ccpKey: value.ccps[0]?.key || '',
          method: '',
          frequency: '',
          responsibleRole: '',
          criticalLimitKeys: [],
          templateKodeHint: '',
        },
      ],
    });
  };

  const updateMonitoring = (index: number, next: Partial<HaccpMonitoringPlan>) => {
    const monitoringPlans = value.monitoringPlans.map((m, i) => (i === index ? { ...m, ...next } : m));
    patch({ monitoringPlans });
  };

  const removeMonitoring = (index: number) => {
    patch({ monitoringPlans: value.monitoringPlans.filter((_, i) => i !== index) });
  };

  const toggleInList = (list: string[], key: string, on: boolean) => (
    on ? [...new Set([...list, key])] : list.filter((k) => k !== key)
  );

  const off = hideProcessSteps ? 0 : 1;

  return (
    <div className="space-y-4">
      {hideProcessSteps && (
        <p className="text-xs text-muted-foreground">
          {value.processSteps.length
            ? `Alur dari langkah C: ${value.processSteps.map((s) => s.nama || s.key).join(' → ')}`
            : 'Isi urutan kerja di langkah C dulu sebelum menambah bahaya.'}
        </p>
      )}
      {!hideProcessSteps && (
      <Section
        step={1}
        title="Langkah proses"
        hint="Urutan kerja di dapur, dari bahan masuk sampai disajikan."
      >
        {value.processSteps.length === 0 && (
          <EmptyHint>Belum ada langkah. Tambahkan misalnya: Penerimaan, Persiapan, Memasak.</EmptyHint>
        )}
        <div className="space-y-2">
          {value.processSteps.map((step, index) => (
            <div key={step.key} className="rounded border bg-background p-2 space-y-2">
              <div className="flex items-start gap-2">
                <span className="mt-1.5 w-6 shrink-0 text-center text-xs font-semibold text-muted-foreground">
                  {index + 1}
                </span>
                <div className="grid flex-1 gap-2 sm:grid-cols-2">
                  <label className="text-xs space-y-1 sm:col-span-2">
                    <span className="text-muted-foreground">Nama langkah</span>
                    <input
                      className={fieldClass()}
                      disabled={disabled}
                      value={step.nama}
                      onChange={(e) => updateStep(index, { nama: e.target.value })}
                      placeholder="Contoh: Memasak"
                    />
                  </label>
                  <label className="text-xs space-y-1 sm:col-span-2">
                    <span className="text-muted-foreground">Keterangan (opsional)</span>
                    <input
                      className={fieldClass()}
                      disabled={disabled}
                      value={step.description || ''}
                      onChange={(e) => updateStep(index, { description: e.target.value })}
                      placeholder="Ringkas apa yang dilakukan di langkah ini"
                    />
                  </label>
                </div>
                {!disabled && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => removeStep(index)} title="Hapus">
                    <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        {!disabled && (
          <Button type="button" size="sm" variant="outline" onClick={addStep}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Tambah langkah
          </Button>
        )}
      </Section>
      )}

      <Section
        step={1 + off}
        title="Analisis bahaya"
        hint="Bahaya apa yang bisa muncul di tiap langkah, dan apakah perlu dikendalikan sebagai CCP."
      >
        {value.processSteps.length === 0 && (
          <EmptyHint>Isi langkah proses dulu sebelum menambah bahaya.</EmptyHint>
        )}
        {value.hazards.length === 0 && value.processSteps.length > 0 && (
          <EmptyHint>Belum ada bahaya. Contoh: kuman tidak mati jika suhu masak kurang.</EmptyHint>
        )}
        <div className="space-y-2">
          {value.hazards.map((hz, index) => (
            <div key={hz.key} className="rounded border bg-background p-2 space-y-2">
              <div className="flex justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">Bahaya #{index + 1}</p>
                {!disabled && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => removeHazard(index)}>
                    <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                  </Button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs space-y-1">
                  <span className="text-muted-foreground">Di langkah</span>
                  <select
                    className={fieldClass()}
                    disabled={disabled}
                    value={hz.processStepKey}
                    onChange={(e) => updateHazard(index, { processStepKey: e.target.value })}
                  >
                    <option value="">— Pilih langkah —</option>
                    {value.processSteps.map((s) => (
                      <option key={s.key} value={s.key}>{s.nama || s.key}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-muted-foreground">Jenis bahaya</span>
                  <select
                    className={fieldClass()}
                    disabled={disabled}
                    value={hz.hazardType}
                    onChange={(e) => updateHazard(index, { hazardType: e.target.value as HaccpHazardType })}
                  >
                    {HAZARD_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs space-y-1 sm:col-span-2">
                  <span className="text-muted-foreground">Uraian bahaya</span>
                  <textarea
                    className={`${fieldClass()} min-h-[56px]`}
                    disabled={disabled}
                    value={hz.description}
                    onChange={(e) => updateHazard(index, { description: e.target.value })}
                    placeholder="Contoh: Bakteri patogen tidak mati jika suhu inti kurang"
                  />
                </label>
                <label className="text-xs space-y-1 sm:col-span-2">
                  <span className="text-muted-foreground">Cara mengendalikan (opsional)</span>
                  <input
                    className={fieldClass()}
                    disabled={disabled}
                    value={hz.controlMeasure || ''}
                    onChange={(e) => updateHazard(index, { controlMeasure: e.target.value })}
                    placeholder="Contoh: Masak sampai suhu inti tercapai"
                  />
                </label>
                <label className="flex items-center gap-2 text-xs sm:col-span-2">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={hz.isCcp}
                    onChange={(e) => updateHazard(index, { isCcp: e.target.checked })}
                  />
                  <span>Bahaya ini adalah CCP (titik kendali kritis)</span>
                </label>
                {hz.isCcp && (
                  <label className="text-xs space-y-1 sm:col-span-2">
                    <span className="text-muted-foreground">Alasan dijadikan CCP (wajib)</span>
                    <textarea
                      className={`${fieldClass()} min-h-[56px]`}
                      disabled={disabled}
                      value={hz.ccpJustification || ''}
                      onChange={(e) => updateHazard(index, { ccpJustification: e.target.value })}
                      placeholder="Mengapa bahaya ini harus dikendalikan di titik ini?"
                    />
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
        {!disabled && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addHazard}
            disabled={value.processSteps.length === 0}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Tambah bahaya
          </Button>
        )}
      </Section>

      <Section
        step={2 + off}
        title="Titik kendali kritis (CCP)"
        hint="Titik di proses yang harus dikontrol ketat agar makanan aman."
      >
        {value.ccps.length === 0 && (
          <EmptyHint>Belum ada CCP. Contoh: pengukuran suhu inti saat memasak.</EmptyHint>
        )}
        <div className="space-y-2">
          {value.ccps.map((ccp, index) => (
            <div key={ccp.key} className="rounded border bg-background p-2 space-y-2">
              <div className="flex justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">CCP #{index + 1}</p>
                {!disabled && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => removeCcp(index)}>
                    <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                  </Button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs space-y-1 sm:col-span-2">
                  <span className="text-muted-foreground">Nama CCP</span>
                  <input
                    className={fieldClass()}
                    disabled={disabled}
                    value={ccp.nama}
                    onChange={(e) => updateCcp(index, { nama: e.target.value })}
                    placeholder="Contoh: Suhu inti masak"
                  />
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-muted-foreground">Di langkah</span>
                  <select
                    className={fieldClass()}
                    disabled={disabled}
                    value={ccp.processStepKey}
                    onChange={(e) => updateCcp(index, { processStepKey: e.target.value })}
                  >
                    <option value="">— Pilih langkah —</option>
                    {value.processSteps.map((s) => (
                      <option key={s.key} value={s.key}>{s.nama || s.key}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-muted-foreground">Jenis CCP</span>
                  <select
                    className={fieldClass()}
                    disabled={disabled}
                    value={ccp.category || 'OTHER'}
                    onChange={(e) => updateCcp(index, { category: e.target.value as HaccpCategory })}
                  >
                    {CATEGORY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <fieldset className="sm:col-span-2 space-y-1">
                  <legend className="text-xs text-muted-foreground">Bahaya yang dikendalikan</legend>
                  {value.hazards.length === 0 ? (
                    <EmptyHint>Belum ada bahaya untuk dipilih.</EmptyHint>
                  ) : (
                    <div className="space-y-1 rounded border px-2 py-1.5">
                      {value.hazards.map((h) => (
                        <label key={h.key} className="flex items-start gap-2 text-xs">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            disabled={disabled}
                            checked={(ccp.hazardKeys || []).includes(h.key)}
                            onChange={(e) => updateCcp(index, {
                              hazardKeys: toggleInList(ccp.hazardKeys || [], h.key, e.target.checked),
                            })}
                          />
                          <span>{h.description || h.key}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
                <label className="text-xs space-y-1 sm:col-span-2">
                  <span className="text-muted-foreground">Cara memantau</span>
                  <input
                    className={fieldClass()}
                    disabled={disabled}
                    value={ccp.monitoringMethod || ''}
                    onChange={(e) => updateCcp(index, { monitoringMethod: e.target.value })}
                    placeholder="Contoh: Ukur suhu inti dengan termometer"
                  />
                </label>
                <label className="text-xs space-y-1 sm:col-span-2">
                  <span className="text-muted-foreground">Tindakan jika gagal (wajib)</span>
                  <input
                    className={fieldClass()}
                    disabled={disabled}
                    value={ccp.correctiveAction || ''}
                    onChange={(e) => updateCcp(index, { correctiveAction: e.target.value })}
                    placeholder="Contoh: Lanjut masak / tahan batch / buang sesuai SOP"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
        {!disabled && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addCcp}
            disabled={value.processSteps.length === 0}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Tambah CCP
          </Button>
        )}
      </Section>

      <Section
        step={3 + off}
        title="Batas kritis"
        hint="Angka atau syarat yang harus dipenuhi agar CCP dinyatakan aman."
      >
        {value.ccps.length === 0 && (
          <EmptyHint>Tambah CCP dulu sebelum mengisi batas kritis.</EmptyHint>
        )}
        <div className="space-y-2">
          {value.criticalLimits.map((cl, index) => (
            <div key={cl.key} className="rounded border bg-background p-2 space-y-2">
              <div className="flex justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">Batas #{index + 1}</p>
                {!disabled && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => removeLimit(index)}>
                    <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                  </Button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs space-y-1 sm:col-span-2">
                  <span className="text-muted-foreground">Untuk CCP</span>
                  <select
                    className={fieldClass()}
                    disabled={disabled}
                    value={cl.ccpKey || ''}
                    onChange={(e) => updateLimit(index, { ccpKey: e.target.value || undefined })}
                  >
                    <option value="">— Pilih CCP —</option>
                    {value.ccps.map((c) => (
                      <option key={c.key} value={c.key}>{c.nama || c.key}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-muted-foreground">Nama batas</span>
                  <input
                    className={fieldClass()}
                    disabled={disabled}
                    value={cl.label}
                    onChange={(e) => updateLimit(index, {
                      label: e.target.value,
                      parameter: cl.parameter || slugKey(e.target.value, 'parameter'),
                    })}
                    placeholder="Contoh: Suhu inti"
                  />
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-muted-foreground">Aturan</span>
                  <select
                    className={fieldClass()}
                    disabled={disabled}
                    value={cl.operator}
                    onChange={(e) => updateLimit(index, { operator: e.target.value as CriticalLimitOperator })}
                  >
                    {OPERATOR_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                {cl.operator !== 'TEXT' && (
                  <label className="text-xs space-y-1">
                    <span className="text-muted-foreground">
                      {cl.operator === 'BETWEEN' ? 'Nilai dari' : 'Nilai'}
                    </span>
                    <input
                      type="number"
                      className={fieldClass()}
                      disabled={disabled}
                      value={cl.value ?? ''}
                      onChange={(e) => updateLimit(index, {
                        value: e.target.value === '' ? undefined : Number(e.target.value),
                      })}
                      placeholder="74"
                    />
                  </label>
                )}
                {cl.operator === 'BETWEEN' && (
                  <label className="text-xs space-y-1">
                    <span className="text-muted-foreground">Nilai sampai</span>
                    <input
                      type="number"
                      className={fieldClass()}
                      disabled={disabled}
                      value={cl.valueMax ?? ''}
                      onChange={(e) => updateLimit(index, {
                        valueMax: e.target.value === '' ? undefined : Number(e.target.value),
                      })}
                    />
                  </label>
                )}
                {cl.operator !== 'TEXT' && (
                  <label className="text-xs space-y-1">
                    <span className="text-muted-foreground">Satuan</span>
                    <input
                      className={fieldClass()}
                      disabled={disabled}
                      value={cl.unit || ''}
                      onChange={(e) => updateLimit(index, { unit: e.target.value })}
                      placeholder="C / menit / jam"
                    />
                  </label>
                )}
                <label className="text-xs space-y-1 sm:col-span-2">
                  <span className="text-muted-foreground">Catatan (opsional)</span>
                  <input
                    className={fieldClass()}
                    disabled={disabled}
                    value={cl.note || ''}
                    onChange={(e) => updateLimit(index, { note: e.target.value })}
                    placeholder="Contoh: ≥ 74°C di bagian terdalam"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
        {!disabled && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addLimit}
            disabled={value.ccps.length === 0}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Tambah batas kritis
          </Button>
        )}
      </Section>

      <Section
        step={4 + off}
        title="Rencana pemantauan"
        hint="Siapa memantau, bagaimana, dan seberapa sering — agar batas kritis benar-benar dicek."
      >
        {value.monitoringPlans.length === 0 && (
          <EmptyHint>Belum ada rencana pemantauan. Contoh: ukur suhu setiap batch.</EmptyHint>
        )}
        <div className="space-y-2">
          {value.monitoringPlans.map((mon, index) => (
            <div key={mon.key} className="rounded border bg-background p-2 space-y-2">
              <div className="flex justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">Pemantauan #{index + 1}</p>
                {!disabled && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => removeMonitoring(index)}>
                    <Trash2 className="h-3.5 w-3.5 text-rose-600" />
                  </Button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs space-y-1 sm:col-span-2">
                  <span className="text-muted-foreground">Untuk CCP</span>
                  <select
                    className={fieldClass()}
                    disabled={disabled}
                    value={mon.ccpKey}
                    onChange={(e) => updateMonitoring(index, { ccpKey: e.target.value })}
                  >
                    <option value="">— Pilih CCP —</option>
                    {value.ccps.map((c) => (
                      <option key={c.key} value={c.key}>{c.nama || c.key}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs space-y-1 sm:col-span-2">
                  <span className="text-muted-foreground">Cara memantau</span>
                  <input
                    className={fieldClass()}
                    disabled={disabled}
                    value={mon.method}
                    onChange={(e) => updateMonitoring(index, { method: e.target.value })}
                    placeholder="Contoh: Pengukuran suhu inti per batch"
                  />
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-muted-foreground">Seberapa sering</span>
                  <input
                    className={fieldClass()}
                    disabled={disabled}
                    value={mon.frequency}
                    onChange={(e) => updateMonitoring(index, { frequency: e.target.value })}
                    placeholder="Contoh: Setiap batch"
                  />
                </label>
                <label className="text-xs space-y-1">
                  <span className="text-muted-foreground">Penanggung jawab</span>
                  <input
                    className={fieldClass()}
                    disabled={disabled}
                    value={mon.responsibleRole || ''}
                    onChange={(e) => updateMonitoring(index, { responsibleRole: e.target.value })}
                    placeholder="Contoh: Juru masak / QC dapur"
                  />
                </label>
                <fieldset className="sm:col-span-2 space-y-1">
                  <legend className="text-xs text-muted-foreground">Batas kritis yang dipantau</legend>
                  {value.criticalLimits.length === 0 ? (
                    <EmptyHint>Belum ada batas kritis.</EmptyHint>
                  ) : (
                    <div className="space-y-1 rounded border px-2 py-1.5">
                      {value.criticalLimits.map((cl) => (
                        <label key={cl.key} className="flex items-start gap-2 text-xs">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            disabled={disabled}
                            checked={(mon.criticalLimitKeys || []).includes(cl.key)}
                            onChange={(e) => updateMonitoring(index, {
                              criticalLimitKeys: toggleInList(
                                mon.criticalLimitKeys || [],
                                cl.key,
                                e.target.checked,
                              ),
                            })}
                          />
                          <span>{cl.label || cl.key}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
                <label className="text-xs space-y-1 sm:col-span-2">
                  <span className="text-muted-foreground">Kode formulir checklist (opsional)</span>
                  <input
                    className={fieldClass()}
                    disabled={disabled}
                    value={mon.templateKodeHint || ''}
                    onChange={(e) => updateMonitoring(index, { templateKodeHint: e.target.value })}
                    placeholder="Contoh: HCP-COOK"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
        {!disabled && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addMonitoring}
            disabled={value.ccps.length === 0}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Tambah rencana pemantauan
          </Button>
        )}
      </Section>
    </div>
  );
}
