/**
 * Pembayaran transfer ke personel — hasil deteksi mutasi bank (bukan mesin payroll).
 */

import { PERSON_PAYMENTS_COLLECTION as _PAY } from '@/lib/people/person';

export const BANK_TXN_INBOX_COLLECTION = 'bank_txn_inbox';
export const PERSON_PAYMENTS_COLLECTION = _PAY;
export const PERSON_PAYMENT_DOC_PREFIX = 'HNR';
export const PERSON_PAYMENT_DOC_TYPE = 'person_payment';
export const PERSON_PAYMENT_SOURCE_TYPE = 'AUTO_KAS_KELUAR_PERSONEL';
export const DEFAULT_KAS_REKENING_KODE = '10130';
export const BEBAN_GAJI_KODE = '40010';

export type BankTxnProvider = 'BNI';
export type BankTxnSource = 'CSV' | 'WEBHOOK';
export type BankTxnDirection = 'DEBIT' | 'CREDIT';
export type BankTxnInboxStatus = 'NEW' | 'MATCHED' | 'IGNORED';
export type PersonPaymentStatus = 'DETECTED' | 'POSTED' | 'IGNORED';

export const PERSON_PAYMENT_STATUS_LABELS: Record<PersonPaymentStatus, string> = {
  DETECTED: 'Terdeteksi',
  POSTED: 'Posted',
  IGNORED: 'Diabaikan',
};

export interface BankTxnInboxDoc {
  id: string;
  tenantId: string;
  provider: BankTxnProvider;
  source: BankTxnSource;
  direction: BankTxnDirection;
  amount: number;
  valueDate: string;
  bookedAt?: Date;
  accountNo?: string;
  counterpartyAccount?: string;
  counterpartyBank?: string;
  counterpartyName?: string;
  description?: string;
  bankRef: string;
  status: BankTxnInboxStatus;
  matchedPersonId?: string;
  matchedPaymentId?: string;
  kasRekeningKode?: string;
  warnings?: string[];
  createdAt: Date;
}

export interface PersonPaymentDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  personId: string;
  personKode?: string;
  personNama: string;
  bankCode?: string;
  accountNo?: string;
  accountName?: string;
  amount: number;
  tanggal: string;
  bankTxnId: string;
  bankRef: string;
  kasRekeningKode: string;
  status: PersonPaymentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export function parseRupiahAmount(raw: unknown): number {
  const s = String(raw || '').trim();
  if (!s) return 0;
  const compact = s.replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(compact)) {
    const n = Number(compact.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(compact)) {
    const n = Number(compact.replace(/,/g, ''));
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const digits = compact.replace(/[^\d]/g, '');
  if (!digits) return 0;
  return Number(digits) || 0;
}

const MONTH_NUM: Record<string, string> = {
  jan: '01', januari: '01',
  feb: '02', februari: '02',
  mar: '03', maret: '03',
  apr: '04', april: '04',
  may: '05', mei: '05',
  jun: '06', juni: '06',
  jul: '07', juli: '07',
  aug: '08', agu: '08', agustus: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', okt: '10', oktober: '10',
  nov: '11', nop: '11', november: '11',
  dec: '12', des: '12', desember: '12',
};

export function normalizeTxnDate(raw: unknown): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const iso = s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (numeric) {
    const d = numeric[1].padStart(2, '0');
    const mo = numeric[2].padStart(2, '0');
    return `${numeric[3]}-${mo}-${d}`;
  }
  const named = /^(\d{1,2})[/\-\s.]+([A-Za-z]+)[/\-\s.]+(\d{4})$/.exec(s);
  if (named) {
    const mo = MONTH_NUM[named[2].toLowerCase()];
    if (!mo) return null;
    return `${named[3]}-${mo}-${named[1].padStart(2, '0')}`;
  }
  return null;
}

export function publicBankTxn(doc: BankTxnInboxDoc) {
  return {
    id: doc.id,
    provider: doc.provider,
    source: doc.source,
    direction: doc.direction,
    amount: doc.amount,
    valueDate: doc.valueDate,
    accountNo: doc.accountNo,
    counterpartyAccount: doc.counterpartyAccount,
    counterpartyBank: doc.counterpartyBank,
    counterpartyName: doc.counterpartyName,
    description: doc.description,
    bankRef: doc.bankRef,
    status: doc.status,
    matchedPersonId: doc.matchedPersonId,
    matchedPaymentId: doc.matchedPaymentId,
    warnings: doc.warnings,
    createdAt: doc.createdAt,
  };
}

/** Snapshot rekening di history — tidak mengikuti perubahan master personel. */
export function publicPersonPayment(doc: PersonPaymentDoc) {
  return {
    id: doc.id,
    noDokumen: doc.noDokumen,
    personId: doc.personId,
    personKode: doc.personKode,
    personNama: doc.personNama,
    bankCode: doc.bankCode,
    accountNo: doc.accountNo,
    accountName: doc.accountName,
    amount: doc.amount,
    tanggal: doc.tanggal,
    bankRef: doc.bankRef,
    kasRekeningKode: doc.kasRekeningKode,
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_STATUSES = new Set<PersonPaymentStatus>(['POSTED', 'DETECTED', 'IGNORED']);

export type PersonPaymentListQuery = {
  filter: Record<string, unknown>;
  limit: number;
  offset: number;
};

/** Validasi query GET :id/payments — from/to/status/paginasi. */
export function buildPersonPaymentListQuery(input: {
  personId: string;
  from?: string;
  to?: string;
  status?: string;
  limit?: unknown;
  offset?: unknown;
}): PersonPaymentListQuery | { error: string } {
  const personId = String(input.personId || '').trim();
  if (!personId) return { error: 'personId wajib' };
  const from = String(input.from || '').trim();
  const to = String(input.to || '').trim();
  if (from && !ISO_DAY.test(from)) return { error: 'from tidak valid (YYYY-MM-DD)' };
  if (to && !ISO_DAY.test(to)) return { error: 'to tidak valid (YYYY-MM-DD)' };
  if (from && to && from > to) return { error: 'from tidak boleh setelah to' };

  const filter: Record<string, unknown> = { personId };
  const statusRaw = String(input.status || '').trim().toUpperCase();
  if (statusRaw && statusRaw !== 'ALL') {
    if (!PAYMENT_STATUSES.has(statusRaw as PersonPaymentStatus)) {
      return { error: 'status tidak valid' };
    }
    filter.status = statusRaw;
  } else {
    filter.status = { $in: ['POSTED', 'DETECTED'] };
  }
  if (from || to) {
    filter.tanggal = {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {}),
    };
  }

  const rawLimit = Number(input.limit);
  const rawOffset = Number(input.offset);
  const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 50));
  const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0);
  return { filter, limit, offset };
}
