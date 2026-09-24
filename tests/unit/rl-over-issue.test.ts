import { describe, expect, it, vi } from 'vitest';
import {
  evaluateRlOverIssue,
  normalizeRlOverIssueTolerancePct,
  rlOverIssueMissingReasonMessage,
  sanitizeOverReason,
} from '@/lib/food-production/rl-over-issue';
import type { PlanReference, PlanReferenceLine } from '@/lib/food-production/plan-reference';

vi.mock('@/lib/api/dashboard-snapshot', () => ({ invalidateDashboardSnapshot: vi.fn() }));

function line(partial: Partial<PlanReferenceLine>): PlanReferenceLine {
  return {
    productId: 'gula',
    productIds: ['gula'],
    productKode: 'GL01',
    productNama: 'Gula',
    satuan: 'KG',
    sumber: 'PO',
    acuanQty: 10,
    qtyMrp: 8,
    poQtyOrdered: 10,
    poQtyReceived: 10,
    poRefs: [],
    rlPosted: 4,
    rlRefs: [],
    pblPosted: 1,
    sisa: 5,
    ...partial,
  };
}

function ref(lines: PlanReferenceLine[]): PlanReference {
  return {
    productionPlanId: 'p1',
    tenantId: 't1',
    mrpSource: 'MRP_DOC',
    lines,
    summary: { lineCount: lines.length, poLineCount: 0, mrpLineCount: 0, acuanTotal: 0, rlPostedTotal: 0, sisaTotal: 0 },
  };
}

describe('normalizeRlOverIssueTolerancePct', () => {
  it('default 0, menerima koma desimal, menolak di luar 0..100', () => {
    expect(normalizeRlOverIssueTolerancePct(undefined)).toBe(0);
    expect(normalizeRlOverIssueTolerancePct('')).toBe(0);
    expect(normalizeRlOverIssueTolerancePct('2,5')).toBe(2.5);
    expect(normalizeRlOverIssueTolerancePct(10.123)).toBe(10.12);
    expect(normalizeRlOverIssueTolerancePct(-1)).toBeNull();
    expect(normalizeRlOverIssueTolerancePct(101)).toBeNull();
    expect(normalizeRlOverIssueTolerancePct('abc')).toBeNull();
  });
});

describe('evaluateRlOverIssue', () => {
  it('RL + PBL bermutasi + qty ini dibanding acuan × (1 + toleransi)', () => {
    const r = ref([line({})]);
    expect(evaluateRlOverIssue(r, [{ stokId: 'gula', qtyBase: 5 }], 0).overCount).toBe(0);
    const over = evaluateRlOverIssue(r, [{ stokId: 'gula', qtyBase: 5.5 }], 0);
    expect(over.lines[0]).toMatchObject({ consumedBefore: 5, qtyAfter: 10.5, limitQty: 10, overQty: 0.5, missingReason: true });
    expect(evaluateRlOverIssue(r, [{ stokId: 'gula', qtyBase: 5.5 }], 10).overCount).toBe(0);
    expect(evaluateRlOverIssue(r, [{ stokId: 'gula', qtyBase: 6.01 }], 10).overCount).toBe(1);
  });

  it('debu float tidak dianggap melebihi', () => {
    const r = ref([line({ acuanQty: 0.3, rlPosted: 0.1, pblPosted: 0 })]);
    expect(evaluateRlOverIssue(r, [{ stokId: 'gula', qtyBase: 0.2 }], 0).overCount).toBe(0);
  });

  it('baris salinan katalog dan baris ganda digabung satu produk; semua baris wajib alasan', () => {
    const r = ref([line({ productIds: ['gula', 'gula-b'], aliasProductIds: ['gula-lama'] })]);
    const res = evaluateRlOverIssue(r, [
      { stokId: 'gula', qtyBase: 3, overReason: 'tamu' },
      { stokId: 'gula-b', qtyBase: 2 },
      { stokId: 'gula-lama', qtyBase: 1, overReason: 'tamu' },
    ], 0);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatchObject({ lineIndexes: [0, 1, 2], qtyRelease: 6, qtyAfter: 11, reasons: ['tamu'], missingReason: true });
    expect(res.missingReasonCount).toBe(1);
  });

  it('produk di luar acuan rencana diperlakukan acuan 0', () => {
    const res = evaluateRlOverIssue(ref([line({})]), [{ stokId: 'sabun', kode: 'SB01', nama: 'Sabun', qtyBase: 1 }], 0);
    expect(res.lines[0]).toMatchObject({ sumber: 'DI_LUAR_ACUAN', productNama: 'Sabun', acuanQty: 0, qtyAfter: 1 });
    expect(rlOverIssueMissingReasonMessage(res)).toMatch(/Sabun: 1 di luar acuan rencana/);
  });

  it('salinan katalog cocok lewat aliasProductIds', () => {
    const res = evaluateRlOverIssue(
      ref([line({ aliasProductIds: ['gula-master'] })]),
      [{ stokId: 'gula-master', kode: 'GL01', qtyBase: 6, overReason: 'x' }],
      0,
    );
    expect(res.lines[0]).toMatchObject({ productId: 'gula', sumber: 'PO', qtyAfter: 11, missingReason: false });
    expect(rlOverIssueMissingReasonMessage(res)).toBeNull();
  });

  it('kode sama tanpa tautan id (satuan dasar bisa beda) tidak dicocokkan ke baris acuan', () => {
    const res = evaluateRlOverIssue(ref([line({})]), [{ stokId: 'gula-gram', kode: 'GL01', qtyBase: 1 }], 0);
    expect(res.lines[0]).toMatchObject({ productId: 'gula-gram', sumber: 'DI_LUAR_ACUAN', acuanQty: 0 });
  });

  it('alasan dirapikan dan dibatasi 300 karakter', () => {
    expect(sanitizeOverReason('  porsi\n  tambahan  ')).toBe('porsi tambahan');
    expect(sanitizeOverReason('a'.repeat(400))).toHaveLength(300);
  });
});

describe('PUT /tenant/settings — toleransi & feature flag hanya MASTER', () => {
  async function put(auth: Record<string, unknown>, body: Record<string, unknown>) {
    const { handleTenants } = await import('@/lib/api/handlers/tenants');
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const db = {
      collection: () => ({ updateOne, findOne: vi.fn().mockResolvedValue({ tenantId: 't1' }) }),
    };
    const res = await handleTenants({
      db,
      route: '/tenant/settings',
      method: 'PUT',
      path: ['tenant', 'settings'],
      body,
      url: new URL('http://local/api/tenant/settings'),
      auth,
      request: new Request('http://local/api/tenant/settings', { method: 'PUT' }),
    } as never);
    return { status: res!.status, set: updateOne.mock.calls[0]?.[1]?.$set as Record<string, unknown> | undefined };
  }

  it('ADMIN tenant: features dan toleransi dibuang', async () => {
    const res = await put(
      { tenantId: 't1', role: 'ADMIN', userId: 'a', isMaster: false },
      { companyName: 'X', features: { rlFromPoReference: false }, rlOverIssueTolerancePct: 50 },
    );
    expect(res.status).toBe(200);
    expect(res.set).toMatchObject({ companyName: 'X' });
    expect(res.set).not.toHaveProperty('features');
    expect(res.set).not.toHaveProperty('rlOverIssueTolerancePct');
  });

  it('MASTER: toleransi divalidasi', async () => {
    const master = { tenantId: 'master', role: 'MASTER', userId: 'm', isMaster: true };
    expect((await put(master, { tenantId: 't1', rlOverIssueTolerancePct: 150 })).status).toBe(400);
    const okRes = await put(master, { tenantId: 't1', rlOverIssueTolerancePct: '2,5' });
    expect(okRes.status).toBe(200);
    expect(okRes.set?.rlOverIssueTolerancePct).toBe(2.5);
  });
});
