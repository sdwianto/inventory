'use client';

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import type { HaccpProcessStep, HaccpTeamMember } from '@/lib/food-production/haccp-plan';

export type HaccpPreambleValue = {
  team: HaccpTeamMember[];
  scope: string;
  productDescription: string;
  intendedUse: string;
  recipeIdsCsv: string;
  menuIdsCsv: string;
  flowDiagramNote: string;
  flowDiagramUrls: string[];
  flowVerified: boolean;
  flowVerifiedByName: string;
  flowVerifiedNote: string;
};

function fieldClass() {
  return 'w-full rounded border bg-background px-2 py-1.5 text-sm';
}

function Helper({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

type StepProps = {
  value: HaccpPreambleValue;
  onChange: (next: HaccpPreambleValue) => void;
  disabled?: boolean;
};

type StepAProps = StepProps & {
  nama?: string;
  onNamaChange?: (v: string) => void;
  description?: string;
  onDescriptionChange?: (v: string) => void;
};

export function HaccpWizardStepA({
  value,
  onChange,
  disabled,
  nama,
  onNamaChange,
  description,
  onDescriptionChange,
}: StepAProps) {
  const setTeam = (team: HaccpTeamMember[]) => onChange({ ...value, team });
  return (
    <div className="space-y-4 rounded-lg border bg-white p-4">
      <div>
        <h3 className="text-sm font-semibold">Tim & ruang lingkup</h3>
        <Helper>
          Siapa yang menyusun rencana ini, dan proses mana yang dicakup? (BGN meminta tim dari beberapa peran.)
        </Helper>
      </div>
      {onNamaChange && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-sm sm:col-span-2">
            <span className="font-medium">Nama rencana</span>
            <input
              className={fieldClass()}
              disabled={disabled}
              value={nama || ''}
              onChange={(e) => onNamaChange(e.target.value)}
              placeholder="Contoh: HACCP Plan Memasak Dapur Utama"
            />
          </label>
          <label className="block space-y-1 text-sm sm:col-span-2">
            <span className="font-medium">Ringkasan (opsional)</span>
            <textarea
              className={fieldClass()}
              rows={2}
              disabled={disabled}
              value={description || ''}
              onChange={(e) => onDescriptionChange?.(e.target.value)}
              placeholder="Untuk dapur apa, menu apa, atau proses apa"
            />
          </label>
        </div>
      )}
      <div className="space-y-2">
        {value.team.map((m, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              className={fieldClass()}
              placeholder="Nama"
              disabled={disabled}
              value={m.name}
              onChange={(e) => {
                const team = [...value.team];
                team[i] = { ...m, name: e.target.value };
                setTeam(team);
              }}
            />
            <input
              className={fieldClass()}
              placeholder="Peran (mis. Ketua Tim, Kepala Dapur)"
              disabled={disabled}
              value={m.role}
              onChange={(e) => {
                const team = [...value.team];
                team[i] = { ...m, role: e.target.value };
                setTeam(team);
              }}
            />
            <input
              className={fieldClass()}
              placeholder="Unit (opsional)"
              disabled={disabled}
              value={m.unit || ''}
              onChange={(e) => {
                const team = [...value.team];
                team[i] = { ...m, unit: e.target.value };
                setTeam(team);
              }}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={disabled}
              onClick={() => setTeam(value.team.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setTeam([...value.team, { name: '', role: '', unit: '' }])}
        >
          <Plus className="mr-1 h-4 w-4" />
          Tambah anggota
        </Button>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Ruang lingkup</span>
        <Helper>Batas proses yang masuk studi (mis. dari penerimaan sampai holding panas di dapur X).</Helper>
        <textarea
          className={fieldClass()}
          rows={3}
          disabled={disabled}
          value={value.scope}
          onChange={(e) => onChange({ ...value, scope: e.target.value })}
        />
      </label>
    </div>
  );
}

export function HaccpWizardStepB({ value, onChange, disabled }: StepProps) {
  return (
    <div className="space-y-4 rounded-lg border bg-white p-4">
      <div>
        <h3 className="text-sm font-semibold">Produk & pengguna</h3>
        <Helper>Makanan apa yang dijaga, dan untuk siapa? Ini membantu fokus bahaya nanti.</Helper>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Deskripsi produk</span>
        <textarea
          className={fieldClass()}
          rows={3}
          disabled={disabled}
          value={value.productDescription}
          onChange={(e) => onChange({ ...value, productDescription: e.target.value })}
          placeholder="Komposisi singkat, kemasan/sajian, umur simpan, cara simpan…"
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Tujuan penggunaan & pengguna</span>
        <Helper>Untuk siapa makanan ini? (anak sekolah, ibu hamil, konsumsi segera, dll.)</Helper>
        <textarea
          className={fieldClass()}
          rows={2}
          disabled={disabled}
          value={value.intendedUse}
          onChange={(e) => onChange({ ...value, intendedUse: e.target.value })}
          placeholder="Mis. dikonsumsi segera oleh anak sekolah / ibu hamil…"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <LinkedMasterPicker
          label="Resep terkait (opsional)"
          helper="Pilih resep yang dicakup rencana ini — bukan mengetik ID."
          endpoint="/api/recipes?aktif=1"
          idsCsv={value.recipeIdsCsv}
          onChange={(recipeIdsCsv) => onChange({ ...value, recipeIdsCsv })}
          disabled={disabled}
        />
        <LinkedMasterPicker
          label="Menu terkait (opsional)"
          helper="Pilih menu yang dicakup, bila ada."
          endpoint="/api/menus?aktif=1"
          idsCsv={value.menuIdsCsv}
          onChange={(menuIdsCsv) => onChange({ ...value, menuIdsCsv })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

type StepCProps = StepProps & {
  processSteps: HaccpProcessStep[];
  onProcessStepsChange: (steps: HaccpProcessStep[]) => void;
  /** Tanggal verifikasi tersimpan (read-only hint). */
  flowVerifiedAtLabel?: string | null;
};

export function HaccpWizardStepC({
  value,
  onChange,
  processSteps,
  onProcessStepsChange,
  flowVerifiedAtLabel,
  disabled,
}: StepCProps) {
  const updateStep = (i: number, patch: Partial<HaccpProcessStep>) => {
    const next = processSteps.map((s, j) => (j === i ? { ...s, ...patch } : s));
    onProcessStepsChange(next);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-white p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Alur proses di dapur</h3>
          <Helper>
            Susun urutan kerja nyata. Lalu konfirmasi bahwa alur sudah dicek di lapangan (bukan hanya di kertas).
          </Helper>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Urutan langkah</div>
          {processSteps.map((s, i) => (
            <div key={s.key || i} className="space-y-2 rounded border bg-background p-2">
              <div className="grid gap-2 sm:grid-cols-[4rem_1fr_auto]">
                <input
                  className={fieldClass()}
                  type="number"
                  disabled={disabled}
                  value={s.sequence}
                  onChange={(e) => updateStep(i, { sequence: Number(e.target.value) || i + 1 })}
                />
                <input
                  className={fieldClass()}
                  placeholder="Nama langkah (mis. Memasak)"
                  disabled={disabled}
                  value={s.nama}
                  onChange={(e) => {
                    const nama = e.target.value;
                    const key = s.key || `step_${i + 1}`;
                    updateStep(i, { nama, key });
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onProcessStepsChange(processSteps.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <input
                className={fieldClass()}
                placeholder="Keterangan singkat (opsional)"
                disabled={disabled}
                value={s.description || ''}
                onChange={(e) => updateStep(i, { description: e.target.value })}
              />
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              const n = processSteps.length + 1;
              onProcessStepsChange([
                ...processSteps,
                { key: `step_${n}_${Date.now().toString(36)}`, nama: '', sequence: n },
              ]);
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            Tambah langkah
          </Button>
        </div>

        <label className="block space-y-1 text-sm">
          <span className="font-medium">Catatan diagram alir (opsional)</span>
          <textarea
            className={fieldClass()}
            rows={2}
            disabled={disabled}
            value={value.flowDiagramNote}
            onChange={(e) => onChange({ ...value, flowDiagramNote: e.target.value })}
          />
        </label>
        <PhotoUploadField
          label="Foto / sketsa alur (opsional)"
          photos={value.flowDiagramUrls}
          onChange={(urls) => onChange({ ...value, flowDiagramUrls: urls })}
          disabled={disabled}
          maxPhotos={3}
        />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            disabled={disabled}
            checked={value.flowVerified}
            onChange={(e) => onChange({ ...value, flowVerified: e.target.checked })}
          />
          <span>
            <span className="font-medium">Sudah dicek di lapangan</span>
            <Helper>Wajib sebelum rencana bisa disetujui / diaktifkan.</Helper>
          </span>
        </label>
        {value.flowVerified && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Diverifikasi oleh</span>
              <input
                className={fieldClass()}
                disabled={disabled}
                value={value.flowVerifiedByName}
                onChange={(e) => onChange({ ...value, flowVerifiedByName: e.target.value })}
                placeholder="Nama yang mengecek di lapangan"
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Catatan verifikasi</span>
              <input
                className={fieldClass()}
                disabled={disabled}
                value={value.flowVerifiedNote}
                onChange={(e) => onChange({ ...value, flowVerifiedNote: e.target.value })}
              />
            </label>
            {flowVerifiedAtLabel ? (
              <p className="sm:col-span-2 text-xs text-muted-foreground">
                Tanggal konfirmasi tersimpan: {flowVerifiedAtLabel}
              </p>
            ) : (
              <p className="sm:col-span-2 text-xs text-muted-foreground">
                Tanggal dicatat otomatis saat Anda menekan Simpan draft.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function emptyPreamble(): HaccpPreambleValue {
  return {
    team: [{ name: '', role: '', unit: '' }],
    scope: '',
    productDescription: '',
    intendedUse: '',
    recipeIdsCsv: '',
    menuIdsCsv: '',
    flowDiagramNote: '',
    flowDiagramUrls: [],
    flowVerified: false,
    flowVerifiedByName: '',
    flowVerifiedNote: '',
  };
}

type MasterRow = { id: string; nama?: string; kode?: string };

function idsFromCsv(raw: string): string[] {
  return [...new Set(String(raw || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
}

function LinkedMasterPicker({
  label,
  helper,
  endpoint,
  idsCsv,
  onChange,
  disabled,
}: {
  label: string;
  helper: string;
  endpoint: string;
  idsCsv: string;
  onChange: (csv: string) => void;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState<MasterRow[]>([]);
  const selected = new Set(idsFromCsv(idsCsv));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(endpoint, { headers: actingTenantHeaders() });
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.items || data.data || []);
        if (!cancelled) {
          setRows(
            (list as MasterRow[]).map((r) => ({
              id: String(r.id),
              nama: r.nama,
              kode: r.kode,
            })),
          );
        }
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange([...next].join(', '));
  };

  return (
    <div className="space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <Helper>{helper}</Helper>
      <div className="max-h-40 space-y-1 overflow-y-auto rounded border bg-background px-2 py-1.5">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">Belum ada data, atau gagal dimuat. Boleh dikosongkan.</p>
        )}
        {rows.map((r) => (
          <label key={r.id} className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              disabled={disabled}
              checked={selected.has(r.id)}
              onChange={(e) => toggle(r.id, e.target.checked)}
            />
            <span>
              {r.nama || r.id}
              {r.kode ? <span className="text-muted-foreground"> · {r.kode}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function preambleChecklist(value: HaccpPreambleValue, processStepCount: number): Array<{
  id: string;
  label: string;
  ok: boolean;
}> {
  return [
    {
      id: 'team',
      label: 'Tim HACCP terisi',
      ok: value.team.some((m) => m.name.trim() && m.role.trim()),
    },
    { id: 'scope', label: 'Ruang lingkup', ok: Boolean(value.scope.trim()) },
    {
      id: 'product',
      label: 'Deskripsi produk',
      ok: Boolean(value.productDescription.trim()),
    },
    { id: 'use', label: 'Tujuan penggunaan', ok: Boolean(value.intendedUse.trim()) },
    { id: 'steps', label: 'Langkah proses', ok: processStepCount > 0 },
    {
      id: 'flow',
      label: 'Alur dicek di lapangan',
      ok: value.flowVerified && Boolean(value.flowVerifiedByName.trim()),
    },
  ];
}
