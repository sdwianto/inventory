import { describe, expect, it } from 'vitest';
import {
  normalizeAssetStatus,
  normalizePriority,
  buildAssetSearchFilter,
} from '@/lib/api/maintenance-helpers';

describe('maintenance-helpers', () => {
  it('normalizeAssetStatus defaults to ACTIVE', () => {
    expect(normalizeAssetStatus(undefined)).toBe('ACTIVE');
    expect(normalizeAssetStatus('IN_REPAIR')).toBe('IN_REPAIR');
    expect(normalizeAssetStatus('invalid')).toBe('ACTIVE');
  });

  it('normalizePriority defaults to MEDIUM', () => {
    expect(normalizePriority(undefined)).toBe('MEDIUM');
    expect(normalizePriority('CRITICAL')).toBe('CRITICAL');
    expect(normalizePriority('x')).toBe('MEDIUM');
  });

  it('buildAssetSearchFilter returns empty without query', () => {
    expect(buildAssetSearchFilter('')).toEqual({});
    expect(buildAssetSearchFilter('  ')).toEqual({});
  });

  it('buildAssetSearchFilter builds regex or', () => {
    const f = buildAssetSearchFilter('mesin');
    expect(f).toHaveProperty('$or');
  });
});
