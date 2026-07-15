/**
 * Shared mock for execution_outbox (EE-14 Phase 3).
 * Claim/enqueue/complete paths now write durable outbox entries.
 */

import { vi } from 'vitest';
import { EXECUTION_OUTBOX_COLLECTION } from '@/lib/execution/queue/constants';

export type MockOutboxDoc = Record<string, unknown>;

/** Minimal collection stub — enough for insert + publish success/fail paths. */
export function createMockExecutionOutboxCollection(docs: MockOutboxDoc[] = []) {
  return {
    createIndex: vi.fn().mockResolvedValue(undefined),
    insertOne: vi.fn(async (doc: MockOutboxDoc) => {
      docs.push({ ...doc });
      return { acknowledged: true };
    }),
    updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const idx = docs.findIndex((d) => d.id === filter.id);
      if (idx === -1) return { matchedCount: 0 };
      const next = { ...docs[idx] };
      if (update.$set) Object.assign(next, update.$set as Record<string, unknown>);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc as Record<string, number>)) {
          next[k] = Number(next[k] ?? 0) + Number(v);
        }
      }
      docs[idx] = next;
      return { matchedCount: 1 };
    }),
    find: vi.fn((filter: Record<string, unknown>) => ({
      sort: () => ({
        limit: (n: number) => ({
          toArray: async () =>
            docs
              .filter((d) => (filter.status == null ? true : d.status === filter.status))
              .slice(0, n),
        }),
      }),
    })),
  };
}

export function isExecutionOutboxCollection(name: string): boolean {
  return name === EXECUTION_OUTBOX_COLLECTION || name === 'execution_outbox';
}

export { EXECUTION_OUTBOX_COLLECTION };
