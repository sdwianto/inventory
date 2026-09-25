import { describe, it, expect } from 'vitest';
import {
  addShelfDays,
  businessDateIso,
  isIngredientExpired,
  normalizeShelfLifeDays,
  parseIsoDateOnly,
  resolveLotExpiry,
} from '@/lib/food-production/ingredient-lot';

const base = { receivedAt: '2026-09-25', label: 'Telur' };

describe('businessDateIso (WIB)', () => {
  it('rolls over at 00:00 WIB, not 00:00 UTC', () => {
    expect(businessDateIso(new Date('2026-09-25T16:59:59Z'))).toBe('2026-09-25');
    expect(businessDateIso(new Date('2026-09-25T17:00:00Z'))).toBe('2026-09-26');
  });

  it('expiry checks use the WIB day', () => {
    // 06:00 WIB tgl 26 = 23:00 UTC tgl 25: lot kedaluwarsa tgl 25 sudah lewat.
    expect(isIngredientExpired('2026-09-25', new Date('2026-09-25T23:00:00Z'))).toBe(true);
    expect(isIngredientExpired('2026-09-26', new Date('2026-09-25T23:00:00Z'))).toBe(false);
    expect(addShelfDays(new Date('2026-09-25T23:00:00Z'), 1)).toBe('2026-09-27');
  });
});

describe('parseIsoDateOnly', () => {
  it('accepts real calendar dates only', () => {
    expect(parseIsoDateOnly('2026-10-01')).toBe('2026-10-01');
    expect(parseIsoDateOnly('2026-10-01T08:00:00.000Z')).toBe('2026-10-01');
    expect(parseIsoDateOnly('2026-10-01T00:00:00+07:00')).toBe('2026-10-01');
    expect(parseIsoDateOnly(new Date('2026-10-01T08:00:00.000Z'))).toBe('2026-10-01');
    expect(parseIsoDateOnly('2026-10-01xyz')).toBeNull();
    expect(parseIsoDateOnly('2026-10-01 sampah')).toBeNull();
    expect(parseIsoDateOnly('2026-02-30')).toBeNull();
    expect(parseIsoDateOnly('01/10/2026')).toBeNull();
    expect(parseIsoDateOnly('')).toBeNull();
    expect(parseIsoDateOnly(null)).toBeNull();
  });
});

describe('normalizeShelfLifeDays', () => {
  it('empty → null, integer 1–3650 ok, else error', () => {
    expect(normalizeShelfLifeDays(undefined)).toBeNull();
    expect(normalizeShelfLifeDays('')).toBeNull();
    expect(normalizeShelfLifeDays(null)).toBeNull();
    expect(normalizeShelfLifeDays(7)).toBe(7);
    expect(normalizeShelfLifeDays('30')).toBe(30);
    expect(normalizeShelfLifeDays(0)).toHaveProperty('error');
    expect(normalizeShelfLifeDays(1.5)).toHaveProperty('error');
    expect(normalizeShelfLifeDays(3651)).toHaveProperty('error');
    expect(normalizeShelfLifeDays('abc')).toHaveProperty('error');
  });
});

describe('resolveLotExpiry', () => {
  it('input wins over master shelf life', () => {
    expect(resolveLotExpiry({ ...base, inputExpiry: '2026-10-05', shelfLifeDays: 3, required: true }))
      .toEqual({ expiryDate: '2026-10-05', expirySource: 'INPUT' });
  });

  it('master shelf life when input empty', () => {
    expect(resolveLotExpiry({ ...base, shelfLifeDays: 7, required: true }))
      .toEqual({ expiryDate: '2026-10-02', expirySource: 'MASTER_SHELF' });
  });

  it('required: missing input and shelf → error', () => {
    const r = resolveLotExpiry({ ...base, required: true });
    expect('error' in r && r.error).toMatch(/wajib untuk Telur/);
  });

  it('required: invalid, expired, or > 10 years input → error', () => {
    expect(resolveLotExpiry({ ...base, inputExpiry: '2026-13-01', shelfLifeDays: 7, required: true })).toHaveProperty('error');
    const expired = resolveLotExpiry({ ...base, inputExpiry: '2026-09-24', required: true });
    expect('error' in expired && expired.error).toMatch(/sudah kedaluwarsa/);
    expect(resolveLotExpiry({ ...base, inputExpiry: '2037-01-01', required: true })).toHaveProperty('error');
  });

  it('required: expiry on received day is accepted', () => {
    expect(resolveLotExpiry({ ...base, inputExpiry: '2026-09-25', required: true }))
      .toEqual({ expiryDate: '2026-09-25', expirySource: 'INPUT' });
  });

  it('not required: legacy +30 marked DEFAULT', () => {
    expect(resolveLotExpiry({ ...base, required: false }))
      .toEqual({ expiryDate: '2026-10-25', expirySource: 'DEFAULT' });
    expect(resolveLotExpiry({ ...base, shelfLifeDays: 4, required: false }))
      .toEqual({ expiryDate: '2026-09-29', expirySource: 'MASTER_SHELF' });
  });

  it('not required: filled input is still validated (no silent fallback to default)', () => {
    expect(resolveLotExpiry({ ...base, inputExpiry: 'rusak', required: false })).toHaveProperty('error');
    expect(resolveLotExpiry({ ...base, inputExpiry: '2026-09-01', required: false })).toHaveProperty('error');
    expect(resolveLotExpiry({ ...base, inputExpiry: '2026-11-01', required: false }))
      .toEqual({ expiryDate: '2026-11-01', expirySource: 'INPUT' });
  });

  it('invalid master shelf life is ignored', () => {
    const r = resolveLotExpiry({ ...base, shelfLifeDays: -5, required: true });
    expect(r).toHaveProperty('error');
  });
});
