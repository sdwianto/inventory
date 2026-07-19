/**
 * WEBHOOK_INBOX enqueue → claim → complete (inventory repo, EE-9C scaffold).
 */

import type { Db } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueue } from '@/lib/execution/queue/enqueue';
import { processOneTick } from '@/lib/execution/runtime/worker-runner';
import { ShutdownController } from '@/lib/execution/runtime/worker-shutdown';
import { clearHandlersForTests } from '@/lib/execution/workers/registry';
import { registerInventoryHandlers } from '@/lib/execution/workers/register-inventory';
import {
  BG_JOBS_COLLECTION,
  EXECUTION_AUDIT_COLLECTION,
} from '@/lib/execution/queue/constants';
import {
  createMockExecutionOutboxCollection,
  isExecutionOutboxCollection,
} from '../../helpers/mock-execution-outbox-collection';
import { priorityOrder, classificationOrder } from '@/lib/execution/queue/sort-keys';
import { setExecutionEventBus } from '@sdwianto/events';
import { setJobBusAdapter } from '@/lib/execution/dispatcher/bus-adapter';
import { resetExecutionPlatformWiringForTests } from '@/lib/execution/runtime/platform-bootstrap';
import {
  resetConcurrencyForTests,
  setConcurrencyForTests,
} from '@/lib/execution/runtime/concurrency';
import { resetLocksForTests } from '@/lib/execution/locks/lock-manager';

const processWebhookInboxEvent = vi.fn().mockResolvedValue({ ok: true });

vi.mock('@/lib/api/webhook-inbox-process', () => ({
  processWebhookInboxEvent: (...args: unknown[]) => processWebhookInboxEvent(...args),
}));

type JobDoc = Record<string, unknown>;

function withSortKeys(doc: JobDoc): JobDoc {
  const priority = String(doc.priority ?? 'NORMAL');
  const classification = String(doc.classification ?? 'IO_INTENSIVE');
  return {
    ...doc,
    priorityOrder: priorityOrder(priority as never),
    classificationOrder: classificationOrder(classification as never),
  };
}

function matchesClaimCandidate(doc: JobDoc, filter: Record<string, unknown>): boolean {
  if (filter.status && doc.status !== filter.status) return false;
  if (filter.domain && doc.domain !== filter.domain) return false;
  const schemaFilter = filter.jobSchemaVersion as { $lte?: number } | undefined;
  if (schemaFilter?.$lte != null) {
    const version = Number(doc.jobSchemaVersion ?? 1);
    if (version > schemaFilter.$lte) return false;
  }
  if (filter.$or) {
    const clauses = filter.$or as Array<Record<string, unknown>>;
    const matched = clauses.some((clause) => {
      if ('nextRunAt' in clause && clause.nextRunAt === null) return doc.nextRunAt == null;
      if (clause.nextRunAt && typeof clause.nextRunAt === 'object') {
        const lte = (clause.nextRunAt as { $lte?: string }).$lte;
        if (lte && doc.nextRunAt != null) return String(doc.nextRunAt) <= lte;
      }
      return false;
    });
    if (!matched) return false;
  }
  return true;
}

function matchesUpdateFilter(doc: JobDoc, filter: Record<string, unknown>): boolean {
  if (filter.id && doc.id !== filter.id) return false;
  const statusFilter = filter.status as { $in?: string[] } | string | undefined;
  if (typeof statusFilter === 'string' && doc.status !== statusFilter) return false;
  if (typeof statusFilter === 'object' && statusFilter?.$in) {
    if (!statusFilter.$in.includes(String(doc.status))) return false;
  }
  if (filter.version != null && doc.version !== filter.version) return false;
  return true;
}

function sortDocs(docs: JobDoc[], sort: Record<string, 1 | -1>): JobDoc[] {
  return [...docs].sort((a, b) => {
    for (const [key, direction] of Object.entries(sort)) {
      const av = a[key];
      const bv = b[key];
      if (av === bv) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return direction === 1 ? -1 : 1;
      if (av > bv) return direction === 1 ? 1 : -1;
    }
    return 0;
  });
}

function createIntegrationMockDb() {
  const docs: JobDoc[] = [];

  const collection = {
    createIndex: vi.fn().mockResolvedValue(undefined),
    find: vi.fn(() => ({
      sort: () => ({
        limit: () => ({
          toArray: async () => [],
        }),
      }),
    })),
    findOne: vi.fn(async (
      filter: Record<string, unknown>,
      options?: { sort?: Record<string, 1 | -1> },
    ) => {
      if (filter.id) return docs.find((doc) => doc.id === filter.id) ?? null;
      let matched = docs.filter((doc) => matchesClaimCandidate(doc, filter));
      if (options?.sort) matched = sortDocs(matched, options.sort);
      return matched[0] ?? null;
    }),
    insertOne: vi.fn(async (doc: JobDoc) => {
      docs.push(withSortKeys(doc));
    }),
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    findOneAndUpdate: vi.fn(async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: { returnDocument?: 'before' | 'after' },
    ) => {
      const idx = docs.findIndex((doc) => matchesUpdateFilter(doc, filter));
      if (idx === -1) return null;
      const current = { ...docs[idx] };
      const $set = (update.$set ?? {}) as Record<string, unknown>;
      const next = { ...current, ...$set };
      if (update.$inc) {
        const inc = update.$inc as Record<string, number>;
        for (const [key, delta] of Object.entries(inc)) {
          next[key] = Number(next[key] ?? 0) + delta;
        }
      }
      if ($set.status === 'DLQ') next.deadLetter = true;
      if (($set.status === 'SUCCEEDED' || $set.status === 'DLQ') && !next.finishedAt) {
        next.finishedAt = new Date().toISOString();
      }
      docs[idx] = next;
      return options?.returnDocument === 'after' ? next : current;
    }),
  };

  const db = {
    collection: vi.fn((name: string) => {
      if (name === BG_JOBS_COLLECTION || name === 'webhook_inbox') return collection;
      if (name === EXECUTION_AUDIT_COLLECTION) {
        return {
          createIndex: vi.fn().mockResolvedValue(undefined),
          insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
        };
      }
      if (isExecutionOutboxCollection(name)) {
        return createMockExecutionOutboxCollection();
      }
      throw new Error(`unexpected collection ${name}`);
    }),
    docs,
  } as unknown as Db & { docs: JobDoc[] };

  return { db };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.JOB_BUS_ENABLED = '0';
  clearHandlersForTests();
  resetExecutionPlatformWiringForTests();
  setJobBusAdapter({ publish: vi.fn().mockResolvedValue(undefined) });
  setExecutionEventBus(null);
  resetConcurrencyForTests();
  setConcurrencyForTests({ acquireTenantSlot: async () => true });
  processWebhookInboxEvent.mockClear();
  registerInventoryHandlers();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetExecutionPlatformWiringForTests();
  setJobBusAdapter(null);
  setExecutionEventBus(null);
  resetConcurrencyForTests();
  resetLocksForTests();
  vi.clearAllMocks();
});

describe('WEBHOOK_INBOX integration (inventory)', () => {
  it('enqueue → claim → complete via register-inventory', async () => {
    const { db } = createIntegrationMockDb();

    const { jobId } = await enqueue(db, {
      type: 'WEBHOOK_INBOX',
      domain: 'inventory',
      priority: 'HIGH',
      classification: 'REALTIME',
      tenantId: 'tenant-1',
      payload: {
        dedupeKey: 'wh:1',
        event: 'delivery_order.shipped',
        payload: { deliveryOrderId: 'DO-1' },
        customerTenantId: 'tenant-1',
      },
    });

    expect(jobId).toBeTruthy();

    const shutdown = new ShutdownController();
    const ran = await processOneTick({
      domain: 'inventory',
      workerId: 'inventory-worker-1',
      capabilities: ['WEBHOOK', 'CPU_BATCH', 'SYNC'],
      db,
      shutdown,
    });

    expect(ran).toBe(true);
    expect(db.docs[0].status).toBe('SUCCEEDED');
    expect(processWebhookInboxEvent).toHaveBeenCalled();
  });
});
