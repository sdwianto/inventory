import { describe, expect, it } from 'vitest';
import { publicPersonPayment, buildPersonPaymentListQuery, type PersonPaymentDoc } from '@/lib/people/person-payment';

function payment(over: Partial<PersonPaymentDoc> = {}): PersonPaymentDoc {
  const now = new Date('2026-09-21T00:00:00.000Z');
  return {
    id: 'pay1',
    tenantId: 'sppg',
    noDokumen: 'HNR0001',
    personId: 'p-siti',
    personKode: 'KDP0001',
    personNama: 'Siti Aminah',
    bankCode: 'BNI',
    accountNo: '1122334455',
    accountName: 'Siti Aminah',
    amount: 1_500_000,
    tanggal: '2029-03-05',
    bankTxnId: 'txn1',
    bankRef: 'NTB001INHOUSE',
    kasRekeningKode: '10130',
    status: 'POSTED',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('publicPersonPayment snapshot', () => {
  it('keeps the norek captured at match even if master rekening later changes', () => {
    const posted = payment();
    const masterNow = { bankCode: 'BCA', accountNo: '9999999999', accountName: 'Siti Baru' };
    const view = publicPersonPayment(posted);
    expect(view.accountNo).toBe('1122334455');
    expect(view.bankCode).toBe('BNI');
    expect(view.accountNo).not.toBe(masterNow.accountNo);
    expect(view.bankRef).toBe('NTB001INHOUSE');
    expect(view.status).toBe('POSTED');
  });

  it('does not expose tenant internals', () => {
    const view = publicPersonPayment(payment()) as Record<string, unknown>;
    expect(view.tenantId).toBeUndefined();
    expect(view.bankTxnId).toBeUndefined();
  });
});

describe('buildPersonPaymentListQuery', () => {
  it('defaults to POSTED+DETECTED, limit 50, tanggal range inclusive', () => {
    const q = buildPersonPaymentListQuery({
      personId: 'p1',
      from: '2029-03-01',
      to: '2029-03-31',
    });
    expect('error' in q).toBe(false);
    if ('error' in q) return;
    expect(q.filter.personId).toBe('p1');
    expect(q.filter.status).toEqual({ $in: ['POSTED', 'DETECTED'] });
    expect(q.filter.tanggal).toEqual({ $gte: '2029-03-01', $lte: '2029-03-31' });
    expect(q.limit).toBe(50);
    expect(q.offset).toBe(0);
  });

  it('rejects inverted from/to, bad dates, and unknown status', () => {
    expect(buildPersonPaymentListQuery({ personId: 'p1', from: '2029-04-01', to: '2029-03-01' }))
      .toEqual({ error: 'from tidak boleh setelah to' });
    expect(buildPersonPaymentListQuery({ personId: 'p1', from: '05/03/2029' }))
      .toEqual({ error: 'from tidak valid (YYYY-MM-DD)' });
    expect(buildPersonPaymentListQuery({ personId: 'p1', status: 'PAID' }))
      .toEqual({ error: 'status tidak valid' });
  });

  it('caps limit and floors offset', () => {
    const q = buildPersonPaymentListQuery({ personId: 'p1', status: 'POSTED', limit: 999, offset: -3 });
    expect('error' in q).toBe(false);
    if ('error' in q) return;
    expect(q.filter.status).toBe('POSTED');
    expect(q.limit).toBe(200);
    expect(q.offset).toBe(0);
  });

  it('treats ALL/empty status as POSTED+DETECTED and allows open-ended from', () => {
    const all = buildPersonPaymentListQuery({ personId: 'p1', status: 'ALL', from: '2029-03-01' });
    expect('error' in all).toBe(false);
    if ('error' in all) return;
    expect(all.filter.status).toEqual({ $in: ['POSTED', 'DETECTED'] });
    expect(all.filter.tanggal).toEqual({ $gte: '2029-03-01' });
  });
});
