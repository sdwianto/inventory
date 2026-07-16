/**
 * Management Dashboard + rule-based tips — ADR-001 Phase 3.
 * Bukan AI chat; rekomendasi berbasis data operasional.
 */

export interface FoodDashboardKpis {
  openPlans: number;
  processingPlans: number;
  openIssues: number;
  openResults: number;
  openQc: number;
  productsMissingNutrition: number;
  recipesCoveredNutritionPct: number;
  forecastShortCount: number;
  costVarianceAlerts: number;
}

export interface FoodDashboardTip {
  id: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  href?: string;
}

export interface FoodDashboardSnapshot {
  generatedAt: string;
  kpis: FoodDashboardKpis;
  tips: FoodDashboardTip[];
}

export function buildFoodDashboardTips(kpis: FoodDashboardKpis): FoodDashboardTip[] {
  const tips: FoodDashboardTip[] = [];

  if (kpis.openPlans > 0) {
    tips.push({
      id: 'open-plans',
      severity: 'info',
      title: `${kpis.openPlans} rencana masih terbuka`,
      detail: 'Selesaikan approval atau batalkan draft yang tidak dipakai.',
      href: '/food-production/plan',
    });
  }
  if (kpis.processingPlans > 0 && kpis.openIssues === 0 && kpis.openResults === 0) {
    tips.push({
      id: 'stuck-processing',
      severity: 'warn',
      title: 'Rencana diproses tanpa Issue/Result terbuka',
      detail: 'Cek apakah pengambilan atau hasil produksi perlu dibuat.',
      href: '/food-production/issue',
    });
  }
  if (kpis.openIssues > 0) {
    tips.push({
      id: 'open-issues',
      severity: 'warn',
      title: `${kpis.openIssues} pengambilan bahan belum selesai`,
      detail: 'Post stok PBL agar dapur bisa lanjut ke hasil produksi.',
      href: '/food-production/issue',
    });
  }
  if (kpis.openResults > 0) {
    tips.push({
      id: 'open-results',
      severity: 'warn',
      title: `${kpis.openResults} hasil produksi masih terbuka`,
      detail: 'Selesaikan HSL setelah PBL selesai untuk menutup siklus dapur.',
      href: '/food-production/result',
    });
  }
  if (kpis.openQc > 0) {
    tips.push({
      id: 'open-qc',
      severity: 'info',
      title: `${kpis.openQc} checklist QC belum selesai`,
      detail: 'Lengkapi QC produksi/kebersihan/distribusi.',
      href: '/food-production/qc',
    });
  }
  if (kpis.productsMissingNutrition > 0) {
    tips.push({
      id: 'missing-nutrition',
      severity: 'critical',
      title: `${kpis.productsMissingNutrition} bahan tanpa data gizi`,
      detail: 'Isi profil gizi agar analisis AKG Recipe/Menu/Plan akurat (inti MBG).',
      href: '/food-production/nutrition',
    });
  }
  if (kpis.recipesCoveredNutritionPct < 70 && kpis.recipesCoveredNutritionPct >= 0) {
    tips.push({
      id: 'recipe-coverage',
      severity: 'warn',
      title: `Cakupan gizi resep ${kpis.recipesCoveredNutritionPct}%`,
      detail: 'Targetkan ≥70% resep punya semua bahan ber-gizi.',
      href: '/food-production/nutrition',
    });
  }
  if (kpis.forecastShortCount > 0) {
    tips.push({
      id: 'forecast-short',
      severity: 'critical',
      title: `${kpis.forecastShortCount} bahan berisiko shortage (forecast)`,
      detail: 'Review forecast 7/14/30 hari lalu buat kebutuhan beli.',
      href: '/food-production/forecast',
    });
  }
  if (kpis.costVarianceAlerts > 0) {
    tips.push({
      id: 'cost-variance',
      severity: 'warn',
      title: `${kpis.costVarianceAlerts} rencana dengan variance biaya tinggi`,
      detail: 'Bandingkan standard vs actual food cost per porsi.',
      href: '/food-production/cost',
    });
  }
  if (!tips.length) {
    tips.push({
      id: 'all-clear',
      severity: 'info',
      title: 'Operasi dapur tampak sehat',
      detail: 'Tidak ada alert kritis dari KPI Phase 3 saat ini.',
      href: '/food-production/dashboard',
    });
  }

  const rank = { critical: 0, warn: 1, info: 2 };
  return tips.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function buildFoodDashboardSnapshot(kpis: FoodDashboardKpis): FoodDashboardSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    kpis,
    tips: buildFoodDashboardTips(kpis),
  };
}
