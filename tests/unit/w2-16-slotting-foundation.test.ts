import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  isValidBinKode,
  normalizeBinKode,
  resolveDefaultBinKode,
} from '@/lib/api/warehouse-bins';

describe('W2-16 bin kode helpers', () => {
  it('normalizes and validates bin kode', () => {
    expect(normalizeBinKode('  rcv-01 ')).toBe('RCV-01');
    expect(normalizeBinKode('A@01#')).toBe('A01');
    expect(isValidBinKode('RCV')).toBe(true);
    expect(isValidBinKode('')).toBe(false);
    expect(isValidBinKode('!!!')).toBe(false);
  });
});

describe('W2-16 resolveDefaultBinKode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns aktif default bin for warehouse', async () => {
    const findOne = vi.fn(async () => ({ kode: 'RCV' }));
    const db = { collection: () => ({ findOne }) };
    await expect(resolveDefaultBinKode(db as never, 't1', 'GKERING')).resolves.toBe('RCV');
    expect(findOne).toHaveBeenCalledWith(
      { tenantId: 't1', warehouseKode: 'GKERING', aktif: true, isDefault: true },
      { projection: { kode: 1 } },
    );
  });

  it('returns null when no default bin', async () => {
    const findOne = vi.fn(async () => null);
    const db = { collection: () => ({ findOne }) };
    await expect(resolveDefaultBinKode(db as never, 't1', 'GBASAH')).resolves.toBeNull();
  });

  it('returns null for invalid warehouse', async () => {
    const findOne = vi.fn();
    const db = { collection: () => ({ findOne }) };
    await expect(resolveDefaultBinKode(db as never, 't1', 'UNKNOWN')).resolves.toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });
});
