// Compare-and-set dokumen: update hanya berlaku bila dokumen masih dalam kondisi yang dibaca.
// Konflik (dokumen sudah diubah/diproses pengguna lain) → HTTP 409, bukan menimpa diam-diam.

import type { ClientSession, Db, Filter, Document, UpdateFilter } from 'mongodb';
import { err } from '@/lib/api/db';
import { writeAuditLog, type AuditLogEntry } from '@/lib/api/audit-log';
import { runInTransactionOnDb, runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';

export const CAS_CONFLICT_MESSAGE = 'Dokumen sudah diubah atau diproses pengguna lain — muat ulang lalu coba lagi';

/** Error yang dilempar di dalam transaksi agar handler bisa membalas 409. */
export class CasConflictError extends Error {
  readonly status = 409;
  constructor(message = CAS_CONFLICT_MESSAGE) {
    super(message);
    this.name = 'CasConflictError';
  }
}

export function isCasConflict(e: unknown): e is CasConflictError {
  return e instanceof CasConflictError;
}

export function casConflict(message = CAS_CONFLICT_MESSAGE) {
  return err(message, 409);
}

type CasDoc = { id?: unknown; status?: unknown; updatedAt?: unknown; tenantId?: unknown };

/**
 * Filter transisi status: dokumen harus masih berstatus `expected`.
 * Dokumen yang membawa `tenantId` dikunci ke tenant itu agar update by-id tidak pernah lintas tenant.
 */
export function casStatusFilter<T extends object>(
  doc: T,
  expected: string | readonly string[] = String((doc as CasDoc).status ?? ''),
  extra: Filter<Document> = {},
): Filter<Document> {
  const d = doc as CasDoc;
  const status = Array.isArray(expected) ? { $in: [...expected] } : expected;
  const tenant = typeof d.tenantId === 'string' && d.tenantId ? { tenantId: d.tenantId } : {};
  return { ...tenant, ...extra, id: d.id, status } as Filter<Document>;
}

/**
 * Filter edit isi: status sama dan `updatedAt` belum berubah sejak dibaca
 * (null juga cocok dengan dokumen lama yang belum punya `updatedAt`).
 */
export function casEditFilter<T extends object>(doc: T, extra: Filter<Document> = {}): Filter<Document> {
  const d = doc as CasDoc;
  return {
    ...casStatusFilter(doc, String(d.status ?? ''), extra),
    updatedAt: d.updatedAt ?? null,
  } as Filter<Document>;
}

function runTx<T>(db: Db | undefined, fn: (ctx: { db: Db; session?: ClientSession }) => Promise<T>) {
  return db ? runInTransactionOnDb(db, fn) : runInTransactionOrFallback(fn);
}

/**
 * Insert dokumen + audit log dalam satu transaksi. `before` berjalan di transaksi yang sama sebelum insert
 * (mis. ambil nomor dokumen, batalkan draft lama) dan bisa diulang bila transaksi di-retry.
 * Error (mis. duplicate key, CasConflictError) diteruskan ke pemanggil.
 */
export async function insertWithAudit(input: {
  collection: string;
  doc: object;
  audit: AuditLogEntry | (() => AuditLogEntry);
  before?: (ctx: { db: Db; session?: ClientSession }) => Promise<void>;
  /** Bertransaksi di client milik `db` ini (fungsi pustaka); default koneksi global. */
  db?: Db;
}) {
  await runTx(input.db, async ({ db: txDb, session }) => {
    if (input.before) await input.before({ db: txDb, session });
    await txDb.collection(input.collection).insertOne(input.doc as Document, txOpts(session));
    const audit = typeof input.audit === 'function' ? input.audit() : input.audit;
    await writeAuditLog(txDb, audit, session);
  });
}

/**
 * Update CAS + audit log dalam satu transaksi.
 * @returns `null` bila berhasil, respons 409 bila dokumen sudah berubah.
 */
export async function casUpdateWithAudit(
  input: {
    collection: string;
    filter: Filter<Document>;
    update: UpdateFilter<Document>;
    audit?: AuditLogEntry | (() => AuditLogEntry) | null;
    /** Jalan di transaksi yang sama sebelum update (kunci, validasi ulang, nomor dokumen). Boleh dipanggil ulang saat retry. */
    before?: (ctx: { db: Db; session?: ClientSession }) => Promise<void>;
    db?: Db;
  },
) {
  try {
    await runTx(input.db, async ({ db: txDb, session }) => {
      if (input.before) await input.before({ db: txDb, session });
      const res = await txDb.collection(input.collection).updateOne(input.filter, input.update, txOpts(session));
      if (res.matchedCount === 0) throw new CasConflictError();
      const audit = typeof input.audit === 'function' ? input.audit() : input.audit;
      if (audit) await writeAuditLog(txDb, audit, session);
    });
  } catch (e) {
    if (isCasConflict(e)) return casConflict(e.message);
    throw e;
  }
  return null;
}
