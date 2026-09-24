import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateOne = vi.fn();
const writeAuditLog = vi.fn();

vi.mock('@/lib/api/transaction', () => ({
  runInTransactionOrFallback: async (fn: (ctx: { db: unknown; session: unknown }) => Promise<unknown>) =>
    fn({ db: { collection: () => ({ updateOne }) }, session: 'S' }),
  txOpts: (session: unknown) => (session ? { session } : {}),
}));
vi.mock('@/lib/api/audit-log', () => ({ writeAuditLog: (...a: unknown[]) => writeAuditLog(...a) }));

const { casEditFilter, casStatusFilter, casUpdateWithAudit, CAS_CONFLICT_MESSAGE } = await import('@/lib/api/cas');

describe('cas filters', () => {
  it('casStatusFilter memakai status dokumen saat ini sebagai default', () => {
    expect(casStatusFilter({ id: 'a', status: 'DRAFT' })).toEqual({ id: 'a', status: 'DRAFT' });
    expect(casStatusFilter({ id: 'a', status: 'DRAFT' }, ['DRAFT', 'PLANNED'])).toEqual({ id: 'a', status: { $in: ['DRAFT', 'PLANNED'] } });
    expect(casStatusFilter({ id: 'a' }, 'X', { tenantId: 't' })).toEqual({ tenantId: 't', id: 'a', status: 'X' });
  });

  it('casEditFilter mengunci status + updatedAt (null cocok dengan field hilang)', () => {
    const at = new Date('2026-09-24T00:00:00Z');
    expect(casEditFilter({ id: 'a', status: 'DRAFT', updatedAt: at })).toEqual({ id: 'a', status: 'DRAFT', updatedAt: at });
    expect(casEditFilter({ id: 'a', status: 'DRAFT' })).toEqual({ id: 'a', status: 'DRAFT', updatedAt: null });
  });
});

describe('casUpdateWithAudit', () => {
  beforeEach(() => {
    updateOne.mockReset();
    writeAuditLog.mockReset();
  });

  it('matched → audit ditulis di sesi yang sama, return null', async () => {
    updateOne.mockResolvedValue({ matchedCount: 1 });
    const res = await casUpdateWithAudit({
      collection: 'x', filter: { id: 'a' }, update: { $set: { status: 'B' } },
      audit: { tenantId: 't', entityType: 'X', entityId: 'a', action: 'UPDATE' } as never,
    });
    expect(res).toBeNull();
    expect(updateOne).toHaveBeenCalledWith({ id: 'a' }, { $set: { status: 'B' } }, { session: 'S' });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entityId: 'a' }), 'S');
  });

  it('tidak matched → 409 dan audit tidak ditulis', async () => {
    updateOne.mockResolvedValue({ matchedCount: 0 });
    const res = await casUpdateWithAudit({ collection: 'x', filter: { id: 'a' }, update: { $set: {} }, audit: {} as never });
    expect(res?.status).toBe(409);
    expect(await res?.json()).toMatchObject({ error: CAS_CONFLICT_MESSAGE });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
