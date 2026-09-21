import { v4 as uuidv4 } from 'uuid';
import type { ClientSession, Db } from 'mongodb';
import { createJournalIfNotExists } from '@/lib/api/journal';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { txOpts } from '@/lib/api/transaction';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import type { AuthContext } from '@/types/auth';
import { PEOPLE_COLLECTION } from '@/lib/people/person';
import { matchPersonDebit, type MatchPerson } from '@/lib/people/match-person-debit';
import { buildPersonPaymentJournalLines } from '@/lib/api/journal-lines';
import {
  BANK_TXN_INBOX_COLLECTION,
  DEFAULT_KAS_REKENING_KODE,
  PERSON_PAYMENT_DOC_PREFIX,
  PERSON_PAYMENT_DOC_TYPE,
  PERSON_PAYMENT_SOURCE_TYPE,
  PERSON_PAYMENTS_COLLECTION,
  type BankTxnInboxDoc,
  type PersonPaymentDoc,
} from '@/lib/people/person-payment';

function isDuplicateKeyError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: number; message?: string };
  return err.code === 11000 || /E11000/i.test(String(err.message || ''));
}

export async function loadMatchPeople(
  db: Db,
  filter: Record<string, unknown>,
  session?: ClientSession,
): Promise<MatchPerson[]> {
  const docs = await db.collection(PEOPLE_COLLECTION)
    .find({ ...filter, aktif: { $ne: false } }, txOpts(session))
    .project({
      id: 1, kode: 1, nama: 1, aktif: 1, effectiveFrom: 1, effectiveTo: 1, bankAccounts: 1,
    })
    .toArray();
  return docs as unknown as MatchPerson[];
}

async function markInboxMatched(opts: {
  db: Db;
  session?: ClientSession;
  tenantId: string;
  inboxId: string;
  personId: string;
  paymentId: string;
}) {
  await opts.db.collection(BANK_TXN_INBOX_COLLECTION).updateOne(
    { tenantId: opts.tenantId, id: opts.inboxId },
    {
      $set: {
        status: 'MATCHED',
        matchedPersonId: opts.personId,
        matchedPaymentId: opts.paymentId,
      },
    },
    txOpts(opts.session),
  );
}

async function ensurePaymentJournal(opts: {
  db: Db;
  session?: ClientSession;
  tenantId: string;
  payment: PersonPaymentDoc;
  kasRekeningNama?: string;
  auth?: AuthContext | null;
}) {
  const { payment } = opts;
  const lines = buildPersonPaymentJournalLines({
    noDoc: payment.noDokumen,
    amount: payment.amount,
    kasRekeningKode: payment.kasRekeningKode,
    kasRekeningNama: opts.kasRekeningNama,
    personNama: payment.personNama,
  });
  await createJournalIfNotExists(opts.db, {
    tanggal: new Date(`${payment.tanggal}T00:00:00.000Z`),
    keterangan: `Transfer gaji ${payment.personNama} ${payment.noDokumen}`,
    sourceType: PERSON_PAYMENT_SOURCE_TYPE,
    sourceId: payment.id,
    details: lines,
    userName: opts.auth?.name || opts.auth?.email,
    tenantId: opts.tenantId,
  }, opts.session);
}

export async function postMatchedPersonPayment(opts: {
  db: Db;
  session?: ClientSession;
  tenantId: string;
  inbox: BankTxnInboxDoc;
  person: MatchPerson;
  account: { bankCode?: string; accountNo?: string; accountName?: string };
  kasRekeningKode?: string;
  kasRekeningNama?: string;
  auth?: AuthContext | null;
  via: string;
}): Promise<PersonPaymentDoc> {
  const {
    db, session, tenantId, inbox, person, account, auth, via,
  } = opts;
  const kasRekeningKode = String(opts.kasRekeningKode || inbox.kasRekeningKode || DEFAULT_KAS_REKENING_KODE);
  const now = new Date();

  const finishExisting = async (existing: PersonPaymentDoc) => {
    await markInboxMatched({
      db, session, tenantId, inboxId: inbox.id, personId: existing.personId, paymentId: existing.id,
    });
    await ensurePaymentJournal({
      db, session, tenantId, payment: existing, kasRekeningNama: opts.kasRekeningNama, auth,
    });
    return existing;
  };

  const existingPay = await db.collection(PERSON_PAYMENTS_COLLECTION).findOne(
    { tenantId, bankRef: inbox.bankRef },
    txOpts(session),
  );
  if (existingPay) {
    return finishExisting(existingPay as unknown as PersonPaymentDoc);
  }

  const noDokumen = await nextDocNumber(
    db,
    tenantId,
    PERSON_PAYMENT_DOC_TYPE,
    PERSON_PAYMENT_DOC_PREFIX,
    session,
  );
  const payment: PersonPaymentDoc = {
    id: uuidv4(),
    tenantId,
    noDokumen,
    personId: person.id,
    personKode: person.kode,
    personNama: person.nama,
    bankCode: account.bankCode,
    accountNo: account.accountNo,
    accountName: account.accountName,
    amount: inbox.amount,
    tanggal: inbox.valueDate,
    bankTxnId: inbox.id,
    bankRef: inbox.bankRef,
    kasRekeningKode,
    status: 'POSTED',
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.collection(PERSON_PAYMENTS_COLLECTION).insertOne(payment, txOpts(session));
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const raced = await db.collection(PERSON_PAYMENTS_COLLECTION).findOne(
        { tenantId, bankRef: inbox.bankRef },
        txOpts(session),
      );
      if (raced) return finishExisting(raced as unknown as PersonPaymentDoc);
    }
    throw e;
  }

  await markInboxMatched({
    db, session, tenantId, inboxId: inbox.id, personId: person.id, paymentId: payment.id,
  });
  await ensurePaymentJournal({
    db, session, tenantId, payment, kasRekeningNama: opts.kasRekeningNama, auth,
  });
  await writeAuditLog(db, {
    tenantId,
    action: 'PERSON_PAYMENT_MATCH',
    entityType: 'person_payment',
    entityId: payment.id,
    summary: `Match ${via}: ${person.nama} Rp${inbox.amount} (${inbox.bankRef})`,
    ...auditActor(auth),
  }, session);

  return payment;
}

export function autoMatchInbox(people: MatchPerson[], inbox: BankTxnInboxDoc) {
  return matchPersonDebit(people, {
    counterpartyAccount: inbox.counterpartyAccount,
    counterpartyBank: inbox.counterpartyBank,
    description: inbox.description,
    onDate: inbox.valueDate,
  });
}
