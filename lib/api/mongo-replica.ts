/** Verifikasi MongoDB replica set — wajib di production untuk transaksi atomik. */

import type { Db } from 'mongodb';

export function requiresMongoTransactions(): boolean {
  return process.env.NODE_ENV === 'production'
    || process.env.REQUIRE_MONGO_TRANSACTIONS === '1';
}

export function isNoTransactionSupportError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes('Transaction numbers are only allowed on a replica set')
    || msg.includes('replica set')
    || msg.includes('not support transactions')
  );
}

export class MongoTransactionsRequiredError extends Error {
  constructor() {
    super(
      'MongoDB replica set wajib di production untuk transaksi atomik stok/finansial. '
      + 'Deploy ke Atlas replica set (bukan standalone).',
    );
    this.name = 'MongoTransactionsRequiredError';
  }
}

export type ReplicaSetCheck = {
  status: 'ok' | 'fail' | 'skipped';
  setName?: string;
  error?: string;
};

export async function checkMongoReplicaSet(db: Db): Promise<ReplicaSetCheck> {
  if (!requiresMongoTransactions()) return { status: 'skipped' };
  try {
    const hello = await db.admin().command({ hello: 1 }) as { setName?: string };
    const setName = hello.setName ? String(hello.setName) : '';
    if (setName) return { status: 'ok', setName };
    return { status: 'fail', error: 'MongoDB bukan replica set (setName kosong)' };
  } catch (e) {
    return {
      status: 'fail',
      error: e instanceof Error ? e.message : 'hello command failed',
    };
  }
}
