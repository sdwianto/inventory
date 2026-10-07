'use client';

// Sama dengan AKG_COMPLIANCE_* di lib/food-production/nutrition.ts; tidak diimpor agar katalog TKPI tidak ikut bundel klien.
const AKG_COMPLIANCE_MIN_PCT = 90;
const AKG_COMPLIANCE_MAX_PCT = 120;

export type PlateOil = { serapPct: number; absorbedGramsPerPorsi: number; basis: string };

export type PlateView = {
  family: 'KECIL' | 'BESAR';
  perPorsi: { energiKcal: number; proteinG: number };
  perPorsiAkgPct: { energiKcal?: number; proteinG?: number };
  akgDaily: { energiKcal: number; proteinG: number };
  recipes: Array<{ kode?: string; oil?: PlateOil }>;
};

export function parsePlates(raw: unknown): PlateView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && (p.family === 'KECIL' || p.family === 'BESAR'))
    .map((p) => ({
      family: p.family,
      perPorsi: { energiKcal: Number(p.perPorsi?.energiKcal) || 0, proteinG: Number(p.perPorsi?.proteinG) || 0 },
      perPorsiAkgPct: { energiKcal: Number(p.perPorsiAkgPct?.energiKcal) || 0, proteinG: Number(p.perPorsiAkgPct?.proteinG) || 0 },
      akgDaily: { energiKcal: Number(p.akgDaily?.energiKcal) || 0, proteinG: Number(p.akgDaily?.proteinG) || 0 },
      recipes: Array.isArray(p.recipes)
        ? p.recipes.map((r: { kode?: string; oil?: PlateOil }) => ({ kode: r.kode, oil: r.oil }))
        : [],
    }));
}

/** Peringatan data gizi saja; kepatuhan target dinilai per piring, bukan dari rata-rata penerima. */
export function dataGiziWarnings(warnings: string[] | null | undefined): string[] {
  return (warnings || []).filter((w) => !/target MBG/.test(w));
}

const fmt = (n: number, d = 0) => n.toLocaleString('id-ID', { maximumFractionDigits: d });
const outOfRange = (pct?: number) => pct != null && (pct < AKG_COMPLIANCE_MIN_PCT || pct > AKG_COMPLIANCE_MAX_PCT);

/** Est. AKG per piring: Porsi Kecil vs target Kecil, Porsi Besar vs target Besar. */
export function NutritionPlates({ plates }: { plates: PlateView[] }) {
  const oils = new Map<string, PlateOil>();
  for (const p of plates) for (const r of p.recipes) if (r.oil && r.kode && !oils.has(r.kode)) oils.set(r.kode, r.oil);
  return (
    <div className="space-y-0.5">
      {plates.map((p) => {
        const warn = outOfRange(p.perPorsiAkgPct.energiKcal) || outOfRange(p.perPorsiAkgPct.proteinG);
        return (
          <div key={p.family} className={warn ? 'text-amber-900' : 'text-slate-800'}>
            <span className="font-medium">{p.family === 'KECIL' ? 'Porsi Kecil' : 'Porsi Besar'}: </span>
            <span className="tabular-nums">
              ~{fmt(p.perPorsi.energiKcal)} kkal · {fmt(p.perPorsi.proteinG, 1)} g protein
              {' · '}
              <span className={outOfRange(p.perPorsiAkgPct.energiKcal) ? 'font-semibold' : ''}>{fmt(p.perPorsiAkgPct.energiKcal ?? 0, 1)}% energi</span>
              {' · '}
              <span className={outOfRange(p.perPorsiAkgPct.proteinG) ? 'font-semibold' : ''}>{fmt(p.perPorsiAkgPct.proteinG ?? 0, 1)}% protein</span>
            </span>
            <span className="ml-1 text-slate-500 tabular-nums">
              (target {fmt(p.akgDaily.energiKcal)} kkal · {fmt(p.akgDaily.proteinG, 1)} g; aman {AKG_COMPLIANCE_MIN_PCT}–{AKG_COMPLIANCE_MAX_PCT}%)
            </span>
          </div>
        );
      })}
      {oils.size > 0 && (
        <div className="text-[11px] text-slate-500">
          Minyak goreng terserap:{' '}
          {[...oils.entries()].map(([kode, o]) => `${kode} ~${fmt(o.absorbedGramsPerPorsi, 1)} g/porsi (${fmt(o.serapPct, 1)}%, ${o.basis})`).join(' · ')}
        </div>
      )}
    </div>
  );
}
