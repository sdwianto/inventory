import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT_TAX,
  isPpnDikreditkan,
  isValidNpwp,
  normalizeTenantTax,
  validateTenantTaxInput,
} from '@/lib/api/tenant-tax';

const NPWP16 = '0012345678901000';

describe('tenant tax (pembeli)', () => {
  it('default non-PKP', () => {
    expect(normalizeTenantTax(undefined)).toEqual(DEFAULT_TENANT_TAX);
    expect(normalizeTenantTax({ pkp: 'ya' })).toEqual({ pkp: false, pkpSejak: null });
  });

  it('NPWP 15/16 digit valid, format bertitik diterima', () => {
    expect(isValidNpwp('01.234.567.8-901.000')).toBe(true);
    expect(isValidNpwp(NPWP16)).toBe(true);
    expect(isValidNpwp('1234')).toBe(false);
  });

  it('PKP wajib NPWP', () => {
    const r = validateTenantTaxInput({ pkp: true }, DEFAULT_TENANT_TAX, '');
    expect(r.ok).toBe(false);
  });

  it('pkpSejak tanggal form = awal hari WIB', () => {
    const r = validateTenantTaxInput({ pkp: true, pkpSejak: '2026-10-01' }, DEFAULT_TENANT_TAX, NPWP16);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tax.pkpSejak?.toISOString()).toBe('2026-09-30T17:00:00.000Z');
  });

  it('tanggal tidak valid ditolak; non-PKP mengosongkan pkpSejak', () => {
    expect(validateTenantTaxInput({ pkp: true, pkpSejak: 'besok' }, DEFAULT_TENANT_TAX, NPWP16).ok).toBe(false);
    const prev = { pkp: true, pkpSejak: new Date('2026-01-01T00:00:00+07:00') };
    const r = validateTenantTaxInput({ pkp: false }, prev, NPWP16);
    expect(r).toEqual({ ok: true, tax: { pkp: false, pkpSejak: null } });
  });

  it('pkp tanpa field pkp mempertahankan nilai sebelumnya', () => {
    const prev = { pkp: true, pkpSejak: null };
    const r = validateTenantTaxInput({}, prev, NPWP16);
    expect(r).toEqual({ ok: true, tax: prev });
    expect(validateTenantTaxInput({ pkp: 'true' }, prev, NPWP16).ok).toBe(false);
  });

  it('PPN dikreditkan hanya untuk PKP dan dokumen sejak tanggal pengukuhan', () => {
    const sejak = new Date('2026-10-01T00:00:00+07:00');
    expect(isPpnDikreditkan({ pkp: false, pkpSejak: null }, new Date())).toBe(false);
    expect(isPpnDikreditkan({ pkp: true, pkpSejak: null }, new Date('2020-01-01'))).toBe(true);
    expect(isPpnDikreditkan({ pkp: true, pkpSejak: sejak }, new Date('2026-09-30T16:59:59Z'))).toBe(false);
    expect(isPpnDikreditkan({ pkp: true, pkpSejak: sejak }, new Date('2026-09-30T17:00:00Z'))).toBe(true);
  });
});
