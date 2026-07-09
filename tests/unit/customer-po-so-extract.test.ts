import { describe, expect, it } from 'vitest';
import {
  extractPushedVendorSo,
  poHasVendorSoNumbers,
  submissionHasVendorSo,
  summarizeVendorNoSo,
} from '@/lib/api/customer-po-so-extract';

describe('extractPushedVendorSo', () => {
  it('reads flat sales.app POST response', () => {
    const doc = extractPushedVendorSo({
      id: 'so-1',
      noSO: 'SO2607000001',
      created: true,
    });
    expect(doc.noSO).toBe('SO2607000001');
    expect(doc.id).toBe('so-1');
  });

  it('reads nested doc wrapper', () => {
    const doc = extractPushedVendorSo({
      ok: true,
      data: { id: 'so-2', noSO: 'SO2607000002' },
    });
    expect(doc.noSO).toBe('SO2607000002');
  });

  it('reads salesOrderId alias from status lookup', () => {
    const doc = extractPushedVendorSo({
      salesOrderId: 'so-3',
      noSO: 'SO2607000003',
    });
    expect(doc.salesOrderId).toBe('so-3');
    expect(doc.noSO).toBe('SO2607000003');
  });
});

describe('submissionHasVendorSo', () => {
  it('true when vendorNoSO present', () => {
    expect(submissionHasVendorSo({ vendorNoSO: 'SO1' })).toBe(true);
  });
  it('true when only vendorSoId present', () => {
    expect(submissionHasVendorSo({ vendorSoId: 'id-1' })).toBe(true);
  });
  it('false when empty', () => {
    expect(submissionHasVendorSo({ status: 'SYNCED' })).toBe(false);
  });
});

describe('poHasVendorSoNumbers', () => {
  it('true from vendorNoSO', () => {
    expect(poHasVendorSoNumbers({ vendorNoSO: 'SO1' })).toBe(true);
  });
  it('true from vendorSubmissions', () => {
    expect(poHasVendorSoNumbers({
      vendorSubmissions: [{ vendorNoSO: 'SO2' }],
    })).toBe(true);
  });
  it('false when missing', () => {
    expect(poHasVendorSoNumbers({ status: 'SUBMITTED', vendorSubmissions: [] })).toBe(false);
  });
});

describe('summarizeVendorNoSo', () => {
  it('joins multiple SO numbers', () => {
    expect(summarizeVendorNoSo([
      { vendorNoSO: 'SO1' },
      { vendorNoSO: 'SO2' },
    ])).toBe('SO1, SO2');
  });
});
