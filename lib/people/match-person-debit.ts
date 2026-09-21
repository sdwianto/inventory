import {
  PERSON_CODE_PREFIX,
  isPersonEffective,
  normalizeAccountNo,
  normalizeBankCode,
  type KitchenPersonDoc,
  type PersonBankAccount,
} from '@/lib/people/person';

export type MatchPerson = Pick<
  KitchenPersonDoc,
  'id' | 'kode' | 'nama' | 'aktif' | 'effectiveFrom' | 'effectiveTo' | 'bankAccounts'
>;

export type DebitMatchInput = {
  counterpartyAccount?: string;
  counterpartyBank?: string;
  description?: string;
  onDate?: string;
};

export type DebitMatchResult =
  | { kind: 'matched'; person: MatchPerson; account: PersonBankAccount; via: 'account_bank' | 'account' | 'kode' }
  | { kind: 'unmatched'; reason: string };

function effectivePeople(people: MatchPerson[], onDate?: string): MatchPerson[] {
  return people.filter((p) => isPersonEffective(p, onDate));
}

function accountsOf(person: MatchPerson): PersonBankAccount[] {
  return Array.isArray(person.bankAccounts) ? person.bankAccounts : [];
}

export function matchPersonDebit(people: MatchPerson[], input: DebitMatchInput): DebitMatchResult {
  const pool = effectivePeople(people, input.onDate);
  const account = normalizeAccountNo(input.counterpartyAccount);
  const bank = normalizeBankCode(input.counterpartyBank);

  if (account && bank) {
    const hits = pool.flatMap((person) => (
      accountsOf(person)
        .filter((a) => a.accountNo === account && a.bankCode === bank)
        .map((a) => ({ person, account: a }))
    ));
    if (hits.length === 1) return { kind: 'matched', ...hits[0], via: 'account_bank' };
    if (hits.length > 1) return { kind: 'unmatched', reason: 'Norek+bank cocok ke lebih dari satu personel' };
  }

  if (account) {
    const hits = pool.flatMap((person) => (
      accountsOf(person)
        .filter((a) => a.accountNo === account)
        .map((a) => ({ person, account: a }))
    ));
    if (hits.length === 1) return { kind: 'matched', ...hits[0], via: 'account' };
    if (hits.length > 1) return { kind: 'unmatched', reason: 'Norek cocok ke lebih dari satu personel' };
  }

  const desc = String(input.description || '').toUpperCase();
  const kodeMatch = desc.match(new RegExp(`\\b(${PERSON_CODE_PREFIX}\\d{4,})\\b`));
  if (kodeMatch) {
    const kode = kodeMatch[1];
    const hits = pool.filter((p) => String(p.kode || '').toUpperCase() === kode);
    if (hits.length === 1) {
      const person = hits[0];
      const acc = accountsOf(person).find((a) => a.isPrimary) || accountsOf(person)[0];
      if (!acc) return { kind: 'unmatched', reason: `Personel ${kode} belum punya rekening` };
      return { kind: 'matched', person, account: acc, via: 'kode' };
    }
    if (hits.length > 1) return { kind: 'unmatched', reason: `Kode ${kode} bentrok` };
  }

  return { kind: 'unmatched', reason: 'Tidak ada norek/kode yang cocok otomatis' };
}
