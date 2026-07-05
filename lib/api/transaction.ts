// MongoDB multi-document transactions for critical stock & financial writes.

import type { ClientSession, Db } from 'mongodb';
import { getMongoClient, connectToMongo } from '@/lib/api/db';
import {
  isNoTransactionSupportError,
  MongoTransactionsRequiredError,
  requiresMongoTransactions,
} from '@/lib/api/mongo-replica';

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

let warnedNoTx = false;

/**
 * Run in transaction when supported.
 * Production / REQUIRE_MONGO_TRANSACTIONS=1: fail hard if not replica set (no fallback).
 */
export async function runInTransactionOrFallback<T>(
  fn: (ctx: { db: Db; session?: ClientSession }) => Promise<T>,
): Promise<T> {
  try {
    return await runInTransaction(({ db, session }) => fn({ db, session }));
  } catch (e) {
    if (isNoTransactionSupportError(e)) {
      if (requiresMongoTransactions()) {
        throw new MongoTransactionsRequiredError();
      }
      if (!warnedNoTx) {
        warnedNoTx = true;
        console.warn(
          '[transaction] MongoDB does not support transactions (standalone?). '
          + 'Non-atomic fallback — local dev only. Use: mongod --replSet rs0',
        );
      }
      const db = await connectToMongo();
      return fn({ db });
    }
    throw e;
  }
}
