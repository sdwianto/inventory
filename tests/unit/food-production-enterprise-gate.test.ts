/**
 * Food Production enterprise gate — structural smoke for Phase 0–4 + Sprint 18 AI.
 * Fast, no DB. Catches missing routes/modules/nav after refactors.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiKeyRouteDenied } from '@/lib/api/route-dispatch';
import { FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';

const ROOT = resolve(import.meta.dirname, '../..');

const REQUIRED_MODULES = [
  'lib/api/stock-mutation.ts',
  'lib/food-production/document.ts',
  'lib/food-production/item-role.ts',
  'lib/food-production/kitchen.ts',
  'lib/food-production/kitchen-scope.ts',
  'lib/food-production/roles.ts',
  'lib/food-production/recipe.ts',
  'lib/food-production/menu.ts',
  'lib/food-production/production-plan.ts',
  'lib/food-production/material-requirement.ts',
  'lib/food-production/purchase-requirement.ts',
  'lib/food-production/material-issue.ts',
  'lib/food-production/production-result.ts',
  'lib/food-production/production-report.ts',
  'lib/food-production/nutrition.ts',
  'lib/food-production/tkpi-parse.ts',
  'lib/food-production/tkpi-catalog.ts',
  'lib/food-production/cost.ts',
  'lib/food-production/qc.ts',
  'lib/food-production/forecast.ts',
  'lib/food-production/dashboard.ts',
  'lib/food-production/recommendations.ts',
  'lib/food-production/kitchen-transfer.ts',
  'lib/food-production/production-calendar.ts',
  'lib/food-production/production-batch.ts',
  'lib/food-production/service-point.ts',
  'lib/food-production/distribution.ts',
  'lib/food-production/temperature-log.ts',
  'lib/food-production/haccp.ts',
  'lib/food-production/batch-audit-trail.ts',
  'lib/api/request-metrics.ts',
  'lib/food-production/supplier-price-book.ts',
  'lib/api/handlers/food-recommendations.ts',
  'lib/api/handlers/fp-public.ts',
  'lib/api/handlers/service-points.ts',
  'lib/api/handlers/distribution-orders.ts',
  'lib/api/handlers/temperature-logs.ts',
  'lib/api/handlers/haccp.ts',
  'lib/api/handlers/supplier-price-book.ts',
  'lib/api/handlers/ops-dashboard.ts',
  'app/food-production/recommendations/page.tsx',
  'app/food-production/purchase-requirement/page.tsx',
  'app/food-production/report/page.tsx',
  'app/food-production/transfer/page.tsx',
  'app/food-production/calendar/page.tsx',
  'app/food-production/batch/page.tsx',
  'app/food-production/service-point/page.tsx',
  'app/food-production/distribution/page.tsx',
  'components/food-production/DistributionScheduleDocument.tsx',
  'app/food-production/cold-chain/page.tsx',
  'app/food-production/haccp/page.tsx',
  'app/food-production/price-book/page.tsx',
  'docs/adr/001-food-production-domain.md',
];

const REQUIRED_DISPATCH = [
  'food-recommendations',
  'food-dashboard',
  'food-forecasts',
  'fp-public',
  'kitchen-transfers',
  'production-calendar',
  'production-batches',
  'service-points',
  'distribution-orders',
  'temperature-logs',
  'temperature-thresholds',
  'haccp-templates',
  'haccp-results',
  'supplier-price-book',
  'api-keys',
];

describe('food-production enterprise gate', () => {
  it('ships required Phase 0–4 + AI recommendation artifacts', () => {
    const missing = REQUIRED_MODULES.filter((rel) => !existsSync(resolve(ROOT, rel)));
    expect(missing).toEqual([]);
  });

  it('registers FP handlers in route-dispatch', () => {
    const src = readFileSync(resolve(ROOT, 'lib/api/route-dispatch.ts'), 'utf8');
    for (const key of REQUIRED_DISPATCH) {
      expect(src).toContain(`'${key}'`);
    }
  });

  it('AppShell exposes recommendations + Phase 4 routes', () => {
    const src = readFileSync(resolve(ROOT, 'components/AppShell.tsx'), 'utf8');
    expect(src).toContain("/food-production/recommendations");
    // Transfer Dapur disembunyikan dari nav (route/API tetap); jangan assert di NAV.
    expect(src).not.toContain("label: 'Transfer Dapur'");
    expect(src).toContain("/food-production/plan");
    expect(src).toContain("/food-production/calendar");
    expect(src).toContain("/food-production/batch");
    expect(src).toContain("/food-production/service-point");
    expect(src).toContain("/food-production/distribution");
    expect(src).toContain("/food-production/price-book");
    expect(src).not.toContain("/food-production/mobile");
    expect(src).toContain("/utiliti/api-keys");
    expect(src).toContain('FP_OPS_ROUTES');
    expect(src).toContain('FP_MGMT_ROUTES');
    // GUDANG ops-only (no management FP routes in GUDANG list block before SUPERVISOR).
    const gudangBlock = src.slice(src.indexOf('GUDANG:'), src.indexOf('SUPERVISOR:'));
    expect(gudangBlock).toContain('FP_OPS_ROUTES');
    expect(gudangBlock).not.toContain('FP_MGMT_ROUTES');
    expect(gudangBlock).not.toContain('/food-production/recommendations');
    expect(gudangBlock).not.toContain('/food-production/price-book');
  });

  // docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md Sprint 1 STEP 0 + Sprint 2 STEP 2:
  // QC/Cold Chain/HACCP/Armada sengaja dikeluarkan dari FP_OPS_ROUTES/nav Food Production
  // (pindah ke domain Kitchen Assurance / Logistics). Test lama yang menjaga keberadaan
  // route-route ini di AppShell.tsx sudah tidak relevan — diganti test ini.
  it('QC/Cold Chain/HACCP/Armada moved out of Food Production ops routes; Logistics group exists', () => {
    const src = readFileSync(resolve(ROOT, 'components/AppShell.tsx'), 'utf8');
    const fpOpsBlock = src.slice(src.indexOf('const FP_OPS_ROUTES'), src.indexOf('const KA_OPS_ROUTES'));
    expect(fpOpsBlock).not.toContain("/food-production/qc'");
    expect(fpOpsBlock).not.toContain("/food-production/cold-chain'");
    expect(fpOpsBlock).not.toContain("/food-production/haccp'");
    expect(fpOpsBlock).not.toContain("/food-production/armada'");
    expect(src).toContain("key: 'logistics'");
    expect(src).toContain("/logistics/armada");
  });

  it('management APIs require FP_MGMT_READ_ROLES', () => {
    for (const rel of [
      'lib/api/handlers/food-costs.ts',
      'lib/api/handlers/food-forecasts.ts',
      'lib/api/handlers/food-dashboard.ts',
      'lib/api/handlers/food-recommendations.ts',
      'lib/api/handlers/nutrition-profiles.ts',
    ]) {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');
      expect(src).toContain('FP_MGMT_READ_ROLES');
      expect(src).toContain('requireRole');
    }
  });

  it('QC dapur write uses FP_OPS_WRITE_ROLES (ADR #5)', () => {
    const src = readFileSync(resolve(ROOT, 'lib/api/handlers/qc.ts'), 'utf8');
    expect(src).toContain('FP_OPS_WRITE_ROLES');
    expect(src).toContain('FP_MANAGE_ROLES');
    expect(src).toMatch(/QC_RESULT_RECORD|persistItemEvidence/);
  });

  it('distribution supports PLAN source and print document', () => {
    const page = readFileSync(resolve(ROOT, 'app/food-production/distribution/page.tsx'), 'utf8');
    expect(page).toContain("sourceType: useHsl ? 'RESULT' : 'PLAN'");
    expect(page).toContain('DistributionScheduleDocument');
    expect(page).toContain('printDocument');
    expect(page).toContain('PlanDateStrip');
    expect(page).toContain('hasDistDokumenNo');
    expect(page).toContain('Jadwalkan');
    expect(page).toContain('Simpan Draft');
    expect(page).not.toContain('Sumber jadwal');
    expect(page).not.toContain('Rencana produksi (RPN)');
    expect(page).toContain('Tanpa HSL (simpan sebagai Draft)');
    const doc = readFileSync(
      resolve(ROOT, 'components/food-production/DistributionScheduleDocument.tsx'),
      'utf8',
    );
    expect(doc).toContain('JADWAL PENGIRIMAN');
    expect(doc).toContain('DIST_SCHEDULE_PRINT_ID');
    const dist = readFileSync(resolve(ROOT, 'lib/food-production/distribution.ts'), 'utf8');
    expect(dist).toContain("APPROVED: 'Terjadwal'");
    expect(dist).toContain("DRAFT: ['APPROVED', 'CANCELLED']");
  });

  it('doc prefixes cover kitchen loop + XFR + DST + HCP', () => {
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.PRODUCTION_PLAN]).toBe('RPN');
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.MATERIAL_ISSUE]).toBe('PBL');
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.PRODUCTION_RESULT]).toBe('HSL');
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.KITCHEN_TRANSFER]).toBe('XFR');
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.DISTRIBUTION_ORDER]).toBe('DST');
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.HACCP_RESULT]).toBe('HCP');
  });

  it('API key sandbox remains fail-closed outside fp-public', () => {
    expect(apiKeyRouteDenied(true, '/kitchens')).toBe(true);
    expect(apiKeyRouteDenied(true, '/food-recommendations')).toBe(true);
    expect(apiKeyRouteDenied(true, '/fp-public/plans')).toBe(false);
  });

  it('ADR marks Phase 3 AI + Phase 4 + Phase 5 Sprint 19–24 done', () => {
    const adr = readFileSync(resolve(ROOT, 'docs/adr/001-food-production-domain.md'), 'utf8');
    expect(adr).toMatch(/\| 18 \| AI Recommendation[^\n]*DONE/);
    expect(adr).toMatch(/\| 13 \| Multi-Kitchen[^\n]*DONE/);
    expect(adr).toMatch(/\| 17 \| API public[^\n]*DONE/);
    expect(adr).toMatch(/\| 19 \| Titik layanan[^\n]*DONE/);
    expect(adr).toMatch(/\| 20 \| Cold-chain[^\n]*DONE/);
    expect(adr).toMatch(/\| 21 \| HACCP[^\n]*DONE/);
    expect(adr).toMatch(/\| 22 \| FP observability[^\n]*DONE/);
    expect(adr).toMatch(/\| 23 \| Supplier price book[^\n]*DONE/);
    expect(adr).toMatch(/\| 24 \| Mobile-simplified[^\n]*DONE/);
    expect(adr).toContain('Phase 5');
    expect(adr).toContain('MBG Scale & Compliance');
  });

  it('wires api_slow_request + FP request metrics', () => {
    const routeSrc = readFileSync(resolve(ROOT, 'app/api/[[...path]]/route.ts'), 'utf8');
    expect(routeSrc).toContain('api_slow_request');
    expect(routeSrc).toContain('recordRequestDuration');
    expect(routeSrc).toContain('recordFpFailure');
    const opsSrc = readFileSync(resolve(ROOT, 'lib/api/handlers/ops-dashboard.ts'), 'utf8');
    expect(opsSrc).toContain('fpObservability');
    expect(opsSrc).toContain('getFpLatencySnapshots');
    const pkg = readFileSync(resolve(ROOT, 'package.json'), 'utf8');
    expect(pkg).toContain('test:fp:enterprise');
  });
});
