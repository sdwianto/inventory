import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QC_UI_STATUS_NEXT, QC_UI_STATUS_NEXT_LABEL } from '@/lib/food-production/qc';

const ROOT = resolve(import.meta.dirname, '../..');

describe('food-production phase 5 sprint 24', () => {
  it('ships mobile kitchen hub + Issue/Result/QC surfaces', () => {
    const pages = [
      'app/food-production/mobile/page.tsx',
      'app/food-production/mobile/issue/page.tsx',
      'app/food-production/mobile/result/page.tsx',
      'app/food-production/mobile/qc/page.tsx',
    ];
    const missing = pages.filter((rel) => !existsSync(resolve(ROOT, rel)));
    expect(missing).toEqual([]);
  });

  it('reuses existing kitchen APIs (no new mutation endpoints)', () => {
    const issue = readFileSync(resolve(ROOT, 'app/food-production/mobile/issue/page.tsx'), 'utf8');
    const result = readFileSync(resolve(ROOT, 'app/food-production/mobile/result/page.tsx'), 'utf8');
    const qc = readFileSync(resolve(ROOT, 'app/food-production/mobile/qc/page.tsx'), 'utf8');
    expect(issue).toContain('/api/material-issues');
    expect(result).toContain('/api/production-results');
    expect(qc).toContain('/api/qc-results');
    expect(issue).toContain('/status');
    expect(result).toContain('/status');
    expect(qc).toContain('/status');
  });

  it('registers Mode Dapur on FP_OPS_ROUTES (GUDANG-visible)', () => {
    const shell = readFileSync(resolve(ROOT, 'components/AppShell.tsx'), 'utf8');
    expect(shell).toContain("/food-production/mobile");
    expect(shell).toContain('Mode Dapur');
    const opsBlock = shell.slice(shell.indexOf('const FP_OPS_ROUTES'), shell.indexOf('const FP_MGMT_ROUTES'));
    expect(opsBlock).toContain("/food-production/mobile");
    const prefetch = readFileSync(resolve(ROOT, 'lib/prefetch-by-role.ts'), 'utf8');
    expect(prefetch).toContain("/food-production/mobile");
  });

  it('skips offline draft queue (optional deferred)', () => {
    const hub = readFileSync(resolve(ROOT, 'app/food-production/mobile/page.tsx'), 'utf8');
    expect(hub).toMatch(/Offline draft|offline draft/i);
    expect(hub).not.toMatch(/serviceWorker|indexedDB|localStorage\.setItem\(['\"]fp-offline/i);
  });

  it('fokus hari ini: date filter on Issue/Result/QC mobile', () => {
    for (const rel of [
      'app/food-production/mobile/issue/page.tsx',
      'app/food-production/mobile/result/page.tsx',
      'app/food-production/mobile/qc/page.tsx',
    ]) {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');
      expect(src).toContain('type="date"');
      expect(src).toContain('todayIso');
      expect(src).toContain("qs.set('tanggal'");
      expect(src).toMatch(/hari ini/);
    }
  });

  it('shows read-only banner when role cannot manage Issue/Result', () => {
    const hub = readFileSync(resolve(ROOT, 'app/food-production/mobile/page.tsx'), 'utf8');
    expect(hub).toMatch(/lihat saja|Issue\/Result/);
    expect(hub).toContain('canLogQc');
    for (const rel of [
      'app/food-production/mobile/issue/page.tsx',
      'app/food-production/mobile/result/page.tsx',
    ]) {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');
      expect(src).toContain('Mode lihat saja');
      expect(src).toContain('OperationalScopeBar');
      expect(src).toContain('aria-label="Muat ulang"');
    }
    const qc = readFileSync(resolve(ROOT, 'app/food-production/mobile/qc/page.tsx'), 'utf8');
    expect(qc).toContain('OPS_WRITE');
    expect(qc).toContain('canLog');
    expect(qc).toContain('OperationalScopeBar');
  });

  it('QC allows GUDANG ops write (create/edit/submit) per ADR #5', () => {
    const handler = readFileSync(resolve(ROOT, 'lib/api/handlers/qc.ts'), 'utf8');
    expect(handler).toContain('FP_OPS_WRITE_ROLES');
    expect(handler).toContain('FP_MANAGE_ROLES');
    expect(handler).toContain('QC_OPS_STATUS');
    const roles = readFileSync(resolve(ROOT, 'lib/food-production/roles.ts'), 'utf8');
    expect(roles).toMatch(/QC create\/edit\/submit|dapur mencatat/);
    const full = readFileSync(resolve(ROOT, 'app/food-production/qc/page.tsx'), 'utf8');
    expect(full).toContain('OPS_WRITE');
    expect(full).toContain('canLog');
  });

  it('Result mobile supports waste + warnings; COMPLETED confirms match full wording', () => {
    const result = readFileSync(resolve(ROOT, 'app/food-production/mobile/result/page.tsx'), 'utf8');
    expect(result).toContain('wastePorsi');
    expect(result).toContain('summary?.warnings');
    expect(result).toContain('Selesai & post stok masuk FG?');
    expect(result).toContain('Tidak bisa dibatalkan');
    const issue = readFileSync(resolve(ROOT, 'app/food-production/mobile/issue/page.tsx'), 'utf8');
    expect(issue).toContain('Selesai & post stok keluar?');
    expect(issue).toContain('Tidak bisa dibatalkan');
  });

  it('shares QC_UI_STATUS_NEXT between full and mobile QC', () => {
    expect(QC_UI_STATUS_NEXT.DRAFT).toBe('SUBMITTED');
    expect(QC_UI_STATUS_NEXT_LABEL.APPROVED).toBe('Selesai');
    const full = readFileSync(resolve(ROOT, 'app/food-production/qc/page.tsx'), 'utf8');
    const mobile = readFileSync(resolve(ROOT, 'app/food-production/mobile/qc/page.tsx'), 'utf8');
    expect(full).toContain('QC_UI_STATUS_NEXT');
    expect(mobile).toContain('QC_UI_STATUS_NEXT');
    expect(full).not.toMatch(/const STATUS_NEXT\s*=/);
  });

  it('production-results handler has no duplicate KITCHENS_COLLECTION import', () => {
    const src = readFileSync(resolve(ROOT, 'lib/api/handlers/production-results.ts'), 'utf8');
    const matches = src.match(/from ['"]@\/lib\/food-production\/kitchen['"]/g) || [];
    expect(matches).toHaveLength(1);
  });
});
