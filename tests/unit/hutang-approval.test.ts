import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreeWayMatchResult } from '@/types/integration';

const qtyCheck = vi.hoisted(() => ({
  result: { ok: true } as ThreeWayMatchResult,
  calls: [] as Array<{ payload: Record<string, unknown>; opts: Record<string, unknown> }>,
}));

vi.mock('@/lib/api/three-way-match', () => ({
  validateInvoiceAgainstGrn: async (_db: unknown, _tid: string, payload: Record<string, unknown>, opts: Record<string, unknown>) => {
    qtyCheck.calls.push({ payload, opts });
    return qtyCheck.result;
  },
}));

import {
  assertCanApproveInvoice,
  invoicePayloadFromHutang,
  parseKnowingSignature,
  resolvePenerimaGudang,
} from '@/lib/api/hutang-approval';
import type { HutangDoc } from '@/types/documents';

beforeEach(() => {
  qtyCheck.result = { ok: true };
  qtyCheck.calls.length = 0;
});

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

  describe('PO multi-pengiriman (PARTIAL_RECEIVED) — gerbang qty baris yang ditagih', () => {
    // Kasus INV2609000021 / CPO2609000048: baris yang ditagih sudah diterima penuh,
    // tapi harga invoice beda dari PO/SO → EXCEPTION. Override harus bisa dipakai.
    const partialPo = { noPO: 'CPO1', status: 'PARTIAL_RECEIVED' };
    const exceptionInvoice = () => hutang({
      matchStatus: 'EXCEPTION',
      matchError: '3-way match harga: B582948 invoice Rp 750 > harga PO/SO Rp 575 (+2%)',
      noDO: 'DO1',
      vendorTenantId: 'v1',
      vendorInvoiceId: 'inv-1',
      items: [{ lineId: 'l1', kode: 'B582948', satuan: 'PCS', qty: 1350, harga: 750 }],
    });

    it('qty tertutup GRN + override → boleh disetujui', async () => {
      const res = await assertCanApproveInvoice(mockDb(partialPo), exceptionInvoice(), { overrideMatch: true });
      expect(res.ok).toBe(true);
      expect(qtyCheck.calls[0].opts).toMatchObject({ qtyOnly: true, excludeHutangId: 'h1' });
      expect(qtyCheck.calls[0].payload).toMatchObject({ noDO: 'DO1', noPO: 'CPO1', vendorTenantId: 'v1', invoiceId: 'inv-1' });
    });

    it('qty tertutup GRN tanpa override → tetap MATCH_EXCEPTION', async () => {
      const res = await assertCanApproveInvoice(mockDb(partialPo), exceptionInvoice());
      expect((res as { code?: string }).code).toBe('MATCH_EXCEPTION');
    });

    it('qty baris yang ditagih belum diterima → PO_NOT_RECEIVED walau override', async () => {
      qtyCheck.result = { ok: false, code: 'QTY_MISMATCH', error: '3-way match qty: B582948 (PCS) invoice 1350 > GRN posted 1000' };
      const res = await assertCanApproveInvoice(mockDb(partialPo), exceptionInvoice(), { overrideMatch: true });
      expect(res.ok).toBe(false);
      expect((res as { code?: string }).code).toBe('PO_NOT_RECEIVED');
      expect((res as { error?: string }).error).toMatch(/GRN posted 1000/);
    });

    it('tagihan tanpa DO/baris tidak bisa dibuktikan → PO_NOT_RECEIVED tanpa query GRN', async () => {
      const res = await assertCanApproveInvoice(mockDb(partialPo), hutang({ matchStatus: 'EXCEPTION' }), { overrideMatch: true });
      expect((res as { code?: string }).code).toBe('PO_NOT_RECEIVED');
      expect(qtyCheck.calls).toHaveLength(0);
    });

    it('PO RECEIVED atau MATCHED tidak perlu cek qty ulang', async () => {
      await assertCanApproveInvoice(mockDb({ noPO: 'CPO1', status: 'RECEIVED' }), exceptionInvoice(), { overrideMatch: true });
      await assertCanApproveInvoice(mockDb(partialPo), hutang({ matchStatus: 'MATCHED' }));
      expect(qtyCheck.calls).toHaveLength(0);
    });
  });
});

describe('invoicePayloadFromHutang', () => {
  it('memetakan field hutang ke payload 3-way match', () => {
    const payload = invoicePayloadFromHutang(hutang({
      noDO: 'DO1', noSO: 'SO1', salesOrderId: 'so-1', vendorTenantId: 'v1', vendorInvoiceId: 'inv-1', noInvoice: 'INV1',
      items: [{ lineId: 'l1', stokId: 's1', uomId: 'u1', satuan: 'PCS', kode: 'K1', qty: 2, harga: 10, nama: 'X' }],
    }));
    expect(payload).toMatchObject({
      invoiceId: 'inv-1', noInvoice: 'INV1', noDO: 'DO1', noSO: 'SO1', noPO: 'CPO1', salesOrderId: 'so-1', vendorTenantId: 'v1',
      items: [{ lineId: 'l1', stokId: 's1', uomId: 'u1', satuan: 'PCS', kode: 'K1', qty: 2, harga: 10 }],
    });
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
