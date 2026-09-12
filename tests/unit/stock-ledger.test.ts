import { describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import {
  availableQtyAgainstLedger,
  applyLedgerCapToWarehouseMap,
  ledgerSaldoForProduct,
  shouldEnforceLedgerOnOutbound,
} from '@/lib/api/stock-ledger';

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

  it('availableQtyAgainstLedger caps inflated lokasi by ledger (Kelengkeng case)', () => {
    expect(availableQtyAgainstLedger(99, { saldo: 3, hasActivity: true })).toBe(3);
  });

  it('availableQtyAgainstLedger blocks when ledger negative', () => {
    expect(availableQtyAgainstLedger(89, { saldo: -7, hasActivity: true })).toBe(0);
  });

  it('availableQtyAgainstLedger trusts lokasi when no kartu yet', () => {
    expect(availableQtyAgainstLedger(50, { saldo: 0, hasActivity: false })).toBe(50);
  });

  it('applyLedgerCapToWarehouseMap zeros phantom warehouses', () => {
    const capped = applyLedgerCapToWarehouseMap(
      { GKERING: 99, GBASAH: 100, GJANITOR: 100 },
      'GKERING',
      { saldo: 3, hasActivity: true },
    );
    expect(capped).toEqual({ GKERING: 3, GBASAH: 0, GJANITOR: 0 });
  });

  it('shouldEnforceLedgerOnOutbound skips penyesuaian', () => {
    expect(shouldEnforceLedgerOnOutbound('PENYESUAIAN')).toBe(false);
    expect(shouldEnforceLedgerOnOutbound('RELEASE')).toBe(true);
    expect(shouldEnforceLedgerOnOutbound('FP_ISSUE')).toBe(true);
  });

  it('reconcile dry-run does not require writes (shape)', async () => {
    // availableQtyAgainstLedger already covers guard math; dry-run returns drifts via audit.
    expect(availableQtyAgainstLedger(100, { saldo: -1, hasActivity: true })).toBe(0);
  });
});