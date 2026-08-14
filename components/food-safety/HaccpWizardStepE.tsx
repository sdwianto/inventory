'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import { HACCP_RECORDS_POINTERS } from '@/lib/food-safety/haccp-records-pointers';

export type HaccpCloseoutValue = {
  validationNote: string;
  validationEvidenceUrls: string[];
  validatedAtLabel?: string | null;
  validatedByName: string;
  trainingNote: string;
  trainingEvidenceUrls: string[];
};

type Props = {
  value: HaccpCloseoutValue;
  onChange: (next: HaccpCloseoutValue) => void;
  disabled?: boolean;
  onCreateValidation?: () => void;
  creatingValidation?: boolean;
};

export default function HaccpWizardStepE({
  value,
  onChange,
  disabled,
  onCreateValidation,
  creatingValidation,
}: Props) {
  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-lg border bg-white p-4">
        <div>
          <h3 className="text-sm font-semibold">Validasi rencana</h3>
          <p className="text-xs text-muted-foreground">
            Pastikan rencana masuk akal di dapur ini — foto uji coba atau catatan ahli (bukan sertifikat resmi).
          </p>
        </div>
        {value.validatedAtLabel ? (
          <p className="text-xs text-emerald-800">
            Dicatat {value.validatedAtLabel}
            {value.validatedByName ? ` · ${value.validatedByName}` : ''}
          </p>
        ) : null}
        <label className="block text-xs space-y-1">
          <span className="text-muted-foreground">Catatan validasi</span>
          <textarea
            className="w-full min-h-[72px] rounded border bg-background px-2 py-1.5 text-sm"
            disabled={disabled}
            value={value.validationNote}
            onChange={(e) => onChange({ ...value, validationNote: e.target.value })}
            placeholder="Contoh: Suhu inti 74°C tercapai pada uji 3 batch contoh."
          />
        </label>
        <input
          className="w-full rounded border bg-background px-2 py-1.5 text-sm"
          disabled={disabled}
          placeholder="Nama yang memvalidasi"
          value={value.validatedByName}
          onChange={(e) => onChange({ ...value, validatedByName: e.target.value })}
        />
        <PhotoUploadField
          label="Foto / bukti validasi"
          photos={value.validationEvidenceUrls}
          onChange={(urls) => onChange({ ...value, validationEvidenceUrls: urls })}
          disabled={disabled}
          maxPhotos={5}
        />
        {onCreateValidation && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled || creatingValidation}
            onClick={onCreateValidation}
          >
            {creatingValidation ? 'Mencatat…' : 'Catat validasi rencana'}
          </Button>
        )}
      </section>

      <section className="space-y-3 rounded-lg border bg-white p-4">
        <div>
          <h3 className="text-sm font-semibold">Rekaman wajib</h3>
          <p className="text-xs text-muted-foreground">
            Jenis bukti yang harus ada saat auditor datang — klik untuk melihat di Operasi / Setup / Temuan.
          </p>
        </div>
        <ul className="divide-y rounded-md border">
          {HACCP_RECORDS_POINTERS.map((row) => (
            <li key={row.key} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span>{row.label}</span>
              <Link href={row.href} className="inline-flex items-center text-xs text-blue-700 hover:underline">
                Buka
                <ArrowRight className="ml-1 h-3 w-3" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3 rounded-lg border bg-white p-4">
        <div>
          <h3 className="text-sm font-semibold">Bukti pelatihan</h3>
          <p className="text-xs text-muted-foreground">
            Unggah foto briefing atau sertifikat singkat. Ini bukan modul HR.
          </p>
        </div>
        <label className="block text-xs space-y-1">
          <span className="text-muted-foreground">Catatan (opsional)</span>
          <input
            className="w-full rounded border bg-background px-2 py-1.5 text-sm"
            disabled={disabled}
            value={value.trainingNote}
            onChange={(e) => onChange({ ...value, trainingNote: e.target.value })}
            placeholder="Contoh: Briefing CCP suhu 12 Agu 2026"
          />
        </label>
        <PhotoUploadField
          label="Foto / sertifikat pelatihan"
          photos={value.trainingEvidenceUrls}
          onChange={(urls) => onChange({ ...value, trainingEvidenceUrls: urls })}
          disabled={disabled}
          maxPhotos={8}
        />
      </section>
    </div>
  );
}
