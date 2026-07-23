import { describe, it, expect, vi } from 'vitest';
import {
  recoverOrphanDispatchedJobs,
  STALE_DISPATCHED_MS,
} from '@/lib/api/process-execution-jobs';

describe('recoverOrphanDispatchedJobs', () => {
  it('requeues DISPATCHED rows older than maxAgeMs', async () => {
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 2 });
    const db = {
      collection: vi.fn().mockReturnValue({ updateMany }),
    };

    const n = await recoverOrphanDispatchedJobs(db as never, { maxAgeMs: STALE_DISPATCHED_MS });
    expect(n).toBe(2);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = updateMany.mock.calls[0];
    expect(filter.status).toBe('DISPATCHED');
    expect(update.$set.status).toBe('PENDING');
    expect(update.$set.lastError).toMatch(/stale DISPATCHED/i);
  });
});
