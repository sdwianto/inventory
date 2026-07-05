import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  requiresMongoTransactions,
  isNoTransactionSupportError,
  checkMongoReplicaSet,
  MongoTransactionsRequiredError,
} from '@/lib/api/mongo-replica';

describe('requiresMongoTransactions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is true in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('REQUIRE_MONGO_TRANSACTIONS', '');
    expect(requiresMongoTransactions()).toBe(true);
  });

  it('is true when REQUIRE_MONGO_TRANSACTIONS=1', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REQUIRE_MONGO_TRANSACTIONS', '1');
    expect(requiresMongoTransactions()).toBe(true);
  });

  it('is false in dev/test without opt-in', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REQUIRE_MONGO_TRANSACTIONS', '');
    expect(requiresMongoTransactions()).toBe(false);
  });
});

describe('isNoTransactionSupportError', () => {
  it('detects replica set errors', () => {
    expect(isNoTransactionSupportError(new Error('Transaction numbers are only allowed on a replica set'))).toBe(true);
    expect(isNoTransactionSupportError(new Error('not support transactions'))).toBe(true);
    expect(isNoTransactionSupportError(new Error('other'))).toBe(false);
  });
});

describe('checkMongoReplicaSet', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const admin = vi.fn();
    const db = { admin } as { admin: () => { command: ReturnType<typeof vi.fn> } };
    const result = await checkMongoReplicaSet(db as never);
    expect(result.status).toBe('skipped');
    expect(admin).not.toHaveBeenCalled();
  });

  it('returns ok when setName present', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const db = {
      admin: () => ({
        command: vi.fn().mockResolvedValue({ setName: 'rs0' }),
      }),
    };
    const result = await checkMongoReplicaSet(db as never);
    expect(result).toEqual({ status: 'ok', setName: 'rs0' });
  });

  it('returns fail when setName empty', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const db = {
      admin: () => ({
        command: vi.fn().mockResolvedValue({ setName: '' }),
      }),
    };
    const result = await checkMongoReplicaSet(db as never);
    expect(result.status).toBe('fail');
  });
});

describe('MongoTransactionsRequiredError', () => {
  it('has descriptive message', () => {
    const err = new MongoTransactionsRequiredError();
    expect(err.name).toBe('MongoTransactionsRequiredError');
    expect(err.message).toMatch(/replica set/i);
  });
});
