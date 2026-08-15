import { describe, expect, it } from 'vitest';
import {
  BGN_HACCP_SOURCE,
  EXTRA_PRP_REQUIREMENT_SEEDS,
  PRP_GROUP_LABELS,
  buildPrpRecordHref,
  buildPrpSetupHref,
  groupRequirementsByPre,
  resolvePrpMeta,
} from '@/lib/food-safety/prp-meta';

describe('PRP PRE-01…05 meta', () => {
  it('nama grup ramah, bukan hanya kode', () => {
    expect(PRP_GROUP_LABELS['PRE-04']).toMatch(/orang/i);
    expect(PRP_GROUP_LABELS['PRE-05']).toMatch(/sajian|masak/i);
  });

  it('Dasar aturan menunjuk PDF BGN, bukan BGN-PRP-HYG', () => {
    expect(BGN_HACCP_SOURCE.path).toMatch(/HACCP BGN\.pdf/);
    expect(BGN_HACCP_SOURCE.href).toBe('/api/docs/haccp-bgn');
    expect(BGN_HACCP_SOURCE.href).not.toMatch(/BGN-PRP-HYG/);
  });

  it('HYG-01 masuk PRE-04', () => {
    expect(resolvePrpMeta('HYG-01')?.requirementGroup).toBe('PRE-04');
    expect(resolvePrpMeta('WTR-02')?.requirementGroup).toBe('PRE-02');
    expect(resolvePrpMeta('STOR-03')?.requirementGroup).toBe('PRE-05');
  });

  it('celah kritis thawing / reheat / pest kimia ada di extra seed', () => {
    const kodes = EXTRA_PRP_REQUIREMENT_SEEDS.map((s) => s.kode);
    expect(kodes).toEqual(expect.arrayContaining(['STOR-03', 'REHEAT-01', 'PEST-03', 'WTR-02']));
  });

  it('groupRequirementsByPre mengelompokkan dari kode', () => {
    const g = groupRequirementsByPre([
      { kode: 'HYG-01' },
      { kode: 'EQP-01' },
      { kode: 'SITE-01' },
    ]);
    expect(g['PRE-04']).toHaveLength(1);
    expect(g['PRE-02']).toHaveLength(1);
    expect(g['PRE-01']).toHaveLength(1);
  });

  it('groupRequirementsByPre merapikan kode yang tampil dua kali', () => {
    const g = groupRequirementsByPre([
      { kode: 'CLN-01', nama: 'a' },
      { kode: 'CLN-01', nama: 'a-dup' },
      { kode: 'SITE-01', nama: 'b' },
    ]);
    expect(g['PRE-01']).toHaveLength(2);
    expect(g['PRE-01'].map((r) => r.kode)).toEqual(['CLN-01', 'SITE-01']);
  });

  it('deep-link Setup & Catat sekarang stabil untuk Audit', () => {
    expect(buildPrpSetupHref({ group: 'PRE-04', requirementId: 'req-1' }))
      .toBe('/kitchen-assurance/setup?group=PRE-04&requirementId=req-1');
    expect(buildPrpRecordHref({ programId: 'p1', requirementId: 'r1' }))
      .toContain('requirementId=r1');
  });
});
