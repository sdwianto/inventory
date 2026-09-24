import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { runInTransactionOrFallback } from '@/lib/api/transaction';
import { logger } from '@/lib/api/logger';
import { parseBniMutasiCsv } from '@/lib/people/bni-mutasi-parse';
import { PEOPLE_COLLECTION, normalizeAccountNo, isPersonEffective } from '@/lib/people/person';
import {
  autoMatchInbox,
  loadMatchPeople,
  postMatchedPersonPayment,
} from '@/lib/people/post-person-payment';
import {
  BANK_TXN_INBOX_COLLECTION,
  DEFAULT_KAS_REKENING_KODE,
  publicBankTxn,
  type BankTxnInboxDoc,
} from '@/lib/people/person-payment';
import { PEOPLE_MANAGE_ROLES } from '@/lib/people/roles';
import type { HandlerContext } from '@/types/api/handler';
import { casConflict, casStatusFilter } from '@/lib/api/cas';

const MANAGE_ROLES = PEOPLE_MANAGE_ROLES;

function isBankRoot(seg: string | undefined) {
  return seg === 'bank-txn' || seg === 'bank-imports';
}

function isDuplicateKeyError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: number; message?: string };
  return err.code === 11000 || /E11000/i.test(String(err.message || ''));
}

export async function handleBankTxn({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (!isBankRoot(path[0])) return null;
  const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
  if (deniedRole) return deniedRole;

  const payload = (body || {}) as Record<string, unknown>;
  const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: payload, request });
  if (denied) return denied;
  if (!scopeAuth) return err('Scope tidak valid', 400);

  if ((path[1] === 'import' || route === '/bank-imports') && method === 'POST' && !path[2]) {
    const csvText = String(payload.csvText || payload.csv || '').trim();
    if (!csvText) return err('csvText wajib');
    const kasRekeningKode = String(payload.kasRekeningKode || DEFAULT_KAS_REKENING_KODE).trim()
      || DEFAULT_KAS_REKENING_KODE;
    const parsed = parseBniMutasiCsv(csvText);
    const tenantId = tenantIdForWrite(scopeAuth, payload);
    const people = await loadMatchPeople(db, withTenantFilter(scopeAuth, {}));

    let inserted = 0;
    let duplicate = 0;
    let matched = 0;
    const unmatched: ReturnType<typeof publicBankTxn>[] = [];

    for (const row of parsed.rows) {
      const existing = await db.collection(BANK_TXN_INBOX_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { provider: 'BNI', bankRef: row.bankRef }),
      );
      if (existing) {
        duplicate += 1;
        const existingInbox = existing as unknown as BankTxnInboxDoc;
        if (existingInbox.status === 'NEW') {
          const retried = await tryAutoMatchInbox({
            db, people, inbox: existingInbox, tenantId, kasRekeningKode, auth,
          });
          if (retried === 'matched') matched += 1;
          else unmatched.push(publicBankTxn(existingInbox));
        }
        continue;
      }
      const inbox: BankTxnInboxDoc = {
        id: uuidv4(),
        tenantId,
        provider: 'BNI',
        source: 'CSV',
        direction: 'DEBIT',
        amount: row.amount,
        valueDate: row.valueDate,
        accountNo: row.accountNo,
        counterpartyAccount: row.counterpartyAccount,
        counterpartyBank: row.counterpartyBank,
        counterpartyName: row.counterpartyName,
        description: row.description,
        bankRef: row.bankRef,
        status: 'NEW',
        kasRekeningKode,
        warnings: row.warnings,
        createdAt: new Date(),
      };
      try {
        await db.collection(BANK_TXN_INBOX_COLLECTION).insertOne(inbox);
      } catch (e) {
        if (isDuplicateKeyError(e)) {
          duplicate += 1;
          continue;
        }
        throw e;
      }
      inserted += 1;

      const posted = await tryAutoMatchInbox({
        db, people, inbox, tenantId, kasRekeningKode, auth,
      });
      if (posted === 'matched') matched += 1;
      else unmatched.push(publicBankTxn(inbox));
    }

    const parseWarnings = parsed.rows.length
      ? parsed.warnings
      : [...parsed.warnings, 'Tidak ada baris debet'];

    return ok({
      inserted,
      duplicate,
      matched,
      unmatched,
      unmatchedCount: unmatched.length,
      parseWarnings,
    });
  }

  if (!path[1] && method === 'GET') {
    const status = String(url.searchParams.get('status') || 'NEW').trim().toUpperCase();
    const filter: Record<string, unknown> = {};
    if (status && status !== 'ALL') filter.status = status;
    const list = await db.collection(BANK_TXN_INBOX_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ valueDate: -1, createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((doc) => clean(publicBankTxn(doc as unknown as BankTxnInboxDoc))));
  }

  const id = path[1];
  if (!id) return null;

  if (path[2] === 'match' && method === 'POST') {
    const personId = String(payload.personId || '').trim();
    if (!personId) return err('personId wajib');
    const inboxRaw = await db.collection(BANK_TXN_INBOX_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    if (!inboxRaw) return err('Mutasi tidak ditemukan', 404);
    const inbox = inboxRaw as unknown as BankTxnInboxDoc;
    if (inbox.status === 'IGNORED') return err('Mutasi sudah diabaikan');
    if (inbox.status === 'MATCHED' && inbox.matchedPaymentId) {
      return ok({ alreadyMatched: true, paymentId: inbox.matchedPaymentId });
    }
    const person = await db.collection(PEOPLE_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: personId }),
    );
    if (!person) return err('Personel tidak ditemukan', 404);
    if (!isPersonEffective(person as never, inbox.valueDate)) {
      return err('Personel nonaktif atau di luar masa tugas');
    }
    type PersonAccount = { bankCode?: string; accountNo?: string; accountName?: string; isPrimary?: boolean };
    const rawAccounts = (person as unknown as { bankAccounts?: PersonAccount[] }).bankAccounts;
    const accounts = Array.isArray(rawAccounts) ? rawAccounts : [];
    const norek = normalizeAccountNo(inbox.counterpartyAccount);
    const account = accounts.find((a) => norek && a.accountNo === norek)
      || accounts.find((a) => a.isPrimary)
      || accounts[0];
    if (!account) return err('Personel belum punya rekening');

    const tenantId = inbox.tenantId || tenantIdForWrite(scopeAuth, payload);
    const payment = await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      return postMatchedPersonPayment({
        db: txDb,
        session,
        tenantId,
        inbox,
        person: person as never,
        account,
        kasRekeningKode: inbox.kasRekeningKode,
        auth,
        via: 'manual',
      });
    });
    return ok(clean({ paymentId: payment.id, personId: payment.personId, noDokumen: payment.noDokumen }));
  }

  if (path[2] === 'ignore' && method === 'POST') {
    const inboxRaw = await db.collection(BANK_TXN_INBOX_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    if (!inboxRaw) return err('Mutasi tidak ditemukan', 404);
    const inbox = inboxRaw as unknown as BankTxnInboxDoc;
    if (inbox.status === 'MATCHED') return err('Mutasi sudah tercocokkan');
    if (inbox.status === 'IGNORED') return ok({ id, status: 'IGNORED', alreadyIgnored: true });
    const casRes = await db.collection(BANK_TXN_INBOX_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, casStatusFilter(inbox)),
      { $set: { status: 'IGNORED' } },
    );
    if (casRes.matchedCount === 0) return casConflict();
    await writeAuditLog(db, {
      tenantId: inbox.tenantId,
      action: 'PERSON_PAYMENT_IGNORE',
      entityType: 'bank_txn_inbox',
      entityId: id,
      summary: `Abaikan mutasi ${inbox.bankRef} Rp${inbox.amount}`,
      ...auditActor(auth),
    });
    return ok({ id, status: 'IGNORED' });
  }

  return null;
}

async function tryAutoMatchInbox(opts: {
  db: HandlerContext['db'];
  people: Awaited<ReturnType<typeof loadMatchPeople>>;
  inbox: BankTxnInboxDoc;
  tenantId: string;
  kasRekeningKode: string;
  auth: HandlerContext['auth'];
}): Promise<'matched' | 'unmatched'> {
  const hit = autoMatchInbox(opts.people, opts.inbox);
  if (hit.kind !== 'matched') return 'unmatched';
  try {
    await runInTransactionOrFallback(async ({ db: txDb, session }) => {
      await postMatchedPersonPayment({
        db: txDb,
        session,
        tenantId: opts.tenantId,
        inbox: opts.inbox,
        person: hit.person,
        account: hit.account,
        kasRekeningKode: opts.kasRekeningKode,
        auth: opts.auth,
        via: hit.via,
      });
    });
    return 'matched';
  } catch (e) {
    logger.warn('bank_txn_auto_match_failed', {
      bankRef: opts.inbox.bankRef,
      error: e instanceof Error ? e.message : String(e),
    });
    return 'unmatched';
  }
}
