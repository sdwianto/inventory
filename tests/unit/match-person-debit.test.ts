import { describe, expect, it } from 'vitest';
import { matchPersonDebit, type MatchPerson } from '@/lib/people/match-person-debit';

function person(over: Partial<MatchPerson> & Pick<MatchPerson, 'id' | 'kode' | 'nama'>): MatchPerson {
  return {
    aktif: true,
    bankAccounts: [],
    ...over,
  };
}

const siti = person({
  id: 'p-siti',
  kode: 'KDP0001',
  nama: 'Siti Aminah',
  bankAccounts: [{
    bankCode: 'BNI',
    bankNama: 'Bank BNI',
    accountNo: '1122334455',
    accountName: 'Siti Aminah',
    isPrimary: true,
  }],
});

const budi = person({
  id: 'p-budi',
  kode: 'KDP0002',
  nama: 'Budi Santoso',
  bankAccounts: [{
    bankCode: 'BCA',
    bankNama: 'Bank BCA',
    accountNo: '1234567890',
    accountName: 'Budi Santoso',
    isPrimary: true,
  }],
});

describe('matchPersonDebit', () => {
  it('matches unique norek+bank first', () => {
    const hit = matchPersonDebit([siti, budi], {
      counterpartyAccount: '1122334455',
      counterpartyBank: 'BNI',
      description: 'TRANSFER INHOUSE BNI 1122334455 AN. SITI AMINAH',
      onDate: '2029-03-05',
    });
    expect(hit.kind).toBe('matched');
    if (hit.kind === 'matched') {
      expect(hit.person.id).toBe('p-siti');
      expect(hit.via).toBe('account_bank');
    }
  });

  it('falls back to unique norek when bank is missing', () => {
    const hit = matchPersonDebit([siti, budi], {
      counterpartyAccount: '1234567890',
      description: 'TRANSFER KE 1234567890',
      onDate: '2029-03-05',
    });
    expect(hit.kind).toBe('matched');
    if (hit.kind === 'matched') {
      expect(hit.person.id).toBe('p-budi');
      expect(hit.via).toBe('account');
    }
  });

  it('matches unique KDP code in description', () => {
    const hit = matchPersonDebit([siti, budi], {
      description: 'TRANSFER HONOR KDP0001 MARET',
      onDate: '2029-03-05',
    });
    expect(hit.kind).toBe('matched');
    if (hit.kind === 'matched') {
      expect(hit.person.id).toBe('p-siti');
      expect(hit.via).toBe('kode');
    }
  });

  it('does not auto-match on name only', () => {
    const hit = matchPersonDebit([siti, budi], {
      description: 'BI FAST KE BUDI SANTOSO',
      onDate: '2029-03-05',
    });
    expect(hit.kind).toBe('unmatched');
  });

  it('stays unmatched when two people share the same norek', () => {
    const twin = person({
      id: 'p-twin',
      kode: 'KDP0003',
      nama: 'Siti Kembar',
      bankAccounts: [{
        bankCode: 'BNI',
        bankNama: 'Bank BNI',
        accountNo: '1122334455',
        accountName: 'Siti Kembar',
        isPrimary: true,
      }],
    });
    const hit = matchPersonDebit([siti, twin], {
      counterpartyAccount: '1122334455',
      counterpartyBank: 'BNI',
    });
    expect(hit.kind).toBe('unmatched');
  });

  it('skips inactive people even if norek matches', () => {
    const hit = matchPersonDebit([{ ...siti, aktif: false }, budi], {
      counterpartyAccount: '1122334455',
      counterpartyBank: 'BNI',
    });
    expect(hit.kind).toBe('unmatched');
  });
});
