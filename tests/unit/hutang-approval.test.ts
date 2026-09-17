import { describe, expect, it } from 'vitest';
import {
  assertCanApproveInvoice,
  parseKnowingSignature,
  resolvePenerimaGudang,
} from '@/lib/api/hutang-approval';
import type { HutangDoc } from '@/types/documents';

function mockDb(po: Record<string, unknown> | null) {
  return {
    collection: (name: string) => ({
      findOne: async () => (name === 'customer_purchase_orders' ? po : null),
    }),
  } as unknown as Parameters<typeof assertCanApproveInvoice>[0];
}

function hutang(overrides: Partial<HutangDoc>): HutangDoc {
  return {
    id: 'h1',
    tenantId: 'default',
    approvalStatus: 'PENDING_REVIEW',
    noPO: 'CPO1',
    ...overrides,
  } as HutangDoc;
}

describe('assertCanApproveInvoice', () => {
  it('blocks approval when PO is PARTIAL_RECEIVED and match is not MATCHED', async () => {
    const db = mockDb({ noPO: 'CPO1', status: 'PARTIAL_RECEIVED' });
    const res = await assertCanApproveInvoice(db, hutang({ matchStatus: 'PENDING' }));
    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe('PO_NOT_RECEIVED');
  });

  it('allows approval when PO is PARTIAL_RECEIVED (rollup drift) but this invoice already MATCHED', async () => {
    // Ini kasus PO CPO2608000025: rollup po.status nyangkut PARTIAL_RECEIVED gara-gara
    // satu baris gagal ter-match di cpo-status-sync, walau 3-way match per-baris invoice
    // (matchStatus) sudah membuktikan semua baris invoice ini didukung GRN POSTED.
    const db = mockDb({ noPO: 'CPO1', status: 'PARTIAL_RECEIVED' });
    const res = await assertCanApproveInvoice(db, hutang({ matchStatus: 'MATCHED' }));
    expect(res.ok).toBe(true);
  });

  it('still allows approval when PO is fully RECEIVED', async () => {
    const db = mockDb({ noPO: 'CPO1', status: 'RECEIVED' });
    const res = await assertCanApproveInvoice(db, hutang({ matchStatus: 'PENDING' }));
    expect(res.ok).toBe(true);
  });

  it('still blocks on MATCH_EXCEPTION even when PO is fully received', async () => {
    const db = mockDb({ noPO: 'CPO1', status: 'RECEIVED' });
    const res = await assertCanApproveInvoice(db, hutang({ matchStatus: 'EXCEPTION', matchError: 'qty mismatch' }));
    expect(res.ok).toBe(false);
    expect((res as { code?: string }).code).toBe('MATCH_EXCEPTION');
  });
});

describe('parseKnowingSignature', () => {
  it('rejects missing knowingBy', () => {
    const res = parseKnowingSignature(undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Signature Mengetahui wajib/);
  });

  it('rejects with custom slot label', () => {
    const res = parseKnowingSignature(undefined, 'Penerima gudang');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Signature Penerima gudang wajib/);
  });

  it('rejects empty nama or nik', () => {
    expect(parseKnowingSignature({ userName: 'A', nik: '' }).ok).toBe(false);
    expect(parseKnowingSignature({ userName: '', nik: '1' }).ok).toBe(false);
  });

  it('accepts Nama + NIK and optional jabatan', () => {
    const res = parseKnowingSignature({ userName: ' Siti ', nik: ' 123 ', jabatan: ' Staff AP ' });
    expect(res).toEqual({
      ok: true,
      value: { userName: 'Siti', nik: '123', jabatan: 'Staff AP' },
    });
  });

  it('accepts alias nama', () => {
    const res = parseKnowingSignature({ nama: 'Budi', nik: '9' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.userName).toBe('Budi');
  });
});

describe('resolvePenerimaGudang', () => {
  it('prefers receivedBy over legacy userName', () => {
    expect(resolvePenerimaGudang({
      receivedBy: { userId: 'u1', userName: 'Budi', role: 'WAREHOUSE', nik: '99', jabatan: 'Petugas' },
      userName: 'Legacy',
    })).toEqual({
      userId: 'u1',
      userName: 'Budi',
      role: 'WAREHOUSE',
      nik: '99',
      jabatan: 'Petugas',
    });
  });

  it('falls back to userName string when not requireComplete', () => {
    expect(resolvePenerimaGudang({ userName: 'Siti' })).toEqual({
      userId: '',
      userName: 'Siti',
      role: '',
    });
  });

  it('requireComplete rejects legacy userName-only', () => {
    expect(resolvePenerimaGudang({ userName: 'Siti' }, { requireComplete: true })).toBeNull();
    expect(resolvePenerimaGudang({
      receivedBy: { userName: 'Budi', role: 'W' },
    }, { requireComplete: true })).toBeNull();
  });

  it('requireComplete accepts Nama+NIK on receivedBy', () => {
    expect(resolvePenerimaGudang({
      receivedBy: { userId: 'u1', userName: 'Budi', role: 'W', nik: '12' },
      userName: 'Legacy',
    }, { requireComplete: true })).toEqual({
      userId: 'u1',
      userName: 'Budi',
      role: 'W',
      nik: '12',
    });
  });

  it('returns null when empty', () => {
    expect(resolvePenerimaGudang(null)).toBeNull();
    expect(resolvePenerimaGudang({})).toBeNull();
  });
});
