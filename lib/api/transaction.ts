// MongoDB multi-document transactions for critical stock & financial writes.

import type { ClientSession, Db } from 'mongodb';
import { getMongoClient, connectToMongo } from '@/lib/api/db';

export interface TxContext {
  db: Db;
  session: ClientSession;
}

/** Pass to collection write methods when inside a transaction. */
export function txOpts(session?: ClientSession): { session: ClientSession } | Record<string, never> {
  return session ? { session } : {};
}

/**
 * Run `fn` inside a MongoDB transaction. Rolls back on throw.
 * Requires a replica set (local dev: `mongod --replSet rs0`).
 */
export async function runInTransaction<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
  const client = await getMongoClient();
  const session = client.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      const db = await connectToMongo();
      result = await fn({ db, session });
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Run in transaction when supported; otherwise run `fn` without session.
 * Standalone MongoDB (no replica set) falls back gracefully for local dev.
 */
export async function runInTransactionOrFallback<T>(
  fn: (ctx: { db: Db; session?: ClientSession }) => Promise<T>,
): Promise<T> {
  try {
    return await runInTransaction(({ db, session }) => fn({ db, session }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes('Transaction numbers are only allowed on a replica set')
      || msg.includes('replica set')
      || msg.includes('not support transactions')
    ) {
      const db = await connectToMongo();
      return fn({ db });
    }
    throw e;
  }
}
