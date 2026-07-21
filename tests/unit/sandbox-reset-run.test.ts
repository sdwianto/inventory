import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeSandboxResetJob = vi.fn();

vi.mock('@/lib/api/inventory-execution-handlers', () => ({
  executeSandboxResetJob: (...args: unknown[]) => executeSandboxResetJob(...args),
}));

describe('runSandboxResetJobById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims PENDING job and marks DONE', async () => {
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    const findOneAndUpdate = vi.fn().mockResolvedValue({
      id: 'job-1',
      status: 'RUNNING',
      payload: { tenantId: 't1', includeSales: true },
    });
    const findOne = vi.fn();
    const db = {
      collection: () => ({ findOneAndUpdate, updateOne, findOne }),
    } as never;

    executeSandboxResetJob.mockResolvedValue({ ok: true });

    const { runSandboxResetJobById } = await import('@/lib/api/sandbox-reset-run');
    const result = await runSandboxResetJobById(db, 'job-1');

    expect(result).toEqual({ ok: true });
    expect(executeSandboxResetJob).toHaveBeenCalledWith(
      db,
      { tenantId: 't1', includeSales: true },
      'job-1',
    );
    expect(updateOne).toHaveBeenCalledWith(
      { id: 'job-1' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'DONE' }),
      }),
    );
  });

  it('skips when job already claimed', async () => {
    const findOneAndUpdate = vi.fn().mockResolvedValue(null);
    const findOne = vi.fn().mockResolvedValue({ id: 'job-1', status: 'RUNNING' });
    const db = {
      collection: () => ({ findOneAndUpdate, findOne, updateOne: vi.fn() }),
    } as never;

    const { runSandboxResetJobById } = await import('@/lib/api/sandbox-reset-run');
    const result = await runSandboxResetJobById(db, 'job-1');

    expect(result).toEqual({ skipped: true, reason: 'status=RUNNING' });
    expect(executeSandboxResetJob).not.toHaveBeenCalled();
  });
});
