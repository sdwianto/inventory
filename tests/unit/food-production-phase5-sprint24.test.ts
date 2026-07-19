import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isQcEditable, QC_ITEM_RESULT_LABELS } from '@/lib/food-production/qc';

const ROOT = resolve(import.meta.dirname, '../..');

describe('food-production phase 5 sprint 24', () => {
  it('removes Mode Dapur (mobile hub) — not needed for MBG ops', () => {
    const pages = [
      'app/food-production/mobile/page.tsx',
      'app/food-production/mobile/issue/page.tsx',
      'app/food-production/mobile/result/page.tsx',
      'app/food-production/mobile/qc/page.tsx',
    ];
    for (const rel of pages) {
      expect(existsSync(resolve(ROOT, rel))).toBe(false);
    }
    const shell = readFileSync(resolve(ROOT, 'components/AppShell.tsx'), 'utf8');
    expect(shell).not.toContain("/food-production/mobile");
    expect(shell).not.toContain('Mode Dapur');
    const prefetch = readFileSync(resolve(ROOT, 'lib/prefetch-by-role.ts'), 'utf8');
    expect(prefetch).not.toContain("/food-production/mobile");
  });

  it('QC allows GUDANG ops write (create/edit/submit) per ADR #5', () => {
    const handler = readFileSync(resolve(ROOT, 'lib/api/handlers/qc.ts'), 'utf8');
    expect(handler).toContain('FP_OPS_WRITE_ROLES');
    expect(handler).toContain('FP_MANAGE_ROLES');
    const roles = readFileSync(resolve(ROOT, 'lib/food-production/roles.ts'), 'utf8');
    expect(roles).toMatch(/QC create\/edit\/submit|dapur mencatat/);
    const full = readFileSync(resolve(ROOT, 'app/food-production/qc/page.tsx'), 'utf8');
    expect(full).toContain('OPS_WRITE');
    expect(full).toContain('canLog');
  });

  it('QC is single finding form (no approval Setujui/Kembali)', () => {
    expect(isQcEditable('COMPLETED')).toBe(true);
    expect(isQcEditable('CANCELLED')).toBe(false);
    expect(QC_ITEM_RESULT_LABELS.FAIL).toMatch(/temuan/i);
    const full = readFileSync(resolve(ROOT, 'app/food-production/qc/page.tsx'), 'utf8');
    expect(full).toContain('Simpan checklist');
    expect(full).toContain('PhotoUploadField');
    expect(full).toContain('Remark');
    expect(full).toContain('Dicatat oleh');
    expect(full).not.toContain('Setujui');
    expect(full).not.toContain('QC_UI_STATUS_PREV');
    expect(full).not.toContain('goBackEdit');
  });

  it('production-results handler has no duplicate KITCHENS_COLLECTION import', () => {
    const src = readFileSync(resolve(ROOT, 'lib/api/handlers/production-results.ts'), 'utf8');
    const matches = src.match(/from ['"]@\/lib\/food-production\/kitchen['"]/g) || [];
    expect(matches).toHaveLength(1);
  });
});
