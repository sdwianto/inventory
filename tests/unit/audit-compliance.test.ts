import { describe, it, expect } from 'vitest';
import {
  AUDIT_COMPLIANCE_RETENTION_DAYS,
  AUDIT_UI_RETENTION_DAYS,
  auditCompliancePurgeCutoff,
  auditUiRetentionCutoff,
} from '@/lib/api/audit-log';
import { auditRowsToCsv } from '@/lib/api/audit-export';

describe('audit compliance (P3)', () => {
  it('compliance retention is ~7 years', () => {
    expect(AUDIT_COMPLIANCE_RETENTION_DAYS).toBeGreaterThan(2500);
    expect(AUDIT_UI_RETENTION_DAYS).toBe(90);
  });

  it('purge cutoff is older than UI cutoff', () => {
    expect(auditCompliancePurgeCutoff().getTime()).toBeLessThan(auditUiRetentionCutoff().getTime());
  });

  it('exports CSV with header', () => {
    const csv = auditRowsToCsv([
      {
        id: 'a1',
        createdAt: '2026-01-01T00:00:00.000Z',
        tenantId: 't1',
        action: 'GRN_POSTED',
        entityType: 'grn',
        entityId: 'grn-1',
        summary: 'Test, "quoted"',
        userName: 'Admin',
      },
    ]);
    expect(csv).toContain('id,createdAt,tenantId');
    expect(csv).toContain('GRN_POSTED');
    expect(csv).toContain('"Test, ""quoted"""');
  });
});
