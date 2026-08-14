'use client';

import Link from 'next/link';

export const HACCP_WIZARD_STEPS = [
  {
    id: 'A',
    title: 'Tim & ruang lingkup',
    blurb: 'Siapa menyusun rencana, dan proses mana yang dicakup.',
    bgn: '8.1',
  },
  {
    id: 'B',
    title: 'Produk & pengguna',
    blurb: 'Makanan apa yang dijaga, untuk siapa, dan cara pakainya.',
    bgn: '8.2–8.3',
  },
  {
    id: 'C',
    title: 'Alur proses dapur',
    blurb: 'Urutan kerja di lapangan, lalu konfirmasi sudah dicek.',
    bgn: '8.4–8.5',
  },
  {
    id: 'D',
    title: 'Bahaya & titik kritis',
    blurb: 'Bahaya → CCP → batas aman → cara pantau → bila menyimpang.',
    bgn: '8.6–8.10',
  },
  {
    id: 'E',
    title: 'Cek rencana & pelatihan',
    blurb: 'Validasi/verifikasi, rekaman wajib, bukti pelatihan.',
    bgn: '8.11–8.13',
  },
] as const;

export type HaccpWizardStepId = (typeof HACCP_WIZARD_STEPS)[number]['id'];

type Props = {
  active: HaccpWizardStepId;
  onSelect?: (id: HaccpWizardStepId) => void;
  /** 0–100 overall plan progress (optional). */
  progressPct?: number | null;
  backHref?: string;
};

export default function HaccpWizardStepper({
  active,
  onSelect,
  progressPct,
  backHref = '/kitchen-assurance/setup',
}: Props) {
  const idx = HACCP_WIZARD_STEPS.findIndex((s) => s.id === active);
  const step = HACCP_WIZARD_STEPS[idx] || HACCP_WIZARD_STEPS[0];

  return (
    <div className="space-y-3 rounded-lg border bg-white p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          <Link href={backHref} className="text-blue-700 hover:underline">
            ← Setup kesiapan
          </Link>
          <span className="mx-2">·</span>
          Panduan rencana HACCP
          {progressPct != null && Number.isFinite(progressPct) ? (
            <span className="ml-2 font-medium text-foreground">{Math.round(progressPct)}%</span>
          ) : null}
        </div>
        <div className="text-[11px] text-muted-foreground">BGN {step.bgn}</div>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {HACCP_WIZARD_STEPS.map((s, i) => {
          const isActive = s.id === active;
          const done = i < idx;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect?.(s.id)}
              className={`min-w-[7.5rem] flex-1 rounded-md border px-2 py-2 text-left text-xs transition ${
                isActive
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : done
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
              }`}
            >
              <div className="font-semibold">{s.id}. {s.title}</div>
            </button>
          );
        })}
      </div>

      <div>
        <h2 className="text-base font-semibold tracking-tight">{step.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{step.blurb}</p>
      </div>
    </div>
  );
}
