import { describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { ledgerSaldoForProduct } from '@/lib/api/stock-ledger';

function mockDb(rows: Array<{ masuk?: number; keluar?: number }>): Db {
  return {
    collection: () => ({
      find: () => ({
        project: () => ({
          toArray: async () => rows,
        }),
      }),
    }),
  } as unknown as Db;
}

describe('stock-ledger', () => {
  it('ledgerSaldoForProduct sums masuk minus keluar', async () => {
    const db = mockDb([
      { masuk: 10, keluar: 0 },
      { masuk: 5, keluar: 3 },
      { masuk: 0, keluar: 2 },
    ]);
    const saldo = await ledgerSaldoForProduct(db, 'default', 'prod-1');
    expect(saldo).toBe(10);
  });

  it('ledgerSaldoForProduct returns 0 for empty ledger', async () => {
    const db = mockDb([]);
    const saldo = await ledgerSaldoForProduct(db, 'default', 'prod-1');
    expect(saldo).toBe(0);
  });
});
